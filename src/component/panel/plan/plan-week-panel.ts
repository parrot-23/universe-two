// 计划一周面板：左右结构。
// 左侧：周信息摘要（周数 / 日期范围 / 任务数）+ 本周已整周排布的任务列表，
//       点击任务条目选中它，作为右侧日目标的绑定任务（再次点击取消选中）；
//       列表底部：选中任务时显示本周描述输入框，未选中时显示本周各分类计划时长柱形图。
// 右侧：顶部周切换（上一周 / 周数 + 日期范围 / 下一周），
//       下方为周一到周日 7 个方框，编辑选中任务在该周的日目标
//       （数据与任务详情「一周目标」选项卡共享 task.dayGoals）。
import { setIcon } from 'obsidian';

import type { TaskStatus } from '../../../datatypes/domain';
import type { PrototypeTask, TaskDayGoalEntry } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import type { PlanAssignmentRepo } from '../../../repos/plan-assignment-repo';
import type { TimeBoxRepo } from '../../../repos/timebox-repo';
import type { PlanCategory } from '../../../shared/plan-category-manager';
import { UNCATEGORIZED_CATEGORY_ID } from '../../../shared/plan-category-manager';
import {
    getCurrentWeekKey,
    makeDayKeyFromWeek,
    parseWeekKey,
    shiftWeekKey,
} from '../../../shared/plan-data';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 计划一周面板配置 */
export interface PlanWeekPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「计划一周」 */
    title?: string;
    /** 任务数据源（每次打开时重新读取，保证与其他视图一致） */
    getTasks: () => PrototypeTask[];
    /** 计划排布数据仓库（读取本周已排布任务、读写周描述） */
    planAssignmentRepo: PlanAssignmentRepo;
    /** 时间盒仓库（未选中任务时统计本周各分类计划时长） */
    timeBoxRepo: TimeBoxRepo;
    /** 分类数据源（任务名称前的分类颜色圆点） */
    getCategories: () => PlanCategory[];
    /** 数据保存回调 */
    save: () => Promise<void>;
    /** 数据变更回调（界面视图其他卡片据此刷新） */
    onChanged?: () => void;
}

/** 任务状态对应的图标（与习惯面板任务树保持一致） */
const STATUS_ICONS: Record<TaskStatus, string> = {
    notStarted: 'circle',
    inProgress: 'play',
    done: 'check-circle',
    paused: 'pause',
};

/** 星期文案（周一 … 周日） */
const WEEKDAY_LABEL_KEYS: Parameters<typeof t>[0][] = [
    'week.monday',
    'week.tuesday',
    'week.wednesday',
    'week.thursday',
    'week.friday',
    'week.saturday',
    'week.sunday',
];

/** 计划一周面板 */
export class PlanWeekPanel extends FloatingPanel {
    private summaryEl!: HTMLElement;
    private taskListEl!: HTMLElement;
    private navEl!: HTMLElement;
    /** 左侧任务列表底部区域：选中任务时为本周描述输入框，未选中时为本周分类时长柱形图 */
    private bottomEl!: HTMLElement;
    /** 本周描述输入框（仅选中任务时存在） */
    private descEl: HTMLTextAreaElement | undefined;
    /** 已选任务名称（周切换行内右侧） */
    private selectedEl!: HTMLElement;
    /** 右侧七列网格：选中左侧任务后点击某天排布 */
    private dayGridEl!: HTMLElement;
    /** 日目标悬浮预览浮层（悬浮某天卡片区域时展示该天已填写的日目标） */
    private dayGoalTipEl!: HTMLElement;
    /** 悬浮预览当前对应的「任务 + 星期」键，未变化时不重建内容 */
    private dayGoalTipKey: string | undefined;
    /** 日目标编辑浮层（点击卡片某天时在卡片旁弹出，支持新增 / 勾选 / 删除） */
    private dayGoalEditorEl: HTMLElement | undefined;
    /** 编辑浮层当前对应的「任务 id:星期」键 */
    private dayGoalEditorKey: string | undefined;
    /** 编辑浮层锚点（卡片矩形 + 天在卡片中的序号与跨度），用于重绘后重新定位 */
    private dayGoalEditorAnchor: { rect: DOMRect; index: number; span: number } | undefined;
    /** 编辑浮层的新增输入框（新增后保持焦点） */
    private dayGoalEditorInputEl: HTMLInputElement | undefined;
    /** 点击浮层外部关闭的回调（打开时绑定到 document） */
    private dayGoalEditorOutsideHandler: ((evt: MouseEvent) => void) | undefined;
    /** Esc 关闭浮层的回调（打开时绑定到 document） */
    private dayGoalEditorEscapeHandler: ((evt: KeyboardEvent) => void) | undefined;
    /** 当前显示的周键 */
    private weekKey: string;
    /** 左侧选中的任务 id（右侧日目标的绑定任务） */
    private selectedTaskId: string | undefined;

