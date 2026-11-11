// 任务板块宿主：任务详情面板与任务板块面板共用。
// 渲染规则：
//  1. 选项卡栏只展示内容板块（按「配置」里的显示设置过滤），右上角齿轮按钮打开配置页；
//  2. 「开启」始终显示该类型选项卡，「自动」仅在板块存在内容时显示，「关闭」始终隐藏（数据保留）；
//  3. 没有可显示的板块时，配置页作为兜底视图；
//  4. 内容读写统一走 shared/task-sections 访问器，首次写入内容时自动创建板块。
import { Notice, TFolder, setIcon, type App, type TFile } from 'obsidian';

import type { ChecklistItem } from '../../datatypes/domain';
import type { PrototypeTask } from '../../datatypes/prototype-task';
import type { SectionDisplayMode, SectionType } from '../../datatypes/task-section';
import { getLang, getWeekDays, t } from '../../i18n';
import { SECTION_REGISTRY } from '../../shared/section-registry';
import {
    getCurrentDayKey,
    getCurrentWeekKey,
    makeDayKeyFromWeek,
    parseWeekKey,
    shiftWeekKey,
} from '../../shared/plan-data';
import { buildTaskFileName, listTaskFiles, relativeToDir } from '../../shared/task-file';
import {
    appendChecklist,
    getChecklist,
    getDayGoalEntries,
    getSection,
    getSectionDisplay,
    getStageGoalEntries,
    getTaskFileDir,
    getTaskFileTimestamp,
    getTaskGoals,
    getTaskHabit,
    hasSection,
    setChecklist,
    setDayGoalEntries,
    setSectionDisplay,
    setStageGoalEntries,
    setTaskFileTimestamp,
    setTaskGoals,
    setTaskHabit,
    setWeekNote,
    getWeekNote,
} from '../../shared/task-sections';
import { ensureTaskFileDir, revealFolderInExplorer } from '../../shared/task-library';
import { FileEditorPanel } from '../panel/basic/file-editor-panel';

/** 标签 key */
type LabelKey = Parameters<typeof t>[0];

/** 板块宿主配置 */
export interface SectionHostOptions {
    /** Obsidian App */
    app: App;
    /** 当前任务（每次渲染时调用，返回仓库中的最新对象） */
    getTask: () => PrototypeTask | undefined;
    /** 全量任务（任务文件目录按任务树绑定） */
    getTasks?: () => PrototypeTask[];
    /** 项目库根目录（空表示未配置） */
    getTaskLibraryRoot?: () => string;
    /** 持久化出口 */
    save: () => Promise<void>;
    /** 浮层容器（文件编辑面板使用） */
    container?: HTMLElement;
    /** 板块变化后的回调（用于刷新面板中的数量等） */
    onChanged?: () => void;
    /** 只展示这些板块类型（默认全部） */
    types?: SectionType[];
}

/** 任务板块宿主 */
export class SectionHost {
    private readonly options: SectionHostOptions;
    /** 渲染容器（重绘时复用） */
    private hostEl: HTMLElement | null = null;
    /** 当前选中的内容板块选项卡 */
    private activeType: SectionType | null = null;
    /** 是否正在显示配置页（齿轮按钮） */
    private showConfig = false;
    /** 日目标板块当前查看的周键 */
    private weekKey = getCurrentWeekKey();
    /** 清单排序方式 */
    private checklistSort: 'created' | 'due' = 'created';
    /** 清单中选中的条目 id（用于设置截止时间） */
    private selectedChecklistId: string | null = null;
    /** 任务文件是否处于新建输入状态 */
    private fileCreateMode = false;
    /** 文件编辑面板 */
    private fileEditorPanel: FileEditorPanel | null = null;

    constructor(options: SectionHostOptions) {
        this.options = options;
    }

    /** 切换任务时重置临时状态（首次渲染落在第一个可见板块） */
    reset(): void {
        this.activeType = null;
        this.showConfig = false;
        this.weekKey = getCurrentWeekKey();
        this.checklistSort = 'created';
        this.selectedChecklistId = null;
        this.fileCreateMode = false;
    }

    /** 销毁（关闭文件编辑面板） */
    destroy(): void {
        this.fileEditorPanel?.destroy();
        this.fileEditorPanel = null;
    }

    /** 渲染宿主；传入 container 时以其为新容器，否则复用上次容器 */
    render(container?: HTMLElement): void {
        if (container) this.hostEl = container;
        const host = this.hostEl;
        if (!host) return;
        host.empty();
        host.addClass('task-section-host');

        const task = this.options.getTask();
        if (!task) return;

        const types = this.visibleTypes(task);
        // 当前选项卡因显示设置或内容变化被隐藏时回到默认视图
        if (this.activeType && !types.includes(this.activeType)) this.activeType = null;
        if (!this.showConfig && !this.activeType) this.activeType = types[0] ?? null;
        // 没有可显示的板块时，配置页作为兜底视图
        if (!this.activeType) this.showConfig = true;

        this.renderTabs(host, task, types);
        const body = host.createDiv({ cls: 'task-section-tab-body' });
        if (this.showConfig || !this.activeType) this.renderConfig(body, task);
        else this.renderBody(body, task, this.activeType);
    }

