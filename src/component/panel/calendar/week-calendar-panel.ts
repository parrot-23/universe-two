// 周历面板：基于 FloatingPanel 的日历式展示。
// 结构：顶部窄条一行（第一列为 PLAN/CHECK，其余六列为 ACT），下方一行 × 七列日期格子（周一至周日），
// 最下方为内容区：左侧本日目标（当天排布任务及其日目标）、右侧本周排布的任务。
import { setIcon } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import type { PlanAssignmentRepo } from '../../../repos/plan-assignment-repo';
import type { PlanCategory } from '../../../shared/plan-category-manager';
import { getCurrentDayKey, getCurrentWeekKey, getISOWeek, makeDayKeyFromWeek, makeWeekKey } from '../../../shared/plan-data';
import { getDayGoalEntries } from '../../../shared/task-sections';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 周历面板配置 */
export interface WeekCalendarPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「周历」 */
    title?: string;
    /** 起始周键（第一行），默认本周 */
    startWeekKey?: string;
    /** 需要高亮的日期键（默认今天） */
    highlightDayKey?: string;
    /** 任务数据源（内容方框展示本周任务用） */
    getTasks?: () => PrototypeTask[];
    /** 分类数据源（任务前的分类色点） */
    getCategories?: () => PlanCategory[];
    /** 计划排布仓库（读取该周整周排布的任务） */
    planAssignmentRepo?: PlanAssignmentRepo;
}

/** 顶部窄条每列的文案：首列 PLAN/CHECK，其余 ACT */
const STRIP_LABELS = ['PLAN/CHECK', 'ACT', 'ACT', 'ACT', 'ACT', 'ACT', 'ACT'];

/** 任务卡片高度（px），与 styles.css 中 .week-calendar-cell-task 保持一致 */
const TASK_CARD_HEIGHT = 16;

/** 任务卡片之间的间距（px） */
const TASK_CARD_GAP = 3;

/** 日期格子内日期文字占用的高度（px），用于计算格子最小高度 */
const CELL_DATE_HEIGHT = 20;

/** 周历面板 */
export class WeekCalendarPanel extends FloatingPanel {
    /** 当前展示的周键 */
    private startWeekKey: string;
    /** 当前高亮的日期键（未设置时高亮今天） */
    private highlightDayKey?: string;
    /** 面板配置（内容方框的数据源） */
    private readonly panelOptions: WeekCalendarPanelOptions;

    constructor(options: WeekCalendarPanelOptions = {}) {
        super({
            width: 560,
            title: options.title ?? t('panel.weekCalendarTitle'),
            ...options,
        });
        this.panelOptions = options;
        this.startWeekKey = options.startWeekKey ?? getCurrentWeekKey();
        this.highlightDayKey = options.highlightDayKey;
        this.renderCalendar();
    }

    /** 重新渲染 */
    refresh(): void {
        this.body.empty();
        this.renderCalendar();
    }

    /** 切换展示的周并高亮指定日期（不传则高亮今天） */
    showWeek(weekKey: string, highlightDayKey?: string): void {
        this.startWeekKey = weekKey;
        this.highlightDayKey = highlightDayKey;
        this.refresh();
    }