    constructor(private readonly panelOptions: PlanWeekPanelOptions) {
        super({
            width: 1000,
            title: panelOptions.title ?? t('panel.planWeekTitle'),
            ...panelOptions,
            // 默认展示计划一周的操作帮助，可通过 helpText 覆盖
            helpText: panelOptions.helpText ?? t('panel.planWeekHelp'),
        });
        this.body.addClass('plan-week-panel');
        this.weekKey = getCurrentWeekKey();
        this.renderLayout();
    }

    /** 每次打开时重绘，保证任务排布与任务数据都是最新的 */
    override open(): void {
        this.renderAll();
        super.open();
    }

    /** 关闭面板时一并关闭日目标编辑浮层（移除其 document 监听） */
    override close(): void {
        this.closeDayGoalEditor();
        super.close();
    }

    private renderLayout(): void {
        // 左侧：周信息摘要 + 本周已排布任务列表 + 底栏（本周描述 / 分类时长）
        const left = this.body.createDiv({ cls: 'plan-week-left' });
        this.summaryEl = left.createDiv({ cls: 'plan-week-summary' });
        this.taskListEl = left.createDiv({ cls: 'plan-week-task-list' });
        // 底栏：选中任务时是本周描述输入框，未选中时是本周各分类计划时长柱形图
        this.bottomEl = left.createDiv({ cls: 'plan-week-bottom' });

        // 右侧：周切换行（左侧周切换 + 右侧已选任务名称）+ 七列网格
        const right = this.body.createDiv({ cls: 'plan-week-right' });
        const navRow = right.createDiv({ cls: 'plan-week-nav-row' });
        this.navEl = navRow.createDiv({ cls: 'task-week-goal-nav' });
        // 已选任务名称：与周切换按钮同一行，靠右显示
        this.selectedEl = navRow.createDiv({ cls: 'plan-week-selected' });
        this.dayGridEl = right.createDiv({ cls: 'plan-week-day-grid' });

        // 日目标悬浮预览：挂在面板根节点上（不放在滚动网格内，避免被列区域裁剪）
        this.dayGoalTipEl = this.element.createDiv({ cls: 'plan-week-daygoal-tip' });

        this.renderAll();
    }

    /** 重绘全部区域（周切换后调用） */
    private renderAll(): void {
        // 切换周后浮层对应的日期已失效，先关闭
        this.closeDayGoalEditor();
        this.renderNav();
        this.renderSummary();
        this.renderTasks();
        this.renderBottom();
        this.renderDayGrid();
    }

    /** 顶部周切换：上一周 / 周数 + 日期范围 / 下一周 */
    private renderNav(): void {
        this.navEl.empty();
        const prevBtn = this.navEl.createEl('button', {
            cls: 'task-week-goal-nav-btn',
            attr: { type: 'button', 'aria-label': t('panel.weekGoalPrevWeek') },
        });
        setIcon(prevBtn, 'chevron-left');
        prevBtn.addEventListener('click', () => {
            this.weekKey = shiftWeekKey(this.weekKey, -1);
            this.renderAll();
        });

        const { week } = parseWeekKey(this.weekKey);
        const label = this.navEl.createDiv({ cls: 'task-week-goal-nav-label' });
        label.createSpan({ cls: 'task-week-goal-nav-week', text: `W${String(week).padStart(2, '0')}` });
        label.createSpan({ cls: 'task-week-goal-nav-range', text: this.formatWeekRange() });
        if (this.weekKey === getCurrentWeekKey()) label.addClass('is-current');

        const nextBtn = this.navEl.createEl('button', {
            cls: 'task-week-goal-nav-btn',
            attr: { type: 'button', 'aria-label': t('panel.weekGoalNextWeek') },
        });
        setIcon(nextBtn, 'chevron-right');
        nextBtn.addEventListener('click', () => {
            this.weekKey = shiftWeekKey(this.weekKey, 1);
            this.renderAll();
        });
    }

