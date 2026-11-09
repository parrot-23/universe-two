// 公共悬浮面板：页面中一张可拖动的大卡片（非弹窗），右上角 X 按钮关闭。
// 与视图解耦，可挂在任意容器（默认 document.body）上复用。
import { setIcon } from 'obsidian';

import { t } from '../../../i18n';
import { applyThemeColors, getCurrentThemeColors, registerThemeColorsConsumer, unregisterThemeColorsConsumer } from '../../../themestory/theme-colors';
import type { ThemeColors } from '../../../themestory/theme-definition';

/** 悬浮面板配置 */
export interface FloatingPanelOptions {
    /** 面板标题（可选） */
    title?: string;
    /**
     * 挂载容器，默认 document.body（挂到 body 时用 fixed 定位，否则用 absolute）。
     * 传入容器即把面板限制在该容器内显示（拖动范围也限制在容器内）。
     */
    container?: HTMLElement;
    /** 面板宽度（px），默认 480 */
    width?: number;
    /** 是否可拖动，默认 true */
    draggable?: boolean;
    /** 是否在失去焦点时自动关闭（点击面板外任意位置），默认 false */
    closeOnBlur?: boolean;
    /** 标题栏是否显示钉住按钮（钉住后点击面板外不再关闭），默认 false */
    pinnable?: boolean;
    /**
     * 标题栏帮助文案：提供后在关闭按钮左侧显示（?）按钮（默认不显示），
     * 鼠标悬停时在按钮下方弹出提示气泡，移开即关闭。
     */
    helpText?: string;
    /**
     * 固定层级：设置后该面板不参与置顶递增，始终使用此 z-index。
     * 用于需要压在 Obsidian 原生浮层（右键菜单等）之下的面板（如文件编辑面板）。
     */
    zIndex?: number;
    /** 关闭回调 */
    onClose?: () => void;
}

/** 面板层级基数（与 styles.css 中 .floating-panel 的 z-index 保持一致） */
const BASE_PANEL_Z_INDEX = 900;
/** 面板层级上限：超过后重排，保证仍低于下拉浮层（1000+）等更高层元素 */
const MAX_PANEL_Z_INDEX = 1090;
/**
 * 挂在容器内（absolute 定位）时的层级基数：容器自身可能处在较低的层叠上下文里，
 * 用 900 起步会盖住 Obsidian 原生浮层（右键菜单等），因此容器内面板从 50 起步。
 */
const BASE_HOSTED_PANEL_Z_INDEX = 50;
/** 容器内面板层级上限：超过后重排 */
const MAX_HOSTED_PANEL_Z_INDEX = 240;

/** 当前最高层级：每次激活面板时递增，保证最后操作的面板在最上面 */
let topPanelZIndex = BASE_PANEL_Z_INDEX;
/** 容器内面板的当前最高层级（与 body 面板分开计数，互不影响） */
let topHostedPanelZIndex = BASE_HOSTED_PANEL_Z_INDEX;

/**
 * 悬浮面板组件：本质是一张可拖动的卡片，首次打开居中，之后保留拖动位置。
 * 用法：
 * ```ts
 * const panel = new FloatingPanel({ title: '标题' });
 * panel.setContent((body) => body.createDiv({ text: '内容' }));
 * panel.open();
 * ```
 */
export class FloatingPanel {
    private host: HTMLElement;
    private hostIsBody: boolean;
    private root: HTMLElement;
    private headerEl: HTMLElement;
    private titleEl: HTMLElement;
    /** 标题栏右侧自定义操作按钮区（位于关闭按钮左侧） */
    private actionsEl: HTMLElement;
    private bodyEl: HTMLElement;
    private options: FloatingPanelOptions;
    private opened = false;
    /** 嵌入模式挂载容器（null 表示普通浮层模式） */
    private embeddedHost: HTMLElement | null = null;
    /** 是否已钉住（钉住后点击面板外不再关闭） */
    private pinned = false;
    /** 标题栏钉住按钮（仅在 pinnable 时创建） */
    private pinButtonEl: HTMLElement | null = null;
    /** 当前左上角位置（相对挂载容器），null 表示尚未定位 */
    private left: number | null = null;
    private top: number | null = null;

    // 拖动状态
    private dragging = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private dragStartLeft = 0;
    private dragStartTop = 0;

    /** 额外视为「面板内部」的元素（如由本面板打开的子面板），点击时不触发失焦关闭 */
    private ignoreEls: HTMLElement[] = [];

    private onKeyDown = (evt: KeyboardEvent) => {
        if (evt.key === 'Escape') this.close();
    };

    /** 点击面板外时关闭（仅在关闭面板失去焦点行为时绑定） */
    private onOutsidePointerDown = (evt: MouseEvent) => {
        if (!this.opened) return;
        const target = evt.target as Node | null;
        if (target && this.root.contains(target)) return;
        if (target && this.ignoreEls.some((el) => el.contains(target))) return;
        this.close();
    };