    /** 本面板展示的板块类型 */
    private availableTypes(): SectionType[] {
        const all = Object.keys(SECTION_REGISTRY) as SectionType[];
        const allowed = this.options.types;
        return allowed ? all.filter((type) => allowed.includes(type)) : all;
    }

    /** 可见的板块类型：先按 task.sections 顺序，再补未创建但设为「开启」的类型 */
    private visibleTypes(task: PrototypeTask): SectionType[] {
        const available = this.availableTypes();
        const ordered = [...(task.sections ?? []).map((section) => section.type), ...available];
        const seen = new Set<SectionType>();
        const types: SectionType[] = [];
        for (const type of ordered) {
            if (!available.includes(type) || seen.has(type)) continue;
            seen.add(type);
            if (this.isVisible(task, type)) types.push(type);
        }
        return types;
    }

    /** 是否显示该类型选项卡：开启始终显示，自动仅在存在内容时显示 */
    private isVisible(task: PrototypeTask, type: SectionType): boolean {
        const mode = getSectionDisplay(task, type);
        if (mode === 'on') return true;
        if (mode === 'off') return false;
        const section = getSection(task, type);
        return !!section && !SECTION_REGISTRY[type].isEmpty(section.payload);
    }

    /* ---------------- 选项卡 ---------------- */

    /** 选项卡栏：内容板块（单行横向滚动）+ 右侧齿轮按钮打开配置页 */
    private renderTabs(parent: HTMLElement, task: PrototypeTask, types: SectionType[]): void {
        const bar = parent.createDiv({ cls: 'task-section-tabs-bar' });
        const tabs = bar.createDiv({ cls: 'task-section-tabs' });
        for (const type of types) {
            const def = SECTION_REGISTRY[type];
            const tab = tabs.createEl('button', { cls: 'task-section-tab', attr: { type: 'button' } });
            tab.toggleClass('is-active', !this.showConfig && this.activeType === type);
            setIcon(tab.createSpan({ cls: 'task-section-tab-icon' }), def.icon);
            tab.createSpan({ cls: 'task-section-tab-label', text: t(def.labelKey as LabelKey) });
            const count = this.sectionCountText(task, type);
            if (count) tab.createSpan({ cls: 'task-section-tab-count', text: count });
            tab.addEventListener('click', () => this.activateTab(type));
        }

        // 齿轮：打开 / 关闭配置页
        const configBtn = bar.createEl('button', {
            cls: 'task-section-tabs-config',
            attr: { type: 'button', 'aria-label': t('panel.sectionConfig') },
        });
        configBtn.title = t('panel.sectionConfig');
        configBtn.toggleClass('is-active', this.showConfig);
        setIcon(configBtn, 'settings-2');
        configBtn.addEventListener('click', () => this.activateConfig());
    }

    /** 切换内容板块选项卡 */
    private activateTab(type: SectionType): void {
        if (!this.showConfig && this.activeType === type) return;
        this.showConfig = false;
        this.activeType = type;
        this.render();
    }

    /** 打开配置页 */
    private activateConfig(): void {
        if (this.showConfig) return;
        this.showConfig = true;
        this.render();
    }

    /* ---------------- 配置（显示设置） ---------------- */

    /** 配置页：每个板块类型一行，右侧为「自动 / 开启 / 关闭」三段按钮 */
    private renderConfig(body: HTMLElement, task: PrototypeTask): void {
        const wrap = body.createDiv({ cls: 'task-section-config' });
        wrap.createDiv({ cls: 'task-section-config-hint', text: t('panel.sectionConfigHint') });

        const modes: { value: SectionDisplayMode; labelKey: LabelKey }[] = [
            { value: 'auto', labelKey: 'panel.sectionDisplayAuto' },
            { value: 'on', labelKey: 'panel.sectionDisplayOn' },
            { value: 'off', labelKey: 'panel.sectionDisplayOff' },
        ];
        for (const type of this.availableTypes()) {
            const def = SECTION_REGISTRY[type];
            const row = wrap.createDiv({ cls: 'task-section-config-row' });
            setIcon(row.createSpan({ cls: 'task-section-config-icon' }), def.icon);
            row.createSpan({ cls: 'task-section-config-label', text: t(def.labelKey as LabelKey) });

            const segment = row.createDiv({ cls: 'task-section-config-segment' });
            const current = getSectionDisplay(task, type);
            for (const mode of modes) {
                const btn = segment.createEl('button', {
                    cls: 'task-section-config-segment-btn',
                    text: t(mode.labelKey),
                    attr: { type: 'button' },
                });
                btn.toggleClass('is-active', current === mode.value);
                btn.addEventListener('click', () => {
                    if (getSectionDisplay(task, type) === mode.value) return;
                    setSectionDisplay(task, type, mode.value);
                    void this.commit(task);
                });
            }
        }
    }

