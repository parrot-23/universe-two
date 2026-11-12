// 目标面板：左侧任务配置（底部根任务下拉 + 目标通用配置占位），
// 右侧为年-周泳道图（按季度翻页，仅展示根任务一行，读取计划整周排布）；
// 点击色块周格弹出悬浮面板，可填写 / 勾选 / 删除该周的阶段目标（以该周为截止时间点，存入任务的「阶段目标」板块）。
import { setIcon } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import type { PlanAssignmentRepo } from '../../../repos/plan-assignment-repo';
import type { PlanCategory } from '../../../shared/plan-category-manager';
import {
    getCurrentWeekKey,
    getISOWeek,
    makeDayKeyFromWeek,
    makeWeekKey,
    parseWeekKey,
    shiftWeekKey,
} from '../../../shared/plan-data';
import { appendStageGoal, getSection, getStageGoalEntries, getWeekNote, setStageGoalEntries } from '../../../shared/task-sections';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 季度内的一周 */
interface QuarterWeek {
    /** 周键（ISO 周，如 2026-W45） */
    weekKey: string;
    /** 周号（1-53） */
    week: number;
    /** 周一日期键（YYYY-MM-DD） */
    mondayKey: string;
}

/** 泳道行内的排布区间（列下标为季度内周列下标） */
interface BarRange {
    /** 起始列下标（含） */
    startIndex: number;
    /** 结束列下标（含） */
    endIndex: number;
}

/** 目标面板配置 */
export interface GoalBoardPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「目标」 */
    title?: string;
    /** 任务数据源（每次打开时重新读取） */
    getTasks: () => PrototypeTask[];
    /** 分类数据源（色块使用分类颜色） */
    getCategories: () => PlanCategory[];
    /** 计划排布数据仓库（与计划面板共享，只读） */
    planAssignmentRepo: PlanAssignmentRepo;
    /** 持久化出口（阶段目标修改后保存） */
    save: () => Promise<void>;
}

/** 目标面板 */
export class GoalBoardPanel extends FloatingPanel {
    private rootSelectEl!: HTMLSelectElement;
    /** 左侧阶段目标列表容器 */
    private goalListEl!: HTMLElement;
    private navEl!: HTMLElement;
    private weekHeaderEl!: HTMLElement;
    private laneEl!: HTMLElement;

    /** 当前年份 */
    private year: number;
    /** 当前季度（1-4） */
    private quarter: number;
    /** 下拉选中的根任务 id */
    private rootTaskId: string | undefined;
    /** 当前季度内的周列表 */
    private quarterWeeks: QuarterWeek[] = [];
    /** 当前季度内的周键 → 周格子（左侧列表点击定位用） */
    private weekCellMap = new Map<string, HTMLElement>();
    /** 周目标悬浮面板（挂在面板 body 内） */
    private goalTipEl: HTMLElement | null = null;
    /** 悬浮面板对应的周键 */
    private goalTipWeekKey: string | null = null;
    /** 悬浮面板的定位锚点（周格子） */
    private goalTipAnchorEl: HTMLElement | null = null;
    private goalTipOutsideHandler: ((evt: MouseEvent) => void) | null = null;
    private goalTipKeyHandler: ((evt: KeyboardEvent) => void) | null = null;

    constructor(private readonly panelOptions: GoalBoardPanelOptions) {
        super({
            width: 900,
            title: panelOptions.title ?? t('panel.goalBoardTitle'),
            ...panelOptions,
        });
        this.body.addClass('goal-board-panel');
        const current = parseWeekKey(getCurrentWeekKey());
        this.year = current.year;
        this.quarter = this.getQuarterOfMonth(new Date().getMonth() + 1);
        this.renderLayout();
    }

    /** 关闭面板时移除阶段目标悬浮面板 */
    override close(): void {
        this.closeGoalTip();
        super.close();
    }

