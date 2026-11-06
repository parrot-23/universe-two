// 任务面板：基于 FloatingPanel 的任务添加入口。
// 布局从上到下：第一行输入框 + 类型下拉 + 添加按钮；第二行归属方块（收集篮子 / 待办改进等）；
// 最下方为已有任务的单行列表（主线 / 支线用左侧颜色竖条区分）。
import { setIcon } from 'obsidian';

import type { PrototypeTask } from '../../../datatypes/prototype-task';
import type { TaskExecutionRecord } from '../../../datatypes/task-execution';
import { t } from '../../../i18n';
import {
    getCurrentWeekKey,
    getISOWeek,
    makeDayKeyFromWeek,
    makeWeekKey,
    shiftWeekKey,
    type WeekKey,
} from '../../../shared/plan-data';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 任务类型：主线 / 支线 */
export type TaskPanelTaskType = 'main' | 'side';

/** 提交数据 */
export interface TaskPanelSubmitPayload {
    type: TaskPanelTaskType;
    name: string;
}

/** 任务面板配置 */
export interface TaskPanelOptions extends Omit<FloatingPanelOptions, 'title'> {
    /** 面板标题，默认「任务」 */
    title?: string;
    /** 点击确认后的回调 */
    onSubmit?: (payload: TaskPanelSubmitPayload) => void;
    /** 已有的主线 / 支线任务（用于展示） */
    tasks?: PrototypeTask[];
    /** 点击已有任务条目的回调 */
    onTaskClick?: (task: PrototypeTask) => void;
    /** 读取全部任务（含后代，用于汇总执行时长；缺省时只用当前任务列表） */
    getAllTasks?: () => PrototypeTask[];
    /** 读取全部任务执行记录（缺省时不绘制柱状图数据） */
    getExecutions?: () => TaskExecutionRecord[];
    /** 读取已归档的根任务（查看归档时展示） */
    getArchivedTasks?: () => PrototypeTask[];
    /** 点击「移出归档」的回调（父面板负责写仓库并持久化） */
    onUnarchiveTask?: (taskId: string) => void;
}

/** 归属方块定义（仅展示，不参与选择） */
const TARGETS: { icon: string; labelKey: Parameters<typeof t>[0] }[] = [
    { icon: 'list-checks', labelKey: 'panel.targetChecklist' },
    { icon: 'check-square', labelKey: 'panel.targetFormCheck' },
    { icon: 'target', labelKey: 'panel.targetOkr' },
    { icon: 'file-text', labelKey: 'panel.targetFile' },
];

/** 任务面板 */
export class TaskPanel extends FloatingPanel {
    private panelOptions: TaskPanelOptions;
    private inputEl!: HTMLInputElement;
    private typeSelectEl!: HTMLSelectElement;
    private existingEl!: HTMLElement;
    /** 归属方块行（查看归档时隐藏） */
    private targetsEl!: HTMLElement;
    /** 查看归档按钮 */
    private archiveToggleEl!: HTMLElement;
    /** 归档任务列表（查看归档时显示） */
    private archiveListEl!: HTMLElement;
    /** 是否处于查看归档状态 */
    private archiveViewActive = false;

    constructor(options: TaskPanelOptions = {}) {
        super({
            width: 520,
            ...options,
            title: options.title ?? t('panel.taskPanelTitle'),
        });
        this.panelOptions = options;
        this.renderContent();
    }