    /** 板块标题后的数量（清单为未完成数，任务文件为文件数） */
    private sectionCountText(task: PrototypeTask, type: SectionType): string {
        if (!hasSection(task, type)) return '';
        if (type === 'checklist') {
            return `(${getChecklist(task).filter((item) => !item.done).length})`;
        }
        if (type === 'files') {
            return `(${listTaskFiles(this.options.app, getTaskFileDir(task)).length})`;
        }
        if (type === 'stageGoals') {
            const entries = getSection(task, 'stageGoals')?.payload.entries ?? {};
            const pending = Object.values(entries).reduce(
                (sum, list) => sum + list.filter((item) => !item.done).length,
                0,
            );
            return pending > 0 ? `(${pending})` : '';
        }
        return '';
    }

    /** 按类型渲染板块内容 */
    private renderBody(body: HTMLElement, task: PrototypeTask, type: SectionType): void {
        switch (type) {
            case 'checklist':
                this.renderChecklist(body, task);
                return;
            case 'dayGoals':
                this.renderDayGoals(body, task);
                return;
            case 'weekNote':
                this.renderWeekNote(body, task);
                return;
            case 'stageGoals':
                this.renderStageGoals(body, task);
                return;
            case 'goals':
                this.renderGoals(body, task);
                return;
            case 'files':
                this.renderFiles(body, task);
                return;
            case 'habit':
                this.renderHabit(body, task);
        }
    }

    /** 保存并重绘（首次写入非空内容时访问器已创建板块，这里落库） */
    private async commit(task: PrototypeTask): Promise<void> {
        await this.options.save();
        this.options.onChanged?.();
        this.render();
    }

    /* ---------------- 清单 ---------------- */