    /** 左侧周信息摘要：周数 + 日期范围 + 已排布任务数 */
    private renderSummary(): void {
        this.summaryEl.empty();
        const { week } = parseWeekKey(this.weekKey);
        const head = this.summaryEl.createDiv({ cls: 'plan-week-summary-head' });
        if (this.weekKey === getCurrentWeekKey()) head.addClass('is-current');
        head.createSpan({ cls: 'plan-week-summary-week', text: `W${String(week).padStart(2, '0')}` });
        head.createSpan({ cls: 'plan-week-summary-range', text: this.formatWeekRange() });
        this.summaryEl.createDiv({
            cls: 'plan-week-summary-count',
            text: t('panel.planWeekTaskCount', { count: `${this.plannedTasks().length}` }),
        });
    }

    /** 左侧任务列表：本周已整周排布的任务（点击选中 / 再次点击取消选中） */
    private renderTasks(): void {
        this.renderSelectedTask();
        this.taskListEl.empty();
        const tasks = this.plannedTasks();
        if (tasks.length === 0) {
            this.taskListEl.createDiv({ cls: 'plan-week-task-empty', text: t('panel.planWeekNoPlannedTask') });
            return;
        }
        for (const task of tasks) {
            const row = this.taskListEl.createDiv({ cls: 'plan-week-task-row' });
            row.toggleClass('is-selected', task.id === this.selectedTaskId);
            row.title = task.name;
            // 第一行：父级任务路径（无父级时显示「根任务」）
            row.createDiv({
                cls: 'plan-week-task-path',
                text: this.taskPath(task) || t('panel.planWeekRootTask'),
            });
            // 第二行：分类颜色圆点 + 任务名称 + 行末状态图标
            const main = row.createDiv({ cls: 'plan-week-task-main' });
            const category = this.panelOptions.getCategories().find((item) => item.id === task.categoryId);
            const dot = main.createSpan({ cls: 'plan-week-task-dot' });
            dot.style.background = category?.color ?? 'var(--text-faint)';
            main.createSpan({ cls: 'plan-week-task-name', text: task.name });
            setIcon(main.createSpan({ cls: 'plan-week-task-status' }), STATUS_ICONS[task.status ?? 'notStarted']);
            row.addEventListener('click', () => {
                this.selectedTaskId = this.selectedTaskId === task.id ? undefined : task.id;
                this.renderTasks();
                this.renderBottom();
                this.renderDayGrid();
            });
        }
    }