    /** 渲染输入区 + 归属方块 + 已有任务列表 */
    private renderContent(): void {
        const body = this.body;
        body.addClass('task-panel');

        // 第一行：任务名称输入 + 类型下拉 + 添加按钮（常显）
        const nameRow = body.createDiv({ cls: 'task-panel-name-row' });
        this.inputEl = nameRow.createEl('input', { cls: 'task-panel-input' });
        this.inputEl.type = 'text';
        this.inputEl.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') this.submit();
        });

        this.typeSelectEl = nameRow.createEl('select', { cls: 'dropdown task-panel-type-select' });
        this.typeSelectEl.createEl('option', { text: t('panel.mainTaskBadge'), value: 'main' });
        this.typeSelectEl.createEl('option', { text: t('panel.sideTaskBadge'), value: 'side' });
        this.typeSelectEl.addEventListener('change', () => this.syncPlaceholder());
        this.syncPlaceholder();

        const addBtn = nameRow.createEl('button', {
            cls: 'mod-cta task-panel-add-btn',
            text: t('panel.addTask'),
        });
        addBtn.addEventListener('click', () => this.submit());

        // 第二行：归属方块（仅展示，压缩高度）；行末尾为「查看归档」按钮
        this.targetsEl = body.createDiv({ cls: 'task-panel-targets' });
        for (const target of TARGETS) {
            const el = this.targetsEl.createDiv({ cls: 'task-panel-target' });
            const iconEl = el.createDiv({ cls: 'task-panel-target-icon' });
            setIcon(iconEl, target.icon);
            el.createDiv({ cls: 'task-panel-target-label', text: t(target.labelKey) });
        }
        this.archiveToggleEl = this.targetsEl.createEl('button', {
            cls: 'task-panel-archive-toggle',
            attr: { type: 'button' },
        });
        setIcon(this.archiveToggleEl.createSpan({ cls: 'task-panel-archive-toggle-icon' }), 'archive');
        this.archiveToggleEl.createSpan({ text: t('panel.viewArchived') });
        this.archiveToggleEl.addEventListener('click', () => this.toggleArchiveView());

        // 已有任务：单行列表
        this.existingEl = body.createDiv({ cls: 'task-panel-existing' });
        this.setTasks(this.panelOptions.tasks ?? []);

        // 归档任务列表：与归属方块 / 已有任务区互斥显示
        this.archiveListEl = body.createDiv({ cls: 'task-panel-archive-list is-hidden' });
    }

    /** 切换 正常视图 / 查看归档：归档列表替换下方区域，切回时刷新任务列表 */
    private toggleArchiveView(): void {
        this.archiveViewActive = !this.archiveViewActive;
        this.archiveToggleEl.toggleClass('is-active', this.archiveViewActive);
        // 归档按钮所在行保留（仅隐藏归属方块），以便再次点击切回
        this.targetsEl.toggleClass('is-archive', this.archiveViewActive);
        this.existingEl.toggleClass('is-hidden', this.archiveViewActive);
        this.archiveListEl.toggleClass('is-hidden', !this.archiveViewActive);
        if (this.archiveViewActive) {
            this.renderArchivedList();
            return;
        }
        // 切回正常视图：重新读取任务列表（期间可能有任务移出归档）
        const all = this.panelOptions.getAllTasks?.();
        this.setTasks(all ? all.filter((task) => !task.parentId) : (this.panelOptions.tasks ?? []));
    }

    /** 渲染归档任务列表：名称 + 描述 + 移出归档按钮 */
    private renderArchivedList(): void {
        this.archiveListEl.empty();
        const archived = this.panelOptions.getArchivedTasks?.() ?? [];
        if (archived.length === 0) {
            this.archiveListEl.createDiv({
                cls: 'task-panel-archive-empty',
                text: t('panel.noArchivedTasks'),
            });
            return;
        }
        const allTasks = this.panelOptions.getAllTasks?.() ?? [];
        // 后代任务索引，用于累计「自身 + 全部后代」的执行时长
        const children = new Map<string, string[]>();
        for (const item of allTasks) {
            if (!item.parentId) continue;
            const list = children.get(item.parentId) ?? [];
            list.push(item.id);
            children.set(item.parentId, list);
        }
        const records = this.panelOptions.getExecutions?.() ?? [];
        for (const task of archived) {
            const el = this.archiveListEl.createDiv({ cls: 'task-panel-archive-item' });
            const main = el.createDiv({ cls: 'task-panel-archive-main' });
            main.createDiv({ cls: 'task-panel-archive-name', text: task.name });
            const hasDescription = Boolean(task.description && task.description.trim());
            main.createDiv({
                cls: `task-panel-archive-desc${hasDescription ? '' : ' is-empty'}`,
                text: hasDescription ? task.description! : t('panel.noDescription'),
            });
            // 总执行时长方块（含全部后代任务累计）
            const subtree = this.collectSubtree(task.id, children, new Set<string>());
            const totalSeconds = records.reduce(
                (sum, record) => (subtree.has(record.taskId) ? sum + record.durationSeconds : sum),
                0,
            );
            const durationEl = el.createDiv({
                cls: 'task-panel-archive-duration',
                text: this.formatHours(totalSeconds / 3600),
            });
            durationEl.setAttribute('title', t('panel.taskTotalDuration'));
            const btn = el.createEl('button', {
                cls: 'task-panel-unarchive-btn',
                text: t('panel.unarchive'),
                attr: { type: 'button' },
            });
            btn.addEventListener('click', (evt) => {
                evt.stopPropagation();
                this.panelOptions.onUnarchiveTask?.(task.id);
            });
        }
    }

    /** 刷新已有任务列表（含最近 8 周执行时长柱状图） */
    setTasks(tasks: PrototypeTask[]): void {
        this.existingEl.empty();
        const allTasks = this.panelOptions.getAllTasks?.() ?? tasks;
        const children = new Map<string, string[]>();
        for (const item of allTasks) {
            if (!item.parentId) continue;
            const list = children.get(item.parentId) ?? [];
            list.push(item.id);
            children.set(item.parentId, list);
        }
        const records = this.panelOptions.getExecutions?.() ?? [];
        const weeks = this.lastWeeks(8);
        // 每行汇总自身 + 全部后代任务的每周时长，再统一纵轴（按 10 小时取整，取所有行最大值）
        const rows = tasks.map((task) => {
            const subtree = this.collectSubtree(task.id, children, new Set<string>());
            return { task, hours: this.weeklyHours(subtree, weeks, records) };
        });
        const maxHours = rows.reduce(
            (max, row) => Math.max(max, ...row.hours),
            0,
        );
        const scaleHours = Math.max(10, Math.ceil(maxHours / 10) * 10);

        for (const { task, hours } of rows) {
            const el = this.existingEl.createDiv({ cls: `task-panel-existing-item is-${task.type}` });

            // 左侧方块：图标 + 任务名称（任务名称提示只挂在名称方块上，避免柱体悬浮时出现）
            const tileEl = el.createDiv({ cls: 'task-panel-task-tile' });
            tileEl.setAttribute('title', task.name);
            const iconEl = tileEl.createDiv({ cls: 'task-panel-task-icon' });
            setIcon(iconEl, task.type === 'main' ? 'star' : 'git-branch');
            tileEl.createDiv({ cls: 'task-panel-task-name', text: task.name });

            // 右侧：左半为任务描述（无描述时显示占位文案），右半为最近 8 周执行时长柱状图
            const bodyEl = el.createDiv({ cls: 'task-panel-task-body' });
            const descWrap = bodyEl.createDiv({ cls: 'task-panel-task-desc-wrap' });
            descWrap.setAttribute('title', task.description?.trim() ? task.description : task.name);
            const hasDescription = Boolean(task.description && task.description.trim());
            descWrap.createDiv({
                cls: `task-panel-task-desc${hasDescription ? '' : ' is-empty'}`,
                text: hasDescription ? task.description! : t('panel.noDescription'),
            });
            this.renderWeekChart(bodyEl, task, hours, weeks, scaleHours);

            if (this.panelOptions.onTaskClick) {
                el.addClass('is-clickable');
                el.addEventListener('click', () => this.panelOptions.onTaskClick?.(task));
            }
        }
    }

    /** 最近 count 周（含本周）的周键与周一日期标签，顺序为左旧右新 */
    private lastWeeks(count: number): { key: WeekKey; label: string }[] {
        const current = getCurrentWeekKey();
        const weeks: { key: WeekKey; label: string }[] = [];
        for (let i = count - 1; i >= 0; i -= 1) {
            const key = shiftWeekKey(current, -i);
            const dayKey = makeDayKeyFromWeek(key, 1);
            weeks.push({ key, label: `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}` });
        }
        return weeks;
    }

    /** 汇总子树任务 id（含自身） */
    private collectSubtree(taskId: string, children: Map<string, string[]>, out: Set<string>): Set<string> {
        if (out.has(taskId)) return out;
        out.add(taskId);
        for (const childId of children.get(taskId) ?? []) this.collectSubtree(childId, children, out);
        return out;
    }

    /** 指定任务集合的每周执行时长（小时） */
    private weeklyHours(
        taskIds: Set<string>,
        weeks: { key: WeekKey }[],
        records: TaskExecutionRecord[],
    ): number[] {
        const index = new Map(weeks.map((week, i) => [week.key, i]));
        const hours = weeks.map(() => 0);
        for (const record of records) {
            if (!taskIds.has(record.taskId)) continue;
            const date = new Date(record.startAt);
            const weekIndex = index.get(makeWeekKey(date.getFullYear(), getISOWeek(date)));
            if (weekIndex === undefined) continue;
            hours[weekIndex] += record.durationSeconds / 3600;
        }
        return hours;
    }

    /** 最近 8 周柱状图：柱子紧贴，统一 y 轴（scaleHours 对应满高）；悬浮时顶部显示每周时长数据行 */
    private renderWeekChart(
        parent: HTMLElement,
        task: PrototypeTask,
        hours: number[],
        weeks: { key: WeekKey; label: string }[],
        scaleHours: number,
    ): void {
        const chart = parent.createDiv({ cls: `task-panel-week-chart is-${task.type}` });

        // 顶部数据行：悬浮整张图表时显示，每格与下方柱体一一对齐，两行分别为周数 / 总时长
        const hoverRow = chart.createDiv({ cls: 'task-panel-week-hover-row' });
        hours.forEach((value, i) => {
            const cell = hoverRow.createDiv({ cls: 'task-panel-week-hover-cell' });
            cell.createDiv({ cls: 'task-panel-week-hover-week', text: weeks[i].label });
            cell.createDiv({ cls: 'task-panel-week-hover-hours', text: this.formatHours(value) });
        });

        const bars = chart.createDiv({ cls: 'task-panel-week-bars' });
        hours.forEach((value, i) => {
            const bar = bars.createDiv({ cls: 'task-panel-week-bar' });
            const ratio = scaleHours > 0 ? Math.min(1, value / scaleHours) : 0;
            bar.style.height = `${Math.round(ratio * 100)}%`;
            if (value <= 0) bar.addClass('is-empty');
            bar.setAttribute('aria-label', t('panel.taskWeekDurationTip', {
                week: weeks[i].label,
                hours: this.formatHours(value),
            }));
        });
    }

    /** 时长文本：不足 10 小时保留一位小数 */
    private formatHours(hours: number): string {
        if (hours <= 0) return '0h';
        return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
    }

    /** 按下拉选中的类型更新占位文案 */
    private syncPlaceholder(): void {
        this.inputEl.placeholder = this.typeSelectEl.value === 'side'
            ? t('panel.sideTaskName')
            : t('panel.mainTaskName');
    }

    /** 确认提交 */
    private submit(): void {
        const name = this.inputEl.value.trim();
        if (!name) {
            this.inputEl.focus();
            return;
        }
        this.panelOptions.onSubmit?.({
            type: this.typeSelectEl.value === 'side' ? 'side' : 'main',
            name,
        });
        this.inputEl.value = '';
        this.close();
    }
}
