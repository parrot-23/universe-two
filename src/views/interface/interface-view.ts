// 界面视图：新一级视图「界面」下的二级落地页。
// 布局：日期 / 今日时钟 / 今日任务 / 时钟等浮动卡片，右侧垂直功能栏；任务板块内容改为面板（点击任务条目打开）。
import type { App, Plugin } from 'obsidian';

import { DateCard } from '../../component/cards/date-card';
import { createInterfaceCardShell } from '../../component/cards/interface-card-shell';
import { NavCard } from '../../component/cards/nav-card';
import { TodayCard } from '../../component/cards/task/today-card';
import { TodayTasksCard } from '../../component/cards/task/today-tasks-card';
import { TodayTasksSimpleCard } from '../../component/cards/task/today-tasks-simple-card';
import { ClockCard } from '../../component/cards/clock-card';
import type { PrototypeTask, PrototypeTaskType } from '../../datatypes/prototype-task';
import { t } from '../../i18n';
import { AchievementPanel } from '../../component/panel/achievement/achievement-panel';
import { CardPickerPanel } from '../../component/panel/interface/card-picker-panel';
import { CheckPanel } from '../../component/panel/check/check-panel';
import { CollectPanel } from '../../component/panel/collect/collect-panel';
import { DataPanel } from '../../component/panel/check/data-panel';
import { GalleryPanel } from '../../component/panel/gallery/gallery-panel';
import { GoalPanel } from '../../component/panel/goal/goal-panel';
import { HabitPanel } from '../../component/panel/plan/habit-panel';
import { PlanAnnualPanel } from '../../component/panel/plan/plan-annual-panel';
import { PlanWeekPanel } from '../../component/panel/plan/plan-week-panel';
import { TaskSectionsPanel } from '../../component/panel/task/task-sections-panel';
import { TaskDetailPanel } from '../../component/panel/task/task-detail-panel';
import { TaskConfigPanel, type TaskConfigSavePayload } from '../../component/panel/task/task-config-panel';
import { TaskPanel } from '../../component/panel/task/task-panel';
import { TimeBoxPanel } from '../../component/panel/timebox/time-box-panel';
import { WeekCalendarPanel } from '../../component/panel/calendar/week-calendar-panel';
import { ThemePanel } from '../../component/panel/interface/theme-panel';
import type { BaseRepo } from '../../repos/base-repo';
import type { CategoryRepo } from '../../repos/category-repo';
import type { PlanAssignmentRepo } from '../../repos/plan-assignment-repo';
import type { PrototypeTaskRepo } from '../../repos/prototype-task-repo';
import type { TaskExecutionRepo } from '../../repos/task-execution-repo';
import type { ThemeRepo } from '../../repos/theme-repo';
import { THEME_DEFINITIONS, getThemeDefinition } from '../../themestory/registry';
import { applyThemeColors, setCurrentThemeColors } from '../../themestory/theme-colors';
import type { PlanCategoryData } from '../../shared/plan-category-manager';
import { getCurrentWeekKey, getISOWeek, makeDayKey, makeWeekKey } from '../../shared/plan-data';
import { renameTaskDir, sanitizeFolderName } from '../../shared/task-library';

/** 界面视图配置 */
export interface InterfaceViewOptions {
    /** 顶部工具栏当前选中的日期（用于初始化今日任务卡片） */
    getSelectedDate?: () => Date;
    /** 卡片内切换日期后回调（供顶部工具栏同步） */
    onSelectedDateChange?: (date: Date) => void;
}

/** 卡片之间的最小水平间距（与界面布局 gap 保持一致） */
const CARD_GAP = 12;

/** 参与位置夹取与推挤的卡片信息 */
interface LayoutCardItem {
    shellEl: HTMLElement;
    /** 相对界面主区域的坐标与尺寸 */
    left: number;
    top: number;
    width: number;
    height: number;
    /** 排序基准：持久化坐标，用于保留卡片原本的左右顺序（不能用夹取后的 left） */
    anchorLeft: number;
    /** 是否有持久化坐标：只有这类卡片会被推挤，CSS 默认定位的卡片作为固定障碍 */
    movable: boolean;
}

/**
 * 界面视图：与其它二级视图一致，通过 renderInto 渲染到指定容器。
 */
