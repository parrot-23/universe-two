// 任务板块信息面板：基于 FloatingPanel 展示单个任务的全部板块。
// 第一行显示任务名称与任务分类；入口为点击「今日任务」卡片中的任务条目。
// 板块内容由共用 SectionHost 渲染（与任务详情面板保持一致）。
import type { App } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
import { t } from '../../../i18n';
import { SectionHost } from '../../section/section-host';
import type { FloatingPanelOptions } from '../basic/floating-panel';
import { FloatingPanel } from '../basic/floating-panel';

/** 任务板块信息面板配置 */
export interface TaskSectionsPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    app: App;
    /** 按 id 读取任务（每次都从仓库读最新数据） */
    getTask: (taskId: string) => PrototypeTask | undefined;
    /** 读取全量任务（按任务树推导任务文件目录） */
    getTasks?: () => PrototypeTask[];
    /** 读取项目库根目录（任务文件目录按任务树自动绑定，空表示未配置） */
    getTaskLibraryRoot?: () => string;
    /** 分类列表（用于第一行显示任务分类） */
    categories: { id: string; label: string; color?: string }[];
    /** 持久化出口 */
    save: () => Promise<void>;
    /** 点击第一行跳转图标：在任务详情面板中打开该任务 */
    onOpenTaskDetail?: (taskId: string) => void;
}

export class TaskSectionsPanel extends FloatingPanel {
    private readonly sectionsOptions: TaskSectionsPanelOptions;
    /** 当前展示的任务 id */
    private taskId: string | null = null;
    /** 板块宿主（与任务详情面板共用） */
    private readonly sectionHost: SectionHost;

    constructor(options: TaskSectionsPanelOptions) {
        super({
            title: t('panel.taskBoardTitle'),
            width: 460,
            closeOnBlur: true,
            // 任务板块面板需要钉住能力：钉住后点击面板外不关闭
            pinnable: true,
            container: options.container,
            onClose: options.onClose,
        });
        this.sectionsOptions = options;
        this.sectionHost = new SectionHost({
            app: options.app,
            getTask: () => (this.taskId ? options.getTask(this.taskId) : undefined),
            getTasks: options.getTasks,
            getTaskLibraryRoot: options.getTaskLibraryRoot,
            save: options.save,
            container: options.container,
        });
        // 标题栏钉住按钮左侧：跳转到任务详情面板（未提供回调时不显示）
        if (options.onOpenTaskDetail) {
            this.addHeaderAction(
                'square-arrow-up-right',
                t('panel.openTaskDetail'),
                () => {
                    if (this.taskId) this.sectionsOptions.onOpenTaskDetail?.(this.taskId);
                },
                'start',
            );
        }
    }

    /** 打开并展示指定任务 */
    openForTask(taskId: string): void {
        this.taskId = taskId;
        this.sectionHost.reset();
        this.render();
        this.open();
    }

    /** 销毁面板时清理文件编辑面板 */
    override destroy(): void {
        this.sectionHost.destroy();
        super.destroy();
    }

    /** 重绘面板内容 */
    private render(): void {
        const task = this.taskId ? this.sectionsOptions.getTask(this.taskId) : undefined;
        this.setContent((body) => {
            if (!task) {
                body.createDiv({ cls: 'interface-today-empty', text: t('interface.bottomEmpty') });
                return;
            }
            this.renderHead(body, task);
            const hostEl = body.createDiv({ cls: 'task-sections-body' });
            this.sectionHost.render(hostEl);
        });
    }

    /** 第一行：任务名称 + 任务分类；第二行：任务描述（未填写时不占位） */
    private renderHead(body: HTMLElement, task: PrototypeTask): void {
        const head = body.createDiv({ cls: 'task-sections-head' });
        const titleRow = head.createDiv({ cls: 'task-sections-title-row' });
        titleRow.createDiv({ cls: 'task-sections-name', text: task.name });
        const category = task.categoryId
            ? this.sectionsOptions.categories.find((item) => item.id === task.categoryId)
            : undefined;
        const pill = titleRow.createDiv({ cls: 'task-sections-category' });
        const dot = pill.createSpan({ cls: 'task-sections-category-dot' });
        dot.style.background = category?.color ?? '#888888';
        pill.createSpan({
            cls: 'task-sections-category-label',
            text: category?.label ?? t('defaultCategory.uncategorized'),
        });
        const description = (task.description ?? '').trim();
        if (description) {
            head.createDiv({ cls: 'task-sections-description', text: description });
        }
    }
}