    constructor(options: FloatingPanelOptions = {}) {
        this.options = options;
        this.host = options.container ?? document.body;
        this.hostIsBody = this.host === document.body;

        this.root = this.host.createDiv({ cls: 'floating-panel' });
        if (!this.hostIsBody) {
            this.root.addClass('is-absolute');
            // 层级用内联样式写入：CSS 里 .floating-panel.is-absolute 的 z-index 优先级高于内联样式，
            // 不覆盖的话 bringToFront() 设置的层级会失效（后打开的面板无法置顶）
            this.root.style.zIndex = String(options.zIndex ?? BASE_HOSTED_PANEL_Z_INDEX);
            // absolute 定位需要容器本身可作为定位参照
            if (getComputedStyle(this.host).position === 'static') {
                this.host.style.position = 'relative';
            }
        } else if (options.zIndex !== undefined) {
            // 固定层级面板：直接写入内联层级，不参与置顶递增
            this.root.style.zIndex = String(options.zIndex);
        }
        this.root.style.display = 'none';
        if (options.width) this.root.style.width = `${options.width}px`;

        this.headerEl = this.root.createDiv({ cls: 'floating-panel-header' });
        this.titleEl = this.headerEl.createDiv({ cls: 'floating-panel-title' });
        if (options.title) this.titleEl.setText(options.title);

        // 标题栏右侧：自定义操作按钮区 + 关闭按钮
        const rightEl = this.headerEl.createDiv({ cls: 'floating-panel-header-right' });
        this.actionsEl = rightEl.createDiv({ cls: 'floating-panel-actions' });

        // 钉住按钮：默认不启用，由 pinnable 开启
        if (options.pinnable) {
            this.pinButtonEl = this.addHeaderAction('pin', t('panel.pin'), () => this.togglePin());
        }

        // 帮助按钮：默认不显示，传入 helpText 时在关闭按钮左侧出现，悬停弹出提示气泡
        if (options.helpText) {
            const helpEl = rightEl.createDiv({ cls: 'floating-panel-help' });
            // 不设置 aria-label / title：Obsidian 会据此在悬浮时弹出原生提示，挡住自定义帮助气泡
            const helpBtn = helpEl.createDiv({ cls: 'floating-panel-action' });
            setIcon(helpBtn, 'help-circle');
            const helpTip = helpEl.createDiv({ cls: 'floating-panel-help-tip', text: options.helpText });
            helpBtn.addEventListener('mouseenter', () => helpTip.addClass('is-visible'));
            helpBtn.addEventListener('mouseleave', () => helpTip.removeClass('is-visible'));
        }

        const closeBtn = rightEl.createDiv({ cls: 'floating-panel-close', attr: { 'aria-label': 'Close' } });
        setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => this.close());

        this.bodyEl = this.root.createDiv({ cls: 'floating-panel-body' });

        // 点击 / 拖动面板任意位置时置顶，避免多面板互相遮挡时操作到下层
        this.root.addEventListener('pointerdown', () => this.bringToFront(), true);

        // 拖动：按住标题栏移动
        this.headerEl.addEventListener('pointerdown', this.handlePointerDown);
        this.headerEl.addEventListener('pointermove', this.handlePointerMove);
        this.headerEl.addEventListener('pointerup', this.handlePointerUp);
        this.headerEl.addEventListener('pointercancel', this.handlePointerUp);

