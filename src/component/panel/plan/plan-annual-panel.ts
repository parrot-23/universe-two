// 计划年度面板：左右结构。
// 左侧：与计划面板一致（顶部根任务下拉 + 选中根任务的后代任务树 + 底部工具栏「信息」「目标」按钮，按钮暂为占位）。
// 右侧：季度泳道图。顶部为季度翻页行（← 2026年 Q2 →）与周列表头（W45 / 11/03），
// 中间每个任务一行，行内用色块表示该任务整周排布的周区间（数据与计划面板共享 PlanAssignmentRepo）；
// 底部为固定高度的目标占位面板。
// 排布：拖动色块左右手柄调整区间起止周，在行内空白周列拖拽新建区间；松手后同步该任务全年整周排布。
import { setIcon } from 'obsidian';

import type { PrototypeTask, TaskGoalEntry } from '../../../datatypes/prototype-task';
import type { TaskStatus } from '../../../datatypes/domain';
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
import { applyThemeColors, getCurrentThemeColors } from '../../../themestory/theme-colors';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 计划年度面板配置 */
export interface PlanAnnualPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「计划年度」 */
    title?: string;
    /** 任务数据源（每次打开时重新读取，保证与其他视图一致） */
    getTasks: () => PrototypeTask[];
    /** 分类数据源（色块使用分类颜色） */
    getCategories: () => PlanCategory[];
    /** 计划排布数据仓库（与计划面板共享） */
    planAssignmentRepo: PlanAssignmentRepo;
    /** 数据保存回调（排布写入后持久化） */
    save: () => Promise<void>;
    /** 排布变更回调（界面视图「今天任务」方框据此刷新） */
    onChanged?: () => void;
    /** 点击标题栏跳转图标：在任务详情面板中打开左侧选中的任务 */
    onOpenTaskDetail?: (taskId: string) => void;
}

/** 任务状态对应的图标（与计划面板任务树保持一致） */
const STATUS_ICONS: Record<TaskStatus, string> = {
    notStarted: 'circle',
    inProgress: 'play',
    done: 'check-circle',
    paused: 'pause',
};

/** 状态下拉列表的选项（图标 + 文案） */
const STATUS_OPTIONS: {
    value: TaskStatus;
    icon: string;
    labelKey: 'taskPlan.statusNotStarted' | 'taskPlan.statusInProgress' | 'taskPlan.statusDone' | 'taskPlan.statusPaused';
}[] = [
    { value: 'notStarted', icon: 'circle', labelKey: 'taskPlan.statusNotStarted' },
    { value: 'inProgress', icon: 'play', labelKey: 'taskPlan.statusInProgress' },
    { value: 'done', icon: 'check-circle', labelKey: 'taskPlan.statusDone' },
    { value: 'paused', icon: 'pause', labelKey: 'taskPlan.statusPaused' },
];

/** 任务树行缩进（px） */
const TREE_DEPTH_INDENT = 14;

/** 任务树行 / 泳道行高度（px），两侧共用同一滚动容器，行高一致才能对齐 */
const ROW_HEIGHT = 26;

/** 季度导航行高度（px） */
const NAV_ROW_HEIGHT = 28;

/** 周列表头高度（px） */
const HEADER_HEIGHT = 34;

/** 左侧顶部占位高度（px）：导航行 + 表头 */
const LEFT_TOP_PLACEHOLDER_HEIGHT = NAV_ROW_HEIGHT + HEADER_HEIGHT;

/** 底部区域高度（px）：左侧工具栏与右侧目标占位面板等高 */
const BOTTOM_HEIGHT = 80;

/** 色块高度（px） */
const BAR_HEIGHT = 14;

/** 色块左右留白（px） */
const BAR_INSET = 1;

/** 底部目标区单行高度（px） */
const GOAL_ROW_HEIGHT = 18;

/** 底部目标区行间距（px） */
const GOAL_ROW_GAP = 2;

/** 拖拽启动阈值（px） */
const DRAG_THRESHOLD = 3;

/** 拖到季度页面边缘自动翻页的触发距离（px） */
const EDGE_FLIP_DISTANCE = 24;

/** 拖到边缘后自动翻页的停留时间（ms） */
const EDGE_FLIP_DELAY = 400;

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
interface LaneBar {
    task: PrototypeTask;
    /** 起始列下标（含） */
    startIndex: number;
    /** 结束列下标（含） */
    endIndex: number;
    /** 区间是否在季度左侧被截断 */
    clippedStart: boolean;
    /** 区间是否在季度右侧被截断 */
    clippedEnd: boolean;
    /** 完整区间起始周键 */
    startWeekKey: string;
    /** 完整区间结束周键 */
    endWeekKey: string;
}

/** 拖拽状态 */
interface DragState {
    /** 拖拽类型：调整左边缘 / 调整右边缘 / 新建区间 */
    mode: 'start' | 'end' | 'create';
    /** 拖拽所属任务 id */
    taskId: string;
    /** 拖拽所属行元素 */
    rowEl: HTMLElement;
    /** 拖拽起点周键（绝对周，翻页后仍可正确计算） */
    anchorWeekKey: string;
    /** 调整边缘时保持不动的那一端周键（新建区间时为空） */
    fixedWeekKey?: string;
    /** 当前指针所在周键 */
    currentWeekKey: string;
    /** 指针按下位置（用于判断是否超过拖拽阈值） */
    startX: number;
    startY: number;
    /** 是否已超过拖拽阈值 */
    active: boolean;
    /** 预览色块 */
    previewEl: HTMLElement | null;
    /** 周区间提示浮层 */
    tipEl: HTMLElement | null;
    /** 边缘翻页定时器 */
    edgeTimer: number | null;
}