    /** 销毁面板时移除阶段目标悬浮面板 */
    override destroy(): void {
        this.closeGoalTip();
        super.destroy();
    }

    /** 每次打开时刷新根任务下拉，避免任务面板新增后下拉不更新 */
    override open(): void {
        this.refreshRootSelect();
        super.open();
    }

    /** 月份对应的季度（1-4） */
    private getQuarterOfMonth(month: number): number {
        return Math.floor((month - 1) / 3) + 1;
    }

    private renderLayout(): void {
        // 左侧：任务配置面板（根任务下拉在上，目标通用配置在下）
        const left = this.body.createDiv({ cls: 'goal-board-left' });
        const config = left.createDiv({ cls: 'goal-board-config' });

        config.createDiv({ cls: 'goal-board-config-title', text: t('panel.planWeekRootTask') });
        this.rootSelectEl = config.createEl('select', { cls: 'dropdown goal-board-root-select' });
        this.rootSelectEl.addEventListener('change', () => {
            this.rootTaskId = this.rootSelectEl.value || undefined;
            this.renderQuarter();
        });

        config.createDiv({ cls: 'goal-board-config-divider' });
        config.createDiv({ cls: 'goal-board-config-title', text: t('panel.sectionStageGoals') });
        this.goalListEl = config.createDiv({ cls: 'goal-board-goal-list' });

        config.createDiv({ cls: 'goal-board-config-divider' });
        config.createDiv({ cls: 'goal-board-config-title', text: t('panel.goalBoardCommon') });
        this.renderPlaceholderRow(config, t('panel.goalBoardDailyEstimate'));
        this.renderPlaceholderRow(config, t('panel.goalBoardForm'));

        // 右侧：季度导航 + 周表头 + 泳道
        const right = this.body.createDiv({ cls: 'plan-annual-right goal-board-right' });
        this.navEl = right.createDiv({ cls: 'plan-annual-nav' });
        this.weekHeaderEl = right.createDiv({ cls: 'plan-annual-header' });
        this.laneEl = right.createDiv({ cls: 'plan-annual-lanes' });

        this.refreshRootSelect();
    }

    /** 目标通用配置的占位行（功能待实现） */
    private renderPlaceholderRow(parent: HTMLElement, label: string): void {
        const row = parent.createDiv({ cls: 'goal-board-config-row' });
        row.createSpan({ cls: 'goal-board-config-label', text: label });
        row.createSpan({ cls: 'goal-board-config-placeholder', text: t('panel.goalBoardPlaceholder') });
    }

    /** 重建根任务下拉（默认第一个根任务），并重绘右侧 */
    private refreshRootSelect(): void {
        const roots = this.panelOptions.getTasks().filter((task) => !task.parentId);
        if (!roots.some((task) => task.id === this.rootTaskId)) {
            this.rootTaskId = roots[0]?.id;
        }
        this.rootSelectEl.empty();
        if (roots.length === 0) {
            const option = this.rootSelectEl.createEl('option', { text: t('panel.planNoTask') });
            option.value = '';
            this.rootTaskId = undefined;
        } else {
            for (const task of roots) {
                const option = this.rootSelectEl.createEl('option', { text: task.name });
                option.value = task.id;
            }
            this.rootSelectEl.value = this.rootTaskId ?? '';
        }
        this.renderGoalList();
        this.renderQuarter();
    }

