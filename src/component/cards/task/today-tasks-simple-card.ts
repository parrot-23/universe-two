// 今日任务（简洁版）卡片：独立实现（第一步改造）。
// 与普通今日任务卡片的差异：移除顶部日期切换区；习惯列表改为方块卡片网格
//（分类圆点 + 名称 / 习惯时间点 / 操作按钮，各占一行，从左到右自动换行）。
// 进行中任务、当天任务、额外任务与底部按钮组保持一致。
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

/** 折叠分区（额外任务已并入当天任务区） */
type SectionKey = 'habit' | 'planned';

/** 今日任务（简洁版）卡片配置 */
export interface TodayTasksSimpleCardOptions {
    plugin: Plugin;
    /** 初始查看日期（界面统一日期） */
    initialDate?: Date;
    /** 进行中任务变化（开始 / 结束 / 放弃）后通知，用于同步今日时钟卡片 */
    onRunningTaskChanged?: () => void;
    /** 执行记录变化后通知，用于刷新今日时钟外环 */
    onExecutionChanged?: () => void;
    /** 额外任务变化后通知，用于刷新今日时钟的任务列表 */
    onTasksChanged?: () => void;
    /** 点击任务条目：打开任务板块面板 */
    onOpenTaskBoard?: (taskId: string) => void;
}

export class TodayTasksSimpleCard {
    private readonly options: TodayTasksSimpleCardOptions;
    /** 卡片容器 */
    private containerEl: HTMLElement | null = null;
    /** 当前查看的日期（跟随界面统一日期） */
    private selectedDate: Date = startOfToday();
    /** 分区展开状态（默认全部展开） */
    private expanded: Record<SectionKey, boolean> = { habit: true, planned: true };
    /** 「所有任务」切换：默认仅显示未完成任务，激活后显示全部 */
    private showAllTasks = false;
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

    constructor(options: TodayTasksSimpleCardOptions) {
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

        const habit = this.habitTasks();
        const planned = this.plannedTasks();
        const extra = this.extraTasks();
        // 渲染前刷新当天各任务的执行统计（次数 / 时长），供条目上的胶囊标签使用
        this.executionStats = this.buildExecutionStats();

        this.renderHeader(card);

        const body = card.createDiv({ cls: 'interface-today-tasks-body' });
        this.renderRunningSection(body);
        // 未完成模式下存在进行中任务时：隐藏习惯区与当天任务区的折叠行和列表
        const hideLists = !this.showAllTasks && this.hasVisibleRunningTask();
        if (!hideLists) {
            this.renderHabitSection(body, habit);
            this.renderTaskSection(body, planned, extra);
        }
    }

    /** 是否存在今天可见的进行中任务 */
    private hasVisibleRunningTask(): boolean {
        if (!this.isTodaySelected()) return false;
        const running = this.pdcaRepo.runningTask;
        if (!running || typeof running.startedAt !== 'number') return false;
        return this.prototypeTaskRepo.tasks.some((task) => task.id === running.inboxId);
    }

    /** 顶部标题行：今日任务 +（所有任务）切换 +（+）添加额外任务 */
    private renderHeader(card: HTMLElement): void {
        const header = card.createDiv({ cls: 'interface-today-tasks-simple-header' });
        header.createSpan({ cls: 'interface-today-tasks-simple-title', text: t('interface.todaySimpleTitle') });

        const actions = header.createDiv({ cls: 'interface-today-tasks-simple-actions' });
        const allBtn = actions.createEl('button', {
            cls: 'interface-today-tasks-simple-icon-btn',
            attr: {
                type: 'button',
                'aria-label': this.showAllTasks
                    ? t('interface.todayShowIncompleteTasks')
                    : t('interface.todayShowAllTasks'),
            },
        });
        allBtn.toggleClass('is-active', this.showAllTasks);
        setIcon(allBtn, 'list');
        allBtn.addEventListener('click', () => {
            this.showAllTasks = !this.showAllTasks;
            this.renderContent();
        });

        const addBtn = actions.createEl('button', {
            cls: 'interface-today-tasks-simple-icon-btn',
            attr: { type: 'button', 'aria-label': t('interface.todayAddTaskButton') },
        });
        setIcon(addBtn, 'plus');
        addBtn.addEventListener('click', () => this.openTaskPicker());
    }

