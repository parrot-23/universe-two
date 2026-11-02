// 任务板块信息面板：基于 FloatingPanel 展示单个任务的收集篮子 / 待办改进 / 文件目录。
// 第一行显示任务名称与任务分类；入口为点击「今日任务」卡片中的任务条目。
import { Notice, TFolder, setIcon } from 'obsidian';
import type { App, TFile } from 'obsidian';

import type { ChecklistItem } from '../../../datatypes/domain';
import type { PrototypeTask, TaskDayGoalEntry } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import {
    getCurrentDayKey,
    getCurrentWeekKey,
    makeDayKeyFromWeek,
    parseWeekKey,
    shiftWeekKey,
} from '../../../shared/plan-data';
import { buildTaskFileName, listTaskFiles, relativeToDir } from '../../../shared/task-file';
import { ensureTaskFileDir, revealFolderInExplorer } from '../../../shared/task-library';
import { FileEditorPanel } from '../basic/file-editor-panel';
import type { FloatingPanelOptions } from '../basic/floating-panel';
import { FloatingPanel } from '../basic/floating-panel';

/** 板块 key */
type TaskSectionKey = 'checklist' | 'weekGoal' | 'file';

/** 板块：顺序与文案 */
const TASK_SECTIONS: { key: TaskSectionKey; labelKey: Parameters<typeof t>[0] }[] = [
    { key: 'checklist', labelKey: 'interface.bottomTabChecklist' },
    { key: 'weekGoal', labelKey: 'panel.weekGoalTab' },
    { key: 'file', labelKey: 'interface.bottomTabFile' },
];

/** 任务板块信息面板配置 */
export interface TaskSectionsPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    app: App;
    /** 按 id 读取任务（每次都从仓库读最新数据） */
    getTask: (taskId: string) => PrototypeTask | undefined;
    /** 读取全量任务（按任务树推导任务文件目录） */
    getTasks?: () => PrototypeTask[];
    /** 读取项目库根目录（任务文件目录按任务树自动绑定，空表示未配置） */
    getTaskLibraryRoot?: () => string;
    /** 分类列表（用于第一行显示任务分类） */
    categories: { id: string; label: string; color?: string }[];
    /** 持久化出口（文件目录 / 时间戳开关修改后保存） */
    save: () => Promise<void>;
    /** 点击第一行跳转图标：在任务详情面板中打开该任务 */
    onOpenTaskDetail?: (taskId: string) => void;
}

export class TaskSectionsPanel extends FloatingPanel {
    private readonly sectionsOptions: TaskSectionsPanelOptions;
    /** 当前展示的任务 id */
    private taskId: string | null = null;
    /** 当前板块 */
    private section: TaskSectionKey = 'checklist';
    /** 文件目录是否处于新建文件输入状态 */
    private fileCreateMode = false;
    /** 文件编辑面板（切换文件时销毁重建） */
    private fileEditorPanel: FileEditorPanel | null = null;
    /** 「一周目标」板块当前查看的周键（默认本周） */
    private weekGoalWeekKey: string = getCurrentWeekKey();

    constructor(options: TaskSectionsPanelOptions) {
        super({
            title: t('panel.taskBoardTitle'),
            width: 460,
            closeOnBlur: true,
            // 任务板块面板需要钉住能力：钉住后点击面板外不关闭
            pinnable: true,
            container: options.container,
            onClose: options.onClose,
        });
        this.sectionsOptions = options;
        // 标题栏钉住按钮左侧：跳转到任务详情面板（未提供回调时不显示）
        if (options.onOpenTaskDetail) {
            this.addHeaderAction(
                'square-arrow-up-right',
                t('panel.openTaskDetail'),
                () => {
                    if (this.taskId) this.sectionsOptions.onOpenTaskDetail?.(this.taskId);
                },
                'start',
            );
        }
    }

    /** 打开并展示指定任务 */
    openForTask(taskId: string): void {
        this.taskId = taskId;
        // 默认选中第一个选项卡：清单为空时「任务文件」排在最左，此时直接打开任务文件
        const task = this.sectionsOptions.getTask(taskId);
        this.section = (task?.checklist ?? []).length > 0 ? 'checklist' : 'file';
        this.fileCreateMode = false;
        this.render();
        this.open();
    }

