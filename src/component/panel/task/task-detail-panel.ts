// 任务详情面板：基于 FloatingPanel，展示单个原型任务的详情。
// 左侧：类型标题行（主线任务 / 支线任务）+ 添加按钮，下方为后代任务树；
// 右侧：任务名称 / 分类 / 描述 + 归属分区选项卡。
import { Notice, TFolder, setIcon, type App, type TFile } from 'obsidian';

import type { ChecklistItem } from '../../../datatypes/domain';
import type { PrototypeTask, TaskDayGoalEntry } from '../../../datatypes/prototype-task';
import { getLang, t } from '../../../i18n';
import type { PlanCategoryData } from '../../../shared/plan-category-manager';
import {
    getCurrentDayKey,
    getCurrentWeekKey,
    makeDayKeyFromWeek,
    parseWeekKey,
    shiftWeekKey,
} from '../../../shared/plan-data';
import { buildTaskFileName, listTaskFiles, relativeToDir } from '../../../shared/task-file';
import { ensureTaskFileDir, revealFolderInExplorer } from '../../../shared/task-library';
import { ConfirmModal } from '../../ob/confirm-modal';
import { FileEditorPanel } from '../basic/file-editor-panel';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 任务详情面板配置 */
export interface TaskDetailPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 当前展示的任务 */
    task: PrototypeTask;
    /** 全量原型任务（用于构建后代任务树） */
    tasks?: PrototypeTask[];
    /** 新增子任务回调（父面板负责写仓库并刷新），parentId 为当前选中的任务 */
    onAddChild?: (name: string, parentId: string) => void;
    /** 分类数据（图例分类，供右侧详情页的分类展示使用） */
    categoryData?: PlanCategoryData;
    /** 更新任务名称 / 描述 / 分类的回调（父面板负责写仓库并持久化） */
    onUpdateTask?: (taskId: string, patch: { name?: string; description?: string; categoryId?: string }) => void;
    /** Obsidian App（收集篮子「整理到文件」使用） */
    app: App;
    /** 读取项目库根目录（任务文件目录按任务树自动绑定，空表示未配置） */
    getTaskLibraryRoot?: () => string;
    /** 数据保存回调（收集篮子增删后持久化） */
    save: () => Promise<void>;
    /** 任务树拖动排序 / 调整层级后的回调（父面板刷新任务列表等） */
    onTasksChanged?: () => void;
    /** 归档回调（父面板负责写仓库并持久化） */
    onArchiveTask?: (taskId: string) => void;
    /** 删除回调（父面板负责写仓库并持久化） */
    onDeleteTask?: (taskId: string) => void;
    /** 任务树拖拽排序回调（父面板按新顺序写回仓库） */
    onReorderTasks?: (ordered: PrototypeTask[]) => void;
    /** 打开任务配置面板回调（左侧顶部下拉右侧的配置按钮，作用于任务树根任务） */
    onOpenConfig?: (task: PrototypeTask) => void;
}

/** 右侧分区选项卡：showCount 为 true 时在标签后显示条目数量占位 */
const SECTIONS: { labelKey: Parameters<typeof t>[0]; showCount?: boolean }[] = [
    { labelKey: 'panel.weekGoalTab' },
    { labelKey: 'panel.targetChecklist', showCount: true },
    { labelKey: 'panel.targetFile', showCount: true },
];

/** 任务树每层缩进像素（与行 marginLeft 一致） */
const TREE_DEPTH_INDENT = 14;
/** 长按进入拖动的等待时间（毫秒） */
const TREE_LONG_PRESS_MS = 300;

/** 任务详情面板 */
export class TaskDetailPanel extends FloatingPanel {
    private panelOptions: TaskDetailPanelOptions;
    private task: PrototypeTask;
    private tasks: PrototypeTask[];
    private treeEl!: HTMLElement;
    private addFormEl!: HTMLElement;
    private inputEl!: HTMLInputElement;
    /** 右侧分区滚动容器 */
    private sectionsEl!: HTMLElement;
    /** 顶部选项卡 */
    private tabs: HTMLElement[] = [];
    /** 当前选中的任务 id（决定 + 按钮在哪个任务下新增子任务），默认根任务 */
    private selectedTaskId: string;
    /** 清单内容容器 */
    private checklistBodyEl: HTMLElement | null = null;
    /** 清单选项卡的未完成数量标签 */
    private checklistCountEl: HTMLElement | null = null;
    /** 清单排序方式：创建顺序 / 截止时间 */
    private checklistSort: 'created' | 'due' = 'created';
    /** 清单中当前选中的条目 id（用于设置截止时间） */
    private selectedChecklistId: string | null = null;
    /** 任务文件内容容器 */
    private filesBodyEl: HTMLElement | null = null;
    /** 任务文件选项卡的文件数量标签 */
    private fileCountEl: HTMLElement | null = null;
    /** 任务文件是否处于新建文件输入状态 */
    private fileCreateMode = false;
    /** 文件编辑面板（复用同一实例，切换文件时销毁重建） */
    private fileEditorPanel: FileEditorPanel | null = null;
    /** 左侧底部工具栏：表单打卡按钮 */
    private formButtonEl!: HTMLButtonElement;
    /** 右侧底部设置面板（表单打卡） */
    private settingPanelEl!: HTMLElement;
    /** 当前激活的设置面板类型 */
    private settingActive: 'form' | null = null;
    /** 右侧容器（切换左侧选中任务时整体重建） */
    private rightEl!: HTMLElement;
    /** 当前选中的归属分区索引（切换任务后保持不变） */
    private currentSection = 0;
    /** 面板打开时的根任务 id（左侧任务树始终以它为根，不随右侧切换变化） */
    private rootTaskId: string;
    /** 左侧顶部的根任务下拉（可切换任务树的根） */
    private rootSelectEl!: HTMLSelectElement;
    /** 当前进行中的内联编辑取消函数（切换任务时先调用以放弃编辑） */
    private activeInlineEditAbort: (() => void) | null = null;
    /** 拖动结束后抑制一次点击，避免误选中 */
    private suppressTreeClick = false;
    /** 「一周目标」选项卡当前查看的周键（默认本周） */
    private weekGoalWeekKey: string = getCurrentWeekKey();

    constructor(options: TaskDetailPanelOptions) {
        super({
            width: 860,
            title: t('panel.taskDetailTitle'),
            container: options.container,
            draggable: options.draggable,
            onClose: options.onClose,
        });
        this.panelOptions = options;
        this.task = options.task;
        this.tasks = options.tasks ?? [];
        this.selectedTaskId = options.task.id;
        this.rootTaskId = options.task.id;
        this.renderContent();
    }

    /** 每次打开时刷新清单 / 任务文件（数据可能被其它入口改动） */
    override open(): void {
        if (this.checklistBodyEl?.isConnected) this.renderChecklist(this.checklistBodyEl);
        if (this.filesBodyEl?.isConnected) this.renderFiles(this.filesBodyEl);
        this.renderSettingPanel();
        super.open();
    }

    /** 刷新全量任务并重绘任务树 */
    setTasks(tasks: PrototypeTask[]): void {
        this.tasks = tasks;
        this.refreshRootSelect();
        this.renderTree();
    }