        // 注册主题颜色消费者：构造时应用当前主题，主题切换时自动刷新
        registerThemeColorsConsumer(this);
        applyThemeColors(this.root, getCurrentThemeColors());
    }

    /** 面板内容容器（可直接追加内容） */
    get body(): HTMLElement {
        return this.bodyEl;
    }

    /** 是否处于打开状态 */
    get isOpen(): boolean {
        return this.opened;
    }

    /** 是否处于嵌入模式（作为内联内容铺满容器） */
    get isEmbedded(): boolean {
        return this.embeddedHost !== null;
    }

    /**
     * 嵌入到指定容器：根节点改为铺满容器的普通内容块，并隐藏自带标题栏。
     * 之后仍用 open() 激活（各面板的打开逻辑与定时器依赖它），关闭用 close()。
     */
    embed(container: HTMLElement): void {
        this.embeddedHost = container;
        this.root.addClass('is-embedded');
        this.root.removeClass('is-absolute');
        container.appendChild(this.root);
    }

    /** 退出嵌入模式：根节点放回原来的浮层挂载容器，恢复浮动定位与尺寸 */
    unembed(): void {
        if (!this.embeddedHost) return;
        this.embeddedHost = null;
        this.root.removeClass('is-embedded');
        if (!this.hostIsBody) this.root.addClass('is-absolute');
        this.host.appendChild(this.root);
    }

    /** 面板根元素（供其它面板登记为「内部元素」） */
    get element(): HTMLElement {
        return this.root;
    }

    /** 设置标题 */
    setTitle(title: string): void {
        this.titleEl.setText(title);
    }

    /**
     * 登记额外元素：该元素内的点击不触发本面板的失焦关闭。
     * 用于「由本面板打开的子面板」，避免操作子面板时把父面板一并关掉。
     */
    addIgnoreElement(el: HTMLElement): void {
        if (!this.ignoreEls.includes(el)) this.ignoreEls.push(el);
    }

    /** 在标题栏右侧添加一个图标按钮，返回按钮元素；position 为 start 时插到最左侧 */
    addHeaderAction(icon: string, label: string, onClick: () => void, position: 'start' | 'end' = 'end'): HTMLElement {
        const button = this.actionsEl.createDiv({
            cls: 'floating-panel-action',
            attr: { 'aria-label': label, role: 'button' },
        });
        if (position === 'start') this.actionsEl.prepend(button);
        button.title = label;
        setIcon(button, icon);
        button.addEventListener('click', onClick);
        return button;
    }

    /** 切换钉住状态：钉住后点击面板外不再关闭 */
    private togglePin(): void {
        this.pinned = !this.pinned;
        this.setCloseOnBlur(!this.pinned);
        if (!this.pinButtonEl) return;
        this.pinButtonEl.toggleClass('is-active', this.pinned);
        const label = t(this.pinned ? 'panel.unpin' : 'panel.pin');
        this.pinButtonEl.title = label;
        this.pinButtonEl.setAttribute('aria-label', label);
    }

    /** 切换「点击面板外自动关闭」：面板内按钮用于钉住 / 取消钉住 */
    private setCloseOnBlur(enabled: boolean): void {
        this.options.closeOnBlur = enabled;
        if (!this.opened) return;
        if (enabled) {
            document.addEventListener('mousedown', this.onOutsidePointerDown, true);
        } else {
            document.removeEventListener('mousedown', this.onOutsidePointerDown, true);
        }
    }

    /** 设置内容：清空后由回调渲染，或直接传入元素 */
    setContent(content: HTMLElement | ((body: HTMLElement) => void)): void {
        this.bodyEl.empty();
        if (typeof content === 'function') {
            content(this.bodyEl);
        } else {
            this.bodyEl.appendChild(content);
        }
    }

    /** 打开面板（首次打开时居中，之后保留上次拖动位置；已打开时调用视为置顶） */
    open(): void {
        if (this.opened) {
            if (!this.isEmbedded) this.bringToFront();
            return;
        }
        this.opened = true;
        this.root.style.display = 'flex';
        // 嵌入模式：作为内容块显示，不居中、不置顶、不注册 Esc / 失焦关闭
        if (this.isEmbedded) return;
        if (this.left === null || this.top === null) {
            this.center();
        } else {
            // 已定位过：容器尺寸可能已变化，重新夹取到容器范围内
            this.clampIntoHost();
        }
        // 新打开的面板默认在最上层
        this.bringToFront();
        document.addEventListener('keydown', this.onKeyDown);
        if (this.options.closeOnBlur) {
            // 用捕获阶段监听，避免被面板内元素的 stopPropagation 影响
            document.addEventListener('mousedown', this.onOutsidePointerDown, true);
        }
    }

    /** 关闭面板 */
    close(): void {
        if (!this.opened) return;
        this.opened = false;
        this.root.style.display = 'none';
        this.dragging = false;
        this.root.removeClass('is-dragging');
        document.removeEventListener('keydown', this.onKeyDown);
        document.removeEventListener('mousedown', this.onOutsidePointerDown, true);
        this.options.onClose?.();
    }

    /** 销毁面板（从 DOM 移除，不再触发关闭回调） */
    destroy(): void {
        unregisterThemeColorsConsumer(this);
        document.removeEventListener('keydown', this.onKeyDown);
        document.removeEventListener('mousedown', this.onOutsidePointerDown, true);
        this.opened = false;
        // 嵌入中的面板被销毁时不再退回原容器，避免把已移除的节点重新挂回
        this.embeddedHost = null;
        this.root.remove();
    }

    /** 应用主题颜色变量到面板根节点（供主题系统调用） */
    applyThemeColors(colors?: ThemeColors): void {
        applyThemeColors(this.root, colors);
    }

    /** 置顶：把面板层级提到当前所有面板之上（点击 / 打开时调用） */
    private bringToFront(): void {
        if (this.hostIsBody) {
            // 固定层级面板（如文件编辑面板）不参与置顶递增，始终压在原生浮层之下
            if (this.options.zIndex !== undefined) return;
            // 层级只在小范围内递增，超过上限时重排一次，避免盖住下拉浮层等更高层元素
            if (topPanelZIndex >= MAX_PANEL_Z_INDEX) this.renormalizeZIndex();
            topPanelZIndex += 1;
            this.root.style.zIndex = String(topPanelZIndex);
            return;
        }
        // 容器内面板：只在同一容器内比较层级，避免不同容器之间互相干扰
        if (topHostedPanelZIndex >= MAX_HOSTED_PANEL_Z_INDEX) this.renormalizeHostedZIndex();
        topHostedPanelZIndex += 1;
        this.root.style.zIndex = String(topHostedPanelZIndex);
    }

    /** 重排所有已打开面板的层级，恢复连续递增的初始区间 */
    private renormalizeZIndex(): void {
        const panels = Array.from(document.querySelectorAll<HTMLElement>('.floating-panel'))
            .filter((el) => el.style.display !== 'none')
            .sort((a, b) => Number(a.style.zIndex || BASE_PANEL_Z_INDEX) - Number(b.style.zIndex || BASE_PANEL_Z_INDEX));
        let zIndex = BASE_PANEL_Z_INDEX;
        for (const el of panels) el.style.zIndex = String(++zIndex);
        topPanelZIndex = zIndex;
    }

    /** 重排同一容器内已打开面板的层级（容器内面板单独计数） */
    private renormalizeHostedZIndex(): void {
        const panels = Array.from(this.host.querySelectorAll<HTMLElement>('.floating-panel'))
            .filter((el) => el.style.display !== 'none')
            .sort((a, b) => Number(a.style.zIndex || BASE_HOSTED_PANEL_Z_INDEX) - Number(b.style.zIndex || BASE_HOSTED_PANEL_Z_INDEX));
        let zIndex = BASE_HOSTED_PANEL_Z_INDEX;
        for (const el of panels) el.style.zIndex = String(++zIndex);
        topHostedPanelZIndex = zIndex;
    }

    /** 初始居中 */
    private center(): void {
        const hostSize = this.hostSize();
        const w = this.root.offsetWidth;
        const h = this.root.offsetHeight;
        this.setPosition((hostSize.width - w) / 2, (hostSize.height - h) / 2);
    }

    /** 挂载容器的可视尺寸（body 用视口尺寸） */
    private hostSize(): { width: number; height: number } {
        if (this.hostIsBody) {
            return { width: window.innerWidth, height: window.innerHeight };
        }
        return { width: this.host.clientWidth, height: this.host.clientHeight };
    }

    /** 设置位置，限制在挂载容器范围内 */
    private setPosition(left: number, top: number): void {
        const hostSize = this.hostSize();
        const maxLeft = Math.max(0, hostSize.width - this.root.offsetWidth);
        const maxTop = Math.max(0, hostSize.height - this.root.offsetHeight);
        this.left = Math.max(0, Math.min(left, maxLeft));
        this.top = Math.max(0, Math.min(top, maxTop));
        this.root.style.left = `${this.left}px`;
        this.root.style.top = `${this.top}px`;
    }

    /**
     * 挂载容器尺寸变化时重新夹取位置：容器变小后把面板拉回可视范围内，
     * 避免面板被裁到容器外（限制在容器内显示时尤其明显）。
     */
    private clampIntoHost(): void {
        if (this.left === null || this.top === null) return;
        this.setPosition(this.left, this.top);
    }

    private handlePointerDown = (evt: PointerEvent): void => {
        if (this.options.draggable === false || evt.button !== 0) return;
        // 标题栏按钮（关闭 / 自定义操作）不触发拖动
        if ((evt.target as HTMLElement).closest('.floating-panel-close, .floating-panel-action')) return;
        this.dragging = true;
        this.dragStartX = evt.clientX;
        this.dragStartY = evt.clientY;
        this.dragStartLeft = this.left ?? 0;
        this.dragStartTop = this.top ?? 0;
        this.headerEl.setPointerCapture(evt.pointerId);
        this.root.addClass('is-dragging');
        evt.preventDefault();
    };

    private handlePointerMove = (evt: PointerEvent): void => {
        if (!this.dragging) return;
        this.setPosition(
            this.dragStartLeft + (evt.clientX - this.dragStartX),
            this.dragStartTop + (evt.clientY - this.dragStartY),
        );
    };

    private handlePointerUp = (): void => {
        if (!this.dragging) return;
        this.dragging = false;
        this.root.removeClass('is-dragging');
    };
}

/** 便捷创建并打开一个悬浮面板 */
export function showFloatingPanel(options: FloatingPanelOptions): FloatingPanel {
    const panel = new FloatingPanel(options);
    panel.open();
    return panel;
}