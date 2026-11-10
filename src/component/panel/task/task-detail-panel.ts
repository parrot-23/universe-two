// 任务详情面板：基于 FloatingPanel，展示单个原型任务的详情。
// 左侧：类型标题行（主线任务 / 支线任务）+ 添加按钮，下方为后代任务树；
// 右侧：任务名称 / 分类 / 描述 + 任务板块（与任务板块面板共用 SectionHost）。
import { setIcon, type App } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import type { PlanCategoryData } from '../../../shared/plan-category-manager';
import { UNCATEGORIZED_CATEGORY_ID } from '../../../shared/plan-category-manager';
import { getTaskGoals } from '../../../shared/task-sections';
import { applyThemeColors, getCurrentThemeColors } from '../../../themestory/theme-colors';
import { SectionHost } from '../../section/section-host';
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
    /** 右侧板块容器 */
    private sectionsEl!: HTMLElement;
    /** 板块宿主（与任务板块面板共用） */
    private sectionHost!: SectionHost;
    /** 当前选中的任务 id（决定 + 按钮在哪个任务下新增子任务），默认根任务；取消选中时为 undefined */
    private selectedTaskId: string | undefined;
    /** 左侧底部工具栏：表单打卡按钮 */
    private formButtonEl!: HTMLButtonElement;
    /** 右侧底部设置面板（表单打卡） */
    private settingPanelEl!: HTMLElement;
    /** 当前激活的设置面板类型 */
    private settingActive: 'form' | null = null;
    /** 删除确认浮层（点击删除按钮时显示在按钮上方） */
    private deleteConfirmEl: HTMLElement | null = null;
    /** 删除确认浮层的点击外部关闭回调 */
    private deleteConfirmOutsideHandler?: (evt: MouseEvent) => void;
    /** 删除确认浮层的 Esc 关闭回调 */
    private deleteConfirmEscapeHandler?: (evt: KeyboardEvent) => void;
    /** 分类下拉浮层 */
    private categoryMenuEl: HTMLElement | null = null;
    /** 分类下拉浮层的锚点（分类行） */
    private categoryMenuAnchor: HTMLElement | null = null;
    /** 分类下拉浮层的点击外部关闭回调 */
    private categoryMenuOutsideHandler?: (evt: MouseEvent) => void;
    /** 分类下拉浮层的 Esc 关闭回调 */
    private categoryMenuEscapeHandler?: (evt: KeyboardEvent) => void;
    /** 右侧容器（切换左侧选中任务时整体重建） */
    private rightEl!: HTMLElement;
    /** 面板打开时的根任务 id（左侧任务树始终以它为根，不随右侧切换变化） */
    private rootTaskId: string;
    /** 左侧顶部的根任务下拉（可切换任务树的根） */
    private rootSelectEl!: HTMLSelectElement;
    /** 当前进行中的内联编辑取消函数（切换任务时先调用以放弃编辑） */
    private activeInlineEditAbort: (() => void) | null = null;
    /** 拖动结束后抑制一次点击，避免误选中 */
    private suppressTreeClick = false;

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
        this.sectionHost = new SectionHost({
            app: options.app,
            getTask: () => this.task,
            getTasks: () => this.tasks,
            getTaskLibraryRoot: options.getTaskLibraryRoot,
            save: options.save,
            container: options.container,
        });
        this.renderContent();
    }

    /** 每次打开时刷新板块内容（数据可能被其它入口改动） */
    override open(): void {
        if (this.sectionsEl?.isConnected) this.sectionHost.render();
        this.renderSettingPanel();
        super.open();
    }

    /** 关闭面板时一并关闭删除确认浮层与分类下拉浮层（均挂在 body 上，需手动移除） */
    override close(): void {
        this.closeDeleteConfirm();
        this.closeCategoryMenu();
        super.close();
    }

    /** 销毁面板时一并清理浮层 */
    override destroy(): void {
        this.closeDeleteConfirm();
        this.closeCategoryMenu();
        this.sectionHost?.destroy();
        super.destroy();
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
            if (!taskId) return;
            // 再次点击已选中的条目取消选中
            if (taskId === this.selectedTaskId) this.clearTaskSelection();
            else this.selectTask(taskId);
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

        // 右侧：任务信息（名称 / 分类 / 描述）+ 任务板块（切换左侧选中任务时整体重建）
        this.rightEl = body.createDiv({ cls: 'task-detail-right' });
        this.renderRightPane();
    }

    /** 重建右侧内容：任务信息行 + 任务板块 + 底部设置面板 */
    private renderRightPane(): void {
        this.closeDeleteConfirm();
        this.closeCategoryMenu();
        const right = this.rightEl;
        right.empty();

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
        const categoryArrow = categoryRow.createSpan({ cls: 'task-detail-category-arrow' });
        setIcon(categoryArrow, 'chevron-down');
        categoryRow.addEventListener('click', (evt) => {
            evt.stopPropagation();
            this.toggleCategoryMenu(categoryRow, dotEl, categoryNameEl);
        });

        const headActions = headBlock.createDiv({ cls: 'task-detail-head-actions' });
        this.createHeadAction(headActions, 'archive', t('common.archive'), false, () => this.archiveTask());
        const deleteBtn = this.createHeadAction(headActions, 'trash-2', t('common.delete'), true, () =>
            this.openDeleteConfirm(deleteBtn),
        );

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

        // 板块区：已落库板块 + 未创建板块胶囊（与任务板块面板共用 SectionHost）
        this.sectionsEl = right.createDiv({ cls: 'task-detail-sections' });
        this.sectionHost.render(this.sectionsEl);
        // 右侧底部：设置面板（默认隐藏，由左侧工具栏按钮控制）
        this.settingPanelEl = right.createDiv({ cls: 'task-detail-setting-panel is-hidden' });

        this.renderSettingPanel();
    }

    /** 创建右侧标题区的方块按钮（图标 + 换行 + 名称） */
    private createHeadAction(
        parent: HTMLElement,
        icon: string,
        label: string,
        danger: boolean,
        onClick: () => void,
    ): HTMLButtonElement {
        const button = parent.createEl('button', {
            cls: `task-detail-head-action${danger ? ' is-danger' : ''}`,
            attr: { type: 'button', 'aria-label': label },
        });
        setIcon(button.createSpan({ cls: 'task-detail-head-action-icon' }), icon);
        button.createSpan({ cls: 'task-detail-head-action-label', text: label });
        button.addEventListener('click', onClick);
        return button;
    }

    /** 归档当前任务：写完仓库后关闭面板 */
    private archiveTask(): void {
        this.panelOptions.onArchiveTask?.(this.task.id);
        this.close();
    }

    /** 在删除按钮上方打开删除确认浮层（点击确认后连同后代任务一并删除） */
    private openDeleteConfirm(anchor: HTMLElement): void {
        this.closeDeleteConfirm();
        const tip = document.body.createDiv({ cls: 'task-detail-delete-confirm' });
        this.deleteConfirmEl = tip;
        tip.createDiv({
            cls: 'task-detail-delete-confirm-text',
            text: t('panel.deleteTaskDetail', { name: this.task.name }),
        });
        const actions = tip.createDiv({ cls: 'task-detail-delete-confirm-actions' });
        const cancelBtn = actions.createEl('button', {
            text: t('settings.cancel'),
            attr: { type: 'button' },
        });
        cancelBtn.addEventListener('click', () => this.closeDeleteConfirm());
        const confirmBtn = actions.createEl('button', {
            cls: 'mod-warning',
            text: t('settings.confirm'),
            attr: { type: 'button' },
        });
        confirmBtn.addEventListener('click', () => {
            this.closeDeleteConfirm();
            this.panelOptions.onDeleteTask?.(this.task.id);
            this.close();
        });
        this.positionDeleteConfirm(anchor);
        this.deleteConfirmOutsideHandler = (evt: MouseEvent) => {
            const target = evt.target as Node | null;
            if (target && (tip.contains(target) || anchor.contains(target))) return;
            this.closeDeleteConfirm();
        };
        this.deleteConfirmEscapeHandler = (evt: KeyboardEvent) => {
            if (evt.key !== 'Escape') return;
            // 先关闭浮层，避免同时关闭整个面板
            evt.preventDefault();
            evt.stopPropagation();
            this.closeDeleteConfirm();
        };
        document.addEventListener('mousedown', this.deleteConfirmOutsideHandler, true);
        document.addEventListener('keydown', this.deleteConfirmEscapeHandler, true);
    }

    /** 定位删除确认浮层：优先显示在按钮上方，空间不足时翻到下方 */
    private positionDeleteConfirm(anchor: HTMLElement): void {
        const tip = this.deleteConfirmEl;
        if (!tip) return;
        const rect = anchor.getBoundingClientRect();
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
        let top = rect.top - height - 6;
        if (top < 8) top = rect.bottom + 6;
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
    }

    /** 关闭删除确认浮层（移除元素与 document 监听） */
    private closeDeleteConfirm(): void {
        if (this.deleteConfirmOutsideHandler) {
            document.removeEventListener('mousedown', this.deleteConfirmOutsideHandler, true);
            this.deleteConfirmOutsideHandler = undefined;
        }
        if (this.deleteConfirmEscapeHandler) {
            document.removeEventListener('keydown', this.deleteConfirmEscapeHandler, true);
            this.deleteConfirmEscapeHandler = undefined;
        }
        this.deleteConfirmEl?.remove();
        this.deleteConfirmEl = null;
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

        // 第一行：颜色圆点 + 任务名称 + 分类（与习惯面板任务信息一致）
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

    /** 切换分类下拉浮层：点击分类行展开，再次点击收起 */
    private toggleCategoryMenu(anchor: HTMLElement, dotEl: HTMLElement, nameEl: HTMLElement): void {
        if (this.categoryMenuEl && this.categoryMenuAnchor === anchor) {
            this.closeCategoryMenu();
            return;
        }
        this.closeCategoryMenu();
        const categories = this.panelOptions.categoryData?.categories ?? [];
        if (categories.length === 0) return;

        const menu = document.body.createDiv({ cls: 'task-detail-category-menu' });
        applyThemeColors(menu, getCurrentThemeColors());
        this.categoryMenuEl = menu;
        this.categoryMenuAnchor = anchor;
        anchor.addClass('is-open');
        const currentId = this.task.categoryId ?? UNCATEGORIZED_CATEGORY_ID;
        for (const category of categories) {
            const item = menu.createDiv({ cls: 'task-detail-category-item' });
            item.toggleClass('is-active', category.id === currentId);
            const itemDot = item.createSpan({ cls: 'task-detail-category-dot' });
            itemDot.style.background = category.color ?? '#888888';
            item.createSpan({ cls: 'task-detail-category-name', text: category.label });
            item.addEventListener('click', (evt) => {
                evt.stopPropagation();
                this.closeCategoryMenu();
                this.applyTaskCategory(category.id, dotEl, nameEl);
            });
        }

        // 贴在分类行下方，右侧空间不足时向左收敛（宽度随内容自适应）
        const rect = anchor.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const top = rect.bottom + height > window.innerHeight - 8
            ? Math.max(8, rect.top - height - 4)
            : rect.bottom + 4;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        this.categoryMenuOutsideHandler = (evt: MouseEvent) => {
            const target = evt.target as Node | null;
            if (target && (menu.contains(target) || anchor.contains(target))) return;
            this.closeCategoryMenu();
        };
        this.categoryMenuEscapeHandler = (evt: KeyboardEvent) => {
            if (evt.key !== 'Escape') return;
            // 先关闭下拉，避免同时关闭整个面板
            evt.preventDefault();
            evt.stopPropagation();
            this.closeCategoryMenu();
        };
        document.addEventListener('mousedown', this.categoryMenuOutsideHandler, true);
        document.addEventListener('keydown', this.categoryMenuEscapeHandler, true);
    }

    /** 选中分类：更新任务分类、分类行圆点与名称，并写回仓库 */
    private applyTaskCategory(categoryId: string, dotEl: HTMLElement, nameEl: HTMLElement): void {
        if (categoryId === (this.task.categoryId ?? UNCATEGORIZED_CATEGORY_ID)) return;
        const categories = this.panelOptions.categoryData?.categories ?? [];
        const category = categories.find((item) => item.id === categoryId);
        this.task.categoryId = categoryId;
        const target = this.tasks.find((item) => item.id === this.task.id);
        if (target) target.categoryId = categoryId;
        dotEl.style.background = category?.color ?? '#888888';
        nameEl.setText(category?.label ?? t('defaultCategory.uncategorized'));
        this.panelOptions.onUpdateTask?.(this.task.id, { categoryId });
    }

    /** 关闭分类下拉浮层（移除元素与 document 监听） */
    private closeCategoryMenu(): void {
        if (this.categoryMenuOutsideHandler) {
            document.removeEventListener('mousedown', this.categoryMenuOutsideHandler, true);
            this.categoryMenuOutsideHandler = undefined;
        }
        if (this.categoryMenuEscapeHandler) {
            document.removeEventListener('keydown', this.categoryMenuEscapeHandler, true);
            this.categoryMenuEscapeHandler = undefined;
        }
        if (this.categoryMenuAnchor?.isConnected) this.categoryMenuAnchor.removeClass('is-open');
        this.categoryMenuAnchor = null;
        this.categoryMenuEl?.remove();
        this.categoryMenuEl = null;
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
            const goalCount = getTaskGoals(child).length;
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
            // 右侧整体切换为选中任务：名称 / 分类 / 描述 / 板块，未提交的内联编辑先行放弃
            this.activeInlineEditAbort?.();
            this.task = next;
            this.sectionHost.reset();
            this.renderRightPane();
            return;
        }
        this.renderSettingPanel();
    }

    /** 取消任务条目选中：清除高亮，右侧回到任务树根任务（面板打开时的任务） */
    private clearTaskSelection(): void {
        this.selectedTaskId = undefined;
        this.treeEl.querySelectorAll('.task-detail-tree-row').forEach((el) => {
            (el as HTMLElement).removeClass('is-selected');
        });
        const rootTask = this.tasks.find((item) => item.id === this.rootTaskId);
        if (rootTask && rootTask.id !== this.task.id) {
            // 右侧切回根任务，未提交的内联编辑先行放弃
            this.activeInlineEditAbort?.();
            this.task = rootTask;
            this.sectionHost.reset();
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
        this.panelOptions.onAddChild?.(name, this.selectedTaskId ?? this.rootTaskId);
        this.hideAddForm();
    }
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