/** 左侧内容模式：任务树 / 目标列表 */
type LeftMode = 'task' | 'goal';

/** 计划年度面板 */
export class PlanAnnualPanel extends FloatingPanel {
    private rootSelectEl!: HTMLSelectElement;
    private treeEl!: HTMLElement;
    private goalListEl!: HTMLElement;
    private taskButtonEl!: HTMLButtonElement;
    private goalButtonEl!: HTMLButtonElement;
    private navEl!: HTMLElement;
    private weekHeaderEl!: HTMLElement;
    private laneEl!: HTMLElement;
    private goalEl!: HTMLElement;
    /** 标题栏「跳转到任务详情」按钮（仅在提供回调时创建） */
    private detailButtonEl: HTMLElement | null = null;

    /** 左侧当前模式（默认任务树） */
    private leftMode: LeftMode = 'task';
    /** 当前年份 */
    private year: number;
    /** 当前季度（1-4） */
    private quarter: number;
    /** 下拉选中的根任务 id */
    private rootTaskId: string | undefined;
    /** 任务树中选中的任务 id */
    private selectedTaskId: string | undefined;
    /** 当前季度内的周列表 */
    private quarterWeeks: QuarterWeek[] = [];
    /** 当前拖拽状态 */
    private drag: DragState | null = null;
    /** 状态下拉列表（挂在 body 上） */
    private statusMenuEl: HTMLElement | null = null;
    /** 底部目标区悬浮面板（挂在 body 上） */
    private goalTipEl: HTMLElement | null = null;
    /** 悬浮面板当前对应的周键（避免同一列重复渲染） */
    private goalTipWeekKey: string | null = null;

    /** 点击下拉列表外关闭 */
    private readonly onStatusMenuOutside = (evt: MouseEvent): void => {
        const target = evt.target;
        if (!(target instanceof Element)) return;
        if (this.statusMenuEl?.contains(target)) return;
        if (target.closest('.plan-annual-status-btn')) return;
        this.closeStatusMenu();
    };

    private readonly onStatusMenuKeyDown = (evt: KeyboardEvent): void => {
        if (evt.key === 'Escape') this.closeStatusMenu();
    };

    constructor(private readonly panelOptions: PlanAnnualPanelOptions) {
        super({
            width: 1000,
            title: panelOptions.title ?? t('panel.planAnnualTitle'),
            ...panelOptions,
        });
        this.body.addClass('plan-annual-panel');
        const current = parseWeekKey(getCurrentWeekKey());
        this.year = current.year;
        this.quarter = this.getQuarterOfMonth(new Date().getMonth() + 1);
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
        super.open();
    }

    /** 关闭面板时清理拖拽残留 */
    override close(): void {
        this.cancelDrag();
        this.closeStatusMenu();
        this.hideGoalTip();
        super.close();
    }

    /** 销毁面板时清理拖拽残留 */
    override destroy(): void {
        this.cancelDrag();
        this.closeStatusMenu();
        this.hideGoalTip();
        super.destroy();
    }

    /** 月份对应的季度（1-4） */
    private getQuarterOfMonth(month: number): number {
        return Math.floor((month - 1) / 3) + 1;
    }

    private renderLayout(): void {
        // 左侧：顶部占位（与右侧季度导航行等高）+ 根任务下拉（与右侧周列表头等高）+ 任务树 / 目标列表 + 底部工具栏
        const left = this.body.createDiv({ cls: 'plan-annual-left' });
        // 左侧顶部占位：「任务」「目标」按钮（与右侧季度导航行等高）
        const placeholder = left.createDiv({ cls: 'plan-annual-left-placeholder' });
        this.taskButtonEl = this.createToolbarButton(placeholder, 'list-todo', t('interface.task'));
        this.taskButtonEl.addEventListener('click', () => this.switchLeftMode('task'));
        this.goalButtonEl = this.createToolbarButton(placeholder, 'target', t('panel.planAnnualGoal'));
        this.goalButtonEl.addEventListener('click', () => this.switchLeftMode('goal'));
        this.rootSelectEl = left.createEl('select', { cls: 'dropdown plan-annual-root-select' });
        this.rootSelectEl.addEventListener('change', () => {
            this.rootTaskId = this.rootSelectEl.value || undefined;
            this.selectedTaskId = undefined;
            this.renderTree();
            this.renderGoalList();
            this.renderLanes();
            this.updateDetailButton();
        });
        this.treeEl = left.createDiv({ cls: 'plan-annual-tree' });
        this.treeEl.addEventListener('click', (evt) => {
            const row = (evt.target as HTMLElement).closest('.task-detail-tree-row') as HTMLElement | null;
            const taskId = row?.dataset.taskId;
            if (!taskId) return;
            // 再次点击已选中的条目则取消选中
            if (taskId === this.selectedTaskId) this.clearTaskSelection();
            else this.selectTask(taskId);
        });
        // 目标列表：与任务树共用同一位置，按模式互斥显示
        this.goalListEl = left.createDiv({ cls: 'plan-annual-goal-list is-hidden' });

        // 左侧底部工具栏：「信息」按钮（暂为占位，点击无响应）
        const toolbar = left.createDiv({ cls: 'plan-annual-left-toolbar' });
        this.createToolbarButton(toolbar, 'info', t('panel.planTaskInfo'));

        // 右侧：季度导航行 + 周列表头 + 泳道行 + 目标占位面板
        const right = this.body.createDiv({ cls: 'plan-annual-right' });
        this.navEl = right.createDiv({ cls: 'plan-annual-nav' });
        this.weekHeaderEl = right.createDiv({ cls: 'plan-annual-header' });
        this.laneEl = right.createDiv({ cls: 'plan-annual-lanes' });
        this.goalEl = right.createDiv({ cls: 'plan-annual-goal' });

        // 点击面板空白处取消色块选中
        this.laneEl.addEventListener('pointerdown', (evt) => {
            if ((evt.target as HTMLElement).closest('.plan-annual-bar')) return;
            this.clearBarSelection();
        });

        // 底部目标区：悬浮某一周列时显示该周全部分配目标的悬浮面板
        this.goalEl.addEventListener('pointermove', (evt) => this.onGoalHover(evt));
        this.goalEl.addEventListener('pointerleave', () => this.hideGoalTip());

        // 纵向滚动同步：任一侧滚动时另一侧跟随，保证任务树行与泳道行始终对齐
        this.treeEl.addEventListener('scroll', () => {
            this.laneEl.scrollTop = this.treeEl.scrollTop;
        });
        this.laneEl.addEventListener('scroll', () => {
            this.treeEl.scrollTop = this.laneEl.scrollTop;
        });

        this.refreshRootSelect();
        this.switchLeftMode(this.leftMode);
    }

