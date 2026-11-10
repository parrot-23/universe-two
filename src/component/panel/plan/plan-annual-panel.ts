// 计划年度面板：左右结构。
// 左侧：与习惯面板一致（顶部根任务下拉 + 选中根任务的后代任务树 + 底部工具栏「信息」「目标」按钮，按钮暂为占位）。
// 右侧：季度泳道图。顶部为季度翻页行（← 2026年 Q2 →）与周列表头（W45 / 11/03），
// 中间每个任务一行，行内用色块表示该任务整周排布的周区间（数据与计划一周面板共享 PlanAssignmentRepo）；
// 底部为固定高度的目标占位面板。
// 排布：拖动色块左右手柄调整区间起止周，在行内空白周列拖拽新建区间；松手后同步该任务全年整周排布。
import { setIcon } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
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
import { getTaskGoals, getWeekNote, setTaskGoals, setWeekNote } from '../../../shared/task-sections';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 计划年度面板配置 */
export interface PlanAnnualPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「计划年度」 */
    title?: string;
    /** 任务数据源（每次打开时重新读取，保证与其他视图一致） */
    getTasks: () => PrototypeTask[];
    /** 分类数据源（色块使用分类颜色） */
    getCategories: () => PlanCategory[];
    /** 计划排布数据仓库（与计划一周面板共享） */
    planAssignmentRepo: PlanAssignmentRepo;
    /** 数据保存回调（排布写入后持久化） */
    save: () => Promise<void>;
    /** 排布变更回调（界面视图「今天任务」方框据此刷新） */
    onChanged?: () => void;
    /** 点击标题栏跳转图标：在任务详情面板中打开左侧选中的任务 */
    onOpenTaskDetail?: (taskId: string) => void;
}

