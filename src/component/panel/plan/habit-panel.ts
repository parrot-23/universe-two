// 习惯面板：基于 FloatingPanel，用于查看与设置任务习惯。
// 结构：左侧（顶部根任务下拉 + 任务树）+ 右侧（一周七列日历，展示已启用习惯的卡片）。
import { setIcon } from 'obsidian';

import type { PrototypeTask, TaskHabit } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import type { PlanCategory } from '../../../shared/plan-category-manager';
import { getCurrentWeekKey, makeDayKeyFromWeek } from '../../../shared/plan-data';
import { getTaskHabit, setTaskHabit } from '../../../shared/task-sections';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 习惯面板配置 */
export interface HabitPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「习惯」 */
    title?: string;
    /** 任务数据源（每次打开时重新读取，保证与其他视图一致） */
    getTasks: () => PrototypeTask[];
    /** 分类数据源（习惯面板显示分类名称与颜色） */
    getCategories: () => PlanCategory[];
    /** 数据保存回调（习惯写入后持久化） */
    save: () => Promise<void>;
    /** 习惯变更回调（界面视图据此刷新） */
    onChanged?: () => void;
    /** 点击标题栏跳转图标：在任务详情面板中打开左侧选中的任务 */
    onOpenTaskDetail?: (taskId: string) => void;
    /** 初始周键，默认本周 */
    initialWeekKey?: string;
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

/** 习惯面板 */
export class HabitPanel extends FloatingPanel {
    private rootSelectEl!: HTMLSelectElement;
    private treeEl!: HTMLElement;
    private paneEl!: HTMLElement;
    /** 右侧底部的习惯设置面板（默认显示，选中任务后可见） */
    private habitPanelEl!: HTMLElement;

    /** 周视图当前周键 */
    private weekKey: string;
    /** 下拉选中的根任务 id */
    private rootTaskId: string | undefined;
    /** 任务树中选中的任务 id（用于习惯面板的绑定任务） */
    private selectedTaskId: string | undefined;
    /** 标题栏「跳转到任务详情」按钮（仅在提供回调时创建） */
    private detailButtonEl: HTMLElement | null = null;

    constructor(private readonly panelOptions: HabitPanelOptions) {
        super({
            width: 900,
            title: panelOptions.title ?? t('panel.habitPanelTitle'),
            ...panelOptions,
        });
        this.body.addClass('habit-panel-body');
        this.weekKey = panelOptions.initialWeekKey ?? getCurrentWeekKey();
        // 标题栏钉住按钮左侧：跳转到任务详情面板（未提供回调时不显示）
        if (panelOptions.onOpenTaskDetail) {
            this.detailButtonEl = this.addHeaderAction(
                'square-arrow-up-right',
                t('panel.openTaskDetail'),
                () => {
                    if (this.selectedTaskId) this.panelOptions.onOpenTaskDetail?.(this.selectedTaskId);
                },
                'start',
            );
            this.updateDetailButton();
        }
        this.renderLayout();
    }

    /** 每次打开时刷新任务数据，避免任务面板新增后下拉不更新 */
    override open(): void {
        this.refreshRootSelect();
        this.renderHabitPanel();
        super.open();
    }

    private renderLayout(): void {
        // 左侧：根任务下拉 + 任务树
        const left = this.body.createDiv({ cls: 'habit-left' });
        this.rootSelectEl = left.createEl('select', { cls: 'dropdown habit-root-select' });
        this.rootSelectEl.addEventListener('change', () => {
            this.rootTaskId = this.rootSelectEl.value || undefined;
            this.selectedTaskId = undefined;
            this.renderTree();
            this.renderHabitPanel();
            this.updateDetailButton();
        });
        this.treeEl = left.createDiv({ cls: 'habit-tree' });
        this.treeEl.addEventListener('click', (evt) => {
            const row = (evt.target as HTMLElement).closest('.task-detail-tree-row') as HTMLElement | null;
            const taskId = row?.dataset.taskId;
            if (!taskId) return;
            // 再次点击已选中的条目则取消选中
            if (taskId === this.selectedTaskId) {
                this.clearTaskSelection();
            } else {
                this.selectTask(taskId);
            }
        });

        // 右侧：一周七列日历内容
        const right = this.body.createDiv({ cls: 'habit-right' });
        this.paneEl = right.createDiv({ cls: 'plan-pane' });
        // 右侧底部：习惯设置面板（默认显示，选中任务后可见）
        this.habitPanelEl = right.createDiv({ cls: 'habit-panel is-hidden' });
        this.renderPane();
        this.renderHabitPanel();
        this.refreshRootSelect();
        // 默认选中根任务，保证右侧习惯设置面板默认可见
        if (!this.selectedTaskId && this.rootTaskId) this.selectTask(this.rootTaskId);
    }