    /** 切换左侧模式：任务树 / 目标列表（两个按钮互斥高亮） */
    private switchLeftMode(mode: LeftMode): void {
        this.leftMode = mode;
        this.taskButtonEl.toggleClass('is-active', mode === 'task');
        this.goalButtonEl.toggleClass('is-active', mode === 'goal');
        this.treeEl.toggleClass('is-hidden', mode !== 'task');
        this.goalListEl.toggleClass('is-hidden', mode !== 'goal');
        if (mode === 'goal') this.renderGoalList();
    }

    /** 渲染目标列表：当前根任务的目标 + 末尾「添加目标」卡片 */
    private renderGoalList(): void {
        this.goalListEl.empty();
        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        for (const goal of rootTask?.goals ?? []) {
            const row = this.goalListEl.createDiv({ cls: 'plan-annual-goal-item' });
            row.toggleClass('is-done', goal.done === true);
            setIcon(row.createSpan({ cls: 'plan-annual-goal-icon' }), goal.done ? 'circle-check' : 'target');
            row.createSpan({ cls: 'plan-annual-goal-text', text: goal.text });
            // 末尾日历图标：点击选择把该目标分配到某一周
            const weekBtn = row.createSpan({ cls: 'plan-annual-goal-week-btn' });
            weekBtn.toggleClass('is-assigned', !!goal.startWeek);
            setIcon(weekBtn, 'calendar');
            weekBtn.title = goal.startWeek
                ? this.formatWeekRange(goal.startWeek, goal.endWeek ?? goal.startWeek)
                : t('panel.planAnnualAssignWeek');
            weekBtn.addEventListener('click', (evt) => {
                evt.stopPropagation();
                this.openGoalWeekMenu(weekBtn, goal);
            });
        }
        this.renderGoalAddCard(rootTask);
    }

    /** 打开周选择菜单：列出当前季度各周，点击把目标分配到该周（再次点击同一周取消分配） */
    private openGoalWeekMenu(anchorEl: HTMLElement, goal: TaskGoalEntry): void {
        this.closeStatusMenu();
        const menu = document.body.createDiv({ cls: 'plan-annual-status-menu plan-annual-week-menu' });
        applyThemeColors(menu, getCurrentThemeColors());
        this.statusMenuEl = menu;
        for (const item of this.quarterWeeks) {
            const row = menu.createDiv({ cls: 'plan-annual-status-item' });
            row.toggleClass('is-active', goal.startWeek === item.weekKey);
            setIcon(row.createSpan({ cls: 'plan-annual-status-item-icon' }), 'calendar');
            row.createSpan({
                cls: 'plan-annual-status-item-text',
                text: `W${String(item.week).padStart(2, '0')}  ${Number(item.mondayKey.slice(5, 7))}/${Number(item.mondayKey.slice(8, 10))}`,
            });
            row.addEventListener('click', (evt) => {
                evt.stopPropagation();
                if (goal.startWeek === item.weekKey) {
                    goal.startWeek = undefined;
                    goal.endWeek = undefined;
                } else {
                    goal.startWeek = item.weekKey;
                    goal.endWeek = item.weekKey;
                }
                void this.panelOptions.save();
                this.closeStatusMenu();
                this.renderGoalList();
                this.renderGoalLanes();
                this.panelOptions.onChanged?.();
            });
        }
        // 贴在图标下方，右侧空间不足时向左收敛
        const rect = anchorEl.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const top = rect.bottom + height > window.innerHeight - 8
            ? Math.max(8, rect.top - height - 4)
            : rect.bottom + 4;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        document.addEventListener('mousedown', this.onStatusMenuOutside, true);
        document.addEventListener('keydown', this.onStatusMenuKeyDown);
    }