    /** 左侧阶段目标列表：该任务全部周的目标，点击定位周格，可删除 */
    private renderGoalList(): void {
        if (!this.goalListEl) return;
        this.goalListEl.empty();
        const task = this.rootTaskId
            ? this.panelOptions.getTasks().find((item) => item.id === this.rootTaskId)
            : undefined;
        const entries = task ? getSection(task, 'stageGoals')?.payload.entries ?? {} : {};
        const items: Array<{ weekKey: string; id: string; text: string; done: boolean }> = [];
        for (const [weekKey, goals] of Object.entries(entries)) {
            for (const goal of goals) {
                items.push({ weekKey, id: goal.id, text: goal.text, done: goal.done === true });
            }
        }
        items.sort((a, b) => this.weekTime(a.weekKey) - this.weekTime(b.weekKey));
        if (items.length === 0) {
            this.goalListEl.createDiv({ cls: 'goal-board-goal-empty', text: t('panel.sectionStageGoalsEmpty') });
            return;
        }
        for (const item of items) {
            const row = this.goalListEl.createDiv({ cls: 'goal-board-goal-item' });
            row.toggleClass('is-done', item.done);
            row.addEventListener('click', () => this.locateWeek(item.weekKey));
            row.createSpan({ cls: 'goal-board-goal-text', text: item.text });
            row.createSpan({ cls: 'goal-board-goal-week', text: this.shortWeekLabel(item.weekKey) });
            const delBtn = row.createEl('button', {
                cls: 'goal-board-goal-delete',
                text: '×',
                attr: { type: 'button', 'aria-label': t('common.delete') },
            });
            delBtn.addEventListener('click', (evt) => {
                evt.stopPropagation();
                if (!task) return;
                setStageGoalEntries(
                    task,
                    item.weekKey,
                    getStageGoalEntries(task, item.weekKey).filter((goal) => goal.id !== item.id),
                );
                void this.panelOptions.save();
                this.renderGoalList();
                this.renderQuarter();
            });
        }
    }

    /** 周键的短标签（如 W45） */
    private shortWeekLabel(weekKey: string): string {
        const matched = weekKey.match(/^(\d{4})-W(\d{2})$/);
        return matched ? `W${matched[2]}` : weekKey;
    }

    /** 定位到某周：必要时切换季度，滚动到周格并短暂高亮 */
    private locateWeek(weekKey: string): void {
        const mondayKey = makeDayKeyFromWeek(weekKey, 1);
        const year = Number(mondayKey.slice(0, 4));
        const quarter = this.getQuarterOfMonth(Number(mondayKey.slice(5, 7)));
        if (year !== this.year || quarter !== this.quarter) {
            this.year = year;
            this.quarter = quarter;
            this.renderQuarter();
        }
        const cell = this.weekCellMap.get(weekKey);
        if (!cell) return;
        const cellRect = cell.getBoundingClientRect();
        const laneRect = this.laneEl.getBoundingClientRect();
        this.laneEl.scrollTop += cellRect.top - laneRect.top - laneRect.height / 2 + cellRect.height / 2;
        cell.addClass('is-located');
        window.setTimeout(() => cell.removeClass('is-located'), 1600);
    }

    /** 重绘季度导航、周表头与泳道 */
    private renderQuarter(): void {
        // 泳道重绘后锚点失效，先关闭悬浮面板
        this.closeGoalTip();
        this.quarterWeeks = this.buildQuarterWeeks(this.year, this.quarter);
        this.renderNav();
        this.renderHeader();
        this.renderLanes();
    }

    private renderNav(): void {
        this.navEl.empty();
        const prev = this.navEl.createEl('button', { cls: 'plan-nav-btn', text: '←', attr: { type: 'button' } });
        prev.addEventListener('click', () => this.shiftQuarter(-1));
        this.navEl.createSpan({
            cls: 'plan-nav-label',
            text: t('panel.planAnnualQuarter', { year: String(this.year), quarter: String(this.quarter) }),
        });
        const next = this.navEl.createEl('button', { cls: 'plan-nav-btn', text: '→', attr: { type: 'button' } });
        next.addEventListener('click', () => this.shiftQuarter(1));
    }

    /** 季度翻页：Q4 向后进入下一年 Q1，Q1 向前回到上一年 Q4 */
    private shiftQuarter(delta: number): void {
        let quarter = this.quarter + delta;
        let year = this.year;
        if (quarter < 1) {
            quarter = 4;
            year -= 1;
        } else if (quarter > 4) {
            quarter = 1;
            year += 1;
        }
        this.year = year;
        this.quarter = quarter;
        this.renderQuarter();
    }

