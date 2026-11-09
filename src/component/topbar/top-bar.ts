// 顶部工具栏：整行布局，左侧操作区由调用方填充，日期切换 < 月/日 > 与周历按钮居中，右侧操作区由调用方填充。
import { setIcon } from 'obsidian';

import { t } from '../../i18n';

/** 指定日期 0 点 */
function startOfDay(date: Date): Date {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);
    return result;
}

/** 当天 0 点 */
function startOfToday(): Date {
    return startOfDay(new Date());
}

/** 顶部工具栏配置 */
export interface TopBarOptions {
    /** 初始选中日期，默认今天 */
    initialDate?: Date;
    /** 用户切换日期后回调（用于同步其它视图） */
    onDateChange?: (date: Date) => void;
    /** 点击周历按钮（传入当前选中日期） */
    onOpenCalendar?: (date: Date) => void;
    /** 点击功能面板按钮（位于任务目标按钮左侧） */
    onOpenFunctionPanel?: () => void;
    /** 点击任务目标按钮（位于周历按钮左侧） */
    onOpenGoalPanel?: () => void;
    /** 点击设置按钮 */
    onOpenSettings?: () => void;
    /** 点击帮助按钮（位于设置按钮紧贴右侧） */
    onOpenHelp?: () => void;
}

/** 顶部工具栏渲染结果 */
export interface TopBarRenderResult {
    /** 左侧操作区容器（供调用方填充） */
    left: HTMLElement;
    /** 右侧操作区容器 */
    actions: HTMLElement;
}

/** 顶部工具栏 */
export class TopBar {
    private readonly options: TopBarOptions;
    /** 当前选中日期（最多到今天） */
    private selectedDate: Date;
    /** 日期文本 */
    private labelEl: HTMLElement | null = null;
    /** 「后一天」按钮（到达今天后禁用） */
    private nextBtn: HTMLButtonElement | null = null;
    /** 相对日期胶囊（今天 / 昨天 / x 天前，点击回到今天） */
    private relativePillEl: HTMLButtonElement | null = null;

    constructor(options: TopBarOptions = {}) {
        this.options = options;
        this.selectedDate = options.initialDate ? startOfDay(options.initialDate) : startOfToday();
    }