    /** 渲染顶部窄条 + 一行七列日期格子 */
    private renderCalendar(): void {
        const body = this.body;
        body.addClass('week-calendar-panel');
        const grid = body.createDiv({ cls: 'week-calendar-grid' });

        // 第一行：顶部窄条（每列一条，与下方格子对齐）
        for (let col = 0; col < 7; col++) {
            const strip = grid.createDiv({ cls: 'week-calendar-strip' });
            strip.setText(STRIP_LABELS[col]);
            if (col === 0) strip.addClass('is-plan-check');
        }

        const highlightKey = this.highlightDayKey ?? getCurrentDayKey();
        const tasks = this.panelOptions.getTasks?.() ?? [];
        const byId = new Map(tasks.map((task) => [task.id, task]));
        const categories = this.panelOptions.getCategories?.() ?? [];

        // 任务卡片层：绝对定位覆盖在日期格子上，同一任务连续多天合并为一条跨列卡片
        const segments = this.buildDaySegments(byId);
        const lanes = this.assignLanes(segments);
        // 卡片区域高度：按泳道数撑开，日期格子高度跟随它，保证能容纳所有卡片
        const cardsHeight = lanes * TASK_CARD_HEIGHT + (lanes + 1) * TASK_CARD_GAP;

        // 日期格子：只保留一行（周一至周日），高度与卡片区域一致
        for (let col = 0; col < 7; col++) {
            const dayKey = makeDayKeyFromWeek(this.startWeekKey, col + 1);
            const cell = grid.createDiv({ cls: 'week-calendar-cell' });
            if (dayKey === highlightKey) cell.addClass('is-today');
            cell.style.minHeight = `${cardsHeight + CELL_DATE_HEIGHT}px`;
            cell.createDiv({ cls: 'week-calendar-cell-date', text: String(Number(dayKey.slice(8, 10))) });
        }

        const layer = grid.createDiv({ cls: 'week-calendar-task-layer' });
        layer.style.height = `${cardsHeight}px`;
        for (const segment of segments) {
            const chip = layer.createDiv({ cls: 'week-calendar-cell-task' });
            // 横向：按列宽百分比定位（7 列等分），跨列时宽度为 span 列
            const left = (segment.start - 1) * (100 / 7);
            const width = (segment.end - segment.start + 1) * (100 / 7);
            chip.style.left = `calc(${left}% + ${TASK_CARD_GAP}px)`;
            chip.style.width = `calc(${width}% - ${TASK_CARD_GAP * 2}px)`;
            // 纵向：按泳道序号堆叠
            chip.style.top = `${TASK_CARD_GAP + segment.lane * (TASK_CARD_HEIGHT + TASK_CARD_GAP)}px`;
            chip.title = segment.task.name;
            // 分类淡色背景 + 任务名称
            const color = categories.find((category) => category.id === segment.task.categoryId)?.color ?? '#888888';
            chip.style.setProperty('--week-calendar-task-color', color);
            chip.createSpan({ cls: 'week-calendar-cell-task-name', text: segment.task.name });
        }

        this.renderTaskBox(body);
    }