export class InterfaceView {
    private app: App;
    private plugin: Plugin;
    /** 日期卡片对应的周历面板（懒创建，复用同一个实例） */
    private datePanel: WeekCalendarPanel | null = null;
    /** 任务目标面板（懒创建，复用同一个实例） */
    private goalPanel: GoalPanel | null = null;
    /** 任务卡片对应的任务面板 */
    private taskPanel: TaskPanel | null = null;
    /** 任务详情面板（按任务 id 复用） */
    private detailPanels = new Map<string, TaskDetailPanel>();
    /** 时间盒卡片对应的面板 */
    private timeBoxPanel: TimeBoxPanel | null = null;
    /** 今日任务方框组件 */
    private todayCard: TodayCard | null = null;
    /** 今日任务（折叠列表）卡片组件 */
    private todayTasksCard: TodayTasksCard | null = null;
    /** 今日任务（简洁版）卡片组件 */
    private todayTasksSimpleCard: TodayTasksSimpleCard | null = null;
    /** 独立时钟卡片组件 */
    private clockCard: ClockCard | null = null;
    /** 垂直功能栏卡片组件 */
    private navCard: NavCard | null = null;
    /** 任务板块信息面板（复用同一实例） */
    private taskSectionsPanel: TaskSectionsPanel | null = null;
    /** 视图根容器（控制编辑态网点背景） */
    private viewEl: HTMLElement | null = null;
    /** 是否处于编辑模式（仅背景提示，暂不提供拖拽） */
    private editMode = false;
    /** 卡片选择面板 */
    private cardPickerPanel: CardPickerPanel | null = null;
    /** 主题管理面板 */
    private themePanel: ThemePanel | null = null;
    /** 当前主题的动画清理函数（重绘前调用，停止 Canvas 动画） */
    private themeDispose: (() => void) | null = null;
    /** 习惯卡片对应的面板 */
    private habitPanel: HabitPanel | null = null;
    /** 计划年度卡片对应的面板 */
    private planAnnualPanel: PlanAnnualPanel | null = null;
    /** 计划一周卡片对应的面板 */
    private planWeekPanel: PlanWeekPanel | null = null;
    /** 检查卡片对应的面板 */
    private checkPanel: CheckPanel | null = null;
    /** 收集卡片对应的面板 */
    private collectPanel: CollectPanel | null = null;
    /** 画廊卡片对应的面板 */
    private galleryPanel: GalleryPanel | null = null;
    /** 成就榜单卡片对应的面板 */
    private achievementPanel: AchievementPanel | null = null;
    /** 数据卡片对应的面板 */
    private dataPanel: DataPanel | null = null;
    /** 分类数据（与周计划视图共享同一份） */
    private categoryData: PlanCategoryData;
    /** 卡片外壳（按卡片 id 记录，用于窗口尺寸变化时夹取位置） */
    private cardShells = new Map<string, HTMLElement>();
    /** 主区域尺寸监听：窗口变窄时把越界卡片夹回可视区 */
    private layoutObserver: ResizeObserver | null = null;
    /** 界面统一日期：顶部工具栏与所有日期相关卡片共用（仅内存，不持久化） */
    private selectedDate: Date;
    /** 外部（顶部工具栏）联动配置 */
    private readonly viewOptions: InterfaceViewOptions;

    constructor(app: App, plugin: Plugin, categoryData: PlanCategoryData, viewOptions: InterfaceViewOptions = {}) {
        this.app = app;
        this.plugin = plugin;
        this.categoryData = categoryData;
        this.viewOptions = viewOptions;
        this.selectedDate = startOfDay(viewOptions.getSelectedDate?.() ?? new Date());
    }

    /** 原型任务仓库 */
    private get prototypeTaskRepo(): PrototypeTaskRepo {
        return (this.plugin as Plugin & { prototypeTaskRepo: PrototypeTaskRepo }).prototypeTaskRepo;
    }

    /** 任务执行记录仓库 */
    private get taskExecutionRepo(): TaskExecutionRepo {
        return (this.plugin as Plugin & { taskExecutionRepo: TaskExecutionRepo }).taskExecutionRepo;
    }

    /** 基础仓库（读取界面布局等全量数据） */
    private get baseRepo(): BaseRepo {
        return (this.plugin as Plugin & { repo: BaseRepo }).repo;
    }

    /** 主题仓库（读取当前主题） */
    private get themeRepo(): ThemeRepo {
        return (this.plugin as Plugin & { themeRepo: ThemeRepo }).themeRepo;
    }

    /** 插件目录（vault 相对路径，用于读取主题图片素材） */
    private get pluginDir(): string {
        const manifest = this.plugin.manifest;
        return manifest.dir ?? `.obsidian/plugins/${manifest.id}`;
    }

    /** 面板挂载容器：限制在插件界面内显示（视图未渲染时退回 body） */
    private get panelContainer(): HTMLElement {
        return this.viewEl ?? document.body;
    }

    /** 打开周历面板：默认本周 / 今天，传入日期则定位到该日期所在周并高亮该日 */
    openDatePanel(date?: Date): void {
        const weekKey = date ? makeWeekKey(date.getFullYear(), getISOWeek(date)) : getCurrentWeekKey();
        const highlightDayKey = date ? makeDayKey(date) : undefined;
        if (!this.datePanel) {
            this.datePanel = new WeekCalendarPanel({
                container: this.panelContainer,
                startWeekKey: weekKey,
                highlightDayKey,
                getTasks: () => this.prototypeTaskRepo.tasks,
                getCategories: () => this.categoryData.categories,
                planAssignmentRepo: (this.plugin as Plugin & { planAssignmentRepo: PlanAssignmentRepo }).planAssignmentRepo,
            });
        } else {
            this.datePanel.showWeek(weekKey, highlightDayKey);
        }
        this.datePanel.open();
    }