    /** 目标列表末尾的「添加目标」卡片：点击后变为内联输入框，回车保存并关闭 */
    private renderGoalAddCard(rootTask: PrototypeTask | undefined): void {
        const card = this.goalListEl.createDiv({ cls: 'plan-annual-goal-add' });
        setIcon(card.createSpan({ cls: 'plan-annual-goal-add-icon' }), 'plus');
        card.createSpan({ cls: 'plan-annual-goal-add-text', text: t('panel.planAnnualAddGoal') });
        card.addEventListener('click', () => {
            if (!rootTask) return;
            card.empty();
            card.addClass('is-editing');
            const input = card.createEl('input', {
                cls: 'plan-annual-goal-input',
                attr: { type: 'text', placeholder: t('panel.planAnnualAddGoal') },
            });
            input.focus();
            let committed = false;
            const commit = (): void => {
                if (committed) return;
                committed = true;
                const text = input.value.trim();
                if (!text) {
                    this.renderGoalList();
                    return;
                }
                rootTask.goals = [
                    ...(rootTask.goals ?? []),
                    { id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text, createdAt: Date.now() },
                ];
                void this.panelOptions.save();
                this.renderGoalList();
                this.panelOptions.onChanged?.();
            };
            input.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter') {
                    evt.preventDefault();
                    commit();
                } else if (evt.key === 'Escape') {
                    evt.preventDefault();
                    committed = true;
                    this.renderGoalList();
                }
            });
            input.addEventListener('blur', commit);
        });
    }

    /** 左侧工具栏按钮（图标 + 文字） */
    private createToolbarButton(container: HTMLElement, icon: string, label: string): HTMLButtonElement {
        const button = container.createEl('button', { cls: 'plan-toolbar-btn', attr: { type: 'button' } });
        setIcon(button.createSpan({ cls: 'plan-toolbar-btn-icon' }), icon);
        button.createSpan({ cls: 'plan-toolbar-btn-text', text: label });
        return button;
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
        this.renderGoalList();
        this.renderQuarter();
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

    /** 渲染单条任务行（缩进 + 分支图标 + 名称 + 状态图标） */
    private renderTreeRow(parentEl: HTMLElement, task: PrototypeTask, depth: number): void {
        const row = parentEl.createDiv({ cls: 'task-detail-tree-row plan-annual-tree-row' });
        row.style.marginLeft = `${depth * TREE_DEPTH_INDENT}px`;
        row.dataset.taskId = task.id;
        row.toggleClass('is-selected', task.id === this.selectedTaskId);
        setIcon(row.createSpan({ cls: 'task-detail-tree-icon' }), 'git-branch');
        row.createSpan({ cls: 'task-detail-tree-label', text: task.name });
        // 所有状态（含未开始）都绘制状态图标，点击弹出状态下拉列表；
        // 未开始的图标仅在悬浮任务条目或选中任务时显示
        const statusEl = row.createSpan({ cls: 'plan-tree-status-icon plan-annual-status-btn' });
        statusEl.toggleClass('is-not-started', (task.status ?? 'notStarted') === 'notStarted');
        setIcon(statusEl, STATUS_ICONS[task.status ?? 'notStarted']);
        statusEl.addEventListener('click', (evt) => {
            evt.stopPropagation();
            this.openStatusMenu(statusEl, task);
        });
    }

    /** 打开状态下拉列表（挂在 body 上，贴在图标下方；选择后更新任务状态） */
    private openStatusMenu(anchorEl: HTMLElement, task: PrototypeTask): void {
        this.closeStatusMenu();
        const menu = document.body.createDiv({ cls: 'plan-annual-status-menu' });
        applyThemeColors(menu, getCurrentThemeColors());
        this.statusMenuEl = menu;
        const current = task.status ?? 'notStarted';
        for (const option of STATUS_OPTIONS) {
            const item = menu.createDiv({ cls: 'plan-annual-status-item' });
            item.toggleClass('is-active', option.value === current);
            setIcon(item.createSpan({ cls: 'plan-annual-status-item-icon' }), option.icon);
            item.createSpan({ cls: 'plan-annual-status-item-text', text: t(option.labelKey) });
            item.addEventListener('click', (evt) => {
                evt.stopPropagation();
                task.status = option.value;
                void this.panelOptions.save();
                this.closeStatusMenu();
                this.renderTree();
                this.panelOptions.onChanged?.();
            });
        }
        // 贴在图标下方，右侧空间不足时向左收敛
        const rect = anchorEl.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const top = rect.bottom + height > window.innerHeight - 8
            ? Math.max(8, rect.top - height - 4)
            : rect.bottom + 4;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        document.addEventListener('mousedown', this.onStatusMenuOutside, true);
        document.addEventListener('keydown', this.onStatusMenuKeyDown);
    }

    /** 关闭状态下拉列表 */
    private closeStatusMenu(): void {
        document.removeEventListener('mousedown', this.onStatusMenuOutside, true);
        document.removeEventListener('keydown', this.onStatusMenuKeyDown);
        this.statusMenuEl?.remove();
        this.statusMenuEl = null;
    }

    /** 当前根任务及其后代任务（按任务树顺序，与左侧任务树一一对应） */
    private getTreeTasks(): PrototypeTask[] {
        if (!this.rootTaskId) return [];
        const tasks = this.panelOptions.getTasks();
        const result: PrototypeTask[] = [];
        const rootTask = tasks.find((task) => task.id === this.rootTaskId);
        if (rootTask) result.push(rootTask);
        const collect = (parentId: string): void => {
            for (const child of tasks.filter((task) => task.parentId === parentId)) {
                result.push(child);
                collect(child.id);
            }
        };
        collect(this.rootTaskId);
        return result;
    }

    /** 选中任务条目（高亮任务树行与对应泳道行） */
    private selectTask(taskId: string): void {
        this.selectedTaskId = taskId;
        this.refreshSelection();
    }

    /** 取消选中任务条目 */
    private clearTaskSelection(): void {
        this.selectedTaskId = undefined;
        this.refreshSelection();
    }

    /** 同步任务树行与泳道行的选中态 */
    private refreshSelection(): void {
        this.treeEl.querySelectorAll('.task-detail-tree-row').forEach((el) => {
            const row = el as HTMLElement;
            row.toggleClass('is-selected', row.dataset.taskId === this.selectedTaskId);
        });
        this.laneEl.querySelectorAll('.plan-annual-lane-row').forEach((el) => {
            const row = el as HTMLElement;
            row.toggleClass('is-selected', row.dataset.taskId === this.selectedTaskId);
        });
        this.updateDetailButton();
    }

    /** 同步标题栏「跳转到任务详情」按钮的显隐：未选中任务时隐藏 */
    private updateDetailButton(): void {
        this.detailButtonEl?.toggleClass('is-hidden', !this.selectedTaskId);
    }

    /** 渲染季度导航行、周列表头、泳道行与底部目标区 */
    private renderQuarter(): void {
        this.quarterWeeks = this.buildQuarterWeeks(this.year, this.quarter);
        this.renderNav();
        this.renderHeader();
        this.renderLanes();
        this.renderGoalLanes();
    }

    /**
     * 底部目标区：与上方周列对齐。
     * 只绘制已分配到周的目标；同一周有多个目标时依次换行，每行为「图标 + 文字」。
     */
    private renderGoalLanes(): void {
        this.goalEl.empty();
        this.hideGoalTip();
        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        // 已分配且落在当前季度内的目标，按周从左到右排序（同周按创建时间）
        const placed = (rootTask?.goals ?? [])
            .map((goal) => ({
                goal,
                index: goal.startWeek
                    ? this.quarterWeeks.findIndex((item) => item.weekKey === goal.startWeek)
                    : -1,
            }))
            .filter((item) => item.index >= 0)
            .sort((a, b) => a.index - b.index || a.goal.createdAt - b.goal.createdAt);
        if (placed.length === 0) {
            this.goalEl.createDiv({ cls: 'plan-annual-goal-empty', text: t('panel.planAnnualNoGoal') });
            return;
        }
        // 同一周已有目标时换到下一行，避免互相遮挡
        const lanes: number[] = [];
        const rows = placed.map((item) => {
            let lane = 0;
            while (lanes[lane] === item.index) lane += 1;
            lanes[lane] = item.index;
            return { ...item, lane };
        });
        const laneCount = rows.reduce((max, item) => Math.max(max, item.lane + 1), 0);
        const body = this.goalEl.createDiv({ cls: 'plan-annual-goal-body' });
        body.style.height = `${laneCount * GOAL_ROW_HEIGHT + (laneCount - 1) * GOAL_ROW_GAP}px`;
        for (const item of rows) {
            // 图标 + 文字：图标落在绑定周列，文字向右延伸
            const row = body.createDiv({ cls: 'plan-annual-goal-row' });
            row.toggleClass('is-done', item.goal.done === true);
            row.style.left = `${(item.index / this.quarterWeeks.length) * 100}%`;
            row.style.top = `${item.lane * (GOAL_ROW_HEIGHT + GOAL_ROW_GAP)}px`;
            setIcon(row.createSpan({ cls: 'plan-annual-goal-row-icon' }), item.goal.done ? 'circle-check' : 'target');
            row.createSpan({ cls: 'plan-annual-goal-row-text', text: item.goal.text });
        }
    }

    /** 底部目标区悬浮：按鼠标横坐标定位周列，显示该周全部分配目标的悬浮面板 */
    private onGoalHover(evt: PointerEvent): void {
        const rect = this.goalEl.getBoundingClientRect();
        const count = this.quarterWeeks.length;
        if (count === 0) return;
        const index = Math.floor(((evt.clientX - rect.left) / rect.width) * count);
        if (index < 0 || index >= count) {
            this.hideGoalTip();
            return;
        }
        const week = this.quarterWeeks[index];
        if (week.weekKey !== this.goalTipWeekKey) {
            this.goalTipWeekKey = week.weekKey;
            this.renderGoalTip(week);
        }
        this.placeGoalTip(evt.clientX, evt.clientY);
    }

    /** 渲染悬浮面板：标题为周号 + 周一日期，内容为该周绑定的全部目标（图标 + 文字） */
    private renderGoalTip(week: QuarterWeek): void {
        if (!this.goalTipEl) {
            this.goalTipEl = document.body.createDiv({ cls: 'plan-annual-goal-tip' });
            applyThemeColors(this.goalTipEl, getCurrentThemeColors());
        }
        const tip = this.goalTipEl;
        tip.empty();
        tip.createDiv({
            cls: 'plan-annual-goal-tip-title',
            text: `W${String(week.week).padStart(2, '0')} · ${Number(week.mondayKey.slice(5, 7))}/${Number(week.mondayKey.slice(8, 10))}`,
        });
        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        const goals = (rootTask?.goals ?? [])
            .filter((goal) => goal.startWeek === week.weekKey)
            .sort((a, b) => a.createdAt - b.createdAt);
        if (goals.length === 0) {
            tip.createDiv({ cls: 'plan-annual-goal-tip-empty', text: t('panel.planAnnualNoGoal') });
            return;
        }
        for (const goal of goals) {
            const row = tip.createDiv({ cls: 'plan-annual-goal-tip-item' });
            row.toggleClass('is-done', goal.done === true);
            setIcon(row.createSpan({ cls: 'plan-annual-goal-tip-icon' }), goal.done ? 'circle-check' : 'target');
            row.createSpan({ cls: 'plan-annual-goal-tip-text', text: goal.text });
        }
    }

    /** 悬浮面板跟随鼠标（位于鼠标上方 12px 居中，收敛在视口内） */
    private placeGoalTip(clientX: number, clientY: number): void {
        const tip = this.goalTipEl;
        if (!tip) return;
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        const left = Math.max(8, Math.min(clientX - width / 2, window.innerWidth - width - 8));
        const top = Math.max(8, clientY - height - 12);
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
    }

    /** 隐藏悬浮面板 */
    private hideGoalTip(): void {
        this.goalTipEl?.remove();
        this.goalTipEl = null;
        this.goalTipWeekKey = null;
    }

    /** 季度导航行：← 2026年 Q2 →（跨年自动切换年份） */
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
        this.cancelDrag();
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

    /** 泳道行：每个任务一行，行内绘制排布区间色块 */
    private renderLanes(): void {
        this.laneEl.empty();
        const tasks = this.getTreeTasks();
        const categories = this.panelOptions.getCategories();
        for (const task of tasks) {
            const row = this.laneEl.createDiv({ cls: 'plan-annual-lane-row' });
            row.dataset.taskId = task.id;
            row.toggleClass('is-selected', task.id === this.selectedTaskId);
            row.addEventListener('click', () => this.selectTask(task.id));

            // 背景层：每列一个元素，负责竖向分隔线与拖拽新建
            const columnsEl = row.createDiv({ cls: 'plan-annual-lane-columns' });
            this.quarterWeeks.forEach((item, index) => {
                const column = columnsEl.createDiv({ cls: 'plan-annual-lane-column' });
                column.dataset.weekKey = item.weekKey;
                column.dataset.index = String(index);
                column.addEventListener('pointerdown', (evt) => this.startCreateDrag(evt, task, row, item.weekKey));
            });

            // 色块层：该任务全年排布区间在当前季度内的部分
            const bar = this.buildLaneBar(task);
            if (!bar) continue;
            const color = categories.find((category) => category.id === task.categoryId)?.color ?? '#888888';
            const barEl = row.createDiv({ cls: 'plan-annual-bar' });
            barEl.dataset.taskId = task.id;
            barEl.style.left = `${(bar.startIndex / this.quarterWeeks.length) * 100}%`;
            barEl.style.width = `${((bar.endIndex - bar.startIndex + 1) / this.quarterWeeks.length) * 100}%`;
            barEl.style.background = color;
            barEl.style.opacity = '0.75';
            barEl.title = this.formatWeekRange(bar.startWeekKey, bar.endWeekKey);
            barEl.addEventListener('click', (evt) => {
                evt.stopPropagation();
                this.selectTask(task.id);
                this.selectBar(barEl);
            });
            if (bar.clippedStart) {
                setIcon(barEl.createSpan({ cls: 'plan-annual-bar-clip is-start' }), 'chevron-left');
            }
            if (bar.clippedEnd) {
                setIcon(barEl.createSpan({ cls: 'plan-annual-bar-clip is-end' }), 'chevron-right');
            }
            // 左右拖拽手柄：只移动被拖拽的那一端，另一端保持不动
            const startHandle = barEl.createSpan({ cls: 'plan-annual-bar-handle is-start' });
            startHandle.addEventListener('pointerdown', (evt) => this.startEdgeDrag(
                evt,
                task,
                row,
                bar.startWeekKey,
                'start',
                bar.endWeekKey,
            ));
            const endHandle = barEl.createSpan({ cls: 'plan-annual-bar-handle is-end' });
            endHandle.addEventListener('pointerdown', (evt) => this.startEdgeDrag(
                evt,
                task,
                row,
                bar.endWeekKey,
                'end',
                bar.startWeekKey,
            ));
        }
    }

    /** 选中色块（描边 + 手柄常驻） */
    private selectBar(barEl: HTMLElement): void {
        this.laneEl.querySelectorAll('.plan-annual-bar').forEach((el) => {
            (el as HTMLElement).toggleClass('is-selected', el === barEl);
        });
    }

    /** 取消色块选中 */
    private clearBarSelection(): void {
        this.laneEl.querySelectorAll('.plan-annual-bar').forEach((el) => {
            (el as HTMLElement).removeClass('is-selected');
        });
    }

    /** 计算任务在当前季度内的排布区间（无排布或不在本季度时返回 null） */
    private buildLaneBar(task: PrototypeTask): LaneBar | null {
        const weekKeys = this.panelOptions.planAssignmentRepo
            .taskWeekAssignments(task.id)
            .map((assignment) => assignment.weekKey)
            .sort((a, b) => this.weekTime(a) - this.weekTime(b));
        if (weekKeys.length === 0) return null;
        const startWeekKey = weekKeys[0];
        const endWeekKey = weekKeys[weekKeys.length - 1];
        const startTime = this.weekTime(startWeekKey);
        const endTime = this.weekTime(endWeekKey);
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
        return {
            task,
            startIndex,
            endIndex,
            clippedStart: startTime < quarterStart,
            clippedEnd: endTime > quarterEnd,
            startWeekKey,
            endWeekKey,
        };
    }

    /** 周键对应周一的时间戳（用于跨年周的正确比较） */
    private weekTime(weekKey: string): number {
        return new Date(`${makeDayKeyFromWeek(weekKey, 1)}T00:00:00`).getTime();
    }

    /** 周区间文案（含年份，如「2026-W45 - 2026-W48」；单周时「2026-W45」） */
    private formatWeekRange(startWeekKey: string, endWeekKey: string): string {
        return startWeekKey === endWeekKey ? startWeekKey : `${startWeekKey} - ${endWeekKey}`;
    }

    /** 拖拽提示文案（不含年份，如「W45 - W48」；单周时「W45」） */
    private formatWeekRangeShort(startWeekKey: string, endWeekKey: string): string {
        const start = `W${String(parseWeekKey(startWeekKey).week).padStart(2, '0')}`;
        if (startWeekKey === endWeekKey) return start;
        return `${start} - W${String(parseWeekKey(endWeekKey).week).padStart(2, '0')}`;
    }

    /** 生成某年某季度的周列表（按周一日期遍历，周一所在月份决定季度归属） */
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

    /** 指针位置对应的周键（不在任何周列上时返回 null） */
    private weekKeyFromPoint(clientX: number, clientY: number): string | null {
        const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        const column = el?.closest('.plan-annual-lane-column') as HTMLElement | null;
        return column?.dataset.weekKey ?? null;
    }

    /** 开始拖拽调整区间边缘 */
    private startEdgeDrag(
        evt: PointerEvent,
        task: PrototypeTask,
        rowEl: HTMLElement,
        anchorWeekKey: string,
        mode: 'start' | 'end',
        fixedWeekKey: string,
    ): void {
        evt.stopPropagation();
        evt.preventDefault();
        this.beginDrag(evt, task, rowEl, anchorWeekKey, mode, fixedWeekKey);
    }

    /** 开始在空白周列拖拽新建区间 */
    private startCreateDrag(
        evt: PointerEvent,
        task: PrototypeTask,
        rowEl: HTMLElement,
        weekKey: string,
    ): void {
        if (evt.button !== 0) return;
        this.beginDrag(evt, task, rowEl, weekKey, 'create');
    }

    /** 初始化拖拽状态并绑定全局指针事件 */
    private beginDrag(
        evt: PointerEvent,
        task: PrototypeTask,
        rowEl: HTMLElement,
        anchorWeekKey: string,
        mode: 'start' | 'end' | 'create',
        fixedWeekKey?: string,
    ): void {
        this.cancelDrag();
        this.drag = {
            mode,
            taskId: task.id,
            rowEl,
            anchorWeekKey,
            fixedWeekKey,
            currentWeekKey: anchorWeekKey,
            startX: evt.clientX,
            startY: evt.clientY,
            active: false,
            previewEl: null,
            tipEl: null,
            edgeTimer: null,
        };
        window.addEventListener('pointermove', this.onDragMove);
        window.addEventListener('pointerup', this.onDragEnd);
        window.addEventListener('pointercancel', this.onDragEnd);
    }

    private readonly onDragMove = (evt: PointerEvent): void => {
        const drag = this.drag;
        if (!drag) return;
        if (!drag.active) {
            if (Math.abs(evt.clientX - drag.startX) < DRAG_THRESHOLD
                && Math.abs(evt.clientY - drag.startY) < DRAG_THRESHOLD) return;
            drag.active = true;
            document.body.addClass('plan-annual-dragging');
        }
        const weekKey = this.weekKeyFromPoint(evt.clientX, evt.clientY);
        if (weekKey) drag.currentWeekKey = weekKey;
        this.renderDragPreview();
        this.placeDragTip(evt.clientX, evt.clientY);
        this.scheduleEdgeFlip(evt.clientX);
    };

    private readonly onDragEnd = (): void => {
        const drag = this.drag;
        if (!drag) return;
        const active = drag.active;
        const range = this.getDragRange();
        this.cancelDrag();
        if (!active || !range) return;
        this.applyRange(drag.taskId, range.startWeekKey, range.endWeekKey);
    };

    /** 拖拽区间（起止周键，已按先后排序） */
    private getDragRange(): { startWeekKey: string; endWeekKey: string } | null {
        const drag = this.drag;
        if (!drag) return null;
        const anchor = this.weekTime(drag.anchorWeekKey);
        const current = this.weekTime(drag.currentWeekKey);
        // 调整边缘：先向内收缩到最短 1 周，继续拖拽时推动另一端
        if (drag.mode === 'start' && drag.fixedWeekKey) {
            const fixed = this.weekTime(drag.fixedWeekKey);
            return current <= fixed
                ? { startWeekKey: drag.currentWeekKey, endWeekKey: drag.fixedWeekKey }
                : { startWeekKey: drag.fixedWeekKey, endWeekKey: drag.currentWeekKey };
        }
        if (drag.mode === 'end' && drag.fixedWeekKey) {
            const fixed = this.weekTime(drag.fixedWeekKey);
            return current >= fixed
                ? { startWeekKey: drag.fixedWeekKey, endWeekKey: drag.currentWeekKey }
                : { startWeekKey: drag.currentWeekKey, endWeekKey: drag.fixedWeekKey };
        }
        return anchor <= current
            ? { startWeekKey: drag.anchorWeekKey, endWeekKey: drag.currentWeekKey }
            : { startWeekKey: drag.currentWeekKey, endWeekKey: drag.anchorWeekKey };
    }

    /** 渲染拖拽预览色块与周区间提示 */
    private renderDragPreview(): void {
        const drag = this.drag;
        if (!drag) return;
        const range = this.getDragRange();
        if (!range) return;
        const startIndex = this.quarterWeeks.findIndex((item) => item.weekKey === range.startWeekKey);
        const endIndex = this.quarterWeeks.findIndex((item) => item.weekKey === range.endWeekKey);
        // 区间完全不在当前季度内时不显示预览
        if (startIndex < 0 && endIndex < 0) {
            drag.previewEl?.remove();
            drag.previewEl = null;
            return;
        }
        const from = startIndex >= 0 ? startIndex : 0;
        const to = endIndex >= 0 ? endIndex : this.quarterWeeks.length - 1;
        if (!drag.previewEl) {
            drag.previewEl = drag.rowEl.createDiv({ cls: 'plan-annual-bar-preview' });
        }
        drag.previewEl.style.left = `${(from / this.quarterWeeks.length) * 100}%`;
        drag.previewEl.style.width = `${((to - from + 1) / this.quarterWeeks.length) * 100}%`;
        if (!drag.tipEl) {
            drag.tipEl = document.body.createDiv({ cls: 'plan-annual-drag-tip' });
            applyThemeColors(drag.tipEl, getCurrentThemeColors());
        }
        drag.tipEl.setText(this.formatWeekRangeShort(range.startWeekKey, range.endWeekKey));
    }

    /** 拖拽提示浮层跟随鼠标（位于鼠标上方 12px 居中，收敛在视口内） */
    private placeDragTip(clientX: number, clientY: number): void {
        const tip = this.drag?.tipEl;
        if (!tip) return;
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        const left = Math.max(8, Math.min(clientX - width / 2, window.innerWidth - width - 8));
        const top = Math.max(8, clientY - height - 12);
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
    }

    /** 拖到季度页面左右边缘停留后自动翻页 */
    private scheduleEdgeFlip(clientX: number): void {
        const drag = this.drag;
        if (!drag) return;
        const rect = this.laneEl.getBoundingClientRect();
        let delta = 0;
        if (clientX - rect.left <= EDGE_FLIP_DISTANCE) delta = -1;
        else if (rect.right - clientX <= EDGE_FLIP_DISTANCE) delta = 1;
        if (delta === 0) {
            this.clearEdgeTimer();
            return;
        }
        if (drag.edgeTimer !== null) return;
        drag.edgeTimer = window.setTimeout(() => {
            if (!this.drag) return;
            this.drag.edgeTimer = null;
            this.flipQuarterDuringDrag(delta);
        }, EDGE_FLIP_DELAY);
    }

    private clearEdgeTimer(): void {
        const drag = this.drag;
        if (!drag || drag.edgeTimer === null) return;
        window.clearTimeout(drag.edgeTimer);
        drag.edgeTimer = null;
    }

    /** 拖拽中翻页：保留拖拽状态，重绘新季度页面后继续预览 */
    private flipQuarterDuringDrag(delta: number): void {
        const drag = this.drag;
        if (!drag) return;
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
        this.quarterWeeks = this.buildQuarterWeeks(this.year, this.quarter);
        this.renderNav();
        this.renderHeader();
        this.renderLanes();
        // 重绘后行元素已重建，重新定位拖拽所属行
        const rowEl = this.laneEl.querySelector<HTMLElement>(
            `.plan-annual-lane-row[data-task-id="${drag.taskId}"]`,
        );
        if (!rowEl) {
            this.cancelDrag();
            return;
        }
        drag.rowEl = rowEl;
        drag.previewEl = null;
        this.renderDragPreview();
    }

    /** 结束拖拽并清理预览、提示与监听 */
    private cancelDrag(): void {
        const drag = this.drag;
        if (!drag) return;
        this.clearEdgeTimer();
        drag.previewEl?.remove();
        drag.tipEl?.remove();
        window.removeEventListener('pointermove', this.onDragMove);
        window.removeEventListener('pointerup', this.onDragEnd);
        window.removeEventListener('pointercancel', this.onDragEnd);
        document.body.removeClass('plan-annual-dragging');
        this.drag = null;
    }

    /**
     * 写入排布：区间内所有周整周排布，该任务区间外的周全部移除（全年同步，只保留一个连续区间）。
     * 写入后统一保存并通知界面视图刷新。
     */
    private applyRange(taskId: string, startWeekKey: string, endWeekKey: string): void {
        const repo = this.panelOptions.planAssignmentRepo;
        const rangeKeys = new Set<string>();
        let cursor = startWeekKey;
        const endTime = this.weekTime(endWeekKey);
        while (this.weekTime(cursor) <= endTime) {
            rangeKeys.add(cursor);
            cursor = shiftWeekKey(cursor, 1);
        }
        for (const assignment of repo.taskWeekAssignments(taskId)) {
            if (!rangeKeys.has(assignment.weekKey)) repo.removeWeek(assignment.weekKey, taskId);
        }
        for (const weekKey of Array.from(rangeKeys)) repo.addWeek(weekKey, taskId);
        void this.panelOptions.save();
        this.renderLanes();
        this.panelOptions.onChanged?.();
    }
}