    /** 周列表头：每列 W45 + 周一日期，跨入新月份时左上角标注月份 */
    private renderHeader(): void {
        this.weekHeaderEl.empty();
        const currentWeekKey = getCurrentWeekKey();
        for (const item of this.quarterWeeks) {
            const cell = this.weekHeaderEl.createDiv({ cls: 'plan-annual-header-cell' });
            if (item.weekKey === currentWeekKey) cell.addClass('is-current');
            const month = Number(item.mondayKey.slice(5, 7));
            const prevMonday = makeDayKeyFromWeek(shiftWeekKey(item.weekKey, -1), 1);
            if (month !== Number(prevMonday.slice(5, 7))) {
                cell.createSpan({ cls: 'plan-annual-header-month', text: `${month}月` });
            }
            cell.createSpan({ cls: 'plan-annual-header-week', text: `W${String(item.week).padStart(2, '0')}` });
            cell.createSpan({
                cls: 'plan-annual-header-date',
                text: `${month}/${Number(item.mondayKey.slice(8, 10))}`,
            });
        }
    }

    /** 泳道行：仅根任务一行，绘制整周排布区间色块 */
    private renderLanes(): void {
        this.laneEl.empty();
        this.weekCellMap.clear();
        const task = this.rootTaskId
            ? this.panelOptions.getTasks().find((item) => item.id === this.rootTaskId)
            : undefined;
        if (!task) {
            this.laneEl.createDiv({ cls: 'interface-today-empty', text: t('panel.planNoTask') });
            return;
        }

        const row = this.laneEl.createDiv({ cls: 'plan-annual-lane-row' });
        row.dataset.taskId = task.id;

        // 背景层：每列一个元素，负责竖向分隔线与当前周标识
        const columnsEl = row.createDiv({ cls: 'plan-annual-lane-columns' });
        const currentWeekKey = getCurrentWeekKey();
        for (const item of this.quarterWeeks) {
            const column = columnsEl.createDiv({ cls: 'plan-annual-lane-column' });
            column.toggleClass('is-current', item.weekKey === currentWeekKey);
        }

        const range = this.buildBarRange(task);
        if (range) {
            const color = this.panelOptions.getCategories().find((category) => category.id === task.categoryId)?.color
                ?? '#888888';
            const barEl = row.createDiv({ cls: 'plan-annual-bar' });
            barEl.style.left = `${(range.startIndex / this.quarterWeeks.length) * 100}%`;
            barEl.style.width = `${((range.endIndex - range.startIndex + 1) / this.quarterWeeks.length) * 100}%`;
            barEl.style.setProperty('--plan-bar-color', color);
            const status = task.status ?? 'notStarted';
            barEl.toggleClass('is-in-progress', status === 'inProgress');
            barEl.toggleClass('is-done', status === 'done');
            barEl.toggleClass('is-paused', status === 'paused');
            barEl.toggleClass('is-not-started', status === 'notStarted');
        }

        // 周格点击热区：覆盖整行高度、按周列等分，点击任意周列填写该周阶段目标
        const hitLayer = row.createDiv({ cls: 'plan-annual-week-hit-layer' });
        for (const item of this.quarterWeeks) {
            const hit = hitLayer.createDiv({ cls: 'plan-annual-week-hit' });
            hit.addClass('is-clickable');
            this.weekCellMap.set(item.weekKey, hit);
            if (getWeekNote(task, item.weekKey).trim()) {
                hit.addClass('has-week-goal');
                hit.createSpan({ cls: 'plan-annual-bar-weekgoal-mark' });
            }
            this.updateCellMark(hit, task, item.weekKey);
            hit.addEventListener('click', (evt) => {
                evt.stopPropagation();
                this.openGoalTip(item.weekKey, hit, task);
            });
        }

        this.renderDurationSection(task);
    }