    /** 重绘面板内容 */
    private render(): void {
        const task = this.taskId ? this.sectionsOptions.getTask(this.taskId) : undefined;
        this.setContent((body) => {
            if (!task) {
                body.createDiv({ cls: 'interface-today-empty', text: t('interface.bottomEmpty') });
                return;
            }
            this.renderHead(body, task);
            this.renderSections(body, task);
            this.renderContent(body, task);
        });
        // 文件板块：按任务树惰性确保目录存在，目录有更新时重绘一次
        if (task && this.section === 'file') {
            void this.ensureFilesDir(task).then((changed) => {
                if (changed && this.taskId === task.id) this.render();
            });
        }
    }

    /** 第一行：任务名称 + 任务分类 */
    private renderHead(body: HTMLElement, task: PrototypeTask): void {
        const head = body.createDiv({ cls: 'task-sections-head' });
        head.createDiv({ cls: 'task-sections-name', text: task.name });
        const category = task.categoryId
            ? this.sectionsOptions.categories.find((item) => item.id === task.categoryId)
            : undefined;
        const pill = head.createDiv({ cls: 'task-sections-category' });
        const dot = pill.createSpan({ cls: 'task-sections-category-dot' });
        dot.style.background = category?.color ?? '#888888';
        pill.createSpan({
            cls: 'task-sections-category-label',
            text: category?.label ?? t('defaultCategory.uncategorized'),
        });
    }

    /** 第二行：板块选项卡（清单为空时「任务文件」排到第一位） */
    private renderSections(body: HTMLElement, task: PrototypeTask): void {
        const tabs = body.createDiv({ cls: 'task-sections-tabs' });
        const hasChecklist = (task.checklist ?? []).length > 0;
        const ordered = hasChecklist
            ? TASK_SECTIONS
            : [...TASK_SECTIONS].sort((a, b) => (a.key === 'file' ? -1 : b.key === 'file' ? 1 : 0));
        for (const item of ordered) {
            const button = tabs.createEl('button', {
                cls: 'interface-bottom-tab',
                text: t(item.labelKey),
                attr: { type: 'button' },
            });
            button.toggleClass('is-active', this.section === item.key);
            button.addEventListener('click', () => {
                if (this.section === item.key) return;
                this.section = item.key;
                this.fileCreateMode = false;
                this.render();
            });
        }
    }

    /** 板块内容 */
    private renderContent(body: HTMLElement, task: PrototypeTask): void {
        const content = body.createDiv({ cls: 'task-sections-body' });

        if (this.section === 'checklist') {
            const items = task.checklist ?? [];
            if (items.length === 0) {
                content.createDiv({ cls: 'interface-today-empty', text: t('interface.bottomEmpty') });
                return;
            }
            // 未完成在前、已完成沉底
            const ordered = [
                ...items.filter((item) => !item.done),
                ...items.filter((item) => item.done),
            ];
            for (const item of ordered) this.renderChecklistRow(content, item);
            return;
        }

        if (this.section === 'weekGoal') {
            this.renderWeekGoal(content, task);
            return;
        }

        this.renderFileToolbar(content, task);
        if (this.fileCreateMode) this.renderFileCreateRow(content, task);

        const files = listTaskFiles(this.sectionsOptions.app, task.fileDir);
        if (!task.fileDir) {
            content.createDiv({ cls: 'interface-today-empty', text: t('panel.taskLibraryRequired') });
            return;
        }
        if (files.length === 0) {
            content.createDiv({ cls: 'interface-today-empty', text: t('interface.bottomEmpty') });
            return;
        }
        for (const file of files) {
            // 显示相对绑定目录的路径（含子目录），仅文件名不足以区分同名文件
            const row = this.createItemRow(content, 'file-text', relativeToDir(file.path, task.fileDir));
            row.title = file.path;
            row.addClass('is-clickable');
            row.addEventListener('click', () => this.openTaskFile(file));
        }
    }