    private renderChecklist(body: HTMLElement, task: PrototypeTask): void {
        const wrap = body.createDiv({ cls: 'task-section-checklist' });

        // 工具行：排序方式 / 设置截止时间（需先选中条目）
        const toolbar = wrap.createDiv({ cls: 'task-section-toolbar' });
        const sortBtn = toolbar.createEl('button', {
            cls: 'task-section-tool-btn',
            text: this.checklistSort === 'due' ? t('panel.checklistSortDue') : t('panel.checklistSortCreated'),
            attr: { type: 'button' },
        });
        sortBtn.addEventListener('click', () => {
            this.checklistSort = this.checklistSort === 'due' ? 'created' : 'due';
            this.render();
        });
        const dueBtn = toolbar.createEl('button', {
            cls: 'task-section-tool-btn',
            text: t('panel.checklistSetDue'),
            attr: { type: 'button' },
        });
        dueBtn.disabled = !this.selectedChecklistId;
        dueBtn.addEventListener('click', () => this.openDueEditor(wrap, task));

        // 输入行
        const inputRow = wrap.createDiv({ cls: 'task-section-input-row' });
        const input = inputRow.createEl('input', {
            cls: 'task-section-input',
            attr: { type: 'text', placeholder: t('panel.checklistAddPlaceholder') },
        });
        const addBtn = inputRow.createEl('button', {
            cls: 'task-section-add-btn',
            text: t('common.add'),
            attr: { type: 'button' },
        });
        const submit = (): void => {
            const text = input.value.trim();
            if (!text) return;
            const entry: ChecklistItem = {
                id: `checklist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                text,
                createdAt: Date.now(),
            };
            appendChecklist(task, entry);
            input.value = '';
            void this.commit(task);
        };
        addBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') {
                evt.preventDefault();
                submit();
            }
        });

        const entries = getChecklist(task);
        if (entries.length === 0) {
            wrap.createDiv({ cls: 'task-section-empty', text: t('panel.checklistEmpty') });
            return;
        }

        // 未完成在前、已完成沉底；未完成可按截止时间排序（无截止时间排最后）
        const pending = entries.filter((entry) => !entry.done);
        if (this.checklistSort === 'due') {
            pending.sort((a, b) => {
                const aDue = a.dueDate ? new Date(`${a.dueDate}T00:00:00`).getTime() : Number.POSITIVE_INFINITY;
                const bDue = b.dueDate ? new Date(`${b.dueDate}T00:00:00`).getTime() : Number.POSITIVE_INFINITY;
                if (aDue !== bDue) return aDue - bDue;
                return a.createdAt - b.createdAt;
            });
        }

        const list = wrap.createDiv({ cls: 'task-section-list' });
        for (const entry of [...pending, ...entries.filter((item) => item.done)]) {
            const row = list.createDiv({ cls: 'task-section-item' });
            row.toggleClass('is-done', entry.done === true);
            row.toggleClass('is-selected', this.selectedChecklistId === entry.id);
            row.addEventListener('click', () => {
                this.selectedChecklistId = this.selectedChecklistId === entry.id ? null : entry.id;
                this.render();
            });

            const checkbox = row.createEl('input', { cls: 'task-section-check', attr: { type: 'checkbox' } });
            checkbox.checked = entry.done === true;
            checkbox.addEventListener('click', (evt) => evt.stopPropagation());
            checkbox.addEventListener('change', () => {
                entry.done = checkbox.checked;
                if (checkbox.checked) entry.completedAt = Date.now();
                else delete entry.completedAt;
                void this.commit(task);
            });

            const main = row.createDiv({ cls: 'task-section-item-main' });
            main.createSpan({ cls: 'task-section-item-text', text: entry.text });
            const meta = main.createDiv({ cls: 'task-section-item-meta' });
            meta.createSpan({ text: t(entry.done ? 'panel.checklistDone' : 'panel.checklistPending') });
            if (entry.done && entry.completedAt) {
                meta.createSpan({ text: t('panel.checklistCompletedAt', { time: formatCompletedTime(entry.completedAt) }) });
            }
            if (entry.dueDate) this.appendDueTags(meta, entry.dueDate);

            const delBtn = row.createEl('button', {
                cls: 'task-section-item-delete',
                text: '×',
                attr: { type: 'button', 'aria-label': t('common.delete') },
            });
            delBtn.addEventListener('click', (evt) => {
                evt.stopPropagation();
                setChecklist(task, getChecklist(task).filter((item) => item.id !== entry.id));
                if (this.selectedChecklistId === entry.id) this.selectedChecklistId = null;
                void this.commit(task);
            });
        }
    }

    /** 在状态后追加截止日期 / 剩余天数 / 已过期标签 */
    private appendDueTags(meta: HTMLElement, dueDate: string): void {
        const due = new Date(`${dueDate}T00:00:00`);
        if (Number.isNaN(due.getTime())) return;
        const label = getLang() === 'zh'
            ? `${due.getMonth() + 1}月${due.getDate()}日`
            : `${due.getMonth() + 1}/${due.getDate()}`;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const days = Math.round((due.getTime() - today.getTime()) / 86400000);
        if (days < 0) {
            meta.createSpan({ cls: 'is-overdue', text: t('panel.checklistOverdue') });
        } else {
            meta.createSpan({
                text: days === 0 ? t('panel.checklistDueToday') : t('panel.checklistDueInDays', { days }),
            });
        }
        meta.createSpan({ text: t('panel.checklistDueDateTag', { date: label }) });
    }

    /** 选中条目的截止日期编辑行：日期输入框 + 确定 / 清除 / 取消 */
    private openDueEditor(wrap: HTMLElement, task: PrototypeTask): void {
        const entry = getChecklist(task).find((item) => item.id === this.selectedChecklistId);
        if (!entry) return;
        wrap.querySelector('.task-section-due-row')?.remove();
        const editor = wrap.createDiv({ cls: 'task-section-due-row' });
        const input = editor.createEl('input', { cls: 'task-section-due-input', attr: { type: 'date' } });
        input.value = entry.dueDate ?? '';
        const saveEntry = (): void => {
            if (input.value) entry.dueDate = input.value;
            else delete entry.dueDate;
            void this.commit(task);
        };
        editor.createEl('button', {
            cls: 'task-section-tool-btn',
            text: t('panel.checklistDueSave'),
            attr: { type: 'button' },
        }).addEventListener('click', saveEntry);
        editor.createEl('button', {
            cls: 'task-section-tool-btn',
            text: t('panel.checklistDueClear'),
            attr: { type: 'button' },
        }).addEventListener('click', () => {
            input.value = '';
            saveEntry();
        });
        editor.createEl('button', {
            cls: 'task-section-tool-btn',
            text: t('panel.checklistDueCancel'),
            attr: { type: 'button' },
        }).addEventListener('click', () => editor.remove());
        wrap.insertBefore(editor, wrap.querySelector('.task-section-input-row'));
        input.focus();
    }

    /* ---------------- 日目标 ---------------- */

    /** 「一周目标」：顶部周切换 + 周一到周日 7 个方框 */
    private renderDayGoals(body: HTMLElement, task: PrototypeTask): void {
        const wrap = body.createDiv({ cls: 'task-week-goal' });

        // 第一行：周切换按钮（上一周 / 周数 + 日期范围 / 下一周）
        const nav = wrap.createDiv({ cls: 'task-week-goal-nav' });
        const prevBtn = nav.createEl('button', {
            cls: 'task-week-goal-nav-btn',
            attr: { type: 'button', 'aria-label': t('panel.weekGoalPrevWeek') },
        });
        setIcon(prevBtn, 'chevron-left');
        prevBtn.addEventListener('click', () => {
            this.weekKey = shiftWeekKey(this.weekKey, -1);
            this.render();
        });

        const { week } = parseWeekKey(this.weekKey);
        const label = nav.createDiv({ cls: 'task-week-goal-nav-label' });
        label.createSpan({ cls: 'task-week-goal-nav-week', text: `W${String(week).padStart(2, '0')}` });
        const mondayKey = makeDayKeyFromWeek(this.weekKey, 1);
        const sundayKey = makeDayKeyFromWeek(this.weekKey, 7);
        label.createSpan({
            cls: 'task-week-goal-nav-range',
            text: `${Number(mondayKey.slice(5, 7))}/${Number(mondayKey.slice(8, 10))} - ${Number(sundayKey.slice(5, 7))}/${Number(sundayKey.slice(8, 10))}`,
        });
        if (this.weekKey === getCurrentWeekKey()) label.addClass('is-current');

        const nextBtn = nav.createEl('button', {
            cls: 'task-week-goal-nav-btn',
            attr: { type: 'button', 'aria-label': t('panel.weekGoalNextWeek') },
        });
        setIcon(nextBtn, 'chevron-right');
        nextBtn.addEventListener('click', () => {
            this.weekKey = shiftWeekKey(this.weekKey, 1);
            this.render();
        });

        // 周一到周日：每天一个方框
        const list = wrap.createDiv({ cls: 'task-week-goal-list' });
        const weekdayKeys: LabelKey[] = [
            'week.monday',
            'week.tuesday',
            'week.wednesday',
            'week.thursday',
            'week.friday',
            'week.saturday',
            'week.sunday',
        ];
        for (let day = 1; day <= 7; day += 1) {
            const dayKey = makeDayKeyFromWeek(this.weekKey, day);
            this.renderDayGoalBox(list, task, dayKey, t(weekdayKeys[day - 1]));
        }
    }

    /** 单日方框：左侧星期标题，右侧工具行 + 分割线 + 日目标列表 */
    private renderDayGoalBox(parentEl: HTMLElement, task: PrototypeTask, dayKey: string, weekdayLabel: string): void {
        const box = parentEl.createDiv({ cls: 'task-week-goal-day' });
        if (dayKey === getCurrentDayKey()) box.addClass('is-today');

        const head = box.createDiv({ cls: 'task-week-goal-day-head' });
        head.createSpan({ cls: 'task-week-goal-day-name', text: weekdayLabel });
        head.createSpan({
            cls: 'task-week-goal-day-date',
            text: `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`,
        });

        const body = box.createDiv({ cls: 'task-week-goal-day-body' });
        const toolbar = body.createDiv({ cls: 'task-week-goal-day-toolbar' });
        toolbar.createSpan({ cls: 'task-week-goal-day-toolbar-label', text: t('panel.weekGoalUnplanned') });
        const addBtn = toolbar.createEl('button', {
            cls: 'task-week-goal-day-add',
            attr: { type: 'button', 'aria-label': t('common.add') },
        });
        setIcon(addBtn, 'plus');
        addBtn.addEventListener('click', () => this.startAddDayGoal(body, task, dayKey));

        body.createDiv({ cls: 'task-week-goal-day-divider' });

        const list = body.createDiv({ cls: 'task-week-goal-day-list' });
        const entries = getDayGoalEntries(task, dayKey);
        if (entries.length === 0) {
            list.createDiv({ cls: 'task-week-goal-day-empty', text: t('panel.weekGoalEmpty') });
        }
        for (const entry of entries) {
            const row = list.createDiv({ cls: 'task-week-goal-item' });
            row.toggleClass('is-done', entry.done === true);
            const checkbox = row.createEl('input', { cls: 'task-week-goal-item-check', attr: { type: 'checkbox' } });
            checkbox.checked = entry.done === true;
            checkbox.addEventListener('change', () => {
                entry.done = checkbox.checked;
                if (!checkbox.checked) delete entry.done;
                void this.commit(task);
            });
            row.createSpan({ cls: 'task-week-goal-item-text', text: entry.text });
            const delBtn = row.createEl('button', {
                cls: 'task-week-goal-item-delete',
                attr: { type: 'button', 'aria-label': t('common.delete') },
            });
            setIcon(delBtn, 'x');
            delBtn.addEventListener('click', () => {
                setDayGoalEntries(task, dayKey, getDayGoalEntries(task, dayKey).filter((item) => item.id !== entry.id));
                void this.commit(task);
            });
        }
    }

    /** 在列表末尾插入输入行，回车 / 失焦提交，Esc 取消 */
    private startAddDayGoal(body: HTMLElement, task: PrototypeTask, dayKey: string): void {
        const existing = body.querySelector<HTMLInputElement>('.task-week-goal-add-input');
        if (existing) {
            existing.focus();
            return;
        }
        const list = body.querySelector<HTMLElement>('.task-week-goal-day-list');
        if (!list) return;
        list.querySelector('.task-week-goal-day-empty')?.remove();

        const inputRow = list.createDiv({ cls: 'task-week-goal-add-row' });
        const input = inputRow.createEl('input', {
            cls: 'task-week-goal-add-input',
            attr: { type: 'text', placeholder: t('panel.weekGoalAddPlaceholder') },
        });
        input.focus();

        let finished = false;
        const finish = (commit: boolean): void => {
            if (finished) return;
            finished = true;
            const text = input.value.trim();
            inputRow.remove();
            if (!commit || !text) {
                this.render();
                return;
            }
            setDayGoalEntries(task, dayKey, [
                ...getDayGoalEntries(task, dayKey),
                { id: `dgoal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text, createdAt: Date.now() },
            ]);
            void this.commit(task);
        };
        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') {
                evt.preventDefault();
                finish(true);
            } else if (evt.key === 'Escape') {
                evt.preventDefault();
                finish(false);
            }
        });
        input.addEventListener('blur', () => finish(true));
    }

    /* ---------------- 本周描述 ---------------- */

    private renderWeekNote(body: HTMLElement, task: PrototypeTask): void {
        const weekKey = getCurrentWeekKey();
        const { week } = parseWeekKey(weekKey);
        const wrap = body.createDiv({ cls: 'task-section-weeknote' });
        wrap.createDiv({ cls: 'task-section-weeknote-head', text: `W${String(week).padStart(2, '0')}` });
        const textarea = wrap.createEl('textarea', {
            cls: 'task-section-weeknote-textarea',
            attr: { placeholder: t('panel.planWeekDescriptionPlaceholder') },
        });
        textarea.value = getWeekNote(task, weekKey);
        textarea.addEventListener('change', () => {
            const next = textarea.value.trim();
            if (next === getWeekNote(task, weekKey)) return;
            setWeekNote(task, weekKey, textarea.value);
            void this.commit(task);
        });
    }

    /* ---------------- 阶段目标 ---------------- */

    /** 阶段目标：按截止周分组展示（编辑入口在「板块 → 目标」面板的周格悬浮面板） */
    private renderStageGoals(body: HTMLElement, task: PrototypeTask): void {
        const wrap = body.createDiv({ cls: 'task-section-weekgoals' });
        const entries = getSection(task, 'stageGoals')?.payload.entries ?? {};
        const weekKeys = Object.keys(entries).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        if (weekKeys.length === 0) {
            wrap.createDiv({ cls: 'task-section-empty', text: t('panel.sectionStageGoalsEmpty') });
            return;
        }
        for (const weekKey of weekKeys) {
            const group = wrap.createDiv({ cls: 'task-section-weekgoals-group' });
            const matched = weekKey.match(/^(\d{4})-W(\d{2})$/);
            group.createDiv({
                cls: 'task-section-weekgoals-title',
                text: matched ? `${matched[1]} 第${Number(matched[2])}周` : weekKey,
            });
            const list = group.createDiv({ cls: 'task-section-list' });
            for (const goal of entries[weekKey]) {
                const row = list.createDiv({ cls: 'task-section-item' });
                row.toggleClass('is-done', goal.done === true);
                const checkbox = row.createEl('input', { cls: 'task-section-check', attr: { type: 'checkbox' } });
                checkbox.checked = goal.done === true;
                checkbox.addEventListener('change', () => {
                    const next = getStageGoalEntries(task, weekKey).map((item) =>
                        item.id === goal.id ? { ...item, ...(checkbox.checked ? { done: true } : { done: undefined }) } : item,
                    );
                    // done: undefined 会在保存时被丢弃
                    setStageGoalEntries(task, weekKey, next.map((item) => {
                        if (item.done === undefined) {
                            const { done: _done, ...rest } = item;
                            return rest;
                        }
                        return item;
                    }));
                    void this.commit(task);
                });
                const main = row.createDiv({ cls: 'task-section-item-main' });
                main.createSpan({ cls: 'task-section-item-text', text: goal.text });
                const delBtn = row.createEl('button', {
                    cls: 'task-section-item-delete',
                    text: '×',
                    attr: { type: 'button', 'aria-label': t('common.delete') },
                });
                delBtn.addEventListener('click', () => {
                    setStageGoalEntries(
                        task,
                        weekKey,
                        getStageGoalEntries(task, weekKey).filter((item) => item.id !== goal.id),
                    );
                    void this.commit(task);
                });
            }
        }
    }

    /* ---------------- 目标 ---------------- */

    private renderGoals(body: HTMLElement, task: PrototypeTask): void {
        const wrap = body.createDiv({ cls: 'task-section-goals' });
        const goals = getTaskGoals(task);

        const inputRow = wrap.createDiv({ cls: 'task-section-input-row' });
        const input = inputRow.createEl('input', {
            cls: 'task-section-input',
            attr: { type: 'text', placeholder: t('panel.planAnnualAddGoal') },
        });
        const addBtn = inputRow.createEl('button', {
            cls: 'task-section-add-btn',
            text: t('common.add'),
            attr: { type: 'button' },
        });
        const submit = (): void => {
            const text = input.value.trim();
            if (!text) return;
            setTaskGoals(task, [
                ...getTaskGoals(task),
                { id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text, createdAt: Date.now() },
            ]);
            input.value = '';
            void this.commit(task);
        };
        addBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') {
                evt.preventDefault();
                submit();
            }
        });

        if (goals.length === 0) {
            wrap.createDiv({ cls: 'task-section-empty', text: t('panel.planAnnualNoGoal') });
            return;
        }
        const list = wrap.createDiv({ cls: 'task-section-list' });
        for (const goal of goals) {
            const row = list.createDiv({ cls: 'task-section-item' });
            row.toggleClass('is-done', goal.done === true);
            const checkbox = row.createEl('input', { cls: 'task-section-check', attr: { type: 'checkbox' } });
            checkbox.checked = goal.done === true;
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) goal.done = true;
                else delete goal.done;
                void this.commit(task);
            });
            const main = row.createDiv({ cls: 'task-section-item-main' });
            main.createSpan({ cls: 'task-section-item-text', text: goal.text });
            const delBtn = row.createEl('button', {
                cls: 'task-section-item-delete',
                text: '×',
                attr: { type: 'button', 'aria-label': t('common.delete') },
            });
            delBtn.addEventListener('click', () => {
                setTaskGoals(task, getTaskGoals(task).filter((item) => item.id !== goal.id));
                void this.commit(task);
            });
        }
    }

    /* ---------------- 任务文件 ---------------- */

    private renderFiles(body: HTMLElement, task: PrototypeTask): void {
        const wrap = body.createDiv({ cls: 'task-detail-files' });
        const card = wrap.createDiv({ cls: 'task-detail-files-card' });
        const toolbar = card.createDiv({ cls: 'task-detail-files-toolbar' });
        const dir = getTaskFileDir(task);

        // 启用时间戳（无目录时不可用，避免生成只有开关的空板块）
        const switchWrap = toolbar.createDiv({ cls: 'task-detail-files-switch' });
        const checkbox = switchWrap.createEl('input', { cls: 'task-detail-files-checkbox', attr: { type: 'checkbox' } });
        checkbox.checked = getTaskFileTimestamp(task);
        checkbox.disabled = !dir;
        checkbox.addEventListener('change', () => {
            setTaskFileTimestamp(task, checkbox.checked);
            void this.commit(task);
        });
        switchWrap.createSpan({ cls: 'task-detail-files-switch-label', text: t('panel.fileTimestamp') });

        // 文件夹：目录由任务树自动绑定，点击在 Obsidian 文件浏览器中定位
        const dirBtn = toolbar.createEl('button', { cls: 'task-detail-files-btn', attr: { type: 'button' } });
        setIcon(dirBtn.createSpan({ cls: 'task-detail-files-btn-icon' }), 'folder');
        dirBtn.createSpan({ cls: 'task-detail-files-btn-text', text: t('panel.fileFolder') });
        if (dir) dirBtn.title = dir;
        dirBtn.addEventListener('click', () => void this.openTaskFolder(task));

        // 新建文件
        const addBtn = toolbar.createEl('button', { cls: 'task-detail-files-btn', attr: { type: 'button' } });
        setIcon(addBtn.createSpan({ cls: 'task-detail-files-btn-icon' }), 'plus');
        addBtn.createSpan({ cls: 'task-detail-files-btn-text', text: t('panel.fileAdd') });
        addBtn.addEventListener('click', () => void this.startCreateFile(task));

        if (this.fileCreateMode) this.renderFileCreateRow(card, task);

        // 文件列表
        const listCard = wrap.createDiv({ cls: 'task-detail-files-card task-detail-files-list-card' });
        if (!dir) {
            listCard.createDiv({ cls: 'task-section-empty', text: t('panel.taskLibraryRequired') });
            return;
        }
        const files = listTaskFiles(this.options.app, dir);
        if (files.length === 0) {
            listCard.createDiv({ cls: 'task-section-empty', text: t('panel.fileEmpty') });
            return;
        }
        for (const file of files) {
            const row = listCard.createDiv({ cls: 'task-detail-file-row' });
            setIcon(row.createSpan({ cls: 'task-detail-file-icon' }), 'file-text');
            const nameEl = row.createSpan({ cls: 'task-detail-file-name', text: relativeToDir(file.path, dir) });
            nameEl.title = file.path;
            row.createSpan({ cls: 'task-detail-file-time', text: formatDateTime(file.stat.mtime) });
            row.addEventListener('click', () => this.openTaskFile(file));
        }
    }

    /** 新建文件输入行（先确保目录存在） */
    private renderFileCreateRow(card: HTMLElement, task: PrototypeTask): void {
        const createRow = card.createDiv({ cls: 'task-detail-files-create' });
        const nameInput = createRow.createEl('input', {
            cls: 'task-detail-files-create-input',
            attr: { type: 'text', placeholder: t('panel.fileCreatePlaceholder') },
        });
        const confirmBtn = createRow.createEl('button', { text: t('panel.fileCreate'), attr: { type: 'button' } });
        const cancelBtn = createRow.createEl('button', { text: t('common.cancel'), attr: { type: 'button' } });
        const submit = (): void => {
            const name = nameInput.value.trim();
            if (!name) return;
            void this.createTaskFile(task, name);
        };
        confirmBtn.addEventListener('click', submit);
        nameInput.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') submit();
            if (evt.key === 'Escape') {
                this.fileCreateMode = false;
                this.render();
            }
        });
        cancelBtn.addEventListener('click', () => {
            this.fileCreateMode = false;
            this.render();
        });
        nameInput.focus();
    }

    /** 按项目库根目录 + 任务树确保任务文件目录（未配置项目库时返回 null） */
    private async ensureFilesDir(task: PrototypeTask): Promise<string | null> {
        const root = this.options.getTaskLibraryRoot?.() ?? '';
        if (!root) {
            new Notice(t('panel.taskLibraryRequired'));
            return null;
        }
        const tasks = this.options.getTasks?.() ?? [task];
        const result = await ensureTaskFileDir(this.options.app, root, tasks, task);
        if (result.changed) await this.options.save();
        return result.dir;
    }

    /** 点击「文件夹」：确保目录存在并在 Obsidian 文件浏览器中定位 */
    private async openTaskFolder(task: PrototypeTask): Promise<void> {
        const dir = await this.ensureFilesDir(task);
        if (!dir) return;
        const folder = this.options.app.vault.getAbstractFileByPath(dir);
        if (folder instanceof TFolder) revealFolderInExplorer(this.options.app, folder);
        this.render();
    }

    /** 点击「添加」：确保目录存在后展开新建输入行 */
    private async startCreateFile(task: PrototypeTask): Promise<void> {
        const dir = await this.ensureFilesDir(task);
        if (!dir) return;
        this.fileCreateMode = true;
        this.render();
    }

    /** 在任务文件目录下新建 Markdown 文件（启用时间戳时加前缀），并打开内置编辑面板 */
    private async createTaskFile(task: PrototypeTask, name: string): Promise<void> {
        const dir = await this.ensureFilesDir(task);
        if (!dir) return;
        const fileName = buildTaskFileName(name, getTaskFileTimestamp(task));
        if (!fileName) return;
        try {
            const file = await this.options.app.vault.create(`${dir}/${fileName}`, '');
            this.fileCreateMode = false;
            this.render();
            this.openTaskFile(file);
        } catch {
            new Notice(t('panel.fileCreateFailed'));
        }
    }

    /** 打开任务文件：Markdown 使用内置编辑面板，其它类型交给 Obsidian 默认打开方式 */
    private openTaskFile(file: TFile): void {
        if (file.extension !== 'md') {
            void this.options.app.workspace.getLeaf(false).openFile(file);
            return;
        }
        this.fileEditorPanel?.destroy();
        this.fileEditorPanel = new FileEditorPanel({
            app: this.options.app,
            file,
            container: this.options.container,
            onClose: () => {
                if (this.hostEl?.isConnected) this.render();
            },
        });
        this.fileEditorPanel.open();
    }

    /* ---------------- 习惯 ---------------- */

    private renderHabit(body: HTMLElement, task: PrototypeTask): void {
        const saved = getTaskHabit(task);
        const habit = saved ?? { enabled: false, time: '09:00', weekdays: [1, 2, 3, 4, 5, 6, 7] };
        const wrap = body.createDiv({ cls: 'task-section-habit' });

        const enableRow = wrap.createDiv({ cls: 'task-section-habit-row' });
        const checkbox = enableRow.createEl('input', { cls: 'task-section-check', attr: { type: 'checkbox' } });
        checkbox.checked = habit.enabled;
        enableRow.createSpan({ text: t('panel.habitEnable') });
        checkbox.addEventListener('change', () => {
            setTaskHabit(task, { enabled: checkbox.checked, time: habit.time, weekdays: [...habit.weekdays] });
            void this.commit(task);
        });

        const timeRow = wrap.createDiv({ cls: 'task-section-habit-row' });
        timeRow.createSpan({ text: t('panel.habitTime') });
        const timeInput = timeRow.createEl('input', { cls: 'task-section-time-input', attr: { type: 'time' } });
        timeInput.value = habit.time;
        timeInput.addEventListener('change', () => {
            setTaskHabit(task, { enabled: habit.enabled, time: timeInput.value || '09:00', weekdays: [...habit.weekdays] });
            void this.commit(task);
        });

        const weekdayRow = wrap.createDiv({ cls: 'task-section-habit-weekdays' });
        const weekdays = getWeekDays();
        for (let day = 1; day <= 7; day += 1) {
            const btn = weekdayRow.createEl('button', {
                cls: 'task-section-weekday',
                text: weekdays[day - 1],
                attr: { type: 'button' },
            });
            btn.toggleClass('is-active', habit.weekdays.includes(day));
            btn.addEventListener('click', () => {
                const next = habit.weekdays.includes(day)
                    ? habit.weekdays.filter((item) => item !== day)
                    : [...habit.weekdays, day].sort((a, b) => a - b);
                setTaskHabit(task, { enabled: habit.enabled, time: habit.time, weekdays: next });
                void this.commit(task);
            });
        }
    }
}

/** 完成时间格式化为 MM-DD HH:MM */
function formatCompletedTime(ts: number): string {
    const d = new Date(ts);
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mo}-${da} ${h}:${mi}`;
}

/** 时间戳格式化为 YYYY-MM-DD HH:MM */
function formatDateTime(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${da} ${h}:${mi}`;
}