    /** 周格下方：目标时长区（一行标题 + 按周列对齐的子任务卡片，仅展示） */
    private renderDurationSection(task: PrototypeTask): void {
        const wrap = this.laneEl.createDiv({ cls: 'goal-board-duration' });
        wrap.createDiv({ cls: 'goal-board-duration-title', text: t('panel.goalBoardDurationTitle') });
        const columnsEl = wrap.createDiv({ cls: 'goal-board-duration-columns' });
        const categories = this.panelOptions.getCategories();
        const repo = this.panelOptions.planAssignmentRepo;
        const descendants = this.collectDescendantTasks(task.id);
        for (const item of this.quarterWeeks) {
            const column = columnsEl.createDiv({ cls: 'goal-board-duration-column' });
            // 该周整周排布的子任务（与计划年度面板的排布数据一致）
            const assigned = new Set(
                repo.weekAssignments(item.weekKey).map((assignment) => assignment.taskId),
            );
            for (const child of descendants) {
                if (!assigned.has(child.id)) continue;
                const card = column.createDiv({ cls: 'goal-board-duration-card', attr: { title: child.name } });
                card.style.setProperty(
                    '--goal-board-duration-color',
                    categories.find((category) => category.id === child.categoryId)?.color ?? '#888888',
                );
                card.createSpan({ cls: 'goal-board-duration-dot' });
                card.createSpan({ cls: 'goal-board-duration-name', text: child.name });
            }
        }
    }

    /** 根任务的全部后代子任务（按任务树顺序） */
    private collectDescendantTasks(rootId: string): PrototypeTask[] {
        const tasks = this.panelOptions.getTasks();
        const result: PrototypeTask[] = [];
        const collect = (parentId: string): void => {
            for (const child of tasks.filter((task) => task.parentId === parentId)) {
                result.push(child);
                collect(child.id);
            }
        };
        collect(rootId);
        return result;
    }

    /** 刷新周格上的阶段目标：每条一行，显示 target 图标 + 目标名称 */
    private updateCellMark(cell: HTMLElement, task: PrototypeTask, weekKey: string): void {
        cell.querySelector('.goal-board-weekgoal-list')?.remove();
        cell.removeClass('has-week-goals');
        const goals = getStageGoalEntries(task, weekKey);
        if (goals.length === 0) return;
        cell.addClass('has-week-goals');
        const list = cell.createDiv({ cls: 'goal-board-weekgoal-list' });
        for (const goal of goals) {
            const item = list.createDiv({ cls: 'goal-board-weekgoal-item' });
            item.toggleClass('is-done', goal.done === true);
            item.setAttribute('title', goal.text);
            setIcon(item.createSpan({ cls: 'goal-board-weekgoal-icon' }), 'target');
            item.createSpan({ cls: 'goal-board-weekgoal-name', text: goal.text });
        }
    }

