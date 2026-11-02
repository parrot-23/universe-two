// 目标清单视图：嵌入任务详情面板「目标」选项卡。
// 结构：输入行（输入框 + 新建按钮）+ 目标条目列表。
// 条目两行：第一行名称 + 悬停操作图标，第二行展示绑定的子任务与截止日期。
import { setIcon } from 'obsidian';

import type { PrototypeTask, TaskGoalEntry } from '../../../datatypes/prototype-task';
import { getLang, t } from '../../../i18n';
import {
    getISOWeek,
    makeDayKeyFromWeek,
    makeWeekKey,
    parseWeekKey,
} from '../../../shared/plan-data';
import { applyThemeColors, getCurrentThemeColors } from '../../../themestory/theme-colors';
import { DatePickerPopover } from '../basic/date-picker-popover';
import { TaskPickerPanel } from './task-picker-panel';

/** 周区间重叠时每层右移的像素 */
const OVERLAP_INDENT = 20;

/** 目标清单视图配置 */
export interface GoalListViewOptions {
    /** 当前任务（直接读写其 goals 字段） */
    task: PrototypeTask;
    /** 全部任务数据源（解析已绑定子任务、提供可绑定的后代候选） */
    getTasks: () => PrototypeTask[];
    /** 数据保存回调（增删改后持久化） */
    save: () => Promise<void>;
    /** 目标变更回调（父面板据此刷新目标方块） */
    onChanged?: () => void;
}

/** 目标清单视图 */
export class GoalListView {
    private readonly container: HTMLElement;
    private readonly task: PrototypeTask;
    private readonly getTasks: () => PrototypeTask[];
    private readonly save: () => Promise<void>;
    private readonly onChanged?: () => void;
    /** 目标条目列表容器 */
    private listEl!: HTMLElement;
    /** 左右两列高度对齐的监听（重绘时先断开，避免监听已移除的节点） */
    private alignObserver: ResizeObserver | null = null;

    constructor(container: HTMLElement, options: GoalListViewOptions) {
        this.container = container;
        this.task = options.task;
        this.getTasks = options.getTasks;
        this.save = options.save;
        this.onChanged = options.onChanged;
        this.container.addClass('goal-list-view');
        this.render();
    }

