// 今日任务卡片：界面视图编辑模式下通过「添加」面板加入。
// 结构：< 日期 >（第二行标签：第x周 / 周x / 几天前）+ 习惯 / 当天任务 / 额外任务三个可折叠列表，
// 底部为「开始任务 / 新增任务 / 记录任务」按钮组（与今日时钟卡片共用同一进行中任务）。
import { setIcon } from 'obsidian';
import type { Plugin } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import { TaskPickerPanel } from '../../panel/task/task-picker-panel';
import { TaskRecordPanel } from '../../panel/task/task-record-panel';
import type { PdcaRepo } from '../../../repos/pdca-repo';
import type { CategoryRepo } from '../../../repos/category-repo';
import type { PlanAssignmentRepo } from '../../../repos/plan-assignment-repo';
import type { PrototypeTaskRepo } from '../../../repos/prototype-task-repo';
import type { TaskExecutionRepo } from '../../../repos/task-execution-repo';
import { getCurrentDayKey, getISOWeek, makeDayKey, makeWeekKey } from '../../../shared/plan-data';
import { getDayGoalEntries, getTaskHabit } from '../../../shared/task-sections';

/** 当天 0 点 */
function startOfToday(): Date {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
}

/** 指定日期 0 点 */
function startOfDay(date: Date): Date {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
}

/** 周一至周日的文案 key */
const WEEKDAY_KEYS = [
    'week.monday',
    'week.tuesday',
    'week.wednesday',
    'week.thursday',
    'week.friday',
    'week.saturday',
    'week.sunday',
] as const;

/** 三个折叠分区 */
type SectionKey = 'habit' | 'planned' | 'extra';

/** 今日任务卡片配置 */
export interface TodayTasksCardOptions {
    plugin: Plugin;
    /** 初始查看日期（界面统一日期） */
    initialDate?: Date;
    /** 卡片内切换日期后回调（同步界面统一日期） */
    onSelectedDateChange?: (date: Date) => void;
    /** 进行中任务变化（开始 / 结束 / 放弃）后通知，用于同步今日时钟卡片 */
    onRunningTaskChanged?: () => void;
    /** 执行记录变化后通知，用于刷新今日时钟外环 */
    onExecutionChanged?: () => void;
    /** 额外任务变化后通知，用于刷新今日时钟的任务列表 */
    onTasksChanged?: () => void;
    /** 点击任务条目：打开任务板块面板 */
    onOpenTaskBoard?: (taskId: string) => void;
}

export class TodayTasksCard {
    private readonly options: TodayTasksCardOptions;
    /** 卡片容器 */
    private containerEl: HTMLElement | null = null;
    /** 当前查看的日期（默认今天，仅可回看过去） */
    private selectedDate: Date = startOfToday();
    /** 三个分区的展开状态（默认全部展开） */
    private expanded: Record<SectionKey, boolean> = { habit: true, planned: true, extra: true };
    /** 当前查看日期的任务执行统计（次数 / 秒数），渲染前刷新 */
    private executionStats = new Map<string, { count: number; seconds: number }>();
    /** 「进行中的任务」折叠行是否展开（默认展开） */
    private runningExpanded = true;
    /** 进行中任务的计时刷新句柄 */
    private runningTimerHandle: number | null = null;
    /** 进行中任务的时长文本节点 */
    private runningElapsedEl: HTMLElement | null = null;
    /** 任务选择面板（复用同一实例） */
    private taskPickerPanel: TaskPickerPanel | null = null;
    /** 任务记录面板 */
    private recordPanel: TaskRecordPanel | null = null;

    constructor(options: TodayTasksCardOptions) {
        this.options = options;
        if (options.initialDate) this.selectedDate = startOfDay(options.initialDate);
    }

    private get plugin(): Plugin {
        return this.options.plugin;
    }

    private get prototypeTaskRepo(): PrototypeTaskRepo {
        return (this.plugin as Plugin & { prototypeTaskRepo: PrototypeTaskRepo }).prototypeTaskRepo;
    }

    private get planAssignmentRepo(): PlanAssignmentRepo {
        return (this.plugin as Plugin & { planAssignmentRepo: PlanAssignmentRepo }).planAssignmentRepo;
    }