    /** 打开某周的阶段目标悬浮面板（再次点击同一格子则关闭） */
    private openGoalTip(weekKey: string, anchorEl: HTMLElement, task: PrototypeTask): void {
        if (this.goalTipEl && this.goalTipWeekKey === weekKey) {
            this.closeGoalTip();
            return;
        }
        this.closeGoalTip();
        const tip = this.body.createDiv({ cls: 'goal-board-goal-tip' });
        this.goalTipEl = tip;
        this.goalTipWeekKey = weekKey;
        this.goalTipAnchorEl = anchorEl;
        this.renderGoalTipContent(task);

        // 定位：优先显示在格子下方，空间不足时翻到上方，水平方向夹在 body 内
        const width = 220;
        const rect = anchorEl.getBoundingClientRect();
        const bodyRect = this.body.getBoundingClientRect();
        let left = rect.left - bodyRect.left + rect.width / 2 - width / 2;
        left = Math.max(8, Math.min(left, this.body.clientWidth - width - 8));
        let top = rect.bottom - bodyRect.top + 6;
        if (top + 180 > this.body.clientHeight - 8) {
            top = Math.max(8, rect.top - bodyRect.top - 180 - 6);
        }
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        tip.style.width = `${width}px`;

        // 点击面板与锚点以外区域关闭
        this.goalTipOutsideHandler = (evt: MouseEvent): void => {
            const target = evt.target;
            if (!(target instanceof Node)) return;
            if (this.goalTipEl?.contains(target)) return;
            if (this.goalTipAnchorEl?.contains(target)) return;
            this.closeGoalTip();
        };
        this.goalTipKeyHandler = (evt: KeyboardEvent): void => {
            if (evt.key === 'Escape') this.closeGoalTip();
        };
        document.addEventListener('mousedown', this.goalTipOutsideHandler, true);
        document.addEventListener('keydown', this.goalTipKeyHandler);
    }

    /** 重建悬浮面板内容：周标题 + 目标列表 + 新增输入框 */
    private renderGoalTipContent(task: PrototypeTask): void {
        const tip = this.goalTipEl;
        const weekKey = this.goalTipWeekKey;
        if (!tip || !weekKey) return;
        tip.empty();

        const matched = weekKey.match(/^(\d{4})-W(\d{2})$/);
        const head = tip.createDiv({ cls: 'goal-board-goal-tip-head' });
        head.createSpan({
            cls: 'goal-board-goal-tip-title',
            text: matched ? `${matched[1]} 第${Number(matched[2])}周` : weekKey,
        });
        const closeBtn = head.createEl('button', {
            cls: 'goal-board-goal-tip-close',
            text: '×',
            attr: { type: 'button' },
        });
        closeBtn.addEventListener('click', () => this.closeGoalTip());
        tip.createDiv({ cls: 'goal-board-goal-tip-hint', text: t('panel.goalBoardTipHint') });

        const list = tip.createDiv({ cls: 'goal-board-goal-tip-list' });
        const goals = getStageGoalEntries(task, weekKey);
        if (goals.length === 0) {
            list.createDiv({ cls: 'goal-board-goal-tip-empty', text: t('panel.goalBoardTipEmpty') });
        }
        for (const goal of goals) {
            const row = list.createDiv({ cls: 'goal-board-goal-tip-item' });
            row.toggleClass('is-done', goal.done === true);
            const checkbox = row.createEl('input', { cls: 'task-section-check', attr: { type: 'checkbox' } });
            checkbox.checked = goal.done === true;
            checkbox.addEventListener('change', () => {
                setStageGoalEntries(
                    task,
                    weekKey,
                    getStageGoalEntries(task, weekKey).map((item) =>
                        item.id === goal.id ? (checkbox.checked ? { ...item, done: true } : { ...item, done: false }) : item,
                    ),
                );
                void this.panelOptions.save();
                this.afterGoalChange(task, weekKey);
            });
            row.createSpan({ cls: 'goal-board-goal-tip-text', text: goal.text });
            const delBtn = row.createEl('button', {
                cls: 'goal-board-goal-tip-delete',
                text: '×',
                attr: { type: 'button', 'aria-label': t('common.delete') },
            });
            delBtn.addEventListener('click', () => {
                setStageGoalEntries(
                    task,
                    weekKey,
                    getStageGoalEntries(task, weekKey).filter((item) => item.id !== goal.id),
                );
                void this.panelOptions.save();
                this.afterGoalChange(task, weekKey);
            });
        }

        const inputRow = tip.createDiv({ cls: 'goal-board-goal-tip-input-row' });
        const input = inputRow.createEl('input', {
            cls: 'goal-board-goal-tip-input',
            attr: { type: 'text', placeholder: t('panel.goalBoardTipPlaceholder') },
        });
        input.addEventListener('keydown', (evt) => {
            if (evt.key !== 'Enter') return;
            evt.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            appendStageGoal(task, weekKey, text);
            void this.panelOptions.save();
            this.afterGoalChange(task, weekKey);
            this.goalTipEl?.querySelector<HTMLInputElement>('.goal-board-goal-tip-input')?.focus();
        });
    }