    /** 文件目录操作栏：时间戳开关 / 绑定目录 / 添加文件（与任务详情面板的「任务文件」一致） */
    private renderFileToolbar(parentEl: HTMLElement, task: PrototypeTask): void {
        const toolbar = parentEl.createDiv({ cls: 'task-detail-files-toolbar' });

        // 启用时间戳勾选框
        const switchWrap = toolbar.createDiv({ cls: 'task-detail-files-switch' });
        const checkbox = switchWrap.createEl('input', { cls: 'task-detail-files-checkbox' });
        checkbox.type = 'checkbox';
        checkbox.checked = task.fileTimestamp === true;
        checkbox.addEventListener('change', () => {
            task.fileTimestamp = checkbox.checked;
            void this.sectionsOptions.save();
        });
        switchWrap.createSpan({ cls: 'task-detail-files-switch-label', text: t('panel.fileTimestamp') });

        // 文件夹：目录由任务树自动绑定，点击在 Obsidian 文件浏览器中定位
        const dirBtn = toolbar.createEl('button', { cls: 'task-detail-files-btn' });
        setIcon(dirBtn.createSpan({ cls: 'task-detail-files-btn-icon' }), 'folder');
        dirBtn.createSpan({ cls: 'task-detail-files-btn-text', text: t('panel.fileFolder') });
        if (task.fileDir) dirBtn.title = task.fileDir;
        dirBtn.addEventListener('click', () => void this.openTaskFolder(task));

        // 新建文件
        const addBtn = toolbar.createEl('button', { cls: 'task-detail-files-btn' });
        setIcon(addBtn.createSpan({ cls: 'task-detail-files-btn-icon' }), 'plus');
        addBtn.createSpan({ cls: 'task-detail-files-btn-text', text: t('panel.fileAdd') });
        addBtn.addEventListener('click', () => {
            if (!task.fileDir) {
                new Notice(t('panel.taskLibraryRequired'));
                return;
            }
            this.fileCreateMode = true;
            this.render();
        });
    }

