// 功能面板：顶部两级菜单（一级：任务 / 板块 / 计划 / 检查 / 收集，二级：各具体功能），内容区直接嵌入对应功能面板。
// 无二级菜单的一级组（如「检查」）用 directItem 指定直接嵌入的面板，二级行整体隐藏。
// 嵌入模式复用各面板实例（FloatingPanel.embed），切换菜单时关闭并退回原浮层容器；「任务详情」默认打开第一个根任务。
import { setIcon } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 一级菜单标识 */
export type FunctionGroupId = 'task' | 'section' | 'plan' | 'check' | 'collect';

/** 二级菜单（功能）标识 */
export type FunctionItemId =
    | 'task'
    | 'taskDetail'
    | 'habit'
    | 'timeBox'
    | 'planAnnual'
    | 'planWeek'
    | 'check'
    | 'collect'
    | 'gallery';

interface FunctionItem {
    id: FunctionItemId;
    label: string;
    icon: string;
}

interface FunctionGroup {
    id: FunctionGroupId;
    label: string;
    /** 二级菜单；无二级菜单时为空并改用 directItem */
    items: FunctionItem[];
    /** 无二级菜单的一级组：直接嵌入的面板 */
    directItem?: FunctionItemId;
}

/** 功能面板配置 */
export interface FunctionPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「功能」 */
    title?: string;
    /** 根任务列表（「任务详情」入口使用） */
    getTasks: () => PrototypeTask[];
    /** 按功能项解析（必要时创建）对应面板实例；任务详情需要传入选中任务 */
    resolvePanel: (item: FunctionItemId, task?: PrototypeTask) => FloatingPanel | null;
}

/** 功能面板 */
export class FunctionPanel extends FloatingPanel {
    private readonly panelOptions: FunctionPanelOptions;
    private readonly groups: FunctionGroup[];
    private activeGroupId: FunctionGroupId = 'task';
    private activeItemId: FunctionItemId = 'task';
    private groupTabsEl!: HTMLElement;
    private itemTabsEl!: HTMLElement;
    private contentEl!: HTMLElement;
    /** 当前嵌入的功能面板 */
    private embeddedPanel: FloatingPanel | null = null;
    /** 任务详情当前选中的任务（为空时显示任务列表） */
    private detailTask: PrototypeTask | undefined;

    constructor(options: FunctionPanelOptions) {
        super({ ...options, title: options.title ?? t('interface.functionPanel'), width: 980 });
        this.panelOptions = options;
        this.groups = [
            {
                id: 'task',
                label: t('interface.task'),
                items: [
                    { id: 'task', label: t('interface.task'), icon: 'list-todo' },
                    { id: 'taskDetail', label: t('panel.taskDetailTitle'), icon: 'file-text' },
                ],
            },
            {
                id: 'section',
                label: t('interface.functionGroupSection'),
                items: [{ id: 'habit', label: t('interface.habit'), icon: 'repeat' }],
            },
            {
                id: 'plan',
                label: t('interface.functionGroupPlan'),
                items: [
                    { id: 'planAnnual', label: t('interface.planAnnual'), icon: 'calendar-range' },
                    { id: 'planWeek', label: t('interface.planWeek'), icon: 'calendar-check' },
                    { id: 'timeBox', label: t('interface.timeBox'), icon: 'calendar-clock' },
                ],
            },
            {
                id: 'check',
                label: t('interface.check'),
                items: [],
                directItem: 'check',
            },
            {
                id: 'collect',
                label: t('interface.collect'),
                items: [
                    { id: 'collect', label: t('interface.collect'), icon: 'inbox' },
                    { id: 'gallery', label: t('interface.gallery'), icon: 'image' },
                ],
            },
        ];
        this.setContent((body) => this.renderBody(body));
    }

    /** 打开面板时按当前菜单渲染嵌入内容（构造阶段只搭菜单，避免未显示时激活面板定时器） */
    override open(): void {
        super.open();
        this.renderContent();
    }

    /** 关闭面板时把嵌入的功能面板关闭并退回浮层容器 */
    override close(): void {
        this.unmountPanel();
        super.close();
    }

    override destroy(): void {
        this.unmountPanel();
        super.destroy();
    }