    /** 打开任务目标面板（懒创建，复用同一实例） */
    openGoalPanel(): void {
        this.goalPanel ??= new GoalPanel({
            container: this.panelContainer,
            getTasks: () => this.prototypeTaskRepo.tasks,
        });
        this.goalPanel.open();
    }

    /** 顶部工具栏切换日期：写入界面统一日期并广播（卡片未创建时由初始化参数生效） */
    setSelectedDate(date: Date): void {
        this.applySelectedDate(date);
    }

    /** 页面级日期状态：统一写入后广播给所有日期相关卡片与顶部工具栏 */
    private applySelectedDate(date: Date): void {
        const next = startOfDay(date);
        // 与顶部工具栏一致：最晚只能查看今天
        if (next.getTime() > startOfToday().getTime()) return;
        if (next.getTime() === this.selectedDate.getTime()) return;
        this.selectedDate = next;
        this.todayCard?.setSelectedDate(next);
        this.todayTasksCard?.setSelectedDate(next);
        this.todayTasksSimpleCard?.setSelectedDate(next);
        this.clockCard?.setSelectedDate(next);
        // 周历面板已打开时跟随工具栏日期刷新（本日目标按高亮日期展示）
        if (this.datePanel?.isOpen) {
            this.datePanel.showWeek(makeWeekKey(next.getFullYear(), getISOWeek(next)), makeDayKey(next));
        }
        this.viewOptions.onSelectedDateChange?.(next);
    }

    /** 点击任务卡片：打开任务面板 */
    private openTaskPanel(): void {
        if (!this.taskPanel) {
            this.taskPanel = new TaskPanel({
                container: this.panelContainer,
                tasks: this.rootPrototypeTasks(),
                onSubmit: (payload) => this.addPrototypeTask(payload.name, payload.type),
                onTaskClick: (task) => this.openTaskDetail(task),
                getAllTasks: () => this.prototypeTaskRepo.tasks,
                getExecutions: () => this.taskExecutionRepo.records,
                getArchivedTasks: () => this.prototypeTaskRepo.archivedRootTasks,
                onUnarchiveTask: (taskId) => this.unarchivePrototypeTask(taskId),
            });
        } else {
            this.taskPanel.setTasks(this.rootPrototypeTasks());
        }
        this.taskPanel.open();
    }

    /** 点击时间盒卡片：打开时间盒面板 */
    private openTimeBoxPanel(): void {
        if (!this.timeBoxPanel) {
            const holder = this.plugin as Plugin & {
                timeBoxRepo: ConstructorParameters<typeof TimeBoxPanel>[0]['timeBoxRepo'];
                saveAll: () => Promise<void>;
            };
            this.timeBoxPanel = new TimeBoxPanel({
                container: this.panelContainer,
                app: this.app,
                categoryData: this.categoryData,
                categoryRepo: (this.plugin as Plugin & { categoryRepo: CategoryRepo }).categoryRepo,
                timeBoxRepo: holder.timeBoxRepo,
                save: () => holder.saveAll(),
            });
        }
        this.timeBoxPanel.open();
    }

    /** 点击习惯卡片：打开习惯面板 */
    private openHabitPanel(): void {
        if (!this.habitPanel) {
            const holder = this.plugin as Plugin & {
                saveAll: () => Promise<void>;
            };
            this.habitPanel = new HabitPanel({
                container: this.panelContainer,
                getTasks: () => this.prototypeTaskRepo.tasks,
                getCategories: () => this.categoryData.categories,
                save: () => holder.saveAll(),
                onChanged: () => {
                    this.todayCard?.refreshTasks();
                    this.todayTasksCard?.refresh();
                    this.clockCard?.refresh();
                },
                onOpenTaskDetail: (taskId) => {
                    const task = this.prototypeTaskRepo.tasks.find((item) => item.id === taskId);
                    if (!task) return;
                    this.openTaskDetail(task);
                },
            });
        }
        this.habitPanel.open();
    }

    /** 点击计划年度卡片：打开计划年度面板 */
    private openPlanAnnualPanel(): void {
        if (!this.planAnnualPanel) {
            const holder = this.plugin as Plugin & {
                planAssignmentRepo: ConstructorParameters<typeof PlanAnnualPanel>[0]['planAssignmentRepo'];
                saveAll: () => Promise<void>;
            };
            this.planAnnualPanel = new PlanAnnualPanel({
                container: this.panelContainer,
                getTasks: () => this.prototypeTaskRepo.tasks,
                getCategories: () => this.categoryData.categories,
                planAssignmentRepo: holder.planAssignmentRepo,
                save: () => holder.saveAll(),
                onChanged: () => {
                    this.todayCard?.refreshTasks();
                    this.todayTasksCard?.refresh();
                    this.clockCard?.refresh();
                },
                onOpenTaskDetail: (taskId) => {
                    const task = this.prototypeTaskRepo.tasks.find((item) => item.id === taskId);
                    if (!task) return;
                    this.openTaskDetail(task);
                },
            });
        }
        this.planAnnualPanel.open();
    }

