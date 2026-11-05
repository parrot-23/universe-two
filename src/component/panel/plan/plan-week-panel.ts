// 计划一周面板：左右结构。
// 左侧：周信息摘要（周数 / 日期范围 / 任务数）+ 本周已整周排布的任务列表，
//       点击任务条目选中它，作为右侧本周目标与日目标的绑定任务（再次点击取消选中）。
// 右侧：顶部周切换（上一周 / 周数 + 日期范围 / 下一周），
//       下方左侧方框为本周目标（多行文本域，失焦保存，按选中任务 + 周键独立存储），
//       下方右侧为周一到周日 7 个方框，编辑选中任务在该周的日目标
//       （数据与任务详情「一周目标」选项卡共享 task.dayGoals）。
import { setIcon } from 'obsidian';

import type { TaskStatus } from '../../../datatypes/domain';
import type { PrototypeTask, TaskDayGoalEntry } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import type { PlanAssignmentRepo } from '../../../repos/plan-assignment-repo';
import type { TaskExecutionRepo } from '../../../repos/task-execution-repo';
import type { PlanCategory } from '../../../shared/plan-category-manager';
import {
    getCurrentDayKey,
    getCurrentWeekKey,
    makeDayKey,
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
    /** 分类数据源（任务名称前的分类颜色圆点） */
    getCategories: () => PlanCategory[];
    /** 执行记录仓库（图表统计选中任务近 14 天的执行时长） */
    taskExecutionRepo: TaskExecutionRepo;
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
    private descEl!: HTMLTextAreaElement;
    private dayListEl!: HTMLElement;
    /** 已选任务名称（周切换行下方、本周描述方框上方） */
    private selectedEl!: HTMLElement;
    /** 近 14 天执行时长柱形图方框（本周描述方框下方） */
    private chartEl!: HTMLElement;
    /** 左侧顶部两个模式按钮（排布一周 / 填写日目标） */
    private scheduleButtonEl!: HTMLButtonElement;
    private dayGoalButtonEl!: HTMLButtonElement;
    /** 右侧内容区（填写日目标模式：描述 + 图表 + 每日目标） */
    private contentEl!: HTMLElement;
    /** 右侧七列网格（排布一周模式：选中左侧任务后点击某天排布） */
    private dayGridEl!: HTMLElement;
    /** 当前模式：排布一周（默认，七列任务排布）/ 填写日目标 */
    private viewMode: 'schedule' | 'dayGoal' = 'schedule';

    /** 当前显示的周键 */
    private weekKey: string;
    /** 左侧选中的任务 id（右侧日目标的绑定任务） */
    private selectedTaskId: string | undefined;

    constructor(private readonly panelOptions: PlanWeekPanelOptions) {
        super({
            width: 1000,
            title: panelOptions.title ?? t('panel.planWeekTitle'),
            ...panelOptions,
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

    private renderLayout(): void {
        // 左侧：顶部模式按钮 + 周信息摘要 + 本周已排布任务列表
        const left = this.body.createDiv({ cls: 'plan-week-left' });
        const leftTop = left.createDiv({ cls: 'plan-week-left-top' });
        this.scheduleButtonEl = this.createModeButton(leftTop, 'calendar-range', t('panel.planWeekModeSchedule'));
        this.scheduleButtonEl.addEventListener('click', () => this.switchMode('schedule'));
        this.dayGoalButtonEl = this.createModeButton(leftTop, 'list-todo', t('panel.planWeekModeDayGoal'));
        this.dayGoalButtonEl.addEventListener('click', () => this.switchMode('dayGoal'));
        this.summaryEl = left.createDiv({ cls: 'plan-week-summary' });
        this.taskListEl = left.createDiv({ cls: 'plan-week-task-list' });

        // 右侧：周切换行（左侧周切换 + 右侧已选任务名称）+ 内容区 / 七列网格
        const right = this.body.createDiv({ cls: 'plan-week-right' });
        const navRow = right.createDiv({ cls: 'plan-week-nav-row' });
        this.navEl = navRow.createDiv({ cls: 'task-week-goal-nav' });
        // 已选任务名称：与周切换按钮同一行，靠右显示
        this.selectedEl = navRow.createDiv({ cls: 'plan-week-selected' });
        const content = right.createDiv({ cls: 'plan-week-content' });
        this.contentEl = content;

        // 左侧列：本周描述方框 + 近 14 天执行时长柱形图方框
        const side = content.createDiv({ cls: 'plan-week-side' });
        // 本周具体描述：多行文本域，失焦保存
        const descBox = side.createDiv({ cls: 'plan-week-desc' });
        descBox.createDiv({ cls: 'plan-week-desc-title', text: t('panel.planWeekDescription') });
        this.descEl = descBox.createEl('textarea', {
            cls: 'plan-week-desc-input',
            attr: { placeholder: t('panel.planWeekDescriptionPlaceholder') },
        });
        this.descEl.addEventListener('blur', () => this.saveDescription());
        // 近 14 天执行时长柱形图：绘制选中任务每天的累计执行时长
        this.chartEl = side.createDiv({ cls: 'plan-week-chart' });

        // 每日具体目标：与任务详情「一周目标」样式一致
        this.dayListEl = content.createDiv({ cls: 'plan-week-days' });

        // 七列网格（排布一周模式）：选中左侧任务后点击某天排布，与习惯面板周视图的网格样式一致
        this.dayGridEl = right.createDiv({ cls: 'plan-week-day-grid' });

        this.syncMode();
        this.renderAll();
    }

    /** 切换模式：填写日目标（描述 + 图表 + 每日目标）/ 排布一周（七列任务排布） */
    private switchMode(mode: 'schedule' | 'dayGoal'): void {
        if (this.viewMode === mode) return;
        this.viewMode = mode;
        this.syncMode();
        this.renderAll();
    }

    /** 按当前模式显示 / 隐藏内容区与七列网格，并同步按钮激活态 */
    private syncMode(): void {
        this.contentEl.toggleClass('is-hidden', this.viewMode !== 'dayGoal');
        this.dayGridEl.toggleClass('is-hidden', this.viewMode !== 'schedule');
        this.scheduleButtonEl.toggleClass('is-active', this.viewMode === 'schedule');
        this.dayGoalButtonEl.toggleClass('is-active', this.viewMode === 'dayGoal');
    }

    /** 左侧顶部的模式按钮（图标 + 文字） */
    private createModeButton(parentEl: HTMLElement, icon: string, label: string): HTMLButtonElement {
        const button = parentEl.createEl('button', { cls: 'plan-week-mode-btn', attr: { type: 'button' } });
        setIcon(button.createSpan({ cls: 'plan-week-mode-btn-icon' }), icon);
        button.createSpan({ cls: 'plan-week-mode-btn-label', text: label });
        return button;
    }

    /** 重绘全部区域（周切换后调用） */
    private renderAll(): void {
        this.renderNav();
        this.renderSummary();
        this.renderTasks();
        this.renderDescription();
        this.renderDays();
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
        this.renderChart();
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
                this.renderDescription();
                this.renderDays();
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

    /** 近 14 天执行时长柱形图：每天一根柱，柱高按当天累计执行时长占最大值的比例 */
    private renderChart(): void {
        this.chartEl.empty();
        const head = this.chartEl.createDiv({ cls: 'plan-week-chart-head' });
        head.createSpan({ cls: 'plan-week-chart-title', text: t('panel.planWeekChartTitle') });
        const task = this.selectedTask();
        if (!task) {
            this.chartEl.createDiv({ cls: 'plan-week-chart-empty', text: t('panel.planWeekNoTask') });
            return;
        }
        // 最近 14 天（含今天），按日键聚合执行记录
        const days: string[] = [];
        const today = new Date();
        for (let offset = 13; offset >= 0; offset -= 1) {
            days.push(makeDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)));
        }
        const secondsByDay: Record<string, number> = {};
        for (const record of this.panelOptions.taskExecutionRepo.records) {
            if (record.taskId !== task.id) continue;
            const dayKey = makeDayKey(new Date(record.startAt));
            if (!days.includes(dayKey)) continue;
            secondsByDay[dayKey] = (secondsByDay[dayKey] ?? 0) + record.durationSeconds;
        }
        const values = days.map((dayKey) => secondsByDay[dayKey] ?? 0);
        const max = Math.max(1, ...values);
        const total = values.reduce((sum, value) => sum + value, 0);
        head.createSpan({ cls: 'plan-week-chart-total', text: this.formatDuration(total) });
        const body = this.chartEl.createDiv({ cls: 'plan-week-chart-body' });
        for (let index = 0; index < days.length; index += 1) {
            const column = body.createDiv({ cls: 'plan-week-chart-col' });
            column.title = `${this.formatDayLabel(days[index])} · ${this.formatDuration(values[index])}`;
            const bar = column.createDiv({ cls: 'plan-week-chart-bar' });
            if (values[index] <= 0) {
                bar.addClass('is-empty');
                bar.style.height = '2px';
            } else {
                bar.style.height = `${Math.max(2, (values[index] / max) * 100)}%`;
            }
        }
        const foot = this.chartEl.createDiv({ cls: 'plan-week-chart-foot' });
        foot.createSpan({ text: this.formatDayLabel(days[0]) });
        foot.createSpan({ text: this.formatDayLabel(days[days.length - 1]) });
    }

    /** 秒数格式化为「Xh Ym」/「Xm」 */
    private formatDuration(seconds: number): string {
        if (seconds <= 0) return '0m';
        const totalMinutes = Math.max(1, Math.round(seconds / 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    /** 日键（YYYY-MM-DD）格式化为 M/D */
    private formatDayLabel(dayKey: string): string {
        return `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`;
    }


    /** 七列网格：表头 7 格（星期 + 日期），表体按天显示已排布的任务卡片 */
    private renderDayGrid(): void {
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

    /** 渲染一段跨列任务卡片（第一行父层级，第二行任务名；每列一个删除按钮） */
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
        chip.addEventListener('click', (evt) => evt.stopPropagation());
        // 每一列各自一个删除按钮，位置对齐该列右上角；只删除该列的排布
        const delButtons: HTMLElement[] = [];
        for (let offset = 0; offset < span; offset += 1) {
            const weekday = start + offset;
            const del = chip.createSpan({ cls: 'plan-week-task-chip-del plan-week-span-del', text: '×' });
            del.style.right = `calc(${((span - offset - 1) * 100) / span}% + 2px)`;
            del.addEventListener('click', (evt) => {
                evt.stopPropagation();
                this.panelOptions.planAssignmentRepo.remove(this.weekKey, weekday, task.id);
                void this.panelOptions.save();
                this.panelOptions.onChanged?.();
                this.renderDayGrid();
            });
            delButtons.push(del);
        }
        // 鼠标位于卡片内某一列区域时，只显示该列的删除按钮
        chip.addEventListener('mousemove', (evt) => {
            const rect = chip.getBoundingClientRect();
            const columnWidth = rect.width / span;
            const index = Math.max(0, Math.min(span - 1, Math.floor((evt.clientX - rect.left) / columnWidth)));
            delButtons.forEach((button, i) => button.toggleClass('is-visible', i === index));
        });
        chip.addEventListener('mouseleave', () => {
            delButtons.forEach((button) => button.removeClass('is-visible'));
        });
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

    /** 本周目标：按当前选中任务与当前周读取；未选中任务时禁用并提示先选择任务 */
    private renderDescription(): void {
        const task = this.selectedTask();
        this.descEl.disabled = !task;
        this.descEl.toggleClass('is-disabled', !task);
        if (!task) {
            this.descEl.value = '';
            this.descEl.placeholder = t('panel.planWeekNoTask');
            return;
        }
        this.descEl.placeholder = t('panel.planWeekDescriptionPlaceholder');
        this.migrateLegacyWeekNote(task);
        this.descEl.value = task.weekGoals?.[this.weekKey] ?? '';
    }

    /** 保存本周目标到选中任务的 weekGoals（未选中任务或内容未变化时不写入） */
    private saveDescription(): void {
        const task = this.selectedTask();
        if (!task) return;
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

    /** 未选中任务时显示提示，选中后渲染周一到周日 7 个方框 */
    private renderDays(): void {
        this.dayListEl.empty();
        const task = this.selectedTask();
        if (!task) {
            this.dayListEl.createDiv({ cls: 'plan-week-days-empty', text: t('panel.planWeekNoTask') });
            return;
        }
        for (let day = 1; day <= 7; day += 1) {
            const dayKey = makeDayKeyFromWeek(this.weekKey, day);
            this.renderDay(task, dayKey, day, t(WEEKDAY_LABEL_KEYS[day - 1]));
        }
    }

    /** 单日方框：左侧星期标题（右上角 + 按钮），右侧日目标勾选列表；未排布到该天时整体禁用 */
    private renderDay(task: PrototypeTask, dayKey: string, weekday: number, weekdayLabel: string): void {
        const scheduled = this.panelOptions.planAssignmentRepo.dayAssignments(this.weekKey, weekday)
            .some((assignment) => assignment.taskId === task.id);
        const box = this.dayListEl.createDiv({ cls: 'task-week-goal-day' });
        if (dayKey === getCurrentDayKey()) box.addClass('is-today');
        box.toggleClass('is-disabled', !scheduled);

        const head = box.createDiv({ cls: 'task-week-goal-day-head' });
        head.createSpan({ cls: 'task-week-goal-day-name', text: weekdayLabel });
        head.createSpan({
            cls: 'task-week-goal-day-date',
            text: `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`,
        });

        const body = box.createDiv({ cls: 'task-week-goal-day-body' });
        const toolbar = body.createDiv({ cls: 'task-week-goal-day-toolbar' });
        const toolbarLabel = toolbar.createSpan({
            cls: 'task-week-goal-day-toolbar-label',
            text: scheduled ? t('panel.planWeekDayScheduled') : t('panel.planWeekDayNotScheduled'),
        });
        toolbarLabel.toggleClass('is-scheduled', scheduled);
        const addBtn = toolbar.createEl('button', {
            cls: 'task-week-goal-day-add',
            attr: { type: 'button', 'aria-label': t('common.add') },
        });
        setIcon(addBtn, 'plus');
        addBtn.disabled = !scheduled;
        if (scheduled) addBtn.addEventListener('click', () => this.startAddDayGoal(task, body, dayKey));

        body.createDiv({ cls: 'task-week-goal-day-divider' });

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
            checkbox.disabled = !scheduled;
            if (scheduled) {
                checkbox.addEventListener('change', () => {
                    void this.toggleDayGoal(task, dayKey, entry.id, checkbox.checked);
                });
            }
            row.createSpan({ cls: 'task-week-goal-item-text', text: entry.text });
            const delBtn = row.createEl('button', {
                cls: 'task-week-goal-item-delete',
                attr: { type: 'button', 'aria-label': t('common.delete') },
            });
            setIcon(delBtn, 'x');
            delBtn.disabled = !scheduled;
            if (scheduled) delBtn.addEventListener('click', () => void this.removeDayGoal(task, dayKey, entry.id));
        }
    }

    /** 在列表末尾插入一个输入行，回车 / 失焦提交，Esc 取消 */
    private startAddDayGoal(task: PrototypeTask, body: HTMLElement, dayKey: string): void {
        // 已有输入行时不重复创建，直接聚焦
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
            else this.renderDays();
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
        this.renderDays();
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
        this.renderDays();
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
        this.renderDays();
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