    /** 在指定容器内渲染整行工具栏，返回左侧与右侧操作区容器供调用方填充 */
    render(parentEl: HTMLElement): TopBarRenderResult {
        const bar = parentEl.createDiv({ cls: 'parrot-plan-topbar' });
        // 左侧占位：保证日期区（含功能按钮组）落在 grid 中间列，整组居中
        bar.createDiv({ cls: 'parrot-plan-topbar-spacer' });
        const dateBar = bar.createDiv({ cls: 'parrot-plan-topbar-date' });

        // 功能面板按钮：位于任务目标按钮左侧
        const functionBtn = dateBar.createEl('button', {
            cls: 'parrot-plan-topbar-calendar-btn',
            attr: { 'aria-label': t('interface.functionPanel') },
        });
        setIcon(functionBtn, 'layout-grid');
        functionBtn.onclick = () => this.options.onOpenFunctionPanel?.();

        // 任务目标按钮：位于周历按钮左侧
        const goalBtn = dateBar.createEl('button', {
            cls: 'parrot-plan-topbar-calendar-btn',
            attr: { 'aria-label': t('nav.openGoalPanel') },
        });
        setIcon(goalBtn, 'target');
        goalBtn.onclick = () => this.options.onOpenGoalPanel?.();

        // 周历按钮：位于日期切换左侧
        const calendarBtn = dateBar.createEl('button', {
            cls: 'parrot-plan-topbar-calendar-btn',
            attr: { 'aria-label': t('nav.openCalendar') },
        });
        setIcon(calendarBtn, 'calendar');
        calendarBtn.onclick = () => this.options.onOpenCalendar?.(this.getSelectedDate());

        const prevBtn = dateBar.createEl('button', {
            text: '<',
            cls: 'parrot-plan-topbar-date-btn',
            attr: { 'aria-label': t('nav.prevDay') },
        });
        prevBtn.onclick = () => this.shiftDate(-1);

        this.labelEl = dateBar.createSpan({ cls: 'parrot-plan-topbar-date-label' });

        this.nextBtn = dateBar.createEl('button', {
            text: '>',
            cls: 'parrot-plan-topbar-date-btn',
            attr: { 'aria-label': t('nav.nextDay') },
        });
        this.nextBtn.onclick = () => this.shiftDate(1);

        // 相对日期胶囊：位于日期切换右侧，点击回到今天
        this.relativePillEl = dateBar.createEl('button', {
            cls: 'parrot-plan-topbar-relative-pill',
            attr: { 'aria-label': t('nav.backToToday') },
        });
        this.relativePillEl.onclick = () => this.resetToToday();

        // 设置按钮：位于相对日期胶囊右侧
        const settingsBtn = dateBar.createEl('button', {
            cls: 'parrot-plan-topbar-settings-btn',
            attr: { 'aria-label': t('nav.openSettings') },
        });
        setIcon(settingsBtn, 'settings');
        settingsBtn.onclick = () => this.options.onOpenSettings?.();

        // 帮助按钮：紧贴设置按钮右侧
        const helpBtn = dateBar.createEl('button', {
            text: '?',
            cls: 'parrot-plan-nav-help-btn',
            attr: { 'aria-label': t('help.title') },
        });
        helpBtn.onclick = () => this.options.onOpenHelp?.();

        // 左侧操作区：位于帮助按钮右侧（由调用方填充界面功能按钮组）
        const left = dateBar.createDiv({ cls: 'parrot-plan-topbar-left' });

        const actions = bar.createDiv({ cls: 'parrot-plan-topbar-actions' });
        this.update();
        return { left, actions };
    }

    /** 当前选中日期（外部读取用） */
    getSelectedDate(): Date {
        return new Date(this.selectedDate);
    }

    /** 外部同步日期：只刷新显示，不触发 onDateChange（避免循环） */
    setSelectedDate(date: Date): void {
        const next = startOfDay(date);
        if (next.getTime() > startOfToday().getTime()) return;
        this.selectedDate = next;
        this.update();
    }

    /** 用户切换日期：刷新显示并通知外部 */
    private shiftDate(delta: number): void {
        const next = new Date(this.selectedDate);
        next.setDate(next.getDate() + delta);
        if (next.getTime() > startOfToday().getTime()) return;
        this.selectedDate = startOfDay(next);
        this.update();
        this.options.onDateChange?.(this.getSelectedDate());
    }

    /** 点击相对日期胶囊：回到今天（已在今天时无变化） */
    private resetToToday(): void {
        const today = startOfToday();
        if (this.selectedDate.getTime() === today.getTime()) return;
        this.selectedDate = today;
        this.update();
        this.options.onDateChange?.(this.getSelectedDate());
    }

    /** 刷新日期文本、相对日期胶囊与「后一天」禁用态 */
    private update(): void {
        if (this.labelEl) {
            this.labelEl.textContent = `${this.selectedDate.getMonth() + 1}/${this.selectedDate.getDate()}`;
        }
        if (this.relativePillEl) {
            const daysAgo = Math.round((startOfToday().getTime() - this.selectedDate.getTime()) / 86400000);
            this.relativePillEl.textContent = daysAgo === 0
                ? t('nav.today')
                : daysAgo === 1
                    ? t('nav.yesterday')
                    : t('nav.daysAgo', { days: String(daysAgo) });
            this.relativePillEl.toggleClass('is-today', daysAgo === 0);
            this.relativePillEl.disabled = daysAgo === 0;
        }
        if (this.nextBtn) {
            this.nextBtn.disabled = this.selectedDate.getTime() === startOfToday().getTime();
        }
    }
}
