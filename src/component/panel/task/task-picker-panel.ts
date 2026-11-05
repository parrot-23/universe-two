// 任务选择面板：基于 FloatingPanel，顶部搜索框 + 根任务下拉 + 后代任务树，选中后点「确定」回传任务 id。
// 支持多选（multiple）与限定候选范围（scopeTaskId，用于「绑定子任务」等只在本任务后代里选的场景）。
import { setIcon } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 任务选择面板配置 */
export interface TaskPickerPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「选择任务」 */
    title?: string;
    /** 任务数据源（每次打开时重新读取） */
    getTasks: () => PrototypeTask[];
    /** 限定候选范围为该任务的全部后代（此时隐藏根任务下拉，列表与搜索都只在该范围内） */
    scopeTaskId?: string;
    /** 是否多选，默认单选 */
    multiple?: boolean;
    /** 打开时预选的任务 id（多选时传入已绑定项） */
    initialSelectedIds?: string[];
    /** 点「确定」后的回调（单选时数组长度为 1，多选且全部取消时为空数组） */
    onSelect: (taskIds: string[]) => void;
}

/** 任务选择面板 */
export class TaskPickerPanel extends FloatingPanel {
    private searchEl!: HTMLInputElement;
    private rootSelectEl!: HTMLSelectElement;
    private treeEl!: HTMLElement;
    private confirmButton!: HTMLButtonElement;

    /** 下拉选中的根任务 id */
    private rootTaskId: string | undefined;
    /** 当前选中的任务 id 集合 */
    private selectedIds = new Set<string>();

    constructor(private readonly pickerOptions: TaskPickerPanelOptions) {
        super({
            width: 360,
            title: pickerOptions.title ?? t('panel.taskPickerTitle'),
            closeOnBlur: true,
            ...pickerOptions,
        });
        this.body.addClass('task-picker-panel');
        this.renderLayout();
    }

    /** 每次打开时重置搜索、恢复预选，并刷新任务数据 */
    override open(): void {
        this.searchEl.value = '';
        this.selectedIds = new Set(this.pickerOptions.initialSelectedIds ?? []);
        this.refreshRootSelect();
        super.open();
    }

    private renderLayout(): void {
        this.searchEl = this.body.createEl('input', {
            cls: 'task-picker-search',
            attr: { type: 'text', placeholder: t('panel.taskPickerSearch') },
        });
        this.searchEl.addEventListener('input', () => this.renderTree());

        this.rootSelectEl = this.body.createEl('select', { cls: 'dropdown task-picker-root' });
        this.rootSelectEl.addEventListener('change', () => {
            this.rootTaskId = this.rootSelectEl.value || undefined;
            this.selectedIds.clear();
            this.updateSelectionStyles();
            this.renderTree();
        });
        // 限定范围时不需要根任务下拉
        if (this.pickerOptions.scopeTaskId) this.rootSelectEl.style.display = 'none';

        this.treeEl = this.body.createDiv({ cls: 'task-picker-tree' });
        this.treeEl.addEventListener('click', (evt) => {
            const row = (evt.target as HTMLElement).closest('.task-detail-tree-row') as HTMLElement | null;
            const taskId = row?.dataset.taskId;
            if (taskId) this.selectTask(taskId);
        });

        const footer = this.body.createDiv({ cls: 'task-picker-footer' });
        const cancelButton = footer.createEl('button', {
            cls: 'task-picker-button',
            text: t('panel.taskPickerCancel'),
        });
        cancelButton.addEventListener('click', () => this.close());
        this.confirmButton = footer.createEl('button', {
            cls: 'task-picker-button mod-cta',
            text: t('panel.taskPickerConfirm'),
        });
        this.confirmButton.addEventListener('click', () => {
            const taskIds = Array.from(this.selectedIds);
            if (!this.pickerOptions.multiple && taskIds.length === 0) return;
            this.close();
            this.pickerOptions.onSelect(taskIds);
        });
        this.updateConfirmState();
    }

    /** 重建根任务下拉（顶层任务 = 无父任务的主线 / 支线） */
    private refreshRootSelect(): void {
        const scopeTaskId = this.pickerOptions.scopeTaskId;
        if (scopeTaskId) {
            this.rootTaskId = scopeTaskId;
            this.updateConfirmState();
            this.renderTree();
            return;
        }
        const roots = this.pickerOptions.getTasks().filter((task) => !task.parentId);
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
        this.updateConfirmState();
        this.renderTree();
    }