    private get taskExecutionRepo(): TaskExecutionRepo {
        return (this.plugin as Plugin & { taskExecutionRepo: TaskExecutionRepo }).taskExecutionRepo;
    }

    /** PDCA 领域仓库（读写进行中任务） */
    private get pdcaRepo(): PdcaRepo {
        return (this.plugin as Plugin & { pdcaRepo: PdcaRepo }).pdcaRepo;
    }

    /** 分类仓库（任务条目前的分类色点） */
    private get categoryRepo(): CategoryRepo {
        return (this.plugin as Plugin & { categoryRepo: CategoryRepo }).categoryRepo;
    }

    /** 唯一持久化出口 */
    private saveAll(): Promise<void> {
        return (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
    }

    /** 在指定容器内渲染卡片 */
    render(parentEl: HTMLElement): void {
        this.containerEl = parentEl.createDiv({ cls: 'interface-today-tasks-card' });
        this.renderContent();
    }

    /** 外部数据变化后刷新（卡片不在 DOM 中时跳过） */
    refresh(): void {
        if (this.containerEl?.isConnected) this.renderContent();
    }

    /** 外部切换查看日期（界面统一日期广播调用，右边界为今天） */
    setSelectedDate(date: Date): void {
        const next = startOfDay(date);
        if (next.getTime() > startOfToday().getTime()) return;
        if (next.getTime() === this.selectedDate.getTime()) return;
        this.selectedDate = next;
        this.refresh();
    }

    private renderContent(): void {
        const card = this.containerEl;
        if (!card) return;
        this.stopRunningTicker();
        card.empty();
        this.renderNav(card);

        const habit = this.habitTasks();
        const planned = this.plannedTasks();
        const extra = this.extraTasks();
        // 渲染前刷新当天各任务的执行统计（次数 / 时长），供条目上的胶囊标签使用
        this.executionStats = this.buildExecutionStats();

        const body = card.createDiv({ cls: 'interface-today-tasks-body' });
        this.renderRunningSection(body);
        this.renderSection(body, 'habit', t('interface.todayHabitTitle'), habit);
        this.renderSection(body, 'planned', t('interface.todayPlannedTitle'), planned);
        this.renderSection(body, 'extra', t('interface.todayExtraTitle'), extra, () => this.openTaskPicker());
    }

    /** 最上方的「进行中的任务」折叠行：任务名称 + 开始时间 / 累计时长 + 完成 / 放弃 */
    private renderRunningSection(body: HTMLElement): void {
        const running = this.pdcaRepo.runningTask;
        if (!running || !this.isTodaySelected() || typeof running.startedAt !== 'number') return;
        const task = this.prototypeTaskRepo.tasks.find((item) => item.id === running.inboxId);
        if (!task) return;

        const section = body.createDiv({ cls: 'interface-today-tasks-section interface-today-tasks-running' });
        const head = section.createDiv({ cls: 'interface-today-tasks-section-head' });
        const chevron = head.createSpan({ cls: 'interface-today-tasks-section-chevron' });
        setIcon(chevron, this.runningExpanded ? 'chevron-down' : 'chevron-right');
        head.createSpan({ cls: 'interface-today-tasks-section-title', text: t('interface.todayRunningTitle') });
        head.addEventListener('click', () => {
            this.runningExpanded = !this.runningExpanded;
            this.renderContent();
        });
        if (!this.runningExpanded) return;

        const list = section.createDiv({ cls: 'interface-today-tasks-list' });
        const row = list.createDiv({ cls: 'interface-today-tasks-item interface-today-tasks-running-item' });
        row.title = task.name;
        row.addEventListener('click', () => this.options.onOpenTaskBoard?.(task.id));
        row.createSpan({ cls: 'interface-today-tasks-item-name', text: task.name });
        row.createSpan({
            cls: 'interface-today-tasks-running-start',
            text: this.formatClockTime(new Date(running.startedAt)),
        });
        this.runningElapsedEl = row.createSpan({
            cls: 'interface-today-tasks-running-elapsed',
            text: this.formatElapsed(Date.now() - running.startedAt),
        });

        const actions = row.createDiv({ cls: 'interface-today-tasks-item-actions' });
        const doneBtn = this.createRowAction(actions, 'check', t('interface.todayEndTask'));
        doneBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this.finishRunningTask();
        });
        const abandonBtn = this.createRowAction(actions, 'x', t('interface.todayAbandonTask'));
        abandonBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this.abandonRunningTask();
        });
        // 日目标放在条目末尾：换行后独占第二行，不影响第一行的按钮组位置
        this.appendDayGoals(row, task, makeDayKey(this.selectedDate), true);

        this.startRunningTicker(running.startedAt);
    }

    /** 第一行：左右箭头 + 日期；第二行：第x周 / 周x / 几天前 标签 */
    private renderNav(card: HTMLElement): void {
        const nav = card.createDiv({ cls: 'interface-today-tasks-nav' });

        const prevBtn = nav.createEl('button', {
            cls: 'interface-today-tasks-nav-btn',
            attr: { type: 'button', 'aria-label': t('interface.dateYesterday') },
        });
        setIcon(prevBtn, 'chevron-left');
        prevBtn.addEventListener('click', () => this.shiftDate(-1));

        const wrap = nav.createDiv({ cls: 'interface-today-tasks-date-wrap' });
        wrap.createDiv({
            cls: 'interface-today-tasks-date',
            text: `${this.selectedDate.getMonth() + 1}/${this.selectedDate.getDate()}`,
        });
        const tags = wrap.createDiv({ cls: 'interface-today-tasks-tags' });
        tags.createSpan({
            cls: 'interface-today-tasks-tag',
            text: t('interface.todayWeekTag', { week: String(getISOWeek(this.selectedDate)) }),
        });
        tags.createSpan({
            cls: 'interface-today-tasks-tag',
            text: t(WEEKDAY_KEYS[this.weekday() - 1]),
        });
        tags.createSpan({ cls: 'interface-today-tasks-tag', text: this.dateRelationLabel() });

        const nextBtn = nav.createEl('button', {
            cls: 'interface-today-tasks-nav-btn',
            attr: { type: 'button', 'aria-label': t('interface.dateTomorrow') },
        });
        setIcon(nextBtn, 'chevron-right');
        nextBtn.disabled = this.isTodaySelected();
        nextBtn.addEventListener('click', () => this.shiftDate(1));
    }

    /** 渲染一个可折叠分区（标题 + 数量 + 任务行） */
    private renderSection(
        body: HTMLElement,
        key: SectionKey,
        title: string,
        tasks: PrototypeTask[],
        onAdd?: () => void,
    ): void {
        const section = body.createDiv({ cls: 'interface-today-tasks-section' });
        const head = section.createDiv({ cls: 'interface-today-tasks-section-head' });
        const chevron = head.createSpan({ cls: 'interface-today-tasks-section-chevron' });
        setIcon(chevron, this.expanded[key] ? 'chevron-down' : 'chevron-right');
        head.createSpan({ cls: 'interface-today-tasks-section-title', text: title });
        head.createSpan({ cls: 'interface-today-tasks-section-count', text: String(tasks.length) });
        head.addEventListener('click', () => {
            this.expanded[key] = !this.expanded[key];
            this.renderContent();
        });
        if (!this.expanded[key]) return;

        const list = section.createDiv({ cls: 'interface-today-tasks-list' });
        if (tasks.length === 0) {
            list.createDiv({ cls: 'interface-today-tasks-empty', text: t('interface.bottomEmpty') });
        } else {
            for (const task of tasks) {
                const dayKey = makeDayKey(this.selectedDate);
                const completed = this.taskExecutionRepo.isTaskCompleted(dayKey, task.id);
                const row = list.createDiv({ cls: 'interface-today-tasks-item' });
                row.toggleClass('is-done', completed);
                row.title = task.name;
                row.addEventListener('click', () => this.options.onOpenTaskBoard?.(task.id));
                // 主线 / 支线标签：固定在条目最左侧（配色与任务面板一致）
                row.createSpan({
                    cls: `interface-today-tasks-item-badge ${task.type === 'main' ? 'is-main' : 'is-side'}`,
                    text: task.type === 'main' ? t('panel.mainTaskBadge') : t('panel.sideTaskBadge'),
                });
                // 任务名称前的分类色点（与任务记录卡片一致，未分类为灰色）
                const category = task.categoryId ? this.categoryRepo.findById(task.categoryId) : undefined;
                row.createSpan({ cls: 'interface-today-tasks-item-dot' }).style.background = category?.color ?? '#888888';
                row.createSpan({ cls: 'interface-today-tasks-item-name', text: task.name });
                // 当天执行统计：执行次数 + 已执行时长（无执行记录时不显示）
                const stat = this.executionStats.get(task.id);
                if (stat && stat.count > 0) {
                    row.createSpan({
                        cls: 'interface-today-tasks-item-stat',
                        text: t('interface.todayExecCount', { count: String(stat.count) }),
                    });
                    row.createSpan({
                        cls: 'interface-today-tasks-item-stat',
                        text: formatDurationSeconds(stat.seconds),
                    });
                }
                // 习惯任务：习惯时间点（HH:mm）放在条目末尾
                const habitTime = key === 'habit' ? getTaskHabit(task)?.time : undefined;
                if (habitTime) {
                    row.createSpan({ cls: 'interface-today-tasks-item-time', text: habitTime });
                }
                // 当天已完成：条目末尾常显「圆圈 + 打勾」图标
                if (completed) {
                    const doneIconEl = row.createSpan({ cls: 'interface-today-tasks-item-done' });
                    setIcon(doneIconEl, 'circle-check-big');
                }
                // 悬停时标签隐藏、在标签位置显示图标：开始 / 记录 / 完成今日 /（额外任务）删除
                const actions = row.createDiv({ cls: 'interface-today-tasks-item-actions' });
                if (this.isTodaySelected() && !this.isRunning()) {
                    const startBtn = this.createRowAction(actions, 'play', t('interface.todayStartTask'));
                    startBtn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        this.startTask(task.id);
                    });
                }
                const recordBtn = this.createRowAction(actions, 'history', t('interface.todayRecordTask'));
                recordBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.openRecordPanel(task);
                });
                const doneBtn = this.createRowAction(
                    actions,
                    completed ? 'circle-check-big' : 'check',
                    t('interface.todayCompleteTask'),
                );
                doneBtn.toggleClass('is-done', completed);
                doneBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.taskExecutionRepo.setTaskCompleted(dayKey, task.id, !completed);
                    void this.saveAll();
                    this.options.onExecutionChanged?.();
                    this.renderContent();
                });
                if (key === 'extra') {
                    const deleteBtn = this.createRowAction(actions, 'x', t('interface.todayDeleteExtra'));
                    deleteBtn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        this.taskExecutionRepo.removeExtraTask(dayKey, task.id);
                        void this.saveAll();
                        this.options.onTasksChanged?.();
                        this.renderContent();
                    });
                }
                // 日目标放在条目末尾：换行后独占第二行，不影响第一行的按钮组位置
                this.appendDayGoals(row, task, dayKey);
            }
        }
        // 额外任务：展开后列表末尾显示「新增任务」+ 按钮
        if (onAdd) {
            const addBtn = list.createEl('button', {
                cls: 'interface-today-tasks-add',
                attr: { type: 'button', 'aria-label': t('interface.todayAddTaskButton') },
            });
            setIcon(addBtn, 'plus');
            addBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                onAdd();
            });
        }
    }

    /** 当天日目标：追加到条目末尾，换行后与任务名称左对齐并缩进显示（已完成置灰加删除线） */
    private appendDayGoals(row: HTMLElement, task: PrototypeTask, dayKey: string, plainRow = false): void {
        for (const goal of getDayGoalEntries(task, dayKey)) {
            const line = row.createDiv({
                cls: `interface-today-tasks-item-daygoal${plainRow ? ' is-plain' : ''}`,
            });
            line.toggleClass('is-done', goal.done === true);
            const iconEl = line.createSpan({ cls: 'interface-today-tasks-item-daygoal-icon' });
            setIcon(iconEl, 'target');
            line.createSpan({ cls: 'interface-today-tasks-item-daygoal-text', text: goal.text });
        }
    }

    /** 条目末尾的操作图标（悬停时显示） */
    private createRowAction(container: HTMLElement, icon: string, label: string): HTMLButtonElement {
        const button = container.createEl('button', {
            cls: 'interface-today-tasks-item-action',
            attr: { type: 'button', 'aria-label': label },
        });
        setIcon(button, icon);
        return button;
    }

    /** 是否存在进行中的计时（与今日时钟共用同一持久化字段） */
    private isRunning(): boolean {
        const running = this.pdcaRepo.runningTask;
        if (!running || running.source !== 'prototype' || typeof running.startedAt !== 'number') return false;
        return this.prototypeTaskRepo.tasks.some((task) => task.id === running.inboxId);
    }

    /** 开始该任务的计时：写入进行中任务并通知今日时钟同步 */
    private startTask(taskId: string): void {
        if (!this.isTodaySelected() || this.isRunning()) return;
        const now = new Date();
        this.pdcaRepo.setRunningTask({
            inboxId: taskId,
            start: now.getHours() * 60 + now.getMinutes(),
            dayKey: getCurrentDayKey(),
            source: 'prototype',
            startedAt: now.getTime(),
        });
        void this.saveAll();
        this.options.onRunningTaskChanged?.();
        this.renderContent();
    }

    /** 完成进行中任务：满 1 分钟才写入执行记录（与今日时钟一致） */
    private finishRunningTask(): void {
        const running = this.pdcaRepo.runningTask;
        if (running?.source === 'prototype' && typeof running.startedAt === 'number') {
            const endAt = Date.now();
            if (endAt - running.startedAt >= 60000) {
                this.taskExecutionRepo.add(running.inboxId, running.startedAt, endAt);
                this.options.onExecutionChanged?.();
            }
        }
        this.clearRunningTask();
    }

    /** 放弃进行中任务：不写入执行记录 */
    private abandonRunningTask(): void {
        this.clearRunningTask();
    }

    /** 清除进行中任务并通知今日时钟同步 */
    private clearRunningTask(): void {
        this.stopRunningTicker();
        this.pdcaRepo.setRunningTask(undefined);
        void this.saveAll();
        this.options.onRunningTaskChanged?.();
        this.renderContent();
    }

    /** 每秒刷新进行中任务的累计时长 */
    private startRunningTicker(startedAt: number): void {
        this.stopRunningTicker();
        this.runningTimerHandle = window.setInterval(() => {
            if (!this.containerEl?.isConnected) {
                this.stopRunningTicker();
                return;
            }
            if (this.runningElapsedEl) {
                this.runningElapsedEl.textContent = this.formatElapsed(Date.now() - startedAt);
            }
        }, 1000);
    }

    private stopRunningTicker(): void {
        if (this.runningTimerHandle !== null) {
            window.clearInterval(this.runningTimerHandle);
            this.runningTimerHandle = null;
        }
    }

    /** 时:分 */
    private formatClockTime(date: Date): string {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    /** 累计时长（分:秒，超过 1 小时带小时位） */
    private formatElapsed(ms: number): string {
        const total = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        const pad = (value: number): string => String(value).padStart(2, '0');
        return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    }

    /** 点击「新增任务」：打开任务选择面板，选中后加入所选日期的额外任务 */
    private openTaskPicker(): void {
        if (!this.taskPickerPanel) {
            this.taskPickerPanel = new TaskPickerPanel({
                getTasks: () => this.prototypeTaskRepo.tasks,
                onSelect: (taskIds) => {
                    const taskId = taskIds[0];
                    if (!taskId) return;
                    this.taskExecutionRepo.addExtraTask(makeDayKey(this.selectedDate), taskId);
                    void this.saveAll();
                    this.options.onTasksChanged?.();
                    this.renderContent();
                },
            });
        }
        this.taskPickerPanel.open();
    }

    /** 点击条目末尾的记录图标：为该任务打开记录面板，时间归属所选日期 */
    private openRecordPanel(task: PrototypeTask): void {
        const now = new Date();
        const end = new Date(this.selectedDate);
        end.setHours(now.getHours(), now.getMinutes(), 0, 0);
        const start = new Date(end.getTime() - 30 * 60000);
        const formatTime = (date: Date): string =>
            `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        this.recordPanel?.destroy();
        this.recordPanel = new TaskRecordPanel({
            title: `${t('panel.taskRecordTitle')} · ${task.name}`,
            startTime: formatTime(start),
            endTime: formatTime(end),
            date: this.selectedDate,
            onConfirm: (startAt, endAt) => {
                this.taskExecutionRepo.add(task.id, startAt, endAt);
                void this.saveAll();
                this.options.onExecutionChanged?.();
            },
        });
        this.recordPanel.open();
    }

    /** 习惯列表：启用习惯且所选星期生效的任务（按习惯时间排序） */
    private habitTasks(): PrototypeTask[] {
        const weekday = this.weekday();
        return this.prototypeTaskRepo.tasks
            .filter((task) => {
                const habit = getTaskHabit(task);
                return habit?.enabled === true && habit.weekdays.includes(weekday);
            })
            .sort((a, b) => (getTaskHabit(a)?.time ?? '').localeCompare(getTaskHabit(b)?.time ?? ''));
    }

    /** 当天任务：计划排布到所选日期的任务 */
    private plannedTasks(): PrototypeTask[] {
        const tasks = this.taskMap();
        return this.planAssignmentRepo
            .dayAssignments(this.weekKey(), this.weekday())
            .map((assignment) => tasks.get(assignment.taskId))
            .filter((task): task is PrototypeTask => task !== undefined);
    }

    /** 额外任务：当日额外加入的任务（与计划任务去重） */
    private extraTasks(): PrototypeTask[] {
        const tasks = this.taskMap();
        const plannedIds = new Set(this.plannedTasks().map((task) => task.id));
        return this.taskExecutionRepo
            .extraTaskIds(makeDayKey(this.selectedDate))
            .map((taskId) => tasks.get(taskId))
            .filter((task): task is PrototypeTask => task !== undefined && !plannedIds.has(task.id));
    }

    /** 当天各任务的执行统计：执行次数 + 已执行时长（跨天记录按天裁剪） */
    private buildExecutionStats(): Map<string, { count: number; seconds: number }> {
        const dayStart = this.selectedDate.getTime();
        const dayEnd = dayStart + 24 * 3600000;
        const stats = new Map<string, { count: number; seconds: number }>();
        for (const record of this.taskExecutionRepo.records) {
            const start = Math.max(dayStart, record.startAt);
            const end = Math.min(dayEnd, record.endAt);
            if (end <= start) continue;
            const item = stats.get(record.taskId) ?? { count: 0, seconds: 0 };
            item.count += 1;
            item.seconds += (end - start) / 1000;
            stats.set(record.taskId, item);
        }
        return stats;
    }

    private taskMap(): Map<string, PrototypeTask> {
        return new Map(this.prototypeTaskRepo.tasks.map((task) => [task.id, task]));
    }

    /** 所选日期对应星期（1 = 周一 … 7 = 周日） */
    private weekday(): number {
        const day = this.selectedDate.getDay();
        return day === 0 ? 7 : day;
    }

    private weekKey(): string {
        return makeWeekKey(this.selectedDate.getFullYear(), getISOWeek(this.selectedDate));
    }

    private isTodaySelected(): boolean {
        return this.selectedDate.getTime() === startOfToday().getTime();
    }

    /** 切换日期：只能回看过去，不能超过今天 */
    private shiftDate(delta: number): void {
        const next = new Date(this.selectedDate);
        next.setDate(next.getDate() + delta);
        if (next.getTime() > startOfToday().getTime()) return;
        this.selectedDate = next;
        this.renderContent();
        this.options.onSelectedDateChange?.(this.selectedDate);
    }

    /** 日期相对标签：今天 / 昨天 / N天前 */
    private dateRelationLabel(): string {
        const diff = Math.round((startOfToday().getTime() - this.selectedDate.getTime()) / 86400000);
        if (diff <= 0) return t('interface.dateToday');
        if (diff === 1) return t('interface.dateYesterday');
        return t('interface.dateDaysAgo', { days: String(diff) });
    }
}

/** 秒数 →「x分」/「x小时」/「x小时y分」 */
function formatDurationSeconds(seconds: number): string {
    const totalMinutes = Math.max(1, Math.round(seconds / 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return t('interface.durationMinutes', { minutes: String(minutes) });
    if (minutes === 0) return t('interface.durationHours', { hours: String(hours) });
    return t('interface.durationHoursMinutes', { hours: String(hours), minutes: String(minutes) });
}