    /** 目标变更后：重建悬浮面板内容、刷新格子标识与左侧列表 */
    private afterGoalChange(task: PrototypeTask, weekKey: string): void {
        this.renderGoalTipContent(task);
        if (this.goalTipAnchorEl) this.updateCellMark(this.goalTipAnchorEl, task, weekKey);
        this.renderGoalList();
        // 重建内容后焦点回到输入框，便于连续添加
        this.goalTipEl?.querySelector<HTMLInputElement>('.goal-board-goal-tip-input')?.focus();
    }

    /** 关闭阶段目标悬浮面板并解绑全局监听 */
    private closeGoalTip(): void {
        if (this.goalTipOutsideHandler) {
            document.removeEventListener('mousedown', this.goalTipOutsideHandler, true);
            this.goalTipOutsideHandler = null;
        }
        if (this.goalTipKeyHandler) {
            document.removeEventListener('keydown', this.goalTipKeyHandler);
            this.goalTipKeyHandler = null;
        }
        this.goalTipEl?.remove();
        this.goalTipEl = null;
        this.goalTipWeekKey = null;
        this.goalTipAnchorEl = null;
    }

    /** 任务整周排布在当前季度内的区间（无交集时返回 null） */
    private buildBarRange(task: PrototypeTask): BarRange | null {
        const weekKeys = this.panelOptions.planAssignmentRepo
            .taskWeekAssignments(task.id)
            .map((assignment) => assignment.weekKey)
            .sort((a, b) => this.weekTime(a) - this.weekTime(b));
        if (weekKeys.length === 0) return null;
        const startTime = this.weekTime(weekKeys[0]);
        const endTime = this.weekTime(weekKeys[weekKeys.length - 1]);
        const first = this.quarterWeeks[0];
        const last = this.quarterWeeks[this.quarterWeeks.length - 1];
        if (!first || !last) return null;
        const quarterStart = this.weekTime(first.weekKey);
        const quarterEnd = this.weekTime(last.weekKey);
        // 区间与当前季度无交集时不显示
        if (endTime < quarterStart || startTime > quarterEnd) return null;
        const startIndex = Math.max(0, this.quarterWeeks.findIndex((item) => this.weekTime(item.weekKey) >= startTime));
        let endIndex = this.quarterWeeks.length - 1;
        for (let i = this.quarterWeeks.length - 1; i >= 0; i -= 1) {
            if (this.weekTime(this.quarterWeeks[i].weekKey) <= endTime) {
                endIndex = i;
                break;
            }
        }
        return { startIndex, endIndex };
    }

    /** 周键对应周一的时间戳（用于跨年周的正确比较） */
    private weekTime(weekKey: string): number {
        return new Date(`${makeDayKeyFromWeek(weekKey, 1)}T00:00:00`).getTime();
    }

    /** 季度内的周列表（周一为基准） */
    private buildQuarterWeeks(year: number, quarter: number): QuarterWeek[] {
        const result: QuarterWeek[] = [];
        const date = new Date(year, 0, 1);
        // 定位到 1 月 1 日之后的第一个周一
        date.setDate(date.getDate() + ((8 - (date.getDay() || 7)) % 7));
        while (date.getFullYear() === year) {
            if (this.getQuarterOfMonth(date.getMonth() + 1) === quarter) {
                const week = getISOWeek(date);
                result.push({
                    weekKey: makeWeekKey(date.getFullYear(), week),
                    week,
                    mondayKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
                });
            }
            date.setDate(date.getDate() + 7);
        }
        return result;
    }
}