    /** 点击计划一周卡片：打开计划一周面板 */
    private openPlanWeekPanel(): void {
        if (!this.planWeekPanel) {
            const holder = this.plugin as Plugin & {
                planAssignmentRepo: ConstructorParameters<typeof PlanWeekPanel>[0]['planAssignmentRepo'];
                saveAll: () => Promise<void>;
            };
            this.planWeekPanel = new PlanWeekPanel({
                container: this.panelContainer,
                getTasks: () => this.prototypeTaskRepo.tasks,
                planAssignmentRepo: holder.planAssignmentRepo,
                getCategories: () => this.categoryData.categories,
                taskExecutionRepo: this.taskExecutionRepo,
                save: () => holder.saveAll(),
                onChanged: () => {
                    this.todayCard?.refreshTasks();
                    this.todayTasksCard?.refresh();
                    this.clockCard?.refresh();
                },
            });
        }
        this.planWeekPanel.open();
    }

    /** 点击检查卡片：打开检查面板 */
    private openCheckPanel(): void {
        if (!this.checkPanel) {
            const holder = this.plugin as Plugin & {
                timeBoxRepo: ConstructorParameters<typeof CheckPanel>[0]['timeBoxRepo'];
            };
            this.checkPanel = new CheckPanel({
                container: this.panelContainer,
                app: this.app,
                categoryData: this.categoryData,
                timeBoxRepo: holder.timeBoxRepo,
                taskExecutionRepo: this.taskExecutionRepo,
                getTasks: () => this.prototypeTaskRepo.tasks,
                onOpenData: () => this.openDataPanel(),
            });
        }
        this.checkPanel.open();
    }

    /** 点击收集卡片：打开收集面板（内容复用 GTD 收集视图） */
    private openCollectPanel(): void {
        const holder = this.plugin as Plugin & {
            gtdRepo: ConstructorParameters<typeof CollectPanel>[0]['gtdRepo'];
            saveAll: () => Promise<void>;
        };
        this.collectPanel ??= new CollectPanel({
            container: this.panelContainer,
            gtdRepo: holder.gtdRepo,
            save: () => holder.saveAll(),
            getTasks: () => this.prototypeTaskRepo.tasks,
        });
        this.collectPanel.open();
    }

    /** 点击画廊卡片：打开画廊面板 */
    private openGalleryPanel(): void {
        this.galleryPanel ??= new GalleryPanel({ container: this.panelContainer });
        this.galleryPanel.open();
    }

    /** 点击成就榜单卡片：打开成就榜单面板 */
    private openAchievementPanel(): void {
        this.achievementPanel ??= new AchievementPanel({ container: this.panelContainer });
        this.achievementPanel.open();
    }

    /** 打开数据面板（由检查面板顶部的「数据」按钮触发） */
    private openDataPanel(): void {
        this.dataPanel ??= new DataPanel({ container: this.panelContainer });
        this.dataPanel.open();
    }