    /** 渲染整个视图 */
    private render(): void {
        this.alignObserver?.disconnect();
        this.alignObserver = null;
        this.container.empty();

        // 第一行：输入框 + 新建按钮
        const inputRow = this.container.createDiv({ cls: 'goal-list-input-row' });
        const input = inputRow.createEl('input', { cls: 'goal-list-input' });
        input.type = 'text';
        input.placeholder = t('panel.goalAddPlaceholder');
        const addBtn = inputRow.createEl('button', {
            cls: 'goal-list-add-btn',
            attr: { type: 'button', 'aria-label': t('panel.goalListTitle') },
        });
        setIcon(addBtn, 'plus');
        const submit = (): void => void this.addGoal(input);
        addBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') submit();
        });

        // 第二行起：分成两个独立方框
        // 上方方框：未分配周数的目标；下方方框：按周数排列的目标（左列周卡片 + 右列目标行）
        const goals = this.task.goals ?? [];
        if (goals.length === 0) {
            this.container.createDiv({ cls: 'goal-list-empty', text: t('panel.goalEmpty') });
            return;
        }

        // 排序：未分配周数的排最上面；其余按起始周、结束周从早到晚
        const ordered = [...goals].sort((a, b) => {
            const aAssigned = Boolean(a.startWeek);
            const bAssigned = Boolean(b.startWeek);
            if (aAssigned !== bAssigned) return aAssigned ? 1 : -1;
            if (!aAssigned) return 0;
            const aStart = a.startWeek ?? '';
            const bStart = b.startWeek ?? '';
            if (aStart !== bStart) return aStart < bStart ? -1 : 1;
            const aEnd = a.endWeek ?? aStart;
            const bEnd = b.endWeek ?? bStart;
            if (aEnd !== bEnd) return aEnd < bEnd ? -1 : 1;
            return 0;
        });

        const unassigned = ordered.filter((goal) => !goal.startWeek);
        const assigned = ordered.filter((goal) => Boolean(goal.startWeek));

        // 上方方框：未分配目标（左侧「未分配」卡片 + 右侧目标行）
        if (unassigned.length > 0) {
            const box = this.container.createDiv({ cls: 'goal-list-box is-unassigned' });
            const weekCol = box.createDiv({ cls: 'goal-list-week-col' });
            const rowCol = box.createDiv({ cls: 'goal-list-row-col' });
            for (let i = 0; i < unassigned.length; i += 1) {
                const card = weekCol.createDiv({ cls: 'goal-list-week-card is-unassigned' });
                card.createSpan({ cls: 'goal-list-week-card-label', text: t('panel.goalWeekUnassigned') });
            }
            this.listEl = rowCol;
            for (const goal of unassigned) this.renderRow(goal, 0);
        }

        // 下方方框：按周数排列的目标
        if (assigned.length > 0) {
            const box = this.container.createDiv({ cls: 'goal-list-box' });
            const weekCol = box.createDiv({ cls: 'goal-list-week-col' });
            const rowCol = box.createDiv({ cls: 'goal-list-row-col' });
            this.listEl = rowCol;

            // 左列周数卡片：所有涉及的周（去重、按时间升序）
            const weekKeys = new Set<string>();
            for (const goal of assigned) {
                if (goal.startWeek) weekKeys.add(goal.startWeek);
                if (goal.endWeek) weekKeys.add(goal.endWeek);
            }
            for (const weekKey of Array.from(weekKeys).sort()) {
                this.renderWeekCard(weekCol, weekKey);
            }

            // 右列目标行：与已排布目标周区间有交集时，按重叠数量累加右移
            const placed: { start: string; end: string }[] = [];
            for (const goal of assigned) {
                let indent = 0;
                const start = goal.startWeek ?? '';
                const end = goal.endWeek ?? start;
                for (const item of placed) {
                    if (start <= item.end && item.start <= end) indent += 1;
                }
                placed.push({ start, end });
                this.renderRow(goal, indent);
            }
        }
    }

    /** 渲染单个目标行（右列）：第一行名称 + 操作图标，第二行子任务与截止日期 */
    private renderRow(goal: TaskGoalEntry, indent = 0): HTMLElement {
        const row = this.listEl.createDiv({ cls: 'goal-list-item' });
        row.toggleClass('is-done', goal.done === true);
        // 未分配目标行固定高度，内容多时行内滚动，避免撑高整行挤占下方
        if (!goal.startWeek) row.addClass('is-unassigned');
        // 周区间重叠时整体右移，宽度同步减少
        if (indent > 0) {
            row.style.marginLeft = `${indent * OVERLAP_INDENT}px`;
            row.style.width = `calc(100% - ${indent * OVERLAP_INDENT}px)`;
        }

        const content = row.createDiv({ cls: 'goal-list-item-content' });
        const main = content.createDiv({ cls: 'goal-list-item-main' });
        const iconEl = main.createSpan({ cls: 'goal-list-item-icon' });
        setIcon(iconEl, 'target');
        const nameEl = main.createSpan({ cls: 'goal-list-item-name', text: goal.text });

        // 跨周时：从 target 图标位置向下延伸一条竖线，终点落在结束周卡片中心
        this.renderWeekSpanLine(row, iconEl, goal);

        const boundTasks = this.boundTasks(goal);

        // 名称末尾的编辑图标：悬浮条目时显示，点击后原地编辑名称
        const editBtn = this.createAction(main, 'pencil', t('panel.goalEditName'), false, () => {
            this.startRename(goal, nameEl);
        });
        editBtn.addClass('goal-list-item-edit-btn');

        // 悬停时显示：分配周数 / 设置截止时间 / 绑定子任务 / 删除
        const actions = main.createDiv({ cls: 'goal-list-item-actions' });
        this.createAction(
            actions,
            'calendar-range',
            t('panel.goalAssignWeek'),
            Boolean(goal.startWeek || goal.endWeek),
            (button) => this.openWeekAssign(goal, button),
        );
        this.createAction(actions, 'calendar', t('panel.checklistSetDue'), false, (button) => {
            this.openDuePicker(goal, button);
        });
        this.createAction(actions, 'link-2', t('panel.goalBindSubtask'), boundTasks.length > 0, () => {
            this.openSubtaskPicker(goal);
        });
        // 完成标记：点击切换完成状态，已完成的图标常显
        const done = goal.done === true;
        const doneBtn = this.createAction(
            actions,
            done ? 'circle-check' : 'circle',
            done ? t('panel.goalMarkUndone') : t('panel.goalMarkDone'),
            done,
            () => void this.toggleDone(goal),
        );
        doneBtn.toggleClass('goal-list-item-done-btn', true);
        this.createAction(actions, 'x', t('common.delete'), false, () => void this.removeGoal(goal.id));

        // 第二行：绑定的子任务标签 + 末尾的截止日期（都为空时不占位）
        if (boundTasks.length === 0 && !goal.dueDate) return row;
        const meta = content.createDiv({ cls: 'goal-list-item-meta' });
        for (const task of boundTasks) {
            const tag = meta.createSpan({ cls: 'goal-list-item-subtask', attr: { title: task.name } });
            setIcon(tag.createSpan({ cls: 'goal-list-item-subtask-icon' }), 'git-branch');
            tag.createSpan({ cls: 'goal-list-item-subtask-name', text: task.name });
        }
        if (goal.dueDate) this.renderDueTag(meta, goal);
        return row;
    }

    /** 左列单个周数卡片：周数 + 该周周一日期 */
    private renderWeekCard(parentEl: HTMLElement, weekKey: string): HTMLElement {
        const card = parentEl.createDiv({ cls: 'goal-list-week-card' });
        card.dataset.weekKey = weekKey;
        const { week } = parseWeekKey(weekKey);
        card.createSpan({ cls: 'goal-list-week-card-label', text: `W${String(week).padStart(2, '0')}` });
        const dayKey = makeDayKeyFromWeek(weekKey, 1);
        card.createSpan({
            cls: 'goal-list-week-card-date',
            text: `${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))}`,
        });
        return card;
    }

    /**
     * 跨周竖线：从 target 图标位置向下延伸，终点落在结束周卡片的垂直中心，并在终点画一个圆点。
     * 竖线与圆点均绝对定位绘制在目标行容器内，不参与布局，因此不会改变目标行方框的高度。
     */
    private renderWeekSpanLine(row: HTMLElement, iconEl: HTMLElement, goal: TaskGoalEntry): void {
        const startWeek = goal.startWeek;
        const endWeek = goal.endWeek;
        if (!startWeek || !endWeek || endWeek === startWeek) return;

        const line = row.createDiv({ cls: 'goal-list-item-week-line' });
        const dot = row.createDiv({ cls: 'goal-list-item-week-dot' });
        // 等布局完成后按图标与结束周卡片的实际位置计算竖线范围
        window.requestAnimationFrame(() => {
            if (!line.isConnected) return;
            const endCard = this.container.querySelector<HTMLElement>(
                `.goal-list-week-card[data-week-key="${endWeek}"]`,
            );
            if (!endCard) return;
            const rowRect = row.getBoundingClientRect();
            const iconRect = iconEl.getBoundingClientRect();
            const endRect = endCard.getBoundingClientRect();
            const left = iconRect.left - rowRect.left + iconRect.width / 2;
            const top = iconRect.top - rowRect.top + iconRect.height / 2;
            // 终点：结束周卡片的垂直中心
            const bottom = endRect.top - rowRect.top + endRect.height / 2;
            line.style.left = `${left}px`;
            line.style.top = `${top}px`;
            line.style.height = `${Math.max(bottom - top, 0)}px`;
            dot.style.left = `${left}px`;
            dot.style.top = `${bottom}px`;
        });
    }

    /** 截止日期标签：悬浮时末尾出现清除按钮 */
    private renderDueTag(parentEl: HTMLElement, goal: TaskGoalEntry): void {
        const due = parentEl.createSpan({ cls: 'goal-list-item-due' });
        due.createSpan({ text: this.formatDue(goal.dueDate ?? '') });
        const clearBtn = due.createSpan({
            cls: 'goal-list-item-due-clear',
            text: '×',
            attr: { role: 'button', 'aria-label': t('panel.checklistDueClear') },
        });
        clearBtn.addEventListener('click', (evt) => {
            evt.stopPropagation();
            delete goal.dueDate;
            void this.save().then(() => {
                this.onChanged?.();
                this.render();
            });
        });
    }

    /** 条目末尾的操作图标按钮 */
    private createAction(
        parentEl: HTMLElement,
        icon: string,
        label: string,
        active: boolean,
        onClick: (button: HTMLButtonElement) => void,
    ): HTMLButtonElement {
        const button = parentEl.createEl('button', {
            cls: 'goal-list-item-action',
            attr: { type: 'button', 'aria-label': label, title: label },
        });
        button.toggleClass('is-active', active);
        setIcon(button, icon);
        button.addEventListener('click', (evt) => {
            evt.stopPropagation();
            onClick(button);
        });
        return button;
    }

    /** 绑定子任务：复用任务选择面板（多选，限定在当前任务的后代里） */
    private openSubtaskPicker(goal: TaskGoalEntry): void {
        const picker: TaskPickerPanel = new TaskPickerPanel({
            title: t('panel.goalBindSubtask'),
            getTasks: this.getTasks,
            scopeTaskId: this.task.id,
            multiple: true,
            initialSelectedIds: (goal.subtaskIds ?? []).filter((id) => this.findTask(id)),
            onClose: () => picker.destroy(),
            onSelect: (taskIds) => {
                if (taskIds.length > 0) goal.subtaskIds = taskIds;
                else delete goal.subtaskIds;
                void this.save().then(() => {
                    this.onChanged?.();
                    this.render();
                });
            },
        });
        picker.open();
    }

    /** 分配周数：在图标下方弹出小面板，选择起始周 / 结束周 */
    private openWeekAssign(goal: TaskGoalEntry, anchor: HTMLElement): void {
        // 关闭已存在的面板，避免重复叠加
        document.querySelector('.goal-week-assign-popover')?.remove();

        const popover = document.body.createDiv({ cls: 'goal-week-assign-popover' });
        applyThemeColors(popover, getCurrentThemeColors());

        // 全年所有周（当前年份 W01 ~ W52/53）
        const year = new Date().getFullYear();
        const weekOptions = this.buildYearWeekOptions(year);

        const startRow = popover.createDiv({ cls: 'goal-week-assign-row' });
        startRow.createSpan({ cls: 'goal-week-assign-label', text: t('panel.goalWeekStart') });
        const startSelect = startRow.createEl('select', { cls: 'dropdown goal-week-assign-select' });
        for (const option of weekOptions) {
            startSelect.createEl('option', { text: option.label, value: option.value });
        }
        startSelect.value = goal.startWeek ?? weekOptions[0]?.value ?? '';

        const endRow = popover.createDiv({ cls: 'goal-week-assign-row' });
        endRow.createSpan({ cls: 'goal-week-assign-label', text: t('panel.goalWeekEnd') });
        const endSelect = endRow.createEl('select', { cls: 'dropdown goal-week-assign-select' });
        for (const option of weekOptions) {
            endSelect.createEl('option', { text: option.label, value: option.value });
        }
        endSelect.value = goal.endWeek ?? goal.startWeek ?? weekOptions[0]?.value ?? '';

        // 起始周变化时，结束周不早于起始周
        startSelect.addEventListener('change', () => {
            if (endSelect.value < startSelect.value) endSelect.value = startSelect.value;
        });

        const footer = popover.createDiv({ cls: 'goal-week-assign-footer' });
        const clearBtn = footer.createEl('button', {
            cls: 'goal-week-assign-btn',
            text: t('panel.goalWeekClear'),
            attr: { type: 'button' },
        });
        const confirmBtn = footer.createEl('button', {
            cls: 'goal-week-assign-btn mod-cta',
            text: t('common.confirm'),
            attr: { type: 'button' },
        });

        const close = (): void => {
            document.removeEventListener('mousedown', onOutside, true);
            document.removeEventListener('keydown', onKey, true);
            popover.remove();
        };
        const onOutside = (evt: MouseEvent): void => {
            const target = evt.target as Node | null;
            if (target && popover.contains(target)) return;
            close();
        };
        const onKey = (evt: KeyboardEvent): void => {
            if (evt.key === 'Escape') close();
        };

        clearBtn.addEventListener('click', () => {
            delete goal.startWeek;
            delete goal.endWeek;
            close();
            void this.save().then(() => {
                this.onChanged?.();
                this.render();
            });
        });
        confirmBtn.addEventListener('click', () => {
            goal.startWeek = startSelect.value;
            goal.endWeek = endSelect.value;
            close();
            void this.save().then(() => {
                this.onChanged?.();
                this.render();
            });
        });

        // 贴着图标下方定位
        const rect = anchor.getBoundingClientRect();
        popover.style.top = `${Math.round(rect.bottom + 4)}px`;
        popover.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - 240)))}px`;

        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
    }

    /** 生成某年全部 ISO 周的下拉选项（W01 ~ W52/53） */
    private buildYearWeekOptions(year: number): { value: string; label: string }[] {
        // 12 月 28 日必定属于该年最后一周，用它反推该年周数
        const weekCount = getISOWeek(new Date(year, 11, 28));
        const options: { value: string; label: string }[] = [];
        for (let week = 1; week <= weekCount; week += 1) {
            const weekKey = makeWeekKey(year, week);
            const dayKey = makeDayKeyFromWeek(weekKey, 1);
            options.push({
                value: weekKey,
                label: `W${String(week).padStart(2, '0')} (${Number(dayKey.slice(5, 7))}/${Number(dayKey.slice(8, 10))})`,
            });
        }
        return options;
    }

    /** 设置截止时间：在图标下方弹出自绘日历，不额外占一行 */
    private openDuePicker(goal: TaskGoalEntry, anchor: HTMLElement): void {
        const popover: DatePickerPopover = new DatePickerPopover({
            anchor,
            value: goal.dueDate,
            onSelect: (value) => {
                goal.dueDate = value;
                void this.save().then(() => {
                    this.onChanged?.();
                    this.render();
                });
            },
            onClose: () => popover.destroy(),
        });
        popover.open();
    }

    /** 新增目标条目 */
    private async addGoal(input: HTMLInputElement): Promise<void> {
        const text = input.value.trim();
        if (!text) return;
        const entry: TaskGoalEntry = {
            id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text,
            createdAt: Date.now(),
        };
        this.task.goals = [...(this.task.goals ?? []), entry];
        await this.save();
        this.onChanged?.();
        this.render();
        this.container.querySelector<HTMLInputElement>('.goal-list-input')?.focus();
    }

    /** 切换目标完成状态 */
    private async toggleDone(goal: TaskGoalEntry): Promise<void> {
        if (goal.done) delete goal.done;
        else goal.done = true;
        await this.save();
        this.onChanged?.();
        this.render();
    }

    /** 原地编辑目标名称：名称处替换为输入框，Enter 或失焦保存，Esc 取消 */
    private startRename(goal: TaskGoalEntry, nameEl: HTMLElement): void {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'goal-list-item-name-input';
        input.value = goal.text;
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        let finished = false;
        const finish = (commit: boolean): void => {
            if (finished) return;
            finished = true;
            const next = input.value.trim();
            if (!commit || !next || next === goal.text) {
                input.replaceWith(nameEl);
                return;
            }
            goal.text = next;
            void this.save().then(() => {
                this.onChanged?.();
                this.render();
            });
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

    /** 删除目标条目 */
    private async removeGoal(goalId: string): Promise<void> {
        this.task.goals = (this.task.goals ?? []).filter((goal) => goal.id !== goalId);
        await this.save();
        this.onChanged?.();
        this.render();
    }

    /** 目标已绑定的子任务（指向已删除任务时自动忽略） */
    private boundTasks(goal: TaskGoalEntry): PrototypeTask[] {
        const byId = new Map(this.getTasks().map((task) => [task.id, task]));
        return (goal.subtaskIds ?? [])
            .map((id) => byId.get(id))
            .filter((task): task is PrototypeTask => task !== undefined);
    }

    /** 按 id 查找任务 */
    private findTask(taskId?: string): PrototypeTask | undefined {
        if (!taskId) return undefined;
        return this.getTasks().find((item) => item.id === taskId);
    }

    /** 截止日期展示文案（如「截止日期：10月30日」） */
    private formatDue(dueDate: string): string {
        const due = new Date(`${dueDate}T00:00:00`);
        if (Number.isNaN(due.getTime())) return '';
        const label = getLang() === 'zh'
            ? `${due.getMonth() + 1}月${due.getDate()}日`
            : `${due.getMonth() + 1}/${due.getDate()}`;
        return t('panel.checklistDueDateTag', { date: label });
    }
}