/** 任务状态对应的图标（与习惯面板任务树保持一致） */
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
    /** 目标列表中选中的目标 id：选中后点击底部格子可直接分配周 */
    private selectedGoalId: string | undefined;
    /** 当前季度内的周列表 */
    private quarterWeeks: QuarterWeek[] = [];
    /** 当前拖拽状态 */
    private drag: DragState | null = null;
    /** 状态下拉列表（挂在 body 上） */
    private statusMenuEl: HTMLElement | null = null;
    /** 点击目标格子后的新增目标浮层（挂在面板根节点内） */
    private goalEditorEl: HTMLElement | null = null;
    /** 新增目标浮层对应的周键 */
    private goalEditorWeekKey: string | null = null;
    /** 新增目标浮层的定位锚点（目标格子元素） */
    private goalEditorAnchorEl: HTMLElement | null = null;
    private goalEditorOutsideHandler: ((evt: MouseEvent) => void) | null = null;
    private goalEditorKeyHandler: ((evt: KeyboardEvent) => void) | null = null;

    /** 本周描述悬浮面板（挂在面板根节点内） */
    private weekGoalTipEl: HTMLElement | null = null;
    /** 悬浮面板内容对应的键（任务 id + 周键） */
    private weekGoalTipKey: string | undefined;
    /** 本周描述编辑面板（挂在面板根节点内） */
    private weekGoalEditorEl: HTMLElement | null = null;
    private weekGoalEditorOutsideHandler: ((evt: MouseEvent) => void) | null = null;
    private weekGoalEditorKeyHandler: ((evt: KeyboardEvent) => void) | null = null;

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

    /** 外部任务数据变化（如任务详情面板增删目标）后刷新：重建根任务下拉、任务树与底部目标区 */
    refresh(): void {
        if (!this.isOpen) return;
        this.refreshRootSelect();
    }

    /** 关闭面板时清理拖拽残留 */
    override close(): void {
        this.cancelDrag();
        this.closeStatusMenu();
        this.closeGoalEditor();
        this.closeWeekGoalTip();
        this.closeWeekGoalEditor();
        super.close();
    }

    /** 销毁面板时清理拖拽残留 */
    override destroy(): void {
        this.cancelDrag();
        this.closeStatusMenu();
        this.closeGoalEditor();
        this.closeWeekGoalTip();
        this.closeWeekGoalEditor();
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
            this.closeGoalEditor();
            this.rootTaskId = this.rootSelectEl.value || undefined;
            this.selectedTaskId = undefined;
            this.selectedGoalId = undefined;
            this.renderTree();
            this.renderGoalList();
            this.renderLanes();
            // 底部目标区绑定当前根任务，切换后必须同步重绘，否则会残留上一个根任务的目标
            this.renderGoalLanes();
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
        // 目标列表隐藏时清空目标选中态，避免看不到选中项时误分配
        if (mode === 'task') this.selectedGoalId = undefined;
        if (mode === 'goal') this.renderGoalList();
    }

    /** 渲染目标列表：当前根任务的目标 + 末尾「添加目标」卡片 */
    private renderGoalList(): void {
        this.goalListEl.empty();
        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        const goals = rootTask ? getTaskGoals(rootTask) : [];
        // 选中的目标已不存在时清空选中态
        if (this.selectedGoalId && !goals.some((goal) => goal.id === this.selectedGoalId)) {
            this.selectedGoalId = undefined;
        }
        for (const goal of goals) {
            const card = this.goalListEl.createDiv({ cls: 'plan-annual-goal-item' });
            card.dataset.goalId = goal.id;
            card.toggleClass('is-done', goal.done === true);
            card.toggleClass('is-selected', goal.id === this.selectedGoalId);
            // 点击条目选中 / 取消选中，选中后在底部目标格子点击即可分配周
            card.addEventListener('click', () => {
                this.selectedGoalId = this.selectedGoalId === goal.id ? undefined : goal.id;
                this.renderGoalList();
            });
            // 图标 + 目标文字 + 右上角已绑定周的标识（如 w05）
            const main = card.createDiv({ cls: 'plan-annual-goal-main' });
            setIcon(main.createSpan({ cls: 'plan-annual-goal-icon' }), goal.done ? 'circle-check' : 'target');
            main.createSpan({ cls: 'plan-annual-goal-text', text: goal.text });
            if (goal.startWeek) {
                const week = this.quarterWeeks.find((item) => item.weekKey === goal.startWeek);
                if (week) {
                    main.createSpan({
                        cls: 'plan-annual-goal-week-badge',
                        text: `w${String(week.week).padStart(2, '0')}`,
                    });
                }
            }
        }
        this.renderGoalAddCard(rootTask);
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
                setTaskGoals(rootTask, [
                    ...getTaskGoals(rootTask),
                    { id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text, createdAt: Date.now() },
                ]);
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
                this.renderLanes();
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
        // 季度变化后目标所属周列已变，底部目标区同步重绘
        this.renderGoalLanes();
        this.renderGoalLanes();
    }

    /**
     * 底部目标区：与上方周列对齐。
     * 底层按周列分割为格子（悬浮高亮、点击新增目标）；上层绘制已分配到周的目标，
     * 同一周有多个目标时依次换行，每行为「图标 + 文字」。
     */
    private renderGoalLanes(): void {
        this.goalEl.empty();
        const count = this.quarterWeeks.length;
        if (count === 0) return;

        // 列格子层：每列一格，当前周显示与表头 / 泳道一致的条纹
        const cells = this.goalEl.createDiv({ cls: 'plan-annual-goal-cells' });
        const currentWeekKey = getCurrentWeekKey();
        for (const item of this.quarterWeeks) {
            const cell = cells.createDiv({ cls: 'plan-annual-goal-cell' });
            cell.dataset.weekKey = item.weekKey;
            cell.toggleClass('is-current', item.weekKey === currentWeekKey);
            cell.addEventListener('click', () => this.handleGoalCellClick(item, cell));
        }

        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        // 已分配且落在当前季度内的目标，按周从左到右排序（同周按创建时间）
        const placed = (rootTask ? getTaskGoals(rootTask) : [])
            .map((goal) => ({
                goal,
                index: goal.startWeek
                    ? this.quarterWeeks.findIndex((item) => item.weekKey === goal.startWeek)
                    : -1,
            }))
            .filter((item) => item.index >= 0)
            .sort((a, b) => a.index - b.index || a.goal.createdAt - b.goal.createdAt);
        if (placed.length === 0) return;
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

    /** 点击底部目标格子：有选中目标时直接分配（同周再点取消），否则打开新增目标浮层 */
    private handleGoalCellClick(week: QuarterWeek, cell: HTMLElement): void {
        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        const goal = this.selectedGoalId && rootTask
            ? getTaskGoals(rootTask).find((item) => item.id === this.selectedGoalId)
            : undefined;
        if (!goal) {
            this.openGoalEditor(week, cell);
            return;
        }
        // 一个目标只绑定一个周：点击其他周即改绑，点击已绑定的周则取消
        const sameWeek = goal.startWeek === week.weekKey;
        goal.startWeek = sameWeek ? undefined : week.weekKey;
        goal.endWeek = sameWeek ? undefined : week.weekKey;
        void this.panelOptions.save();
        this.closeGoalEditor();
        this.renderGoalList();
        this.renderGoalLanes();
        this.panelOptions.onChanged?.();
    }

    /** 点击目标格子：在格子旁打开新增目标浮层（点击外部 / Esc 关闭） */
    private openGoalEditor(week: QuarterWeek, anchorEl: HTMLElement): void {
        this.closeGoalEditor();
        const editor = this.element.createDiv({ cls: 'plan-annual-goal-editor' });
        this.goalEditorEl = editor;
        this.goalEditorWeekKey = week.weekKey;
        this.goalEditorAnchorEl = anchorEl;
        this.goalEditorOutsideHandler = (evt: MouseEvent) => {
            if (editor.contains(evt.target as Node)) return;
            this.closeGoalEditor();
        };
        this.goalEditorKeyHandler = (evt: KeyboardEvent) => {
            if (evt.key !== 'Escape') return;
            // 先关闭浮层，避免同时关闭整个面板
            evt.preventDefault();
            evt.stopPropagation();
            this.closeGoalEditor();
        };
        document.addEventListener('mousedown', this.goalEditorOutsideHandler, true);
        document.addEventListener('keydown', this.goalEditorKeyHandler, true);
        this.renderGoalEditor();
    }

    /** 关闭新增目标浮层（移除元素与 document 监听） */
    private closeGoalEditor(): void {
        if (this.goalEditorOutsideHandler) {
            document.removeEventListener('mousedown', this.goalEditorOutsideHandler, true);
            this.goalEditorOutsideHandler = null;
        }
        if (this.goalEditorKeyHandler) {
            document.removeEventListener('keydown', this.goalEditorKeyHandler, true);
            this.goalEditorKeyHandler = null;
        }
        this.goalEditorEl?.remove();
        this.goalEditorEl = null;
        this.goalEditorWeekKey = null;
        this.goalEditorAnchorEl = null;
    }

    /** 重绘新增目标浮层（周标题 + 输入行 + 该周已有目标）并按锚点定位 */
    private renderGoalEditor(): void {
        const editor = this.goalEditorEl;
        const weekKey = this.goalEditorWeekKey;
        if (!editor || !weekKey) return;
        const week = this.quarterWeeks.find((item) => item.weekKey === weekKey);
        if (!week) {
            this.closeGoalEditor();
            return;
        }
        editor.empty();
        editor.createDiv({
            cls: 'plan-annual-goal-editor-head',
            text: `W${String(week.week).padStart(2, '0')} · ${Number(week.mondayKey.slice(5, 7))}/${Number(week.mondayKey.slice(8, 10))}`,
        });
        // 新增行：回车提交并保持输入焦点，便于连续添加
        const addRow = editor.createDiv({ cls: 'plan-annual-goal-editor-add' });
        const input = addRow.createEl('input', {
            cls: 'plan-annual-goal-editor-input',
            attr: { type: 'text', placeholder: t('panel.planAnnualAddGoal') },
        });
        input.addEventListener('keydown', (evt) => {
            if (evt.key !== 'Enter') return;
            evt.preventDefault();
            this.addGoalToWeek(input.value.trim(), weekKey);
        });
        const list = editor.createDiv({ cls: 'plan-annual-goal-editor-list' });
        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        const goals = (rootTask ? getTaskGoals(rootTask) : [])
            .filter((goal) => goal.startWeek === weekKey)
            .sort((a, b) => a.createdAt - b.createdAt);
        if (goals.length === 0) {
            list.createDiv({ cls: 'plan-annual-goal-editor-empty', text: t('panel.planAnnualNoGoal') });
        }
        for (const goal of goals) {
            const row = list.createDiv({ cls: 'plan-annual-goal-editor-item' });
            row.toggleClass('is-done', goal.done === true);
            setIcon(
                row.createSpan({ cls: 'plan-annual-goal-editor-icon' }),
                goal.done ? 'circle-check' : 'target',
            );
            row.createSpan({ cls: 'plan-annual-goal-editor-text', text: goal.text });
        }
        this.positionGoalEditor();
        input.focus();
    }

    /** 新增目标并自动绑定到格子对应的周，保存后刷新目标区与左侧目标列表 */
    private addGoalToWeek(text: string, weekKey: string): void {
        if (!text) return;
        const rootTask = this.panelOptions.getTasks().find((task) => task.id === this.rootTaskId);
        if (!rootTask) return;
        setTaskGoals(rootTask, [
            ...getTaskGoals(rootTask),
            {
                id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                text,
                createdAt: Date.now(),
                startWeek: weekKey,
                endWeek: weekKey,
            },
        ]);
        void this.panelOptions.save();
        this.renderGoalLanes();
        this.renderGoalList();
        this.panelOptions.onChanged?.();
        // 重绘后格子元素已重建，按周键重新定位锚点并刷新浮层，保持连续添加
        this.goalEditorAnchorEl = Array.from(
            this.goalEl.querySelectorAll<HTMLElement>('.plan-annual-goal-cell'),
        ).find((el) => el.dataset.weekKey === weekKey) ?? null;
        this.renderGoalEditor();
    }

    /** 浮层定位：横向对齐格子中心，纵向优先显示在格子上方，空间不足时翻到下方 */
    private positionGoalEditor(): void {
        const editor = this.goalEditorEl;
        const anchor = this.goalEditorAnchorEl;
        if (!editor || !anchor) return;
        const rootRect = this.element.getBoundingClientRect();
        const rect = anchor.getBoundingClientRect();
        const width = editor.offsetWidth;
        const height = editor.offsetHeight;
        const rawLeft = rect.left - rootRect.left + rect.width / 2 - width / 2;
        const maxLeft = Math.max(8, rootRect.width - width - 8);
        let top = rect.top - rootRect.top - height - 6;
        if (top < 8) top = rect.bottom - rootRect.top + 6;
        editor.style.left = `${Math.min(Math.max(rawLeft, 8), maxLeft)}px`;
        editor.style.top = `${Math.max(8, top)}px`;
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
        this.closeGoalEditor();
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
        const currentWeekKey = getCurrentWeekKey();
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
                // 当前周列与表头使用同样的条纹背景，纵向贯通所有泳道行
                column.toggleClass('is-current', item.weekKey === currentWeekKey);
                column.addEventListener('pointerdown', (evt) => this.startCreateDrag(evt, task, row, item.weekKey));
            });

            // 子任务向上汇总线：所有后代任务排布的并集，仅视觉展示，不写入排布仓库
            this.renderAggregateLines(row, task);

            // 色块层：该任务全年排布区间在当前季度内的部分
            const bar = this.buildLaneBar(task);
            if (!bar) continue;
            const color = categories.find((category) => category.id === task.categoryId)?.color ?? '#888888';
            const barEl = row.createDiv({ cls: 'plan-annual-bar' });
            barEl.dataset.taskId = task.id;
            barEl.style.left = `${(bar.startIndex / this.quarterWeeks.length) * 100}%`;
            barEl.style.width = `${((bar.endIndex - bar.startIndex + 1) / this.quarterWeeks.length) * 100}%`;
            // 分类色作为基准色，具体填充方式由任务状态样式决定
            barEl.style.setProperty('--plan-bar-color', color);
            const status = task.status ?? 'notStarted';
            barEl.toggleClass('is-in-progress', status === 'inProgress');
            barEl.toggleClass('is-done', status === 'done');
            barEl.toggleClass('is-paused', status === 'paused');
            barEl.toggleClass('is-not-started', status === 'notStarted');
            // 进度条按周拆格：填写了本周描述的周在格子右下角显示标识
            const barWeeks = this.quarterWeeks.slice(bar.startIndex, bar.endIndex + 1);
            const weekSpan = barWeeks.length;
            for (let offset = 0; offset < weekSpan; offset++) {
                const weekKey = barWeeks[offset].weekKey;
                const cell = barEl.createDiv({ cls: 'plan-annual-bar-cell' });
                cell.style.left = `${(offset / weekSpan) * 100}%`;
                cell.style.width = `${(1 / weekSpan) * 100}%`;
                if (getWeekNote(task, weekKey).trim()) {
                    cell.addClass('has-week-goal');
                    cell.createSpan({ cls: 'plan-annual-bar-weekgoal-mark' });
                }
            }
            barEl.addEventListener('click', (evt) => {
                evt.stopPropagation();
                // 首次点击仅选中进度条，已选中时再次点击进入该周的本周描述编辑
                const wasSelected = barEl.hasClass('is-selected');
                this.selectTask(task.id);
                this.selectBar(barEl);
                if (!wasSelected) return;
                const index = this.barWeekIndexAt(barEl, evt.clientX, weekSpan);
                if (index < 0) return;
                this.openWeekGoalEditor(task, barWeeks[index].weekKey, this.barCellRect(barEl, index, weekSpan));
            });
            barEl.addEventListener('pointermove', (evt) => {
                if (this.drag) return;
                const index = this.barWeekIndexAt(barEl, evt.clientX, weekSpan);
                if (index < 0) {
                    this.closeWeekGoalTip();
                    return;
                }
                const weekKey = barWeeks[index].weekKey;
                const desc = getWeekNote(task, weekKey).trim();
                if (!desc) {
                    this.closeWeekGoalTip();
                    return;
                }
                this.showWeekGoalTip(task.id, weekKey, desc, this.barCellRect(barEl, index, weekSpan));
            });
            barEl.addEventListener('pointerleave', () => this.closeWeekGoalTip());
            // 右键：删除该任务的整条计划（全年排布全部移除）
            barEl.addEventListener('contextmenu', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.removeTaskBar(task.id);
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

    /**
     * 绘制子任务向上汇总线：取所有后代任务真实排布的并集，
     * 仅作视觉展示（不参与拖拽、右键删除与周计划排布）。
     */
    private renderAggregateLines(row: HTMLElement, task: PrototypeTask): void {
        const segments = this.buildAggregateSegments(task);
        for (const segment of segments) {
            const line = row.createDiv({ cls: 'plan-annual-agg-line' });
            line.style.left = `${(segment.startIndex / this.quarterWeeks.length) * 100}%`;
            line.style.width = `${((segment.endIndex - segment.startIndex + 1) / this.quarterWeeks.length) * 100}%`;
        }
    }

    /** 汇总线在当前季度内的分段（按周列下标，连续周合并为一段） */
    private buildAggregateSegments(task: PrototypeTask): { startIndex: number; endIndex: number }[] {
        const tasks = this.panelOptions.getTasks();
        const descendantIds: string[] = [];
        const collect = (parentId: string): void => {
            for (const child of tasks.filter((item) => item.parentId === parentId)) {
                descendantIds.push(child.id);
                collect(child.id);
            }
        };
        collect(task.id);
        if (descendantIds.length === 0) return [];
        const repo = this.panelOptions.planAssignmentRepo;
        const descendantTimes: number[] = [];
        for (const id of descendantIds) {
            for (const assignment of repo.taskWeekAssignments(id)) {
                descendantTimes.push(this.weekTime(assignment.weekKey));
            }
        }
        if (descendantTimes.length === 0) return [];
        const aggregateStart = Math.min(...descendantTimes);
        const aggregateEnd = Math.max(...descendantTimes);
        const segments: { startIndex: number; endIndex: number }[] = [];
        this.quarterWeeks.forEach((item, index) => {
            const time = this.weekTime(item.weekKey);
            if (time < aggregateStart || time > aggregateEnd) return;
            const last = segments[segments.length - 1];
            if (last && last.endIndex === index - 1) last.endIndex = index;
            else segments.push({ startIndex: index, endIndex: index });
        });
        return segments;
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

    /** 鼠标横坐标 → 进度条内的周格子下标（不在进度条范围内返回 -1） */
    private barWeekIndexAt(barEl: HTMLElement, clientX: number, span: number): number {
        if (span <= 0) return -1;
        const rect = barEl.getBoundingClientRect();
        if (rect.width <= 0) return -1;
        const ratio = (clientX - rect.left) / rect.width;
        if (ratio < 0 || ratio > 1) return -1;
        return Math.min(span - 1, Math.floor(ratio * span));
    }

    /** 进度条内某一周格子的屏幕矩形 */
    private barCellRect(
        barEl: HTMLElement,
        index: number,
        span: number,
    ): { left: number; top: number; width: number; height: number } {
        const rect = barEl.getBoundingClientRect();
        const cellWidth = rect.width / span;
        return {
            left: rect.left + cellWidth * index,
            top: rect.top,
            width: cellWidth,
            height: rect.height,
        };
    }

    /** 显示本周描述悬浮面板：有描述时才显示，优先显示在格子下方 */
    private showWeekGoalTip(
        taskId: string,
        weekKey: string,
        desc: string,
        cellRect: { left: number; top: number; width: number; height: number },
    ): void {
        let tip = this.weekGoalTipEl;
        if (!tip) {
            tip = this.element.createDiv({ cls: 'plan-annual-weekgoal-tip' });
            this.weekGoalTipEl = tip;
        }
        const key = `${taskId}:${weekKey}:${desc}`;
        if (this.weekGoalTipKey !== key) {
            tip.empty();
            tip.createDiv({ cls: 'plan-annual-weekgoal-tip-head', text: t('panel.planWeekDescription') });
            tip.createDiv({ cls: 'plan-annual-weekgoal-tip-week', text: this.formatWeekRange(weekKey, weekKey) });
            tip.createDiv({ cls: 'plan-annual-weekgoal-tip-text', text: desc });
            this.weekGoalTipKey = key;
        }
        tip.style.display = 'flex';
        const rootRect = this.element.getBoundingClientRect();
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        const rawLeft = cellRect.left - rootRect.left + cellRect.width / 2 - width / 2;
        const maxLeft = Math.max(8, rootRect.width - width - 8);
        let top = cellRect.top - rootRect.top + cellRect.height + 6;
        if (top + height > rootRect.height - 8) {
            top = cellRect.top - rootRect.top - height - 6;
        }
        tip.style.left = `${Math.min(Math.max(rawLeft, 8), maxLeft)}px`;
        tip.style.top = `${Math.max(8, top)}px`;
    }

    /** 关闭本周描述悬浮面板 */
    private closeWeekGoalTip(): void {
        this.weekGoalTipEl?.remove();
        this.weekGoalTipEl = null;
        this.weekGoalTipKey = undefined;
    }

    /** 打开本周描述编辑面板：文本框失焦保存，点击外部 / Esc 关闭 */
    private openWeekGoalEditor(
        task: PrototypeTask,
        weekKey: string,
        cellRect: { left: number; top: number; width: number; height: number },
    ): void {
        this.closeWeekGoalEditor();
        this.closeWeekGoalTip();
        const editor = this.element.createDiv({ cls: 'plan-annual-weekgoal-editor' });
        this.weekGoalEditorEl = editor;
        editor.createDiv({ cls: 'plan-annual-weekgoal-editor-head', text: t('panel.planWeekDescription') });
        editor.createDiv({ cls: 'plan-annual-weekgoal-editor-week', text: this.formatWeekRange(weekKey, weekKey) });
        const textarea = editor.createEl('textarea', {
            cls: 'plan-annual-weekgoal-editor-input',
            attr: { placeholder: t('panel.planWeekDescriptionPlaceholder') },
        });
        textarea.value = getWeekNote(task, weekKey);

        const commit = (): void => {
            this.saveWeekGoal(task, weekKey, textarea.value);
        };
        textarea.addEventListener('blur', () => commit());
        this.weekGoalEditorOutsideHandler = (evt) => {
            const target = evt.target;
            if (target instanceof Node && editor.contains(target)) return;
            commit();
            this.closeWeekGoalEditor();
        };
        this.weekGoalEditorKeyHandler = (evt) => {
            if (evt.key !== 'Escape') return;
            evt.preventDefault();
            evt.stopPropagation();
            commit();
            this.closeWeekGoalEditor();
        };
        document.addEventListener('mousedown', this.weekGoalEditorOutsideHandler, true);
        document.addEventListener('keydown', this.weekGoalEditorKeyHandler, true);

        // 定位：优先显示在格子下方，空间不足时翻到上方
        const rootRect = this.element.getBoundingClientRect();
        const width = editor.offsetWidth;
        const height = editor.offsetHeight;
        const rawLeft = cellRect.left - rootRect.left + cellRect.width / 2 - width / 2;
        const maxLeft = Math.max(8, rootRect.width - width - 8);
        let top = cellRect.top - rootRect.top + cellRect.height + 6;
        if (top + height > rootRect.height - 8) {
            top = cellRect.top - rootRect.top - height - 6;
        }
        editor.style.left = `${Math.min(Math.max(rawLeft, 8), maxLeft)}px`;
        editor.style.top = `${Math.max(8, top)}px`;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    /** 关闭本周描述编辑面板 */
    private closeWeekGoalEditor(): void {
        if (this.weekGoalEditorOutsideHandler) {
            document.removeEventListener('mousedown', this.weekGoalEditorOutsideHandler, true);
            this.weekGoalEditorOutsideHandler = null;
        }
        if (this.weekGoalEditorKeyHandler) {
            document.removeEventListener('keydown', this.weekGoalEditorKeyHandler, true);
            this.weekGoalEditorKeyHandler = null;
        }
        this.weekGoalEditorEl?.remove();
        this.weekGoalEditorEl = null;
    }

    /** 保存某一周的本周描述（为空时删除），并刷新泳道 */
    private saveWeekGoal(task: PrototypeTask, weekKey: string, raw: string): void {
        const next = raw.trim();
        if (next === getWeekNote(task, weekKey)) return;
        setWeekNote(task, weekKey, next);
        void this.panelOptions.save();
        this.renderLanes();
        this.panelOptions.onChanged?.();
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

    /**
     * 指针横坐标对应的周键（按拖拽行宽度百分比换算，不在周列范围内时返回 null）。
     * 不用 elementFromPoint：拖拽手柄时指针始终在色块上，色块与周列层是兄弟节点，
     * 命中元素里找不到周列，会导致同一行内拖动时周键不更新。
     */
    private weekKeyFromPoint(clientX: number): string | null {
        const drag = this.drag;
        if (!drag) return null;
        const count = this.quarterWeeks.length;
        if (count === 0) return null;
        const rect = drag.rowEl.getBoundingClientRect();
        if (rect.width <= 0) return null;
        const index = Math.floor(((clientX - rect.left) / rect.width) * count);
        if (index < 0 || index >= count) return null;
        return this.quarterWeeks[index].weekKey;
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
        const weekKey = this.weekKeyFromPoint(evt.clientX);
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
        // 季度变化后目标所属周列已变，底部目标区同步重绘
        this.renderGoalLanes();
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
     * 写入排布：只写入被拖拽任务自身的区间。
     * 父级不再自动写入真实排布，改由渲染时按后代任务求并集绘制汇总线（仅视觉展示）。
     */
    private applyRange(taskId: string, startWeekKey: string, endWeekKey: string): void {
        this.writeRange(taskId, startWeekKey, endWeekKey);
        void this.panelOptions.save();
        this.renderLanes();
        this.panelOptions.onChanged?.();
    }

    /** 右键删除计划条：移除该任务的全年整周排布 */
    private removeTaskBar(taskId: string): void {
        const repo = this.panelOptions.planAssignmentRepo;
        for (const assignment of repo.taskWeekAssignments(taskId)) {
            repo.removeWeek(assignment.weekKey, taskId);
        }
        void this.panelOptions.save();
        this.renderLanes();
        this.panelOptions.onChanged?.();
    }

    /** 写入某任务的连续整周区间：区间内全部排布，区间外的排布全部移除（全年单区间） */
    private writeRange(taskId: string, startWeekKey: string, endWeekKey: string): void {
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
    }
}