    /** 新建文件输入行 */
    private renderFileCreateRow(parentEl: HTMLElement, task: PrototypeTask): void {
        const createRow = parentEl.createDiv({ cls: 'task-detail-files-create' });
        const nameInput = createRow.createEl('input', { cls: 'task-detail-files-create-input' });
        nameInput.type = 'text';
        nameInput.placeholder = t('panel.fileCreatePlaceholder');
        const confirmBtn = createRow.createEl('button', { text: t('panel.fileCreate') });
        const cancelBtn = createRow.createEl('button', { text: t('common.cancel') });
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

    /** 按项目库根目录 + 任务树确保任务文件目录（未配置项目库时返回 false） */
    private async ensureFilesDir(task: PrototypeTask): Promise<boolean> {
        const root = this.sectionsOptions.getTaskLibraryRoot?.() ?? '';
        if (!root) return false;
        const tasks = this.sectionsOptions.getTasks?.() ?? [task];
        const result = await ensureTaskFileDir(this.sectionsOptions.app, root, tasks, task);
        if (result.changed) await this.sectionsOptions.save();
        return result.changed;
    }

    /** 点击「文件夹」：未配置项目库时提示；已配置时确保目录存在并在 Obsidian 文件浏览器中定位 */
    private async openTaskFolder(task: PrototypeTask): Promise<void> {
        const root = this.sectionsOptions.getTaskLibraryRoot?.() ?? '';
        if (!root) {
            new Notice(t('panel.taskLibraryRequired'));
            return;
        }
        await this.ensureFilesDir(task);
        if (!task.fileDir) return;
        const folder = this.sectionsOptions.app.vault.getAbstractFileByPath(task.fileDir);
        if (folder instanceof TFolder) revealFolderInExplorer(this.sectionsOptions.app, folder);
        this.render();
    }

    /** 在自动绑定的任务文件目录下新建 Markdown 文件（启用时间戳时加前缀），并打开内置编辑面板 */
    private async createTaskFile(task: PrototypeTask, name: string): Promise<void> {
        await this.ensureFilesDir(task);
        const dir = task.fileDir;
        if (!dir) {
            new Notice(t('panel.taskLibraryRequired'));
            return;
        }
        const fileName = buildTaskFileName(name, task.fileTimestamp === true);
        if (!fileName) return;
        try {
            const file = await this.sectionsOptions.app.vault.create(`${dir}/${fileName}`, '');
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
            void this.sectionsOptions.app.workspace.getLeaf(false).openFile(file);
            return;
        }
        this.fileEditorPanel?.destroy();
        this.fileEditorPanel = new FileEditorPanel({
            app: this.sectionsOptions.app,
            file,
            container: this.sectionsOptions.container,
            onClose: () => {
                if (this.taskId) this.render();
            },
        });
        this.fileEditorPanel.open();
    }

    /** 「一周目标」板块：顶部周切换 + 周一到周日 7 个方框（左侧星期标题，右侧日目标勾选列表） */
    private renderWeekGoal(container: HTMLElement, task: PrototypeTask): void {
        container.empty();
        const wrap = container.createDiv({ cls: 'task-week-goal' });

        // 第一行：周切换按钮（上一周 / 周数 / 下一周）
        const nav = wrap.createDiv({ cls: 'task-week-goal-nav' });
        const prevBtn = nav.createEl('button', {
            cls: 'task-week-goal-nav-btn',
            attr: { type: 'button', 'aria-label': t('panel.weekGoalPrevWeek') },
        });
        setIcon(prevBtn, 'chevron-left');
        prevBtn.addEventListener('click', () => {
            this.weekGoalWeekKey = shiftWeekKey(this.weekGoalWeekKey, -1);
            this.render();
        });

        const { week } = parseWeekKey(this.weekGoalWeekKey);
        const label = nav.createDiv({ cls: 'task-week-goal-nav-label' });
        label.createSpan({ cls: 'task-week-goal-nav-week', text: `W${String(week).padStart(2, '0')}` });
        const mondayKey = makeDayKeyFromWeek(this.weekGoalWeekKey, 1);
        const sundayKey = makeDayKeyFromWeek(this.weekGoalWeekKey, 7);
        label.createSpan({
            cls: 'task-week-goal-nav-range',
            text: `${Number(mondayKey.slice(5, 7))}/${Number(mondayKey.slice(8, 10))} - ${Number(sundayKey.slice(5, 7))}/${Number(sundayKey.slice(8, 10))}`,
        });
        if (this.weekGoalWeekKey === getCurrentWeekKey()) label.addClass('is-current');

        const nextBtn = nav.createEl('button', {
            cls: 'task-week-goal-nav-btn',
            attr: { type: 'button', 'aria-label': t('panel.weekGoalNextWeek') },
        });
        setIcon(nextBtn, 'chevron-right');
        nextBtn.addEventListener('click', () => {
            this.weekGoalWeekKey = shiftWeekKey(this.weekGoalWeekKey, 1);
            this.render();
        });

        // 周一到周日：每天一个方框
        const list = wrap.createDiv({ cls: 'task-week-goal-list' });
        const weekdayKeys: Parameters<typeof t>[0][] = [
            'week.monday',
            'week.tuesday',
            'week.wednesday',
            'week.thursday',
            'week.friday',
            'week.saturday',
            'week.sunday',
        ];
        for (let day = 1; day <= 7; day += 1) {
            const dayKey = makeDayKeyFromWeek(this.weekGoalWeekKey, day);
            this.renderWeekGoalDay(list, task, dayKey, t(weekdayKeys[day - 1]));
        }
    }

    /** 单日方框：左侧星期标题，右侧工具行（未排布到日计划 + 按钮）+ 分割线 + 日目标列表 */
    private renderWeekGoalDay(
        parentEl: HTMLElement,
        task: PrototypeTask,
        dayKey: string,
        weekdayLabel: string,
    ): void {
        const box = parentEl.createDiv({ cls: 'task-week-goal-day' });
        if (dayKey === getCurrentDayKey()) box.addClass('is-today');

        const head = box.createDiv({ cls: 'task-week-goal-day-head' });
        head.createSpan({ cls: 'task-week-goal-day-name', text: weekdayLabel });
        head.createSpan({
            cls: 'task-week-goal-day-date',
            text: `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`,
        });

        const body = box.createDiv({ cls: 'task-week-goal-day-body' });

        // 顶部工具行：左侧文字「未排布到日计划」，右侧 + 按钮
        const toolbar = body.createDiv({ cls: 'task-week-goal-day-toolbar' });
        toolbar.createSpan({ cls: 'task-week-goal-day-toolbar-label', text: t('panel.weekGoalUnplanned') });
        const addBtn = toolbar.createEl('button', {
            cls: 'task-week-goal-day-add',
            attr: { type: 'button', 'aria-label': t('common.add') },
        });
        setIcon(addBtn, 'plus');
        addBtn.addEventListener('click', () => this.startAddDayGoal(body, task, dayKey));

        // 分割线
        body.createDiv({ cls: 'task-week-goal-day-divider' });

        // 日目标列表
        const list = body.createDiv({ cls: 'task-week-goal-day-list' });
        const entries = task.dayGoals?.[dayKey] ?? [];
        if (entries.length === 0) {
            list.createDiv({ cls: 'task-week-goal-day-empty', text: t('panel.weekGoalEmpty') });
        }
        for (const entry of entries) {
            const row = list.createDiv({ cls: 'task-week-goal-item' });
            row.toggleClass('is-done', entry.done === true);
            const checkbox = row.createEl('input', { cls: 'task-week-goal-item-check' });
            checkbox.type = 'checkbox';
            checkbox.checked = entry.done === true;
            checkbox.addEventListener('change', () => {
                void this.toggleDayGoal(task, dayKey, entry.id, checkbox.checked);
            });
            row.createSpan({ cls: 'task-week-goal-item-text', text: entry.text });
            const delBtn = row.createEl('button', {
                cls: 'task-week-goal-item-delete',
                attr: { type: 'button', 'aria-label': t('common.delete') },
            });
            setIcon(delBtn, 'x');
            delBtn.addEventListener('click', () => void this.removeDayGoal(task, dayKey, entry.id));
        }
    }

    /** 在列表末尾插入一个输入行，回车 / 失焦提交，Esc 取消 */
    private startAddDayGoal(body: HTMLElement, task: PrototypeTask, dayKey: string): void {
        // 已有输入行时不重复聚焦
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
            if (commit && text) void this.addDayGoal(task, dayKey, text);
            else this.render();
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

    /** 新增日目标 */
    private async addDayGoal(task: PrototypeTask, dayKey: string, text: string): Promise<void> {
        const entry: TaskDayGoalEntry = {
            id: `dgoal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text,
            createdAt: Date.now(),
        };
        task.dayGoals = { ...(task.dayGoals ?? {}) };
        task.dayGoals[dayKey] = [...(task.dayGoals[dayKey] ?? []), entry];
        await this.sectionsOptions.save();
        this.render();
    }

    /** 切换日目标完成状态 */
    private async toggleDayGoal(
        task: PrototypeTask,
        dayKey: string,
        entryId: string,
        done: boolean,
    ): Promise<void> {
        const entry = task.dayGoals?.[dayKey]?.find((item) => item.id === entryId);
        if (!entry) return;
        if (done) entry.done = true;
        else delete entry.done;
        await this.sectionsOptions.save();
        this.render();
    }

    /** 删除日目标 */
    private async removeDayGoal(task: PrototypeTask, dayKey: string, entryId: string): Promise<void> {
        const list = task.dayGoals?.[dayKey];
        if (!list) return;
        const next = list.filter((item) => item.id !== entryId);
        if (next.length > 0) task.dayGoals![dayKey] = next;
        else delete task.dayGoals![dayKey];
        await this.sectionsOptions.save();
        this.render();
    }

    /** 条目行：图标 + 文本 */
    private createItemRow(parentEl: HTMLElement, icon: string, text: string): HTMLElement {
        const row = parentEl.createDiv({ cls: 'interface-bottom-item' });
        setIcon(row.createSpan({ cls: 'interface-bottom-item-icon' }), icon);
        row.createSpan({ cls: 'interface-bottom-item-text', text });
        return row;
    }

    /** 清单条目行：勾选框 + 文本，已完成时显示完成时间 */
    private renderChecklistRow(parentEl: HTMLElement, item: ChecklistItem): void {
        const row = parentEl.createDiv({ cls: 'interface-bottom-item task-sections-todo-row' });
        if (item.done) row.addClass('is-done');
        const checkbox = row.createEl('input', { cls: 'task-sections-todo-checkbox' });
        checkbox.type = 'checkbox';
        checkbox.checked = item.done === true;
        checkbox.addEventListener('change', () => {
            item.done = checkbox.checked;
            // 完成时记录时间戳，取消完成时清除
            if (checkbox.checked) item.completedAt = Date.now();
            else delete item.completedAt;
            void this.sectionsOptions.save().then(() => this.render());
        });
        row.createSpan({ cls: 'interface-bottom-item-text', text: item.text });
        if (item.done && item.completedAt) {
            row.createSpan({
                cls: 'interface-bottom-item-time',
                text: t('panel.checklistCompletedAt', { time: formatCompletedTime(item.completedAt) }),
            });
        }
    }
}

/** 完成时间格式化为 MM-DD HH:MM（清单条目上展示） */
function formatCompletedTime(ts: number): string {
    const d = new Date(ts);
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mo}-${da} ${h}:${mi}`;
}