    /** 打开任务详情面板（同一任务复用实例，已打开时置顶） */
    private openTaskDetail(task: PrototypeTask): TaskDetailPanel {
        let panel = this.detailPanels.get(task.id);
        if (!panel) {
            panel = new TaskDetailPanel({
                container: this.panelContainer,
                task,
                tasks: this.prototypeTaskRepo.tasks,
                categoryData: this.categoryData,
                app: this.app,
                getTaskLibraryRoot: () => this.baseRepo.taskLibraryRoot,
                save: () => (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll(),
                onAddChild: (name, parentId) => this.addPrototypeTask(name, task.type, parentId),
                onUpdateTask: (taskId, patch) => this.updatePrototypeTask(taskId, patch),
                onArchiveTask: (taskId) => this.archivePrototypeTask(taskId),
                onDeleteTask: (taskId) => this.deletePrototypeTask(taskId),
                onReorderTasks: (ordered) => this.reorderPrototypeTasks(ordered),
                onOpenConfig: (task) => this.openTaskConfig(task),
                onTasksChanged: () => {
                    this.taskPanel?.setTasks(this.rootPrototypeTasks());
                    this.detailPanels.forEach((item) => item.setTasks(this.prototypeTaskRepo.tasks));
                    this.todayCard?.refreshTasks();
                    this.todayTasksCard?.refresh();
                    this.clockCard?.refresh();
                },
            });
            this.detailPanels.set(task.id, panel);
        } else {
            panel.setTasks(this.prototypeTaskRepo.tasks);
        }
        panel.open();
        return panel;
    }

    /** 根原型任务（不含子任务） */
    private rootPrototypeTasks(): PrototypeTask[] {
        return this.prototypeTaskRepo.tasks.filter((task) => !task.parentId);
    }

    /** 归档任务：隐藏但保留数据，销毁对应详情面板并刷新列表 */
    private archivePrototypeTask(taskId: string): void {
        this.prototypeTaskRepo.archive(taskId);
        this.destroyTaskDetail(taskId);
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
        this.refreshTaskConsumers();
    }

    /** 移出归档：恢复任务到正常列表并持久化 */
    private unarchivePrototypeTask(taskId: string): void {
        this.prototypeTaskRepo.unarchive(taskId);
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
        this.refreshTaskConsumers();
    }

    /** 删除任务：连同其所有后代任务一并删除，销毁对应详情面板并刷新列表 */
    private deletePrototypeTask(taskId: string): void {
        const removedIds = this.prototypeTaskRepo.remove(taskId);
        for (const id of removedIds) this.destroyTaskDetail(id);
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
        this.refreshTaskConsumers();
    }

    /** 销毁任务详情面板实例（归档 / 删除后不再复用） */
    private destroyTaskDetail(taskId: string): void {
        this.detailPanels.get(taskId)?.destroy();
        this.detailPanels.delete(taskId);
    }

    /** 按任务树拖拽结果重排仓库顺序（归档任务保留在末尾） */
    private reorderPrototypeTasks(ordered: PrototypeTask[]): void {
        const all = this.prototypeTaskRepo.allTasks;
        const orderedIds = new Set(ordered.map((task) => task.id));
        const hidden = all.filter((task) => !orderedIds.has(task.id));
        all.splice(0, all.length, ...ordered, ...hidden);
        this.detailPanels.forEach((panel) => panel.setTasks(this.prototypeTaskRepo.tasks));
    }

    /** 任务集合变化后刷新所有读取任务列表的界面 */
    private refreshTaskConsumers(): void {
        this.taskPanel?.setTasks(this.rootPrototypeTasks());
        this.detailPanels.forEach((panel) => panel.setTasks(this.prototypeTaskRepo.tasks));
        this.todayCard?.refreshTasks();
        this.todayTasksCard?.refresh();
        this.clockCard?.refresh();
    }

    /** 新增原型任务：写仓库 + 持久化 + 刷新面板列表与详情树 */
    private addPrototypeTask(name: string, type: PrototypeTaskType, parentId?: string): void {
        this.prototypeTaskRepo.add(name, type, parentId);
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
        this.taskPanel?.setTasks(this.rootPrototypeTasks());
        this.detailPanels.forEach((panel) => panel.setTasks(this.prototypeTaskRepo.tasks));
        this.todayCard?.refreshTasks();
        this.todayTasksCard?.refresh();
    }

    /** 切换原型任务类型（主线 / 支线）：写仓库 + 持久化 + 刷新列表 */
    private changePrototypeTaskType(task: PrototypeTask, type: PrototypeTaskType): void {
        this.prototypeTaskRepo.update(task.id, { type });
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
        this.refreshTaskConsumers();
    }

    /** 更新原型任务的名称 / 描述 / 分类：写仓库 + 持久化（改名时同步重命名任务目录） */
    private updatePrototypeTask(
        taskId: string,
        patch: { name?: string; description?: string; categoryId?: string },
    ): void {
        this.prototypeTaskRepo.update(taskId, patch);
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
        if (patch.name === undefined) return;
        const task = this.prototypeTaskRepo.allTasks.find((item) => item.id === taskId);
        if (!task) return;
        // 任务目录由项目库根目录 + 任务树自动生成，改名后同步重命名目录（子任务目录随之移动）
        void renameTaskDir(this.app, this.baseRepo.taskLibraryRoot, this.prototypeTaskRepo.allTasks, task)
            .then((changed) => {
                if (!changed) return;
                void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
                this.refreshTaskConsumers();
            });
    }

    /** 打开任务配置面板（名称 / 描述 / 类型 / 任务目录），关闭后销毁 */
    private openTaskConfig(task: PrototypeTask): void {
        const panel: TaskConfigPanel = new TaskConfigPanel({
            container: this.panelContainer,
            task,
            getTaskDir: () => this.taskDirOf(task),
            onSave: (payload) => this.saveTaskConfig(task, payload),
            onClose: () => panel.destroy(),
        });
        panel.open();
    }

    /** 保存任务配置：名称 / 描述走通用更新（含目录重命名），类型变化单独写回 */
    private saveTaskConfig(task: PrototypeTask, payload: TaskConfigSavePayload): void {
        this.updatePrototypeTask(task.id, { name: payload.name, description: payload.description });
        if (payload.type !== task.type) this.changePrototypeTaskType(task, payload.type);
        else this.refreshTaskConsumers();
        // 已打开的任务详情面板同步刷新（名称 / 描述 / 类型徽标）
        this.detailPanels.forEach((panel) => panel.refreshTaskView());
    }

    /** 任务所在目录：优先取任务文件目录的父级，尚未生成时按任务树规则给出预计路径 */
    private taskDirOf(task: PrototypeTask): string {
        if (task.fileDir) {
            const index = task.fileDir.lastIndexOf('/');
            return index >= 0 ? task.fileDir.slice(0, index) : task.fileDir;
        }
        const root = this.baseRepo.taskLibraryRoot;
        return root ? `${root}/${sanitizeFolderName(task.name)}` : '';
    }

    async renderInto(container: HTMLElement): Promise<void> {
        // 先停止上一轮主题的动画，避免重绘后仍残留 RAF 循环
        this.themeDispose?.();
        this.themeDispose = null;
        // 重绘会销毁旧卡片节点，同时释放上一轮的尺寸监听
        this.layoutObserver?.disconnect();
        this.layoutObserver = null;
        this.cardShells.clear();
        container.empty();
        container.addClass('interface-view');
        container.toggleClass('is-editing', this.editMode);
        this.viewEl = container;
        this.applyTheme(container);

        const main = container.createDiv({ cls: 'interface-main' });

        // 今日日期卡片：默认不显示，由编辑模式的「添加」面板加入
        if (this.isCardAdded('date')) {
            const dateBody = this.mountCard(main, 'date', 'card-date', () => this.setCardAdded('date', false));
            new DateCard({ onClick: () => this.openDatePanel() }).render(dateBody);
        }

        // 中间：今日任务方框（编辑模式下可移除，隐藏状态随布局持久化）
        if (!this.isCardHidden('today-clock')) {
            this.todayCard ??= new TodayCard({
                app: this.app,
                plugin: this.plugin,
                categoryData: this.categoryData,
                initialDate: this.selectedDate,
                onSelectedDateChange: (date) => this.applySelectedDate(date),
                onRunningTaskChanged: () => {
                    this.todayTasksCard?.refresh();
                    this.todayTasksSimpleCard?.refresh();
                    this.clockCard?.refresh();
                },
            });
            const todayBody = this.mountCard(main, 'today-clock', 'card-today-clock', () => this.setCardHidden('today-clock', true));
            this.todayCard.render(todayBody);
        }

        // 今日任务（折叠列表）卡片：默认不显示，由编辑模式的「添加」面板加入
        if (this.isCardAdded('today-tasks')) {
            this.todayTasksCard ??= new TodayTasksCard({
                plugin: this.plugin,
                initialDate: this.selectedDate,
                onSelectedDateChange: (date) => this.applySelectedDate(date),
                onRunningTaskChanged: () => {
                    this.todayCard?.reloadRunningState();
                    this.todayTasksSimpleCard?.refresh();
                    this.clockCard?.refresh();
                },
                onExecutionChanged: () => {
                    this.todayCard?.refreshClockDisplay();
                    this.todayTasksSimpleCard?.refresh();
                    this.clockCard?.refresh();
                },
                onTasksChanged: () => {
                    this.todayCard?.refreshTasks();
                    this.todayTasksSimpleCard?.refresh();
                },
                onOpenTaskBoard: (taskId) => this.openTaskBoard(taskId),
            });
            const tasksBody = this.mountCard(main, 'today-tasks', 'card-today-tasks', () => this.setCardAdded('today-tasks', false));
            this.todayTasksCard.render(tasksBody);
        }

        // 今日任务（简洁版）卡片：独立实现，无顶部日期切换、习惯为方块卡片
        if (this.isCardAdded('today-tasks-simple')) {
            this.todayTasksSimpleCard ??= new TodayTasksSimpleCard({
                plugin: this.plugin,
                initialDate: this.selectedDate,
                onRunningTaskChanged: () => {
                    this.todayCard?.reloadRunningState();
                    this.todayTasksCard?.refresh();
                    this.clockCard?.refresh();
                },
                onExecutionChanged: () => {
                    this.todayCard?.refreshClockDisplay();
                    this.todayTasksCard?.refresh();
                    this.clockCard?.refresh();
                },
                onTasksChanged: () => {
                    this.todayCard?.refreshTasks();
                    this.todayTasksCard?.refresh();
                },
                onOpenTaskBoard: (taskId) => this.openTaskBoard(taskId),
            });
            const simpleBody = this.mountCard(
                main,
                'today-tasks-simple',
                'card-today-tasks-simple',
                () => this.setCardAdded('today-tasks-simple', false),
            );
            this.todayTasksSimpleCard.render(simpleBody);
        }

        // 时钟卡片（24 小时时钟单独绘制）：默认不显示，由编辑模式的「添加」面板加入
        if (this.isCardAdded('clock')) {
            this.clockCard ??= new ClockCard({
                plugin: this.plugin,
                categoryData: this.categoryData,
                initialDate: this.selectedDate,
            });
            const clockBody = this.mountCard(main, 'clock', 'card-clock', () => this.setCardAdded('clock', false));
            this.clockCard.render(clockBody);
        }

        // 右侧：垂直功能栏（默认显示，编辑模式下可移除）
        if (!this.isCardHidden('nav')) {
            this.navCard ??= new NavCard({
                items: [
                    { labelKey: 'interface.timeBox', icon: 'calendar-clock', onClick: () => this.openTimeBoxPanel() },
                    { labelKey: 'interface.task', icon: 'list-todo', onClick: () => this.openTaskPanel() },
                    { labelKey: 'interface.habit', icon: 'repeat', onClick: () => this.openHabitPanel() },
                    { labelKey: 'interface.planAnnual', icon: 'calendar-range', onClick: () => this.openPlanAnnualPanel() },
                    { labelKey: 'interface.planWeek', icon: 'calendar-check', onClick: () => this.openPlanWeekPanel() },
                    { labelKey: 'interface.check', icon: 'clipboard-check', onClick: () => this.openCheckPanel() },
                    { labelKey: 'interface.collect', icon: 'inbox', onClick: () => this.openCollectPanel() },
                    { labelKey: 'interface.gallery', icon: 'image', onClick: () => this.openGalleryPanel() },
                    { labelKey: 'achievement.title', icon: 'trophy', onClick: () => this.openAchievementPanel() },
                ],
            });
            const navBody = this.mountCard(main, 'nav', 'card-nav', () => this.setCardHidden('nav', true));
            this.navCard.render(navBody);
        }

        // 卡片挂载完成后监听主区域尺寸：窗口变窄时把越界卡片夹回可视区
        this.observeMainResize(main);
    }

    /** 应用当前主题：注入颜色令牌并同步到卡片与所有浮动面板 */
    private applyTheme(container: HTMLElement): void {
        // 清理上一次可能残留的主题类
        for (const definition of THEME_DEFINITIONS) container.removeClass(`is-theme-${definition.id}`);

        const theme = getThemeDefinition(this.themeRepo.currentThemeId);
        // 注入主题颜色令牌（--sdt-* 与 Obsidian 原生变量），并同步到所有浮动面板
        applyThemeColors(container, theme?.colors);
        setCurrentThemeColors(theme?.colors);

        if (!theme) return;
        container.addClass(`is-theme-${theme.id}`);

        const dispose = theme.mount(container, { app: this.app, pluginDir: this.pluginDir });
        this.themeDispose = typeof dispose === 'function' ? dispose : null;
    }

    /** 打开卡片选择面板 */
    openCardPicker(): void {
        this.cardPickerPanel ??= new CardPickerPanel((cardId) => this.showPickedCard(cardId), { container: this.panelContainer });
        this.cardPickerPanel.open();
    }

    /** 打开主题管理面板 */
    openThemePanel(): void {
        if (!this.themePanel) {
            this.themePanel = new ThemePanel({
                container: this.panelContainer,
                app: this.app,
                pluginDir: this.pluginDir,
                getCurrentThemeId: () => this.themeRepo.currentThemeId,
                onApply: (themeId) => {
                    this.themeRepo.setCurrentTheme(themeId);
                    void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
                    if (this.viewEl) void this.renderInto(this.viewEl);
                },
            });
        }
        this.themePanel.refresh();
        this.themePanel.open();
    }

    /** 从卡片选择面板选中卡片后加入界面 */
    private showPickedCard(cardId: string): void {
        // 今日时钟 / 垂直功能栏默认显示：可能被编辑模式移除，重新加入时清除隐藏标记
        if (cardId === 'today-clock' || cardId === 'nav') {
            this.setCardHidden(cardId, false);
            return;
        }
        this.setCardAdded(cardId, true);
    }

    /** 挂载浮动卡片外壳：统一定位、边框、拖动、移除与编辑模式点击拦截 */
    private mountCard(
        parentEl: HTMLElement,
        cardId: string,
        cardClass: string,
        onRemove: () => void,
    ): HTMLElement {
        const { shellEl, bodyEl } = createInterfaceCardShell(parentEl, {
            cardId,
            cardClass,
            editMode: this.editMode,
            position: this.baseRepo.data?.interfaceLayoutData.cardPositions[cardId],
            onMove: (position) => this.saveCardPosition(cardId, position),
            onRemove,
        });
        this.cardShells.set(cardId, shellEl);
        return bodyEl;
    }

    /** 监听主区域尺寸变化：卡片坐标按持久化值夹取，窗口恢复后自动回到原位 */
    private observeMainResize(main: HTMLElement): void {
        this.layoutObserver = new ResizeObserver(() => this.clampCardPositions(main));
        this.layoutObserver.observe(main);
        this.clampCardPositions(main);
    }

    /**
     * 夹取越界卡片：以持久化坐标为准贴边显示，并按「边界卡片优先」向左推挤相邻卡片避免重叠。
     * 结果只写内联样式，不回写布局数据，窗口放大后卡片会回到原来的拖拽位置。
     */
    private clampCardPositions(main: HTMLElement): void {
        const mainRect = main.getBoundingClientRect();
        if (mainRect.width <= 0 || mainRect.height <= 0) return;

        const items: LayoutCardItem[] = [];
        this.cardShells.forEach((shellEl, cardId) => {
            const rect = shellEl.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;
            const saved = this.baseRepo.data?.interfaceLayoutData.cardPositions[cardId];
            if (!saved) {
                // 未拖动过的卡片由 CSS 默认位置（百分比）定位，本身随容器变化，作为固定障碍参与避让
                items.push({
                    shellEl,
                    left: rect.left - mainRect.left,
                    top: rect.top - mainRect.top,
                    width,
                    height,
                    anchorLeft: rect.left - mainRect.left,
                    movable: false,
                });
                return;
            }
            items.push({
                shellEl,
                left: Math.max(0, Math.min(saved.left, mainRect.width - width)),
                top: Math.max(0, Math.min(saved.top, mainRect.height - height)),
                width,
                height,
                anchorLeft: saved.left,
                movable: true,
            });
        });

        // 边界优先：按原始左右顺序处理（最靠右的先占位），再依次向左推挤，避免夹取后顺序被宽度打乱
        const placed = items.filter((item) => !item.movable);
        const movableItems = items
            .filter((item) => item.movable)
            .sort((a, b) => b.anchorLeft - a.anchorLeft || a.top - b.top);

        for (const item of movableItems) {
            let left = item.left;
            // 逐步消解水平重叠：每次推到所有相交卡片的左侧（留出间距），直到不再移动
            for (let pass = 0; pass <= placed.length; pass += 1) {
                let moved = false;
                for (const other of placed) {
                    if (!isVerticallyOverlapped(item, other)) continue;
                    // 已在对方左侧且间距足够，或完全在对方右侧：无需处理
                    if (left + item.width + CARD_GAP <= other.left) continue;
                    if (left >= other.left + other.width) continue;
                    left = other.left - CARD_GAP - item.width;
                    moved = true;
                }
                if (!moved) break;
            }
            // 推到左边界仍放不下时保留重叠（空间不足，不再继续越界）
            item.left = Math.max(0, left);
            item.shellEl.style.left = `${item.left}px`;
            item.shellEl.style.top = `${item.top}px`;
            placed.push(item);
        }
    }

    /** 保存卡片位置到布局并持久化 */
    private saveCardPosition(cardId: string, position: { left: number; top: number }): void {
        const data = this.baseRepo.data;
        if (!data) return;
        data.interfaceLayoutData.cardPositions[cardId] = position;
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
    }

    /** 卡片是否已被编辑模式移除 */
    private isCardHidden(cardId: string): boolean {
        return this.baseRepo.data?.interfaceLayoutData.hiddenCards.includes(cardId) ?? false;
    }

    /** 设置卡片隐藏状态：写布局并持久化，随后重绘视图 */
    private setCardHidden(cardId: string, hidden: boolean): void {
        const data = this.baseRepo.data;
        if (!data) return;
        const cards = data.interfaceLayoutData.hiddenCards;
        const index = cards.indexOf(cardId);
        if (hidden && index < 0) cards.push(cardId);
        if (!hidden && index >= 0) cards.splice(index, 1);
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
        if (this.viewEl) void this.renderInto(this.viewEl);
    }

    /** 可选卡片是否已通过「添加」面板加入界面 */
    private isCardAdded(cardId: string): boolean {
        return this.baseRepo.data?.interfaceLayoutData.addedCards.includes(cardId) ?? false;
    }

    /** 设置可选卡片的加入状态：写布局并持久化，随后重绘视图 */
    private setCardAdded(cardId: string, added: boolean): void {
        const data = this.baseRepo.data;
        if (!data) return;
        const cards = data.interfaceLayoutData.addedCards;
        const index = cards.indexOf(cardId);
        if (added && index < 0) cards.push(cardId);
        if (!added && index >= 0) cards.splice(index, 1);
        void (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
        if (this.viewEl) void this.renderInto(this.viewEl);
    }

    /** 是否处于编辑模式（顶部工具栏的按钮据此同步显隐与激活态） */
    get isEditMode(): boolean {
        return this.editMode;
    }

    /** 切换编辑模式：重绘视图以同步网点背景与卡片 X 按钮 */
    toggleEditMode(): void {
        this.editMode = !this.editMode;
        if (!this.editMode) this.cardPickerPanel?.close();
        if (this.viewEl) void this.renderInto(this.viewEl);
    }

    /** 打开任务板块信息面板：展示指定任务的收集篮子 / 待办改进 / 文件目录 */
    private openTaskBoard(taskId: string): void {
        this.taskSectionsPanel ??= new TaskSectionsPanel({
            container: this.panelContainer,
            app: this.app,
            getTask: (id) => this.prototypeTaskRepo.tasks.find((item) => item.id === id),
            getTasks: () => this.prototypeTaskRepo.tasks,
            getTaskLibraryRoot: () => this.baseRepo.taskLibraryRoot,
            categories: this.categoryData.categories,
            save: () => (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll(),
            onOpenTaskDetail: (taskId) => {
                const task = this.prototypeTaskRepo.tasks.find((item) => item.id === taskId);
                if (!task) return;
                const panel = this.openTaskDetail(task);
                // 详情面板由板块面板打开：在详情面板内操作时不让板块面板失焦关闭
                this.taskSectionsPanel?.addIgnoreElement(panel.element);
            },
        });
        this.taskSectionsPanel.openForTask(taskId);
    }
}

/** 两张卡片在垂直方向是否有重叠（水平推挤只在同一行内生效） */
function isVerticallyOverlapped(a: LayoutCardItem, b: LayoutCardItem): boolean {
    return a.top < b.top + b.height && a.top + a.height > b.top;
}

/** 指定日期 0 点 */
function startOfDay(date: Date): Date {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
}

/** 今天 0 点 */
function startOfToday(): Date {
    return startOfDay(new Date());
}