    /** 任务被外部（如配置面板）修改后，刷新类型徽标与右侧内容 */
    refreshTaskView(): void {
        const current = this.tasks.find((item) => item.id === this.task.id);
        if (current) this.task = current;
        const badge = this.body.querySelector<HTMLElement>('.task-detail-type');
        badge?.setText(t(this.task.type === 'main' ? 'panel.mainTaskBadge' : 'panel.sideTaskBadge'));
        this.renderRightPane();
    }

    /** 重建根任务下拉（顶层任务 = 无父任务的根任务） */
    private refreshRootSelect(): void {
        const roots = this.tasks.filter((task) => !task.parentId);
        if (!roots.some((task) => task.id === this.rootTaskId)) {
            this.rootTaskId = roots[0]?.id ?? this.rootTaskId;
        }
        this.rootSelectEl.empty();
        if (roots.length === 0) {
            this.rootSelectEl.createEl('option', { text: t('panel.planNoTask'), value: '' });
            return;
        }
        for (const task of roots) {
            this.rootSelectEl.createEl('option', { text: task.name, value: task.id });
        }
        this.rootSelectEl.value = this.rootTaskId;
    }

    /** 渲染左右结构 */
    private renderContent(): void {
        const body = this.body;
        body.addClass('task-detail');

        // 左侧
        const left = body.createDiv({ cls: 'task-detail-left' });

        // 根任务下拉：切换任务树的根（位于类型标题行上方），右侧为配置按钮
        const rootRow = left.createDiv({ cls: 'task-detail-root-row' });
        this.rootSelectEl = rootRow.createEl('select', { cls: 'dropdown plan-root-select task-detail-root-select' });
        this.rootSelectEl.addEventListener('change', () => {
            const taskId = this.rootSelectEl.value;
            if (!taskId || taskId === this.rootTaskId) return;
            this.rootTaskId = taskId;
            this.renderTree();
            this.selectTask(taskId);
        });

        if (this.panelOptions.onOpenConfig) {
            const configBtn = rootRow.createDiv({
                cls: 'task-detail-config-btn',
                attr: { 'aria-label': t('panel.taskConfigTitle'), role: 'button' },
            });
            configBtn.title = t('panel.taskConfigTitle');
            setIcon(configBtn, 'settings');
            configBtn.addEventListener('click', () => {
                // 作用于任务树的根任务（下拉当前选中项）
                const rootTask = this.tasks.find((item) => item.id === this.rootTaskId) ?? this.task;
                this.panelOptions.onOpenConfig?.(rootTask);
            });
        }

        const header = left.createDiv({ cls: 'task-detail-header' });
        header.createSpan({
            cls: 'task-detail-type',
            text: t(this.task.type === 'main' ? 'panel.mainTaskBadge' : 'panel.sideTaskBadge'),
        });

        // + 按钮 + 其右侧的小面板
        const addWrap = header.createDiv({ cls: 'task-detail-add-wrap' });
        const addBtn = addWrap.createDiv({ cls: 'task-detail-add-btn' });
        setIcon(addBtn, 'plus');
        addBtn.setAttribute('aria-label', 'Add');
        addBtn.addEventListener('click', () => this.toggleAddForm());

        this.addFormEl = addWrap.createDiv({ cls: 'task-detail-add-form' });
        this.addFormEl.style.display = 'none';
        this.inputEl = this.addFormEl.createEl('input', { cls: 'task-detail-add-input' });
        this.inputEl.type = 'text';
        this.inputEl.placeholder = t('panel.subTaskName');
        this.inputEl.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') this.submitAdd();
            if (evt.key === 'Escape') this.hideAddForm();
        });
        const confirmBtn = this.addFormEl.createEl('button', {
            cls: 'mod-cta',
            text: t('common.confirm'),
        });
        confirmBtn.addEventListener('click', () => this.submitAdd());
        // 失去焦点（焦点移出小面板）时自动收起
        this.addFormEl.addEventListener('focusout', (evt) => {
            const next = evt.relatedTarget as Node | null;
            if (next && this.addFormEl.contains(next)) return;
            this.hideAddForm();
        });

        // 后代任务树
        this.treeEl = left.createDiv({ cls: 'task-detail-tree' });
        // 事件委托：点击行即选中（避免每次重绘重新绑定）
        this.treeEl.addEventListener('click', (evt) => {
            // 长按拖动结束后抑制一次点击，避免把拖动误判为选中
            if (this.suppressTreeClick) {
                this.suppressTreeClick = false;
                return;
            }
            const row = (evt.target as HTMLElement).closest('.task-detail-tree-row') as HTMLElement | null;
            const taskId = row?.dataset.taskId;
            if (taskId) this.selectTask(taskId);
        });
        this.refreshRootSelect();
        this.renderTree();

        // 左侧底部工具栏：表单打卡（激活后右侧底部显示设置面板）
        const toolbar = left.createDiv({ cls: 'task-detail-toolbar' });
        this.formButtonEl = this.createToolbarButton(
            toolbar,
            'check-square',
            t('panel.formCheckSetting'),
            () => this.toggleSetting(),
        );

        // 右侧：任务信息（名称 / 分类 / 描述）+ 归属分区选项卡（切换左侧选中任务时整体重建）
        this.rightEl = body.createDiv({ cls: 'task-detail-right' });
        this.renderRightPane();
    }

    /** 重建右侧内容：任务信息行 + 归属分区选项卡 + 底部设置面板 */
    private renderRightPane(): void {
        const right = this.rightEl;
        right.empty();
        this.tabs = [];
        this.currentSection = Math.min(this.currentSection, SECTIONS.length - 1);

        // 第一、二行：任务名称 + 分类，右侧为跨两行的「归档 / 删除」方块按钮
        const headBlock = right.createDiv({ cls: 'task-detail-head-block' });
        const headInfo = headBlock.createDiv({ cls: 'task-detail-head-info' });

        const head = headInfo.createDiv({ cls: 'task-detail-head' });
        const nameEl = head.createSpan({ cls: 'task-detail-name', text: this.task.name });
        const nameEdit = head.createSpan({ cls: 'task-detail-edit-icon' });
        setIcon(nameEdit, 'pencil');
        nameEdit.setAttribute('aria-label', 'Edit');
        nameEdit.addEventListener('click', () => {
            this.startInlineEdit(nameEl, this.task.name, {
                allowEmpty: false,
                onCommit: (value) => {
                    this.task.name = value;
                    const target = this.tasks.find((item) => item.id === this.task.id);
                    if (target) target.name = value;
                    nameEl.setText(value);
                    this.panelOptions.onUpdateTask?.(this.task.id, { name: value });
                },
            });
        });

        const categoryRow = headInfo.createDiv({ cls: 'task-detail-category-row' });
        const category = this.panelOptions.categoryData?.categories
            .find((item) => item.id === this.task.categoryId);
        const dotEl = categoryRow.createSpan({ cls: 'task-detail-category-dot' });
        dotEl.style.background = category?.color ?? '#888888';
        const categoryNameEl = categoryRow.createSpan({
            cls: 'task-detail-category-name',
            text: category?.label ?? t('defaultCategory.uncategorized'),
        });
        const categoryEdit = categoryRow.createSpan({ cls: 'task-detail-edit-icon' });
        setIcon(categoryEdit, 'pencil');
        categoryEdit.setAttribute('aria-label', 'Edit');
        categoryEdit.addEventListener('click', () => this.startCategoryEdit(dotEl, categoryNameEl));

        const headActions = headBlock.createDiv({ cls: 'task-detail-head-actions' });
        this.createHeadAction(headActions, 'archive', t('common.archive'), false, () => this.archiveTask());
        this.createHeadAction(headActions, 'trash-2', t('common.delete'), true, () => this.confirmDeleteTask());

        // 第三行：任务描述 + 编辑图标（单行，溢出省略）
        const descRow = right.createDiv({ cls: 'task-detail-desc-row' });
        const descEl = descRow.createSpan({
            cls: 'task-detail-desc',
            text: this.task.description?.trim() || '—',
        });
        const descEdit = descRow.createSpan({ cls: 'task-detail-edit-icon' });
        setIcon(descEdit, 'pencil');
        descEdit.setAttribute('aria-label', 'Edit');
        descEdit.addEventListener('click', () => {
            this.startInlineEdit(descEl, this.task.description ?? '', {
                allowEmpty: true,
                displayWhenEmpty: '—',
                onCommit: (value) => {
                    this.task.description = value || undefined;
                    const target = this.tasks.find((item) => item.id === this.task.id);
                    if (target) target.description = this.task.description;
                    descEl.setText(value || '—');
                    this.panelOptions.onUpdateTask?.(this.task.id, { description: value });
                },
            });
        });

        // 第三行：归属分区选项卡
        const tabsEl = right.createDiv({ cls: 'task-detail-tabs' });
        this.sectionsEl = right.createDiv({ cls: 'task-detail-sections' });
        // 右侧底部：设置面板（默认隐藏，由左侧工具栏按钮控制）
        this.settingPanelEl = right.createDiv({ cls: 'task-detail-setting-panel is-hidden' });

        for (const section of SECTIONS) {
            const index = this.tabs.length;
            const label = t(section.labelKey);
            const tab = tabsEl.createDiv({ cls: 'task-detail-tab' });
            tab.createSpan({ text: section.showCount ? `${label} ` : label });
            if (section.showCount) {
                const countEl = tab.createSpan({
                    cls: 'task-detail-tab-count',
                    text: `(${this.sectionCount(index)})`,
                });
                if (section.labelKey === 'panel.targetChecklist') this.checklistCountEl = countEl;
                if (section.labelKey === 'panel.targetFile') this.fileCountEl = countEl;
            }
            tab.addEventListener('click', () => this.switchSection(index));
            this.tabs.push(tab);

            const sectionEl = this.sectionsEl.createDiv({ cls: 'task-detail-section' });
            const sectionBody = sectionEl.createDiv({ cls: 'task-detail-section-body' });
            if (section.labelKey === 'panel.weekGoalTab') this.renderWeekGoalSection(sectionBody);
            if (section.labelKey === 'panel.targetChecklist') this.renderChecklist(sectionBody);
            if (section.labelKey === 'panel.targetFile') this.renderFiles(sectionBody);
        }

        this.switchSection(this.currentSection);
        this.renderSettingPanel();
    }

    /** 创建右侧标题区的方块按钮（图标 + 换行 + 名称） */
    private createHeadAction(
        parent: HTMLElement,
        icon: string,
        label: string,
        danger: boolean,
        onClick: () => void,
    ): void {
        const button = parent.createEl('button', {
            cls: `task-detail-head-action${danger ? ' is-danger' : ''}`,
            attr: { type: 'button', 'aria-label': label },
        });
        setIcon(button.createSpan({ cls: 'task-detail-head-action-icon' }), icon);
        button.createSpan({ cls: 'task-detail-head-action-label', text: label });
        button.addEventListener('click', onClick);
    }

    /** 归档当前任务：写完仓库后关闭面板 */
    private archiveTask(): void {
        this.panelOptions.onArchiveTask?.(this.task.id);
        this.close();
    }

    /** 删除当前任务：确认后删除并关闭面板 */
    private confirmDeleteTask(): void {
        new ConfirmModal(
            this.panelOptions.app,
            t('panel.deleteTaskTitle'),
            t('panel.deleteTaskDetail', { name: this.task.name }),
            () => {
                this.panelOptions.onDeleteTask?.(this.task.id);
                this.close();
            },
        ).open();
    }

    /** 创建左侧工具栏按钮（图标 + 文字） */
    private createToolbarButton(
        parent: HTMLElement,
        icon: string,
        text: string,
        onClick: () => void,
    ): HTMLButtonElement {
        const button = parent.createEl('button', { cls: 'task-detail-toolbar-btn', attr: { type: 'button' } });
        const iconEl = button.createSpan({ cls: 'task-detail-toolbar-btn-icon' });
        setIcon(iconEl, icon);
        button.createSpan({ cls: 'task-detail-toolbar-btn-text', text });
        button.addEventListener('click', onClick);
        return button;
    }

    /** 切换表单打卡设置面板（再次点击按钮则关闭） */
    private toggleSetting(): void {
        this.settingActive = this.settingActive === 'form' ? null : 'form';
        this.renderSettingPanel();
    }

    /** 渲染右侧底部设置面板（未激活时隐藏） */
    private renderSettingPanel(): void {
        this.formButtonEl.toggleClass('is-active', this.settingActive === 'form');
        this.settingPanelEl.empty();
        const visible = this.settingActive !== null;
        this.settingPanelEl.toggleClass('is-hidden', !visible);
        if (!visible) return;

        // 第一行：颜色圆点 + 任务名称 + 分类（与计划面板任务信息一致）
        const task = this.tasks.find((item) => item.id === this.selectedTaskId) ?? this.task;
        const head = this.settingPanelEl.createDiv({ cls: 'plan-info-head' });
        const category = this.panelOptions.categoryData?.categories
            .find((item) => item.id === task.categoryId);
        const dot = head.createSpan({ cls: 'plan-info-dot' });
        dot.style.background = category?.color ?? '#888888';
        head.createSpan({ cls: 'plan-info-name', text: task.name });
        head.createSpan({
            cls: 'plan-info-category',
            text: category?.label ?? t('defaultCategory.uncategorized'),
        });

        // 第二行：表单打卡内容（暂为占位）
        const body = this.settingPanelEl.createDiv({ cls: 'task-detail-setting-body' });
        body.createDiv({ cls: 'task-detail-setting-placeholder', text: t('panel.formCheckPending') });
    }

    /** 「一周目标」选项卡：顶部周切换 + 周一到周日 7 个方框（左侧星期标题，右侧日目标勾选列表） */
    private renderWeekGoalSection(container: HTMLElement): void {
        container.empty();
        const wrap = container.createDiv({ cls: 'task-week-goal' });

        // 第一行：周切换按钮（上一周 / 周数 / 下一周）
        const nav = wrap.createDiv({ cls: 'task-week-goal-nav' });
        const prevBtn = nav.createEl('button', {
            cls: 'task-week-goal-nav-btn',
            attr: { type: 'button', 'aria-label': t('panel.weekGoalPrevWeek') },
        });
        setIcon(prevBtn, 'chevron-left');
        prevBtn.addEventListener('click', () => {
            this.weekGoalWeekKey = shiftWeekKey(this.weekGoalWeekKey, -1);
            this.renderWeekGoalSection(container);
        });

        const { week } = parseWeekKey(this.weekGoalWeekKey);
        const label = nav.createDiv({ cls: 'task-week-goal-nav-label' });
        label.createSpan({ cls: 'task-week-goal-nav-week', text: `W${String(week).padStart(2, '0')}` });
        const mondayKey = makeDayKeyFromWeek(this.weekGoalWeekKey, 1);
        const sundayKey = makeDayKeyFromWeek(this.weekGoalWeekKey, 7);
        label.createSpan({
            cls: 'task-week-goal-nav-range',
            text: `${Number(mondayKey.slice(5, 7))}/${Number(mondayKey.slice(8, 10))} - ${Number(sundayKey.slice(5, 7))}/${Number(sundayKey.slice(8, 10))}`,
        });
        if (this.weekGoalWeekKey === getCurrentWeekKey()) label.addClass('is-current');

        const nextBtn = nav.createEl('button', {
            cls: 'task-week-goal-nav-btn',
            attr: { type: 'button', 'aria-label': t('panel.weekGoalNextWeek') },
        });
        setIcon(nextBtn, 'chevron-right');
        nextBtn.addEventListener('click', () => {
            this.weekGoalWeekKey = shiftWeekKey(this.weekGoalWeekKey, 1);
            this.renderWeekGoalSection(container);
        });

        // 周一到周日：每天一个方框
        const list = wrap.createDiv({ cls: 'task-week-goal-list' });
        const weekdayKeys: Parameters<typeof t>[0][] = [
            'week.monday',
            'week.tuesday',
            'week.wednesday',
            'week.thursday',
            'week.friday',
            'week.saturday',
            'week.sunday',
        ];
        for (let day = 1; day <= 7; day += 1) {
            const dayKey = makeDayKeyFromWeek(this.weekGoalWeekKey, day);
            this.renderWeekGoalDay(list, dayKey, t(weekdayKeys[day - 1]));
        }
    }

    /** 单日方框：左侧星期标题（右上角 + 按钮），右侧日目标勾选列表 */
    private renderWeekGoalDay(parentEl: HTMLElement, dayKey: string, weekdayLabel: string): void {
        const box = parentEl.createDiv({ cls: 'task-week-goal-day' });
        if (dayKey === getCurrentDayKey()) box.addClass('is-today');

        const head = box.createDiv({ cls: 'task-week-goal-day-head' });
        head.createSpan({ cls: 'task-week-goal-day-name', text: weekdayLabel });
        head.createSpan({
            cls: 'task-week-goal-day-date',
            text: `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`,
        });

        const body = box.createDiv({ cls: 'task-week-goal-day-body' });

        // 顶部工具行：左侧文字「未排布到日计划」，右侧 + 按钮
        const toolbar = body.createDiv({ cls: 'task-week-goal-day-toolbar' });
        toolbar.createSpan({ cls: 'task-week-goal-day-toolbar-label', text: t('panel.weekGoalUnplanned') });
        const addBtn = toolbar.createEl('button', {
            cls: 'task-week-goal-day-add',
            attr: { type: 'button', 'aria-label': t('common.add') },
        });
        setIcon(addBtn, 'plus');
        addBtn.addEventListener('click', () => this.startAddDayGoal(body, dayKey));

        // 分割线
        body.createDiv({ cls: 'task-week-goal-day-divider' });

        // 日目标列表
        const list = body.createDiv({ cls: 'task-week-goal-day-list' });
        const entries = this.task.dayGoals?.[dayKey] ?? [];
        if (entries.length === 0) {
            list.createDiv({ cls: 'task-week-goal-day-empty', text: t('panel.weekGoalEmpty') });
        }
        for (const entry of entries) {
            const row = list.createDiv({ cls: 'task-week-goal-item' });
            row.toggleClass('is-done', entry.done === true);
            const checkbox = row.createEl('input', { cls: 'task-week-goal-item-check' });
            checkbox.type = 'checkbox';
            checkbox.checked = entry.done === true;
            checkbox.addEventListener('change', () => {
                void this.toggleDayGoal(dayKey, entry.id, checkbox.checked);
            });
            row.createSpan({ cls: 'task-week-goal-item-text', text: entry.text });
            const delBtn = row.createEl('button', {
                cls: 'task-week-goal-item-delete',
                attr: { type: 'button', 'aria-label': t('common.delete') },
            });
            setIcon(delBtn, 'x');
            delBtn.addEventListener('click', () => void this.removeDayGoal(dayKey, entry.id));
        }
    }

    /** 在列表末尾插入一个输入行，回车 / 失焦提交，Esc 取消 */
    private startAddDayGoal(body: HTMLElement, dayKey: string): void {
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
            if (commit && text) void this.addDayGoal(dayKey, text);
            else this.refreshWeekGoalSection();
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

    /** 新增日目标 */
    private async addDayGoal(dayKey: string, text: string): Promise<void> {
        const entry: TaskDayGoalEntry = {
            id: `dgoal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text,
            createdAt: Date.now(),
        };
        this.task.dayGoals = { ...(this.task.dayGoals ?? {}) };
        this.task.dayGoals[dayKey] = [...(this.task.dayGoals[dayKey] ?? []), entry];
        await this.panelOptions.save();
        this.refreshWeekGoalSection();
    }

    /** 切换日目标完成状态 */
    private async toggleDayGoal(dayKey: string, entryId: string, done: boolean): Promise<void> {
        const entry = this.task.dayGoals?.[dayKey]?.find((item) => item.id === entryId);
        if (!entry) return;
        if (done) entry.done = true;
        else delete entry.done;
        await this.panelOptions.save();
        this.refreshWeekGoalSection();
    }

    /** 删除日目标 */
    private async removeDayGoal(dayKey: string, entryId: string): Promise<void> {
        const list = this.task.dayGoals?.[dayKey];
        if (!list) return;
        const next = list.filter((item) => item.id !== entryId);
        if (next.length > 0) this.task.dayGoals![dayKey] = next;
        else delete this.task.dayGoals![dayKey];
        await this.panelOptions.save();
        this.refreshWeekGoalSection();
    }

    /** 重绘「一周目标」选项卡（保持当前周） */
    private refreshWeekGoalSection(): void {
        const section = this.sectionsEl?.querySelectorAll('.task-detail-section')[1] as HTMLElement | null;
        const body = section?.querySelector('.task-detail-section-body') as HTMLElement | null;
        if (body) this.renderWeekGoalSection(body);
    }

    /** 就地编辑：把元素内容换成输入框，回车 / 失焦提交，Esc 取消 */
    private startInlineEdit(
        hostEl: HTMLElement,
        current: string,
        options: {
            allowEmpty: boolean;
            displayWhenEmpty?: string;
            onCommit: (value: string) => void;
        },
    ): void {
        const restore = (): void => {
            hostEl.setText(current || options.displayWhenEmpty || '');
        };
        hostEl.empty();
        hostEl.addClass('is-editing');
        const input = hostEl.createEl('input', { cls: 'task-detail-inline-input' });
        input.type = 'text';
        input.value = current;
        input.focus();
        input.select();

        let finished = false;
        const finish = (commit: boolean): void => {
            if (finished) return;
            finished = true;
            this.activeInlineEditAbort = null;
            hostEl.removeClass('is-editing');
            const next = input.value.trim();
            const accepted = commit && (next.length > 0 || options.allowEmpty);
            if (!accepted) {
                restore();
                return;
            }
            if (next === current) {
                restore();
                return;
            }
            options.onCommit(next);
        };

        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') finish(true);
            if (evt.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        this.activeInlineEditAbort = () => finish(false);
    }

    /** 就地编辑分类：分类名称位置换成下拉框，选择后保存；Esc 取消 */
    private startCategoryEdit(dotEl: HTMLElement, nameEl: HTMLElement): void {
        const categories = this.panelOptions.categoryData?.categories ?? [];
        if (categories.length === 0) return;
        const currentId = this.task.categoryId
            && categories.some((item) => item.id === this.task.categoryId)
            ? this.task.categoryId
            : '';
        const previousLabel = nameEl.textContent ?? '';

        nameEl.empty();
        const select = nameEl.createEl('select', { cls: 'dropdown task-detail-category-select' });
        for (const category of categories) {
            const option = select.createEl('option', { text: category.label });
            option.value = category.id;
        }
        select.value = currentId;
        select.focus();

        let finished = false;
        const finish = (commit: boolean): void => {
            if (finished) return;
            finished = true;
            this.activeInlineEditAbort = null;
            const value = select.value;
            const category = categories.find((item) => item.id === value);
            nameEl.empty();
            if (!commit || value === currentId) {
                nameEl.setText(previousLabel);
                return;
            }
            this.task.categoryId = value || undefined;
            const target = this.tasks.find((item) => item.id === this.task.id);
            if (target) target.categoryId = this.task.categoryId;
            dotEl.style.background = category?.color ?? '#888888';
            nameEl.setText(category?.label ?? t('defaultCategory.uncategorized'));
            this.panelOptions.onUpdateTask?.(this.task.id, { categoryId: value });
        };

        select.addEventListener('change', () => finish(true));
        select.addEventListener('blur', () => finish(true));
        select.addEventListener('keydown', (evt) => {
            if (evt.key === 'Escape') finish(false);
        });
        this.activeInlineEditAbort = () => finish(false);
    }

    /** 各分区条目数量（清单为未完成数） */
    private sectionCount(index: number): number {
        const key = SECTIONS[index]?.labelKey;
        if (key === 'panel.targetChecklist') {
            return (this.task.checklist ?? []).filter((item) => !item.done).length;
        }
        if (key === 'panel.targetFile') return listTaskFiles(this.panelOptions.app, this.task.fileDir).length;
        return 0;
    }

    /** 清单：顶部按钮组 + 输入行 + 可选中条目的卡片列表（已完成沉底） */
    private renderChecklist(container: HTMLElement): void {
        this.checklistBodyEl = container;
        container.empty();
        const wrap = container.createDiv({ cls: 'task-detail-basket task-detail-todo' });

        // 顶部按钮组：排序方式 / 设置截止时间（需先选中条目）
        const toolbar = wrap.createDiv({ cls: 'task-detail-todo-toolbar' });
        const sortBtn = toolbar.createEl('button', {
            cls: 'task-detail-todo-tool-btn',
            text: this.checklistSort === 'due' ? t('panel.checklistSortDue') : t('panel.checklistSortCreated'),
        });
        sortBtn.onclick = () => {
            this.checklistSort = this.checklistSort === 'due' ? 'created' : 'due';
            this.renderChecklist(container);
        };
        const dueBtn = toolbar.createEl('button', {
            cls: 'task-detail-todo-tool-btn',
            text: t('panel.checklistSetDue'),
        });
        dueBtn.disabled = !this.selectedChecklistId;
        dueBtn.onclick = () => this.openChecklistDueEditor(wrap, container);

        const row = wrap.createDiv({ cls: 'gtd-collect-input-row' });
        const input = row.createEl('input', { cls: 'gtd-collect-input' });
        input.type = 'text';
        input.placeholder = t('panel.checklistAddPlaceholder');
        const addBtn = row.createEl('button', { cls: 'gtd-collect-add-btn', text: t('common.add') });

        const submit = (): void => {
            const text = input.value.trim();
            if (!text) return;
            const entry: ChecklistItem = {
                id: `checklist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                text,
                createdAt: Date.now(),
            };
            this.task.checklist = [...(this.task.checklist ?? []), entry];
            this.syncChecklistToTasks();
            input.value = '';
            void this.panelOptions.save().then(() => this.renderChecklist(container));
        };
        addBtn.onclick = submit;
        input.onkeydown = (evt) => {
            if (evt.key === 'Enter') submit();
        };

        const listWrap = wrap.createDiv({ cls: 'gtd-collect-list task-detail-basket-list' });
        const listInner = listWrap.createDiv({ cls: 'gtd-collect-list-inner' });
        const entries = this.task.checklist ?? [];
        this.checklistCountEl?.setText(`(${entries.filter((item) => !item.done).length})`);

        if (entries.length === 0) {
            listInner.createDiv({ cls: 'gtd-collect-empty', text: t('panel.checklistEmpty') });
            return;
        }

        // 未完成在前、已完成沉底；未完成可按截止时间排序（无截止时间排最后）
        const pending = entries.filter((entry) => !entry.done);
        if (this.checklistSort === 'due') {
            pending.sort((a, b) => {
                const aDue = a.dueDate ? new Date(`${a.dueDate}T00:00:00`).getTime() : Number.POSITIVE_INFINITY;
                const bDue = b.dueDate ? new Date(`${b.dueDate}T00:00:00`).getTime() : Number.POSITIVE_INFINITY;
                if (aDue !== bDue) return aDue - bDue;
                return a.createdAt - b.createdAt;
            });
        }
        const ordered = [...pending, ...entries.filter((entry) => entry.done)];

        for (const entry of ordered) {
            const card = listInner.createDiv({ cls: 'gtd-collect-card task-detail-todo-card' });
            card.toggleClass('is-done', entry.done === true);
            card.toggleClass('is-selected', this.selectedChecklistId === entry.id);
            // 点击条目切换选中态（供「设置截止时间」使用）
            card.addEventListener('click', () => {
                this.selectedChecklistId = this.selectedChecklistId === entry.id ? null : entry.id;
                this.renderChecklist(container);
            });

            // 第一行：状态标签 + 截止日期相关标签（不再显示创建时间）
            const meta = card.createDiv({ cls: 'gtd-collect-card-meta' });
            meta.createSpan({
                cls: 'gtd-collect-card-status',
                text: t(entry.done ? 'panel.checklistDone' : 'panel.checklistPending'),
            });
            // 已完成条目显示完成时间
            if (entry.done && entry.completedAt) {
                meta.createSpan({
                    cls: 'task-detail-todo-due-tag task-detail-todo-done-tag',
                    text: t('panel.checklistCompletedAt', { time: formatCompletedTime(entry.completedAt) }),
                });
            }
            if (entry.dueDate) this.appendChecklistDueTags(meta, entry.dueDate);

            const main = card.createDiv({ cls: 'task-detail-todo-main' });
            const checkbox = main.createEl('input', { cls: 'task-detail-todo-checkbox' });
            checkbox.type = 'checkbox';
            checkbox.checked = entry.done === true;
            checkbox.addEventListener('click', (evt) => evt.stopPropagation());
            checkbox.addEventListener('change', () => {
                entry.done = checkbox.checked;
                // 完成时记录时间戳，取消完成时清除
                if (checkbox.checked) entry.completedAt = Date.now();
                else delete entry.completedAt;
                this.syncChecklistToTasks();
                void this.panelOptions.save().then(() => this.renderChecklist(container));
            });
            main.createSpan({ cls: 'gtd-collect-card-content task-detail-todo-text', text: entry.text });

            const delBtn = card.createEl('button', { cls: 'gtd-collect-card-delete', text: '×' });
            delBtn.onclick = (evt) => {
                evt.stopPropagation();
                this.task.checklist = (this.task.checklist ?? []).filter((item) => item.id !== entry.id);
                if (this.selectedChecklistId === entry.id) this.selectedChecklistId = null;
                this.syncChecklistToTasks();
                void this.panelOptions.save().then(() => this.renderChecklist(container));
            };
        }
    }

    /** 在状态标签后追加截止日期 / 剩余天数 / 已过期标签 */
    private appendChecklistDueTags(meta: HTMLElement, dueDate: string): void {
        const due = new Date(`${dueDate}T00:00:00`);
        if (Number.isNaN(due.getTime())) return;
        const label = getLang() === 'zh'
            ? `${due.getMonth() + 1}月${due.getDate()}日`
            : `${due.getMonth() + 1}/${due.getDate()}`;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const days = Math.round((due.getTime() - today.getTime()) / 86400000);
        // 「几天后 / 已过期」标签在截止日期标签之前
        if (days < 0) {
            meta.createSpan({ cls: 'task-detail-todo-due-tag is-overdue', text: t('panel.checklistOverdue') });
        } else {
            meta.createSpan({
                cls: 'task-detail-todo-due-tag',
                text: days === 0 ? t('panel.checklistDueToday') : t('panel.checklistDueInDays', { days }),
            });
        }
        meta.createSpan({ cls: 'task-detail-todo-due-tag', text: t('panel.checklistDueDateTag', { date: label }) });
    }

    /** 选中条目的截止日期编辑行：日期输入框 + 确定 / 清除 / 取消 */
    private openChecklistDueEditor(wrap: HTMLElement, container: HTMLElement): void {
        const entry = (this.task.checklist ?? []).find((item) => item.id === this.selectedChecklistId);
        if (!entry) return;
        wrap.querySelector('.task-detail-todo-due-editor')?.remove();
        const editor = wrap.createDiv({ cls: 'task-detail-todo-due-editor' });
        const input = editor.createEl('input', { cls: 'task-detail-todo-due-input' });
        input.type = 'date';
        input.value = entry.dueDate ?? '';
        const saveEntry = (): void => {
            if (input.value) entry.dueDate = input.value;
            else delete entry.dueDate;
            this.syncChecklistToTasks();
            void this.panelOptions.save().then(() => this.renderChecklist(container));
        };
        const save = editor.createEl('button', { cls: 'task-detail-todo-tool-btn', text: t('panel.checklistDueSave') });
        save.onclick = saveEntry;
        const clear = editor.createEl('button', { cls: 'task-detail-todo-tool-btn', text: t('panel.checklistDueClear') });
        clear.onclick = () => {
            input.value = '';
            saveEntry();
        };
        const cancel = editor.createEl('button', { cls: 'task-detail-todo-tool-btn', text: t('panel.checklistDueCancel') });
        cancel.onclick = () => editor.remove();
        wrap.insertBefore(editor, wrap.querySelector('.gtd-collect-input-row'));
        input.focus();
    }

    /** 同步清单到全量任务列表中的同一任务 */
    private syncChecklistToTasks(): void {
        const target = this.tasks.find((item) => item.id === this.task.id);
        if (target) target.checklist = this.task.checklist;
    }

    /** 任务文件：先按任务树确保目录存在，再渲染操作卡片（时间戳开关 / 文件夹 / 添加）+ 文件列表卡片 */
    private renderFiles(container: HTMLElement): void {
        this.filesBodyEl = container;
        void this.ensureFilesDir().then(() => {
            // 异步期间可能已切换任务 / 重绘，仅渲染当前容器
            if (this.filesBodyEl === container && container.isConnected) {
                this.renderFilesContent(container);
            }
        });
    }

    /** 按项目库根目录 + 任务树确保任务文件目录（未配置项目库时返回 null） */
    private async ensureFilesDir(): Promise<string | null> {
        const root = this.panelOptions.getTaskLibraryRoot?.() ?? '';
        if (!root) return null;
        const result = await ensureTaskFileDir(this.panelOptions.app, root, this.tasks, this.task);
        if (result.changed) {
            this.syncFilesToTasks();
            void this.panelOptions.save();
        }
        return result.dir;
    }

    /** 渲染任务文件内容 */
    private renderFilesContent(container: HTMLElement): void {
        container.empty();
        const wrap = container.createDiv({ cls: 'task-detail-files' });

        // 卡片一：操作按钮组
        const card = wrap.createDiv({ cls: 'task-detail-files-card' });
        const toolbar = card.createDiv({ cls: 'task-detail-files-toolbar' });

        // 启用时间戳勾选框
        const switchWrap = toolbar.createDiv({ cls: 'task-detail-files-switch' });
        const checkbox = switchWrap.createEl('input', { cls: 'task-detail-files-checkbox' });
        checkbox.type = 'checkbox';
        checkbox.checked = this.task.fileTimestamp === true;
        checkbox.addEventListener('change', () => {
            this.task.fileTimestamp = checkbox.checked;
            this.syncFilesToTasks();
            void this.panelOptions.save();
        });
        switchWrap.createSpan({ cls: 'task-detail-files-switch-label', text: t('panel.fileTimestamp') });

        // 文件夹：目录由任务树自动绑定，点击在 Obsidian 文件浏览器中定位
        const dirBtn = toolbar.createEl('button', { cls: 'task-detail-files-btn' });
        setIcon(dirBtn.createSpan({ cls: 'task-detail-files-btn-icon' }), 'folder');
        dirBtn.createSpan({ cls: 'task-detail-files-btn-text', text: t('panel.fileFolder') });
        if (this.task.fileDir) dirBtn.title = this.task.fileDir;
        dirBtn.addEventListener('click', () => void this.openTaskFolder());

        // 新建文件
        const addBtn = toolbar.createEl('button', { cls: 'task-detail-files-btn' });
        setIcon(addBtn.createSpan({ cls: 'task-detail-files-btn-icon' }), 'plus');
        addBtn.createSpan({ cls: 'task-detail-files-btn-text', text: t('panel.fileAdd') });
        addBtn.addEventListener('click', () => {
            if (!this.task.fileDir) {
                new Notice(t('panel.taskLibraryRequired'));
                return;
            }
            this.fileCreateMode = true;
            this.renderFilesContent(container);
        });

        if (this.fileCreateMode) {
            const createRow = card.createDiv({ cls: 'task-detail-files-create' });
            const nameInput = createRow.createEl('input', { cls: 'task-detail-files-create-input' });
            nameInput.type = 'text';
            nameInput.placeholder = t('panel.fileCreatePlaceholder');
            const confirmBtn = createRow.createEl('button', { text: t('panel.fileCreate') });
            const cancelBtn = createRow.createEl('button', { text: t('common.cancel') });
            const submit = (): void => {
                const name = nameInput.value.trim();
                if (!name) return;
                void this.createTaskFile(name);
            };
            confirmBtn.addEventListener('click', submit);
            nameInput.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter') submit();
                if (evt.key === 'Escape') {
                    this.fileCreateMode = false;
                    this.renderFilesContent(container);
                }
            });
            cancelBtn.addEventListener('click', () => {
                this.fileCreateMode = false;
                this.renderFilesContent(container);
            });
            nameInput.focus();
        }

        // 卡片二：文件列表（文件名 + 最近编辑时间，点击打开）
        const listCard = wrap.createDiv({ cls: 'task-detail-files-card task-detail-files-list-card' });
        const files = listTaskFiles(this.panelOptions.app, this.task.fileDir);
        this.fileCountEl?.setText(`(${files.length})`);

        if (!this.task.fileDir) {
            listCard.createDiv({ cls: 'gtd-collect-empty', text: t('panel.taskLibraryRequired') });
            return;
        }
        if (files.length === 0) {
            listCard.createDiv({ cls: 'gtd-collect-empty', text: t('panel.fileEmpty') });
            return;
        }
        for (const file of files) {
            const row = listCard.createDiv({ cls: 'task-detail-file-row' });
            setIcon(row.createSpan({ cls: 'task-detail-file-icon' }), 'file-text');
            // 显示相对绑定目录的路径（含子目录），仅文件名不足以区分同名文件
            const nameEl = row.createSpan({ cls: 'task-detail-file-name', text: relativeToDir(file.path, this.task.fileDir) });
            nameEl.title = file.path;
            row.createSpan({ cls: 'task-detail-file-time', text: formatDateTime(file.stat.mtime) });
            row.addEventListener('click', () => this.openTaskFile(file));
        }
    }

    /** 打开任务文件：Markdown 使用内置编辑面板，其它类型交给 Obsidian 默认打开方式 */
    private openTaskFile(file: TFile): void {
        if (file.extension !== 'md') {
            void this.panelOptions.app.workspace.getLeaf(false).openFile(file);
            return;
        }
        this.fileEditorPanel?.destroy();
        this.fileEditorPanel = new FileEditorPanel({
            app: this.panelOptions.app,
            file,
            container: this.panelOptions.container,
            onClose: () => {
                if (this.filesBodyEl?.isConnected) this.renderFiles(this.filesBodyEl);
            },
        });
        this.fileEditorPanel.open();
    }

    /** 点击「文件夹」：未配置项目库时提示；已配置时确保目录存在并在 Obsidian 文件浏览器中定位 */
    private async openTaskFolder(): Promise<void> {
        const root = this.panelOptions.getTaskLibraryRoot?.() ?? '';
        if (!root) {
            new Notice(t('panel.taskLibraryRequired'));
            return;
        }
        const dir = await this.ensureFilesDir();
        if (!dir) return;
        const folder = this.panelOptions.app.vault.getAbstractFileByPath(dir);
        if (folder instanceof TFolder) revealFolderInExplorer(this.panelOptions.app, folder);
        if (this.filesBodyEl?.isConnected) this.renderFilesContent(this.filesBodyEl);
    }

    /** 在自动绑定的任务文件目录下新建 Markdown 文件（启用时间戳时加前缀），并打开内置编辑面板 */
    private async createTaskFile(name: string): Promise<void> {
        const dir = await this.ensureFilesDir();
        if (!dir) {
            new Notice(t('panel.taskLibraryRequired'));
            return;
        }
        const fileName = buildTaskFileName(name, this.task.fileTimestamp === true);
        if (!fileName) return;
        try {
            const file = await this.panelOptions.app.vault.create(`${dir}/${fileName}`, '');
            this.fileCreateMode = false;
            if (this.filesBodyEl) this.renderFilesContent(this.filesBodyEl);
            this.openTaskFile(file);
        } catch {
            new Notice(t('panel.fileCreateFailed'));
        }
    }

    /** 同步任务文件配置到全量任务列表中的同一任务 */
    private syncFilesToTasks(): void {
        const target = this.tasks.find((item) => item.id === this.task.id);
        if (!target) return;
        target.fileDir = this.task.fileDir;
        target.fileTimestamp = this.task.fileTimestamp;
    }

    /** 切换选项卡：只显示对应分区 */
    private switchSection(index: number): void {
        this.currentSection = index;
        const sections = Array.from(this.sectionsEl.children) as HTMLElement[];
        this.tabs.forEach((tab, i) => tab.toggleClass('is-active', i === index));
        sections.forEach((section, i) => section.toggleClass('is-active', i === index));
    }

    /** 渲染后代任务树 */
    private renderTree(): void {
        this.treeEl.empty();
        const hasChild = this.tasks.some((task) => task.parentId === this.rootTaskId);
        if (!hasChild) {
            this.treeEl.createDiv({ cls: 'task-detail-tree-empty', text: t('panel.noSubTask') });
            return;
        }
        this.renderTreeNodes(this.treeEl, this.rootTaskId, 0);
    }

    /** 递归渲染某一层的子任务 */
    private renderTreeNodes(parentEl: HTMLElement, parentId: string, depth: number): void {
        const children = this.tasks.filter((task) => task.parentId === parentId);
        for (const child of children) {
            const row = parentEl.createDiv({ cls: 'task-detail-tree-row' });
            row.style.marginLeft = `${depth * TREE_DEPTH_INDENT}px`;
            row.dataset.taskId = child.id;
            row.dataset.depth = String(depth);
            const iconEl = row.createSpan({ cls: 'task-detail-tree-icon' });
            setIcon(iconEl, 'git-branch');
            row.createSpan({ cls: 'task-detail-tree-label', text: child.name });
            // 条目末尾始终显示目标图标 + 该任务自身目标数量（为 0 不显示）
            const goalCount = child.goals?.length ?? 0;
            if (goalCount > 0) {
                const goalEl = row.createSpan({ cls: 'task-detail-tree-goal' });
                const goalIconEl = goalEl.createSpan({ cls: 'task-detail-tree-goal-icon' });
                setIcon(goalIconEl, 'target');
                goalEl.createSpan({ cls: 'task-detail-tree-goal-count', text: String(goalCount) });
            }
            row.toggleClass('is-selected', child.id === this.selectedTaskId);
            row.addEventListener('mousedown', (evt) => this.startTreeLongPress(evt, child, row));
            this.renderTreeNodes(parentEl, child.id, depth + 1);
        }
    }

    /** 长按任务条目后进入拖动：按落点重排顺序并调整层级（限制在当前根任务子树内） */
    private startTreeLongPress(evt: MouseEvent, item: PrototypeTask, row: HTMLElement): void {
        if (evt.button !== 0) return;
        const startX = evt.clientX;
        const startY = evt.clientY;
        let timer: number | null = window.setTimeout(() => {
            timer = null;
            beginDrag();
        }, TREE_LONG_PRESS_MS);

        const cancelTimer = (): void => {
            if (timer !== null) {
                window.clearTimeout(timer);
                timer = null;
            }
            document.removeEventListener('mousemove', onPreMove);
            document.removeEventListener('mouseup', onPreUp);
        };

        // 长按期间移动超过阈值则视为普通点击 / 取消长按
        const onPreMove = (moveEvt: MouseEvent): void => {
            if (Math.abs(moveEvt.clientX - startX) > 5 || Math.abs(moveEvt.clientY - startY) > 5) {
                cancelTimer();
            }
        };
        const onPreUp = (): void => cancelTimer();
        document.addEventListener('mousemove', onPreMove);
        document.addEventListener('mouseup', onPreUp);

        const beginDrag = (): void => {
            document.removeEventListener('mousemove', onPreMove);
            document.removeEventListener('mouseup', onPreUp);

            // 被拖动任务及其后代（整体移动，且不能作为落点）
            const movingIds = this.collectSubtreeIds(item.id);
            const targets = Array.from(this.treeEl.querySelectorAll<HTMLElement>('.task-detail-tree-row'))
                .filter((el) => {
                    const id = el.dataset.taskId;
                    return id && !movingIds.has(id);
                });

            row.addClass('is-dragging');
            const indicator = this.treeEl.createDiv({ cls: 'task-detail-drag-indicator' });

            // 落点计算：{ beforeId, placeAfter, parentId, depth }
            const computeDrop = (clientX: number, clientY: number) => {
                if (targets.length === 0) {
                    return { beforeId: undefined as string | undefined, parentId: this.rootTaskId, depth: 0 };
                }
                let refEl: HTMLElement | undefined;
                let placeAfter = false;
                for (const el of targets) {
                    const rect = el.getBoundingClientRect();
                    if (clientY < rect.top) {
                        refEl = el;
                        placeAfter = false;
                        break;
                    }
                    if (clientY <= rect.bottom) {
                        refEl = el;
                        placeAfter = clientY > rect.top + rect.height / 2;
                        break;
                    }
                }
                if (!refEl) {
                    refEl = targets[targets.length - 1];
                    placeAfter = true;
                }

                const refId = refEl.dataset.taskId!;
                const refDepth = Number(refEl.dataset.depth ?? '0');
                // 层级：鼠标 X 相对目标行左边缘的偏移（每 14px 一层），最多比目标深一层
                const offset = clientX - refEl.getBoundingClientRect().left;
                let depth = Math.max(0, Math.min(Math.round(offset / TREE_DEPTH_INDENT), refDepth + 1));

                // 父级：目标行之前最近的 depth-1 层任务；找不到则挂回当前根任务
                let parentId = this.rootTaskId;
                if (depth > 0) {
                    const refIndex = targets.indexOf(refEl);
                    let found = false;
                    for (let i = refIndex; i >= 0; i--) {
                        const candId = targets[i].dataset.taskId!;
                        const candDepth = Number(targets[i].dataset.depth ?? '0');
                        if (candDepth === depth - 1) {
                            parentId = candId;
                            found = true;
                            break;
                        }
                    }
                    if (!found) depth = 0;
                }
                return { beforeId: refId, placeAfter, parentId, depth };
            };

            const updateIndicator = (clientX: number, clientY: number): void => {
                const drop = computeDrop(clientX, clientY);
                const refEl = targets.find((el) => el.dataset.taskId === drop.beforeId);
                if (!refEl) {
                    indicator.removeClass('is-visible');
                    return;
                }
                const rect = refEl.getBoundingClientRect();
                const listRect = this.treeEl.getBoundingClientRect();
                const top = (drop.placeAfter ? rect.bottom : rect.top) - listRect.top + this.treeEl.scrollTop;
                indicator.addClass('is-visible');
                indicator.setCssProps({
                    '--indicator-top': `${top}px`,
                    '--indicator-left': `${drop.depth * TREE_DEPTH_INDENT}px`,
                });
            };

            let hasMoved = false;
            const onMove = (moveEvt: MouseEvent): void => {
                // 长按触发后只要鼠标稍微移动即视为真实拖动
                if (!hasMoved) hasMoved = true;
                updateIndicator(moveEvt.clientX, moveEvt.clientY);
            };
            const onUp = (upEvt: MouseEvent): void => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                indicator.remove();
                row.removeClass('is-dragging');
                if (hasMoved) {
                    this.suppressTreeClick = true;
                    this.applyTreeDrop(item, computeDrop(upEvt.clientX, upEvt.clientY));
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
    }

    /** 应用落点：更新 parentId 并重排 tasks 数组，然后保存并刷新 */
    private applyTreeDrop(
        item: PrototypeTask,
        drop: { beforeId?: string; placeAfter?: boolean; parentId: string; depth: number },
    ): void {
        const target = this.tasks.find((task) => task.id === item.id);
        if (!target) return;
        target.parentId = drop.parentId;

        const movingIds = this.collectSubtreeIds(item.id);
        const moving = this.tasks.filter((task) => movingIds.has(task.id));
        const rest = this.tasks.filter((task) => !movingIds.has(task.id));
        let next: PrototypeTask[];
        if (!drop.beforeId) {
            next = [...rest, ...moving];
        } else {
            const refIndex = rest.findIndex((task) => task.id === drop.beforeId);
            const insertAt = refIndex < 0 ? rest.length : (drop.placeAfter ? refIndex + 1 : refIndex);
            next = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
        }
        // 优先交由父面板按新顺序写回仓库；未提供时退回本地数组替换
        if (this.panelOptions.onReorderTasks) {
            this.panelOptions.onReorderTasks(next);
        } else {
            this.tasks.splice(0, this.tasks.length, ...next);
        }

        this.renderTree();
        void this.panelOptions.save().then(() => this.panelOptions.onTasksChanged?.());
    }

    /** 某任务及其全部后代的 id 集合 */
    private collectSubtreeIds(id: string): Set<string> {
        const ids = new Set<string>([id]);
        const walk = (parentId: string): void => {
            for (const task of this.tasks) {
                if (task.parentId === parentId) {
                    ids.add(task.id);
                    walk(task.id);
                }
            }
        };
        walk(id);
        return ids;
    }

    /** 选中某个任务条目（决定 + 新增子任务挂到哪个任务下） */
    private selectTask(taskId: string): void {
        this.selectedTaskId = taskId;
        this.treeEl.querySelectorAll('.task-detail-tree-row').forEach((el) => {
            const row = el as HTMLElement;
            row.toggleClass('is-selected', row.dataset.taskId === taskId);
        });
        const next = this.tasks.find((item) => item.id === taskId);
        if (next && next.id !== this.task.id) {
            // 右侧整体切换为选中任务：名称 / 分类 / 描述 / 归属分区，未提交的内联编辑先行放弃
            this.activeInlineEditAbort?.();
            this.task = next;
            this.selectedChecklistId = null;
            this.fileCreateMode = false;
            this.renderRightPane();
            return;
        }
        this.renderSettingPanel();
    }

    /** 展开 / 收起新增子任务小面板 */
    private toggleAddForm(): void {
        const visible = this.addFormEl.style.display !== 'none';
        if (visible) {
            this.hideAddForm();
        } else {
            this.addFormEl.style.display = 'flex';
            this.inputEl.focus();
        }
    }

    private hideAddForm(): void {
        this.addFormEl.style.display = 'none';
        this.inputEl.value = '';
    }

    /** 确认新增子任务 */
    private submitAdd(): void {
        const name = this.inputEl.value.trim();
        if (!name) {
            this.inputEl.focus();
            return;
        }
        this.panelOptions.onAddChild?.(name, this.selectedTaskId);
        this.hideAddForm();
    }
}

/** 时间戳格式化为 YYYY-MM-DD HH:MM */
function formatDateTime(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${da} ${h}:${mi}`;
}

/** 完成时间格式化为 MM-DD HH:MM（清单条目上展示） */
function formatCompletedTime(ts: number): string {
    const d = new Date(ts);
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mo}-${da} ${h}:${mi}`;
}