    /** 本周按天排布的任务区段：同一任务连续的天合并为一段，不连续的拆成多段 */
    private buildDaySegments(byId: Map<string, PrototypeTask>): {
        task: PrototypeTask;
        start: number;
        end: number;
        lane: number;
    }[] {
        const weekdaysByTask = new Map<string, number[]>();
        for (let weekday = 1; weekday <= 7; weekday += 1) {
            const assignments = this.panelOptions.planAssignmentRepo?.dayAssignments(this.startWeekKey, weekday) ?? [];
            for (const assignment of assignments) {
                if (!byId.has(assignment.taskId)) continue;
                const days = weekdaysByTask.get(assignment.taskId) ?? [];
                days.push(weekday);
                weekdaysByTask.set(assignment.taskId, days);
            }
        }

        const segments: { task: PrototypeTask; start: number; end: number; lane: number }[] = [];
        weekdaysByTask.forEach((days, taskId) => {
            const task = byId.get(taskId);
            if (!task) return;
            const sorted = days.slice().sort((a, b) => a - b)
                .filter((day, index, list) => index === 0 || day !== list[index - 1]);
            let start = sorted[0];
            let prev = sorted[0];
            for (let i = 1; i < sorted.length; i += 1) {
                const day = sorted[i];
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
        return segments;
    }

    /** 依次把区段放入第一条不冲突的泳道，避免卡片互相覆盖；返回泳道总数 */
    private assignLanes(segments: { start: number; end: number; lane: number }[]): number {
        segments.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
        const lanes: { start: number; end: number }[][] = [];
        for (const segment of segments) {
            let lane = 0;
            while (lanes[lane]?.some((item) => !(item.end < segment.start || item.start > segment.end))) {
                lane += 1;
            }
            (lanes[lane] ??= []).push({ start: segment.start, end: segment.end });
            segment.lane = lane;
        }
        return lanes.length;
    }

    /** 底部内容区：左右分栏，左侧本日目标、右侧本周任务 */
    private renderTaskBox(parentEl: HTMLElement): void {
        const boxes = parentEl.createDiv({ cls: 'week-calendar-boxes' });
        this.renderDayGoalBox(boxes);
        this.renderWeekTaskBox(boxes);
    }

    /** 本日目标方框：列出当天排布的任务，任务下缩进展示该天填写的日目标；没有日目标的任务只显示名称 */
    private renderDayGoalBox(parentEl: HTMLElement): void {
        const box = parentEl.createDiv({ cls: 'week-calendar-task-box week-calendar-daygoal-box' });
        box.createDiv({ cls: 'week-calendar-task-box-title', text: t('panel.weekCalendarDayGoals') });

        const dayKey = this.highlightDayKey ?? getCurrentDayKey();
        const tasks = this.panelOptions.getTasks?.() ?? [];
        const byId = new Map(tasks.map((task) => [task.id, task]));
        const categories = this.panelOptions.getCategories?.() ?? [];
        // 按日期自身推算所在的周与星期：高亮日期可能不在当前展示的周内，需与工具栏日期保持一致
        const date = new Date(
            Number(dayKey.slice(0, 4)),
            Number(dayKey.slice(5, 7)) - 1,
            Number(dayKey.slice(8, 10)),
        );
        const weekKey = makeWeekKey(date.getFullYear(), getISOWeek(date));
        const weekday = date.getDay() || 7;
        const dayTasks = (this.panelOptions.planAssignmentRepo?.dayAssignments(weekKey, weekday) ?? [])
            .map((assignment) => byId.get(assignment.taskId))
            .filter((task): task is PrototypeTask => task !== undefined);

        if (dayTasks.length === 0) {
            box.createDiv({ cls: 'week-calendar-task-empty', text: t('panel.weekCalendarNoDayTask') });
            return;
        }

        for (const task of dayTasks) {
            const item = box.createDiv({ cls: 'week-calendar-task-item' });
            const head = item.createDiv({ cls: 'week-calendar-task-head' });
            const dot = head.createSpan({ cls: 'week-calendar-task-dot' });
            dot.style.background = categories.find((category) => category.id === task.categoryId)?.color
                ?? '#888888';
            head.createSpan({ cls: 'week-calendar-task-name', text: task.name });
            for (const goal of getDayGoalEntries(task, dayKey)) {
                const row = item.createDiv({ cls: 'week-calendar-task-goal week-calendar-day-goal' });
                if (goal.done) row.addClass('is-done');
                setIcon(
                    row.createSpan({ cls: 'week-calendar-task-goal-icon' }),
                    goal.done ? 'circle-check' : 'circle',
                );
                row.createSpan({ cls: 'week-calendar-task-goal-text', text: goal.text });
            }
        }
    }

    /** 本周任务方框：本周（年视图周格子）任务，任务下缩进列出祖先任务绑定到该任务的目标 */
    private renderWeekTaskBox(parentEl: HTMLElement): void {
        const box = parentEl.createDiv({ cls: 'week-calendar-task-box' });
        box.createDiv({ cls: 'week-calendar-task-box-title', text: t('panel.weekCalendarTasks') });

        const tasks = this.panelOptions.getTasks?.() ?? [];
        const byId = new Map(tasks.map((task) => [task.id, task]));
        const categories = this.panelOptions.getCategories?.() ?? [];
        const assignments = this.panelOptions.planAssignmentRepo?.weekAssignments(this.startWeekKey) ?? [];
        const weekTasks = assignments
            .map((assignment) => byId.get(assignment.taskId))
            .filter((task): task is PrototypeTask => task !== undefined);

        if (weekTasks.length === 0) {
            box.createDiv({ cls: 'week-calendar-task-empty', text: t('panel.weekCalendarNoTask') });
            return;
        }

        for (const task of weekTasks) {
            const item = box.createDiv({ cls: 'week-calendar-task-item' });
            const head = item.createDiv({ cls: 'week-calendar-task-head' });
            const dot = head.createSpan({ cls: 'week-calendar-task-dot' });
            dot.style.background = categories.find((category) => category.id === task.categoryId)?.color
                ?? '#888888';
            head.createSpan({ cls: 'week-calendar-task-name', text: task.name });
        }
    }
}