    /** 渲染任务树：搜索时全局平铺匹配结果，否则展示下拉选中根任务的后代 */
    private renderTree(): void {
        this.treeEl.empty();
        const tasks = this.pickerOptions.getTasks();
        const keyword = this.searchEl.value.trim().toLowerCase();
        const scope = this.scopeIds();

        if (keyword) {
            const byId = new Map(tasks.map((task) => [task.id, task]));
            const matches = tasks.filter((task) => (!scope || scope.has(task.id))
                && task.name.toLowerCase().includes(keyword));
            if (matches.length === 0) {
                this.treeEl.createDiv({ cls: 'interface-today-empty', text: t('panel.taskPickerEmpty') });
                return;
            }
            for (const task of matches) {
                this.createTaskRow(this.treeEl, task, this.taskPath(task, byId));
            }
            return;
        }

        if (!this.rootTaskId) {
            this.treeEl.createDiv({ cls: 'interface-today-empty', text: t('panel.planNoTask') });
            return;
        }
        this.renderTreeNodes(this.treeEl, this.rootTaskId, 0);
        if (!this.treeEl.firstChild) {
            this.treeEl.createDiv({ cls: 'interface-today-empty', text: t('panel.taskPickerEmpty') });
        }
    }

    /** 限定范围内的任务 id 集合（未限定范围时返回 null） */
    private scopeIds(): Set<string> | null {
        const scopeTaskId = this.pickerOptions.scopeTaskId;
        if (!scopeTaskId) return null;
        const byParent = new Map<string, PrototypeTask[]>();
        for (const task of this.pickerOptions.getTasks()) {
            if (!task.parentId) continue;
            const siblings = byParent.get(task.parentId) ?? [];
            siblings.push(task);
            byParent.set(task.parentId, siblings);
        }
        const ids = new Set<string>();
        const walk = (parentId: string): void => {
            for (const child of byParent.get(parentId) ?? []) {
                ids.add(child.id);
                walk(child.id);
            }
        };
        walk(scopeTaskId);
        return ids;
    }

    private renderTreeNodes(parentEl: HTMLElement, parentId: string, depth: number): void {
        const children = this.pickerOptions.getTasks().filter((task) => task.parentId === parentId);
        for (const child of children) {
            const row = this.createTaskRow(parentEl, child);
            row.style.marginLeft = `${depth * 14}px`;
            this.renderTreeNodes(parentEl, child.id, depth + 1);
        }
    }

    /** 创建一条任务行（与习惯面板左侧任务树同一套样式） */
    private createTaskRow(parentEl: HTMLElement, task: PrototypeTask, label?: string): HTMLElement {
        const row = parentEl.createDiv({ cls: 'task-detail-tree-row' });
        row.dataset.taskId = task.id;
        row.toggleClass('is-selected', this.selectedIds.has(task.id));
        const iconEl = row.createSpan({ cls: 'task-detail-tree-icon' });
        setIcon(iconEl, 'git-branch');
        row.createSpan({ cls: 'task-detail-tree-label', text: label ?? task.name });
        return row;
    }

    /** 任务路径：父级任务名以「 / 」连接，搜索结果中用于区分同名任务 */
    private taskPath(task: PrototypeTask, byId: Map<string, PrototypeTask>): string {
        const names = [task.name];
        let parentId = task.parentId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = byId.get(parentId);
            if (!parent) break;
            names.unshift(parent.name);
            parentId = parent.parentId;
        }
        return names.join(' / ');
    }

    /** 选中任务：单选时替换选中项，多选时切换 */
    private selectTask(taskId: string): void {
        if (this.pickerOptions.multiple) {
            if (this.selectedIds.has(taskId)) this.selectedIds.delete(taskId);
            else this.selectedIds.add(taskId);
        } else {
            this.selectedIds = new Set([taskId]);
        }
        this.updateSelectionStyles();
    }

    private updateSelectionStyles(): void {
        this.treeEl.querySelectorAll('.task-detail-tree-row').forEach((el) => {
            const row = el as HTMLElement;
            row.toggleClass('is-selected', this.selectedIds.has(row.dataset.taskId ?? ''));
        });
        this.updateConfirmState();
    }

    private updateConfirmState(): void {
        // 多选允许一个都不选（表示清空绑定），单选必须选中才能确定
        this.confirmButton.disabled = this.pickerOptions.multiple ? false : this.selectedIds.size === 0;
    }
}