    /** 渲染面板主体：两级菜单 + 内容区 */
    private renderBody(body: HTMLElement): void {
        body.addClass('interface-function-panel');
        const menu = body.createDiv({ cls: 'interface-function-menu' });
        this.groupTabsEl = menu.createDiv({ cls: 'interface-function-group-tabs' });
        this.itemTabsEl = menu.createDiv({ cls: 'interface-function-item-tabs' });
        this.contentEl = body.createDiv({ cls: 'interface-function-content' });
        this.renderMenu();
    }

    /** 当前一级菜单 */
    private activeGroup(): FunctionGroup {
        return this.groups.find((group) => group.id === this.activeGroupId) ?? this.groups[0];
    }

    /** 当前二级菜单；无二级菜单的一级组直接返回其嵌入面板 */
    private activeItem(): FunctionItem {
        const group = this.activeGroup();
        if (group.directItem) return { id: group.directItem, label: group.label, icon: 'clipboard-check' };
        return group.items.find((item) => item.id === this.activeItemId) ?? group.items[0];
    }

    /** 渲染两级菜单（一级切换时二级默认选中第一项） */
    private renderMenu(): void {
        this.groupTabsEl.empty();
        for (const group of this.groups) {
            const btn = this.groupTabsEl.createEl('button', {
                cls: 'interface-function-group-tab',
                text: group.label,
                attr: { type: 'button' },
            });
            btn.toggleClass('is-active', group.id === this.activeGroupId);
            btn.onclick = () => {
                if (this.activeGroupId === group.id) return;
                this.activeGroupId = group.id;
                this.activeItemId = group.directItem ?? group.items[0].id;
                this.detailTask = undefined;
                this.renderMenu();
                this.renderContent();
            };
        }

        const items = this.activeGroup().items;
        // 无二级菜单的一级组：整行隐藏，内容区直接嵌入面板
        this.itemTabsEl.toggleClass('is-hidden', items.length === 0);
        this.itemTabsEl.empty();
        for (const item of items) {
            const btn = this.itemTabsEl.createEl('button', {
                cls: 'interface-function-item-tab',
                attr: { type: 'button' },
            });
            setIcon(btn.createSpan({ cls: 'interface-function-item-tab-icon' }), item.icon);
            btn.createSpan({ cls: 'interface-function-item-tab-text', text: item.label });
            btn.toggleClass('is-active', item.id === this.activeItemId);
            btn.onclick = () => {
                if (this.activeItemId === item.id) return;
                this.activeItemId = item.id;
                this.detailTask = undefined;
                this.renderMenu();
                this.renderContent();
            };
        }
    }

    /** 渲染内容区：普通功能直接嵌入面板，「任务详情」默认打开第一个根任务 */
    private renderContent(): void {
        if (!this.isOpen) return;
        this.unmountPanel();
        this.contentEl.empty();
        const item = this.activeItem();
        if (item.id === 'taskDetail') {
            const tasks = this.panelOptions.getTasks();
            if (tasks.length === 0) {
                this.contentEl.createDiv({ cls: 'interface-function-hint', text: t('interface.functionNoTask') });
                return;
            }
            // 未选中时默认第一个根任务；已选中的任务被删除时同样回退到第一个
            if (!this.detailTask || !tasks.some((task) => task.id === this.detailTask?.id)) {
                this.detailTask = tasks[0];
            }
        }
        const host = this.contentEl.createDiv({ cls: 'interface-function-embed-host' });
        this.embedPanel(item.id, this.detailTask, host);
    }

    /** 把功能面板嵌入内容区（无对应实例时保持空白） */
    private embedPanel(item: FunctionItemId, task: PrototypeTask | undefined, host: HTMLElement): void {
        const panel = this.panelOptions.resolvePanel(item, task);
        if (!panel) return;
        panel.embed(host);
        panel.open();
        this.embeddedPanel = panel;
    }

    /** 外部要把当前嵌入的面板作为浮层打开时调用：退出嵌入并清空内容区 */
    releasePanel(panel: FloatingPanel): void {
        if (this.embeddedPanel !== panel) {
            panel.close();
            panel.unembed();
            return;
        }
        this.embeddedPanel = null;
        panel.close();
        panel.unembed();
        this.contentEl.empty();
        this.contentEl.createDiv({
            cls: 'interface-function-hint',
            text: t('interface.functionOpenedAsFloat'),
        });
    }

    /** 关闭并退回当前嵌入的功能面板 */
    private unmountPanel(): void {
        const panel = this.embeddedPanel;
        this.embeddedPanel = null;
        if (!panel) return;
        panel.close();
        panel.unembed();
    }
}