    /** 父级任务路径：从根到直接父级的名称，用 / 连接（无父级时返回空串） */
    private taskPath(task: PrototypeTask): string {
        const tasks = this.panelOptions.getTasks();
        const names: string[] = [];
        const seen = new Set<string>();
        let parentId = task.parentId;
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = tasks.find((item) => item.id === parentId);
            if (!parent) break;
            names.unshift(parent.name);
            parentId = parent.parentId;
        }
        return names.join(' / ');
    }

    /** 已选任务名称：显示在周切换行下方、本周描述方框上方；未选中时整行隐藏 */
    private renderSelectedTask(): void {
        this.selectedEl.empty();
        const task = this.selectedTask();
        this.selectedEl.toggleClass('is-hidden', !task);
        if (!task) return;
        this.selectedEl.createSpan({ cls: 'plan-week-selected-label', text: t('panel.planWeekSelectedTask') });
        this.selectedEl.createSpan({ cls: 'plan-week-selected-name', text: task.name });
    }

    /** 日键（YYYY-MM-DD）格式化为 M/D */
    private formatDayLabel(dayKey: string): string {
        return `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`;
    }


    /** 七列网格：表头 7 格（星期 + 日期），表体按天显示已排布的任务卡片 */
    private renderDayGrid(): void {
        this.hideDayGoalTip();
        this.dayGridEl.empty();
        const grid = this.dayGridEl.createDiv({ cls: 'plan-week-grid' });
        const headerRow = grid.createDiv({ cls: 'plan-week-header' });
        const columnsRow = grid.createDiv({ cls: 'plan-week-columns' });
        const segments = this.buildDaySegments();
        const laneCount = segments.reduce((max, item) => Math.max(max, item.lane + 1), 0);
        columnsRow.style.gridTemplateRows = laneCount > 0
            ? `repeat(${laneCount}, min-content) 1fr`
            : '1fr';
        for (let col = 0; col < 7; col += 1) {
            const dayKey = makeDayKeyFromWeek(this.weekKey, col + 1);
            const header = headerRow.createDiv({ cls: 'plan-week-header-cell' });
            // 当天进入新的月份时，在左上角标注月份
            const month = Number(dayKey.slice(5, 7));
            if (month !== this.getPreviousDayMonth(dayKey)) {
                header.createSpan({
                    cls: 'plan-week-header-month',
                    text: t('panel.planWeekMonthLabel', { month: String(month) }),
                });
            }
            header.createSpan({ cls: 'plan-week-header-name', text: t(WEEKDAY_LABEL_KEYS[col]) });
            header.createSpan({
                cls: 'plan-week-header-date',
                text: `${month}/${Number(dayKey.slice(8, 10))}`,
            });
            // 日列作为背景层跨满所有行：已选中任务时点击某列即排布到该天
            const column = columnsRow.createDiv({ cls: 'plan-week-column' });
            column.style.gridColumn = String(col + 1);
            column.style.gridRow = '1 / -1';
            column.toggleClass('is-assignable', this.selectedTaskId !== undefined);
            column.addEventListener('click', () => this.assignSelectedTaskToDay(col + 1));
        }
        for (const segment of segments) this.renderDaySegment(columnsRow, segment);
    }

    /** 取指定日期前一天的月份（用于判断当天是否跨入新月份） */
    private getPreviousDayMonth(dayKey: string): number {
        const date = new Date(`${dayKey}T00:00:00`);
        date.setDate(date.getDate() - 1);
        return date.getMonth() + 1;
    }

    /** 本周按天排布的任务段：同一任务连续的天合并为一段，并分入不冲突的泳道 */
    private buildDaySegments(): { task: PrototypeTask; start: number; end: number; lane: number }[] {
        const tasks = new Map(this.panelOptions.getTasks().map((task) => [task.id, task]));
        const weekdaysByTask = new Map<string, number[]>();
        for (let weekday = 1; weekday <= 7; weekday += 1) {
            for (const assignment of this.panelOptions.planAssignmentRepo.dayAssignments(this.weekKey, weekday)) {
                if (!tasks.has(assignment.taskId)) continue;
                const days = weekdaysByTask.get(assignment.taskId) ?? [];
                days.push(weekday);
                weekdaysByTask.set(assignment.taskId, days);
            }
        }
        const segments: { task: PrototypeTask; start: number; end: number; lane: number }[] = [];
        weekdaysByTask.forEach((days, taskId) => {
            const task = tasks.get(taskId);
            if (!task) return;
            const sorted = days.slice().sort((a, b) => a - b)
                .filter((day, index, list) => index === 0 || day !== list[index - 1]);
            let start = sorted[0];
            let prev = sorted[0];
            for (let index = 1; index < sorted.length; index += 1) {
                const day = sorted[index];
                if (day === prev + 1) {
                    prev = day;
                    continue;
                }
                segments.push({ task, start, end: prev, lane: 0 });
                start = day;
                prev = day;
            }
            segments.push({ task, start, end: prev, lane: 0 });
        });
        segments.sort((a, b) => a.start - b.start
            || (b.end - b.start) - (a.end - a.start)
            || a.task.name.localeCompare(b.task.name));
        const lanes: { start: number; end: number }[][] = [];
        for (const segment of segments) {
            let lane = 0;
            while (lanes[lane]?.some((item) => !(item.end < segment.start || item.start > segment.end))) {
                lane += 1;
            }
            (lanes[lane] ??= []).push({ start: segment.start, end: segment.end });
            segment.lane = lane;
        }
        return segments;
    }

    /** 渲染一段跨列任务卡片（第一行父层级，第二行任务名；右键移除所在那一天的排布） */
    private renderDaySegment(
        parentEl: HTMLElement,
        segment: { task: PrototypeTask; start: number; end: number; lane: number },
    ): void {
        const { task, start, end, lane } = segment;
        const span = end - start + 1;
        const chip = parentEl.createDiv({ cls: 'plan-week-task-chip plan-week-span-chip' });
        chip.style.gridColumn = `${start} / span ${span}`;
        chip.style.gridRow = String(lane + 1);
        const parentPath = this.taskPath(task);
        chip.title = parentPath ? `${parentPath} > ${task.name}` : task.name;
        chip.createDiv({ cls: 'plan-week-task-chip-path', text: parentPath });
        chip.createDiv({ cls: 'plan-week-task-chip-name', text: task.name });
        // 左键：同步选中该任务，并在点击的这一天旁打开日目标编辑浮层（阻止冒泡，避免触发列的排布）
        chip.addEventListener('click', (evt) => {
            evt.stopPropagation();
            const rect = chip.getBoundingClientRect();
            const columnWidth = rect.width / span;
            const index = Math.max(0, Math.min(span - 1, Math.floor((evt.clientX - rect.left) / columnWidth)));
            this.selectedTaskId = task.id;
            this.renderTasks();
            this.renderBottom();
            this.renderDayGrid();
            this.openDayGoalEditor(task.id, start + index, rect, index, span);
        });
        // 某天已填写日目标时，在该天所在列的右下角显示圆圈标识；该天全部日目标已完成时显示打勾（仅视觉提示，不响应点击）
        for (let offset = 0; offset < span; offset += 1) {
            const weekday = start + offset;
            const entries = this.dayGoalEntries(task, weekday);
            if (entries.length === 0) continue;
            const mark = chip.createSpan({ cls: 'plan-week-daygoal-mark' });
            mark.style.right = `calc(${((span - offset - 1) * 100) / span}% + 2px)`;
            setIcon(mark, entries.every((entry) => entry.done === true) ? 'check-circle' : 'circle');
        }
        // 鼠标位于卡片内某一列区域时，该天有日目标则展示悬浮预览（编辑浮层打开时不显示，避免叠加）
        chip.addEventListener('mousemove', (evt) => {
            if (this.dayGoalEditorEl) return;
            const rect = chip.getBoundingClientRect();
            const columnWidth = rect.width / span;
            const index = Math.max(0, Math.min(span - 1, Math.floor((evt.clientX - rect.left) / columnWidth)));
            const weekday = start + index;
            const entries = this.dayGoalEntries(task, weekday);
            if (entries.length === 0) this.hideDayGoalTip();
            else this.showDayGoalTip(task, entries, weekday, rect, index, span);
        });
        chip.addEventListener('mouseleave', () => this.hideDayGoalTip());
        // 右键：阻止浏览器默认菜单，移除右键所在那一天的排布（卡片其余天保留），并自动选中对应任务
        chip.addEventListener('contextmenu', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            const rect = chip.getBoundingClientRect();
            const columnWidth = rect.width / span;
            const index = Math.max(0, Math.min(span - 1, Math.floor((evt.clientX - rect.left) / columnWidth)));
            this.panelOptions.planAssignmentRepo.remove(this.weekKey, start + index, task.id);
            this.selectedTaskId = task.id;
            // 该天卡片已被移除，编辑浮层不再对应有效排布，一并关闭
            this.closeDayGoalEditor();
            void this.panelOptions.save();
            this.panelOptions.onChanged?.();
            this.renderDayGrid();
            this.renderTasks();
            this.renderBottom();
        });
    }

    /** 选中任务在某一天已填写的日目标（星期 1=周一 … 7=周日） */
    private dayGoalEntries(task: PrototypeTask, weekday: number): TaskDayGoalEntry[] {
        return task.dayGoals?.[makeDayKeyFromWeek(this.weekKey, weekday)] ?? [];
    }

    /** 悬浮预览：在该天卡片区域展示该天已填写的日目标 */
    private showDayGoalTip(
        task: PrototypeTask,
        entries: TaskDayGoalEntry[],
        weekday: number,
        chipRect: DOMRect,
        index: number,
        span: number,
    ): void {
        const tip = this.dayGoalTipEl;
        const key = `${task.id}:${weekday}`;
        if (this.dayGoalTipKey !== key) {
            const dayKey = makeDayKeyFromWeek(this.weekKey, weekday);
            tip.empty();
            tip.createDiv({
                cls: 'plan-week-daygoal-tip-head',
                text: `${this.formatDayLabel(dayKey)} ${t(WEEKDAY_LABEL_KEYS[weekday - 1])}`,
            });
            for (const entry of entries) {
                const row = tip.createDiv({ cls: 'plan-week-daygoal-tip-item' });
                row.toggleClass('is-done', entry.done === true);
                setIcon(row.createSpan({ cls: 'plan-week-daygoal-tip-icon' }), entry.done ? 'circle-check' : 'circle');
                row.createSpan({ cls: 'plan-week-daygoal-tip-text', text: entry.text });
            }
            this.dayGoalTipKey = key;
        }
        tip.style.display = 'flex';
        // 面板根节点为定位参照：横向对齐悬浮所在天，纵向优先显示在卡片下方，空间不足时翻到上方
        const rootRect = this.element.getBoundingClientRect();
        const columnWidth = chipRect.width / span;
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        const rawLeft = chipRect.left - rootRect.left + columnWidth * index;
        const maxLeft = Math.max(8, rootRect.width - width - 8);
        let top = chipRect.bottom - rootRect.top + 6;
        if (top + height > rootRect.height - 8) top = chipRect.top - rootRect.top - height - 6;
        tip.style.left = `${Math.min(Math.max(rawLeft, 8), maxLeft)}px`;
        tip.style.top = `${Math.max(8, top)}px`;
    }

    /** 隐藏日目标悬浮预览，同时清空内容键以便下次重新渲染 */
    private hideDayGoalTip(): void {
        this.dayGoalTipEl.style.display = 'none';
        this.dayGoalTipKey = undefined;
    }

    /** 点击卡片某天：在卡片旁打开该天该任务的日目标编辑浮层（点击外部 / Esc 关闭） */
    private openDayGoalEditor(
        taskId: string,
        weekday: number,
        chipRect: DOMRect,
        index: number,
        span: number,
    ): void {
        this.closeDayGoalEditor();
        this.hideDayGoalTip();
        const editor = this.element.createDiv({ cls: 'plan-week-daygoal-tip plan-week-daygoal-editor' });
        this.dayGoalEditorEl = editor;
        this.dayGoalEditorKey = `${taskId}:${weekday}`;
        this.dayGoalEditorAnchor = { rect: chipRect, index, span };
        this.dayGoalEditorOutsideHandler = (evt: MouseEvent) => {
            if (!editor.contains(evt.target as Node)) this.closeDayGoalEditor();
        };
        this.dayGoalEditorEscapeHandler = (evt: KeyboardEvent) => {
            if (evt.key !== 'Escape') return;
            // 先关闭浮层，避免同时关闭整个面板
            evt.preventDefault();
            evt.stopPropagation();
            this.closeDayGoalEditor();
        };
        document.addEventListener('mousedown', this.dayGoalEditorOutsideHandler, true);
        document.addEventListener('keydown', this.dayGoalEditorEscapeHandler, true);
        this.renderDayGoalEditor();
    }

    /** 关闭日目标编辑浮层（移除元素与 document 监听） */
    private closeDayGoalEditor(): void {
        if (this.dayGoalEditorOutsideHandler) {
            document.removeEventListener('mousedown', this.dayGoalEditorOutsideHandler, true);
            this.dayGoalEditorOutsideHandler = undefined;
        }
        if (this.dayGoalEditorEscapeHandler) {
            document.removeEventListener('keydown', this.dayGoalEditorEscapeHandler, true);
            this.dayGoalEditorEscapeHandler = undefined;
        }
        this.dayGoalEditorEl?.remove();
        this.dayGoalEditorEl = undefined;
        this.dayGoalEditorKey = undefined;
        this.dayGoalEditorAnchor = undefined;
        this.dayGoalEditorInputEl = undefined;
    }

    /** 重绘编辑浮层（日期行 + 新增输入行 + 日目标列表），并按锚点定位 */
    private renderDayGoalEditor(): void {
        const editor = this.dayGoalEditorEl;
        const key = this.dayGoalEditorKey;
        if (!editor || !key) return;
        const [taskId, weekdayText] = key.split(':');
        const weekday = Number(weekdayText);
        const task = this.panelOptions.getTasks().find((item) => item.id === taskId);
        if (!task) {
            this.closeDayGoalEditor();
            return;
        }
        const dayKey = makeDayKeyFromWeek(this.weekKey, weekday);
        editor.empty();
        editor.createDiv({
            cls: 'plan-week-daygoal-tip-head',
            text: `${this.formatDayLabel(dayKey)} ${t(WEEKDAY_LABEL_KEYS[weekday - 1])}`,
        });
        // 新增行：紧贴日期行下方，回车提交并保持输入焦点，便于连续添加
        const addRow = editor.createDiv({ cls: 'task-week-goal-add-row' });
        const addInput = addRow.createEl('input', {
            cls: 'task-week-goal-add-input',
            attr: { type: 'text', placeholder: t('panel.weekGoalAddPlaceholder') },
        });
        this.dayGoalEditorInputEl = addInput;
        addInput.addEventListener('keydown', (evt) => {
            if (evt.key !== 'Enter') return;
            evt.preventDefault();
            const text = addInput.value.trim();
            if (text) void this.addDayGoal(task, dayKey, text).then(() => this.dayGoalEditorInputEl?.focus());
        });
        const list = editor.createDiv({ cls: 'plan-week-daygoal-editor-list' });
        const entries = task.dayGoals?.[dayKey] ?? [];
        if (entries.length === 0) {
            list.createDiv({ cls: 'plan-week-daygoal-editor-empty', text: t('panel.weekGoalEmpty') });
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
        this.positionDayGoalEditor();
    }

    /** 按卡片锚点定位编辑浮层：横向对齐所在天，纵向优先显示在卡片下方，空间不足时翻到上方 */
    private positionDayGoalEditor(): void {
        const editor = this.dayGoalEditorEl;
        const anchor = this.dayGoalEditorAnchor;
        if (!editor || !anchor) return;
        const rootRect = this.element.getBoundingClientRect();
        const columnWidth = anchor.rect.width / anchor.span;
        const width = editor.offsetWidth;
        const height = editor.offsetHeight;
        const rawLeft = anchor.rect.left - rootRect.left + columnWidth * anchor.index;
        const maxLeft = Math.max(8, rootRect.width - width - 8);
        let top = anchor.rect.bottom - rootRect.top + 6;
        if (top + height > rootRect.height - 8) top = anchor.rect.top - rootRect.top - height - 6;
        editor.style.left = `${Math.min(Math.max(rawLeft, 8), maxLeft)}px`;
        editor.style.top = `${Math.max(8, top)}px`;
    }

    /** 把左侧选中的任务排布到某一天（同时补入本周整周排布） */
    private assignSelectedTaskToDay(weekday: number): void {
        if (!this.selectedTaskId) return;
        this.panelOptions.planAssignmentRepo.add(this.weekKey, weekday, this.selectedTaskId);
        this.panelOptions.planAssignmentRepo.addWeek(this.weekKey, this.selectedTaskId);
        void this.panelOptions.save();
        this.panelOptions.onChanged?.();
        this.renderDayGrid();
        this.renderSummary();
        this.renderTasks();
    }

    /** 本周已整周排布的任务（保持排布顺序，去重并跳过已删除 / 已归档任务） */
    private plannedTasks(): PrototypeTask[] {
        const tasks = this.panelOptions.getTasks();
        const seen = new Set<string>();
        const result: PrototypeTask[] = [];
        for (const assignment of this.panelOptions.planAssignmentRepo.weekAssignments(this.weekKey)) {
            if (seen.has(assignment.taskId)) continue;
            seen.add(assignment.taskId);
            const task = tasks.find((item) => item.id === assignment.taskId);
            if (task) result.push(task);
        }
        return result;
    }

    /** 左侧底栏：选中任务时显示并允许编辑本周描述；未选中任务时显示本周各分类计划时长 */
    private renderBottom(): void {
        this.bottomEl.empty();
        this.descEl = undefined;
        const task = this.selectedTask();
        if (!task) {
            this.renderWeekCategoryBars();
            return;
        }
        const box = this.bottomEl.createDiv({ cls: 'plan-week-desc' });
        box.createDiv({ cls: 'plan-week-desc-title', text: t('panel.planWeekDescription') });
        this.descEl = box.createEl('textarea', {
            cls: 'plan-week-desc-input',
            attr: { placeholder: t('panel.planWeekDescriptionPlaceholder') },
        });
        this.migrateLegacyWeekNote(task);
        this.descEl.value = task.weekGoals?.[this.weekKey] ?? '';
        this.descEl.addEventListener('blur', () => this.saveDescription());
    }

    /** 本周各分类计划时长：时间盒格子按分类累加（每格 1 小时），未匹配到分类的归入未分类 */
    private renderWeekCategoryBars(): void {
        const wrap = this.bottomEl.createDiv({ cls: 'plan-week-cat-bars check-cat-bars' });
        wrap.createDiv({ cls: 'check-cat-bars-title', text: t('panel.planWeekCategoryTitle') });

        const cats = this.panelOptions.getCategories();
        const knownIds = new Set(cats.map((cat) => cat.id));
        const minutesByCat = new Map<string, number>();
        for (const cell of this.panelOptions.timeBoxRepo.weekCells(this.weekKey)) {
            const catId = cell.categoryId && knownIds.has(cell.categoryId)
                ? cell.categoryId
                : UNCATEGORIZED_CATEGORY_ID;
            minutesByCat.set(catId, (minutesByCat.get(catId) ?? 0) + 60);
        }
        const rows = [
            ...cats.map((cat) => ({
                id: cat.id,
                label: cat.label,
                color: cat.color,
                minutes: minutesByCat.get(cat.id) ?? 0,
            })),
            ...(minutesByCat.has(UNCATEGORIZED_CATEGORY_ID)
                ? [{
                    id: UNCATEGORIZED_CATEGORY_ID,
                    label: t('inbox.noCategory'),
                    color: '#888888',
                    minutes: minutesByCat.get(UNCATEGORIZED_CATEGORY_ID) ?? 0,
                }]
                : []),
        ];
        const maxMinutes = Math.max(0, ...rows.map((row) => row.minutes));

        for (const row of rows) {
            const rowEl = wrap.createDiv({ cls: 'check-cat-bars-row' });
            rowEl.createSpan({ cls: 'check-cat-bars-dot' }).style.background = row.color ?? '#888888';
            rowEl.createSpan({ cls: 'check-cat-bars-label', text: row.label });
            const track = rowEl.createDiv({ cls: 'check-cat-bars-track is-plain' });
            track.createDiv({ cls: 'check-cat-bars-fill' }).setCssProps({
                '--fill-color': row.color ?? '#888888',
                '--fill-width': `${maxMinutes > 0 ? (row.minutes / maxMinutes) * 100 : 0}%`,
            });
            rowEl.createSpan({ cls: 'check-cat-bars-value', text: this.formatMinutesShort(row.minutes) });
        }
    }

    /** 分钟数格式化为「Xh」/「Xm」（与检查面板分类时长一致） */
    private formatMinutesShort(minutes: number): string {
        if (minutes >= 60) return `${Number((minutes / 60).toFixed(1))}h`;
        return `${Math.round(minutes)}m`;
    }

    /** 保存本周目标到选中任务的 weekGoals（未选中任务或内容未变化时不写入） */
    private saveDescription(): void {
        const task = this.selectedTask();
        if (!task || !this.descEl) return;
        const next = this.descEl.value.trim();
        if (next === (task.weekGoals?.[this.weekKey] ?? '')) return;
        const goals = { ...(task.weekGoals ?? {}) };
        if (next) goals[this.weekKey] = next;
        else delete goals[this.weekKey];
        if (Object.keys(goals).length > 0) task.weekGoals = goals;
        else delete task.weekGoals;
        void this.panelOptions.save();
        this.panelOptions.onChanged?.();
    }

    /**
     * 旧数据迁移：该周此前按周保存的「本周描述」，
     * 在首次选中任务时转入该任务的本周目标，随后清除旧的周级描述。
     */
    private migrateLegacyWeekNote(task: PrototypeTask): void {
        const repo = this.panelOptions.planAssignmentRepo;
        const legacy = repo.weekNote(this.weekKey);
        if (!legacy) return;
        if (!task.weekGoals?.[this.weekKey]) {
            task.weekGoals = { ...(task.weekGoals ?? {}), [this.weekKey]: legacy };
        }
        repo.setWeekNote(this.weekKey, '');
        void this.panelOptions.save();
        this.panelOptions.onChanged?.();
    }

    /** 新增日目标（写入选中任务的 dayGoals，与任务详情「一周目标」共享） */
    private async addDayGoal(task: PrototypeTask, dayKey: string, text: string): Promise<void> {
        const entry: TaskDayGoalEntry = {
            id: `dgoal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text,
            createdAt: Date.now(),
        };
        task.dayGoals = { ...(task.dayGoals ?? {}) };
        task.dayGoals[dayKey] = [...(task.dayGoals[dayKey] ?? []), entry];
        await this.panelOptions.save();
        this.panelOptions.onChanged?.();
        this.afterDayGoalChanged();
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
        await this.panelOptions.save();
        this.panelOptions.onChanged?.();
        this.afterDayGoalChanged();
    }

    /** 删除日目标 */
    private async removeDayGoal(task: PrototypeTask, dayKey: string, entryId: string): Promise<void> {
        const list = task.dayGoals?.[dayKey];
        if (!list) return;
        const next = list.filter((item) => item.id !== entryId);
        if (next.length > 0) task.dayGoals![dayKey] = next;
        else delete task.dayGoals![dayKey];
        await this.panelOptions.save();
        this.panelOptions.onChanged?.();
        this.afterDayGoalChanged();
    }

    /** 日目标变更后刷新相关区域：七列卡片标识 + 编辑浮层内容 */
    private afterDayGoalChanged(): void {
        this.renderDayGrid();
        if (this.dayGoalEditorEl) this.renderDayGoalEditor();
    }

    /** 当前选中并绑定日目标的任务 */
    private selectedTask(): PrototypeTask | undefined {
        if (!this.selectedTaskId) return undefined;
        return this.panelOptions.getTasks().find((task) => task.id === this.selectedTaskId);
    }

    /** 当前周的日期范围文案（如 11/03 - 11/09） */
    private formatWeekRange(): string {
        const monday = makeDayKeyFromWeek(this.weekKey, 1);
        const sunday = makeDayKeyFromWeek(this.weekKey, 7);
        const format = (dayKey: string): string =>
            `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`;
        return `${format(monday)} - ${format(sunday)}`;
    }
}