    /** 习惯区：与普通今日任务卡片一致的行列表；未完成模式仅显示未完成 */
    private renderHabitSection(body: HTMLElement, tasks: PrototypeTask[]): void {
        const dayKey = makeDayKey(this.selectedDate);
        // 未完成模式仅显示未完成的习惯；「所有任务」模式显示全部（已完成置灰）
        const visible = this.showAllTasks
            ? tasks
            : tasks.filter((task) => !this.taskExecutionRepo.isTaskCompleted(dayKey, task.id));

        const section = body.createDiv({ cls: 'interface-today-tasks-section' });
        const head = section.createDiv({ cls: 'interface-today-tasks-section-head' });
        const chevron = head.createSpan({ cls: 'interface-today-tasks-section-chevron' });
        setIcon(chevron, this.expanded.habit ? 'chevron-down' : 'chevron-right');
        head.createSpan({ cls: 'interface-today-tasks-section-title', text: t('interface.todayHabitTitle') });
        head.createSpan({ cls: 'interface-today-tasks-section-count', text: String(visible.length) });
        head.addEventListener('click', () => {
            this.expanded.habit = !this.expanded.habit;
            this.renderContent();
        });
        if (!this.expanded.habit) return;

        const list = section.createDiv({ cls: 'interface-today-tasks-list' });
        if (visible.length === 0) {
            list.createDiv({ cls: 'interface-today-tasks-empty', text: t('interface.bottomEmpty') });
            return;
        }
        for (const task of visible) {
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
            // 任务名称前的分类色点（未分类为灰色）
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
            // 习惯时间点（HH:mm）放在条目末尾
            const habitTime = task.habit?.time;
            if (habitTime) {
                row.createSpan({ cls: 'interface-today-tasks-item-time', text: habitTime });
            }
            // 当天已完成：条目末尾常显「圆圈 + 打勾」图标
            if (completed) {
                const doneIconEl = row.createSpan({ cls: 'interface-today-tasks-item-done' });
                setIcon(doneIconEl, 'circle-check-big');
            }
            // 悬停时标签隐藏、在标签位置显示图标：开始 / 记录 / 完成今日
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
        }
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

        this.startRunningTicker(running.startedAt);
    }

    /** 当天任务区：当天任务 + 额外任务合并，额外任务行末尾带「额外」标签；默认仅显示未完成 */
    private renderTaskSection(body: HTMLElement, planned: PrototypeTask[], extra: PrototypeTask[]): void {
        const dayKey = makeDayKey(this.selectedDate);
        const entries: Array<{ task: PrototypeTask; isExtra: boolean }> = [
            ...planned.map((task) => ({ task, isExtra: false })),
            ...extra.map((task) => ({ task, isExtra: true })),
        ];
        const visible = this.showAllTasks
            ? entries
            : entries.filter((entry) => !this.taskExecutionRepo.isTaskCompleted(dayKey, entry.task.id));

        const section = body.createDiv({ cls: 'interface-today-tasks-section' });
        const head = section.createDiv({ cls: 'interface-today-tasks-section-head' });
        const chevron = head.createSpan({ cls: 'interface-today-tasks-section-chevron' });
        setIcon(chevron, this.expanded.planned ? 'chevron-down' : 'chevron-right');
        head.createSpan({ cls: 'interface-today-tasks-section-title', text: t('interface.todayPlannedTitle') });
        head.createSpan({ cls: 'interface-today-tasks-section-count', text: String(visible.length) });
        head.addEventListener('click', () => {
            this.expanded.planned = !this.expanded.planned;
            this.renderContent();
        });
        if (!this.expanded.planned) return;

        const list = section.createDiv({ cls: 'interface-today-tasks-list' });
        if (visible.length === 0) {
            list.createDiv({ cls: 'interface-today-tasks-empty', text: t('interface.bottomEmpty') });
            return;
        }
        for (const entry of visible) {
            const task = entry.task;
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
            // 额外任务：行末尾显示「额外」标签
            if (entry.isExtra) {
                row.createSpan({ cls: 'interface-today-tasks-item-extra', text: t('interface.todayExtraBadge') });
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
            if (entry.isExtra) {
                const deleteBtn = this.createRowAction(actions, 'x', t('interface.todayDeleteExtra'));
                deleteBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.taskExecutionRepo.removeExtraTask(dayKey, task.id);
                    void this.saveAll();
                    this.options.onTasksChanged?.();
                    this.renderContent();
                });
            }
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
            .filter((task) => task.habit?.enabled === true && task.habit.weekdays.includes(weekday))
            .sort((a, b) => (a.habit?.time ?? '').localeCompare(b.habit?.time ?? ''));
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