    /** 重建根任务下拉（顶层任务 = 无父任务的主线/支线） */
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
        this.renderTree();
    }

    /** 渲染选中根任务（含根任务自身）的任务树 */
    private renderTree(): void {
        this.treeEl.empty();
        if (!this.rootTaskId) return;
        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        if (rootTask) this.renderTreeRow(this.treeEl, rootTask, 0);
        this.renderTreeNodes(this.treeEl, this.rootTaskId, 1);
    }

    private renderTreeNodes(parentEl: HTMLElement, parentId: string, depth: number): void {
        const children = this.panelOptions.getTasks().filter((task) => task.parentId === parentId);
        for (const child of children) {
            this.renderTreeRow(parentEl, child, depth);
            this.renderTreeNodes(parentEl, child.id, depth + 1);
        }
    }

    /** 渲染单条任务行（缩进 + 分支图标 + 名称 + 末尾图标） */
    private renderTreeRow(parentEl: HTMLElement, task: PrototypeTask, depth: number): void {
        const row = parentEl.createDiv({ cls: 'task-detail-tree-row' });
        row.style.marginLeft = `${depth * 14}px`;
        row.dataset.taskId = task.id;
        row.toggleClass('is-selected', task.id === this.selectedTaskId);
        const iconEl = row.createSpan({ cls: 'task-detail-tree-icon' });
        setIcon(iconEl, 'git-branch');
        row.createSpan({ cls: 'task-detail-tree-label', text: task.name });
        this.renderTrailingIcon(row, task);
    }

    /**
     * 渲染任务行末尾图标：
     * - 已启用习惯 → repeat，未启用 → 不显示。
     */
    private renderTrailingIcon(row: HTMLElement, task: PrototypeTask): void {
        row.querySelector('.plan-tree-status-icon')?.remove();
        if (!getTaskHabit(task)?.enabled) return;
        const statusEl = row.createSpan({ cls: 'plan-tree-status-icon' });
        setIcon(statusEl, 'repeat');
    }

    /** 按当前激活的面板刷新所有任务行的末尾图标 */
    private refreshTreeTrailingIcons(): void {
        const tasks = this.panelOptions.getTasks();
        this.treeEl.querySelectorAll('.task-detail-tree-row').forEach((el) => {
            const row = el as HTMLElement;
            const task = tasks.find((item) => item.id === row.dataset.taskId);
            if (task) this.renderTrailingIcon(row, task);
        });
    }

    /** 选中任务条目（高亮，供习惯面板绑定） */
    private selectTask(taskId: string): void {
        this.selectedTaskId = taskId;
        this.treeEl.querySelectorAll('.task-detail-tree-row').forEach((el) => {
            const row = el as HTMLElement;
            row.toggleClass('is-selected', row.dataset.taskId === taskId);
        });
        this.renderHabitPanel();
        this.updateDetailButton();
    }

    /** 取消选中任务条目（清除高亮） */
    private clearTaskSelection(): void {
        this.selectedTaskId = undefined;
        this.treeEl.querySelectorAll('.task-detail-tree-row').forEach((el) => {
            (el as HTMLElement).removeClass('is-selected');
        });
        this.renderHabitPanel();
        this.updateDetailButton();
    }

    /** 同步标题栏「跳转到任务详情」按钮的显隐：未选中任务时隐藏 */
    private updateDetailButton(): void {
        this.detailButtonEl?.toggleClass('is-hidden', !this.selectedTaskId);
    }

    /** 渲染任务信息头部（颜色圆点 + 任务名称 + 分类） */
    private renderTaskHead(parentEl: HTMLElement, task: PrototypeTask): void {
        const head = parentEl.createDiv({ cls: 'plan-info-head' });
        const category = this.panelOptions.getCategories()
            .find((item) => item.id === task.categoryId);
        const dot = head.createSpan({ cls: 'plan-info-dot' });
        dot.style.background = category?.color ?? '#888888';
        head.createSpan({ cls: 'plan-info-name', text: task.name });
        head.createSpan({
            cls: 'plan-info-category',
            text: category?.label ?? t('defaultCategory.uncategorized'),
        });
    }

    /** 渲染右侧底部的习惯设置面板（默认显示，选中任务后可见） */
    private renderHabitPanel(): void {
        const task = this.selectedTaskId
            ? this.panelOptions.getTasks().find((item) => item.id === this.selectedTaskId)
            : undefined;
        this.habitPanelEl.empty();
        const visible = !!task;
        this.habitPanelEl.toggleClass('is-hidden', !visible);
        if (!visible || !task) return;

        this.renderTaskHead(this.habitPanelEl, task);

        const habit = this.getHabit(task);

        // 第二行：开关 + 图标 + 文字（启用习惯）
        const enableRow = this.habitPanelEl.createDiv({ cls: 'habit-enable' });
        const switchEl = enableRow.createDiv({ cls: 'checkbox-container' });
        const switchInput = switchEl.createEl('input', { type: 'checkbox' });
        switchInput.checked = habit.enabled;
        // Obsidian 的开关圆球位置由容器的 is-enabled 类控制，而不是 input:checked
        switchEl.toggleClass('is-enabled', habit.enabled);
        const enableIconEl = enableRow.createSpan({ cls: 'habit-enable-icon' });
        setIcon(enableIconEl, 'repeat');
        enableRow.createSpan({ cls: 'habit-enable-text', text: t('panel.habitEnable') });
        switchInput.addEventListener('change', () => {
            this.saveHabit(task, { enabled: switchInput.checked });
            this.refreshTreeTrailingIcons();
            this.renderHabitPanel();
        });

        // 第三 / 四行：时间 + 星期（仅启用后可配置）
        const config = this.habitPanelEl.createDiv({ cls: 'habit-config' });
        config.toggleClass('is-disabled', !habit.enabled);

        const timeRow = config.createDiv({ cls: 'habit-time-row' });
        timeRow.createSpan({ cls: 'habit-time-label', text: t('panel.habitTime') });
        const timeInput = timeRow.createEl('input', {
            cls: 'habit-time',
            type: 'time',
        });
        timeInput.value = habit.time;
        timeInput.disabled = !habit.enabled;
        timeInput.addEventListener('change', () => {
            this.saveHabit(task, { time: timeInput.value || '09:00' });
        });

        const daysRow = config.createDiv({ cls: 'habit-days' });
        for (let day = 1; day <= 7; day += 1) {
            const button = daysRow.createEl('button', {
                cls: 'habit-day',
                attr: { type: 'button' },
                text: t(WEEKDAY_KEYS[day - 1]),
            });
            button.toggleClass('is-active', habit.weekdays.includes(day));
            button.disabled = !habit.enabled;
            button.addEventListener('click', () => {
                const current = this.getHabit(task);
                const weekdays = current.weekdays.includes(day)
                    ? current.weekdays.filter((item) => item !== day)
                    : [...current.weekdays, day].sort((a, b) => a - b);
                this.saveHabit(task, { weekdays });
                button.toggleClass('is-active', weekdays.includes(day));
            });
        }
    }

    /** 读取任务习惯设置（未设置时返回默认值） */
    private getHabit(task: PrototypeTask): TaskHabit {
        return getTaskHabit(task) ?? { enabled: false, time: '09:00', weekdays: [1, 2, 3, 4, 5, 6, 7] };
    }

    /** 写入任务习惯设置并持久化 */
    private saveHabit(task: PrototypeTask, patch: Partial<TaskHabit>): void {
        setTaskHabit(task, { ...this.getHabit(task), ...patch });
        void this.panelOptions.save();
        // 习惯卡片变化后同步重绘周日历
        this.renderPane();
        this.panelOptions.onChanged?.();
    }

    private renderPane(): void {
        this.paneEl.empty();
        this.renderWeekPane();
    }

    /** 周视图：一周七列日历（习惯每周循环生效，无需周数切换） */
    private renderWeekPane(): void {
        // 与周计划视图一致：表头一行 7 格，表体 7 列共用分隔线
        const grid = this.paneEl.createDiv({ cls: 'plan-week-grid' });
        const headerRow = grid.createDiv({ cls: 'plan-week-header' });
        const columnsRow = grid.createDiv({ cls: 'plan-week-columns' });
        // 习惯卡片按生效星期算出连续区段与所在行（泳道）
        const habitSegments = this.buildHabitSegments();
        const laneCount = habitSegments.reduce((max, item) => Math.max(max, item.lane + 1), 0);
        columnsRow.style.gridTemplateRows = laneCount > 0
            ? `repeat(${laneCount}, min-content) 1fr`
            : '1fr';
        for (let col = 0; col < 7; col++) {
            const dayKey = makeDayKeyFromWeek(this.weekKey, col + 1);
            const header = headerRow.createDiv({ cls: 'plan-week-header-cell' });
            // 当天进入新的月份时，在左上角标注月份
            const month = Number(dayKey.slice(5, 7));
            if (month !== this.getPreviousDayMonth(dayKey)) {
                header.createSpan({ cls: 'plan-week-header-month', text: `${month}月` });
            }
            header.createSpan({ cls: 'plan-week-header-name', text: t(WEEKDAY_KEYS[col]) });
            header.createSpan({
                cls: 'plan-week-header-date',
                text: `${month}/${Number(dayKey.slice(8, 10))}`,
            });
            // 日列作为背景层，跨满所有行：负责分隔线与悬停反馈
            const column = columnsRow.createDiv({ cls: 'plan-week-column' });
            column.style.gridColumn = String(col + 1);
            column.style.gridRow = '1 / -1';
            column.dataset.weekday = String(col + 1);
        }
        // 卡片层：与日列共用同一网格，按区段跨列显示
        for (const segment of habitSegments) this.renderHabitSegment(columnsRow, segment);
    }

    /** 取指定日期前一天的月份（用于判断当天是否跨入新月份） */
    private getPreviousDayMonth(dayKey: string): number {
        const date = new Date(`${dayKey}T00:00:00`);
        date.setDate(date.getDate() - 1);
        return date.getMonth() + 1;
    }

    /** 周视图中跨列合并的一段习惯卡片：按时间排序固定行，同一习惯的连续星期合并为一段 */
    private buildHabitSegments(): {
        task: PrototypeTask;
        habit: TaskHabit;
        start: number;
        end: number;
        lane: number;
    }[] {
        const habits = this.panelOptions.getTasks()
            .map((task) => ({ task, habit: getTaskHabit(task) }))
            .filter((item): item is { task: PrototypeTask; habit: TaskHabit } => item.habit?.enabled === true)
            .sort((a, b) => a.habit.time.localeCompare(b.habit.time)
                || a.task.name.localeCompare(b.task.name));
        const segments: { task: PrototypeTask; habit: TaskHabit; start: number; end: number; lane: number }[] = [];
        habits.forEach(({ task, habit }, lane) => {
            const days = Array.from(new Set(habit.weekdays))
                .filter((day) => day >= 1 && day <= 7)
                .sort((a, b) => a - b);
            if (days.length === 0) return;
            // 连续星期合并为一段，不连续的拆成多段
            let start = days[0];
            let prev = days[0];
            for (let i = 1; i < days.length; i += 1) {
                const day = days[i];
                if (day === prev + 1) {
                    prev = day;
                    continue;
                }
                segments.push({ task, habit, start, end: prev, lane });
                start = day;
                prev = day;
            }
            segments.push({ task, habit, start, end: prev, lane });
        });
        return segments;
    }

    /** 渲染一段跨列习惯卡片（时间 + 任务名，点击选中左侧对应任务） */
    private renderHabitSegment(
        parentEl: HTMLElement,
        segment: { task: PrototypeTask; habit: TaskHabit; start: number; end: number; lane: number },
    ): void {
        const { task, habit, start, end, lane } = segment;
        const span = end - start + 1;
        const chip = parentEl.createDiv({ cls: 'plan-week-task-chip plan-week-habit-chip' });
        chip.style.gridColumn = `${start} / span ${span}`;
        chip.style.gridRow = String(lane + 1);
        chip.title = `${habit.time} ${task.name}`;
        chip.createSpan({ cls: 'plan-week-habit-time', text: habit.time });
        chip.createSpan({ cls: 'plan-week-task-chip-name', text: task.name });
        chip.addEventListener('click', (evt) => {
            evt.stopPropagation();
            this.selectTask(task.id);
        });
    }
}
