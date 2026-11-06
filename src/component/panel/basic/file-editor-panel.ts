// 文件编辑面板：借 Obsidian 内部嵌入工厂（embedRegistry）取原生 Markdown 编辑器原型，
// 用 EmbeddableMarkdownEditor 包装类自己 new 一个编辑器挂进悬浮面板（社区标准做法，参考 mgmeyers / Fevol）。
// 关键点：
// 1. 临时嵌入视图只用来取编辑器原型，取完立即 unload，不保留、不搬 DOM；
// 2. 包装类在构造后 mock owner（owner.editMode / owner.editor），让编辑器以为自己挂在 MarkdownView 上；
// 3. 内容变化用 DOM input 事件监听，写回文件带防抖；
// 4. 全程不创建 leaf、不开标签页、不激活 workspace，因此不会闪烁；
// 5. 光标由 JS 手动绘制（CM6 的 cursorLayer 在该场景下不生成 .cm-cursor）。
import { Component, Notice, setIcon } from 'obsidian';
import type { App, TFile } from 'obsidian';

import { t } from '../../../i18n';
import { log } from '../../../shared/logger';
import { FloatingPanel } from './floating-panel';

export interface FileEditorPanelOptions {
    app: App;
    file: TFile;
    /** 挂载容器（与其它面板一致，限制在插件界面内显示） */
    container?: HTMLElement;
    /** 面板关闭后回调（文件列表需要刷新修改时间） */
    onClose?: () => void;
}

/** 内部 CodeMirror 6 视图的最小结构 */
interface CodeMirrorLike {
    requestMeasure?: () => void;
    focus?: () => void;
    contentDOM?: HTMLElement;
    scrollDOM?: HTMLElement;
    state?: { doc?: { length?: number; toString: () => string } };
    dispatch?: (spec: { selection: { anchor: number; head: number }; scrollIntoView?: boolean }) => void;
}

/** 内部 Markdown 编辑器实例（ScrollableMarkdownEditor）的最小结构 */
interface MarkdownEditorLike {
    /** 设置内容 */
    set?: (value: string) => void;
    /** 获取内容 */
    get?: () => string;
    /** 聚焦 */
    focus?: () => void;
    /** 销毁编辑器 */
    destroy?: () => void;
    /** 卸载（Component 生命周期） */
    unload?: () => void;
    /** 内部编辑器包装（含 CodeMirror 实例） */
    editor?: { cm?: CodeMirrorLike };
    /** CodeMirror 实例 */
    cm?: CodeMirrorLike;
    /** 所属视图（构造后由包装类 mock） */
    owner?: { editMode?: unknown; editor?: unknown };
}

/** 内部嵌入编辑器视图（WidgetEditorView）的最小结构 */
interface EmbeddedEditorViewLike {
    editable?: boolean;
    showEditor?: () => void;
    editMode?: unknown;
    unload?: () => void;
}

/** 内部嵌入注册表（embedRegistry）的最小结构 */
interface EmbedRegistryLike {
    embedByExtension: Record<string, (
        ctx: { app: App; containerEl: HTMLElement; linktext: string; sourcePath: string; displayMode?: boolean },
        file: TFile | null,
        subpath?: string,
    ) => EmbeddedEditorViewLike>;
}

/** 编辑器构造函数（内部 API，签名不固定，统一按宽松类型处理） */
type MarkdownEditorCtor = new (
    app: App,
    containerEl: HTMLElement,
    options: Record<string, unknown>,
) => MarkdownEditorLike;

/** 编辑器原型缓存（同一会话只解析一次） */
let cachedEditorCtor: MarkdownEditorCtor | null = null;

/** 写回防抖时间（毫秒） */
const SAVE_DEBOUNCE_MS = 300;

export class FileEditorPanel extends FloatingPanel {
    private readonly editorApp: App;
    private readonly file: TFile;
    /** 承载编辑器 DOM 的容器 */
    private hostEl: HTMLElement | null = null;
    /** 保存状态文案 */
    private statusEl: HTMLElement | null = null;
    /** 自己持有的原生编辑器实例 */
    private editor: MarkdownEditorLike | null = null;
    /** 写回防抖定时器 */
    private saveTimer: number | undefined;
    /** 最近一次写回（或初始读取）时的内容，用于判断是否真的有改动 */
    private lastSavedValue: string | null = null;
    /** 输入监听的清理函数 */
    private inputCleanup: (() => void) | null = null;
    /** 手动绘制的光标元素 */
    private caretEl: HTMLElement | null = null;
    /** 光标重绘的动画帧句柄 */
    private paintFrame: number | undefined;
    /** 是否已完成清理，避免 close / destroy 重复执行 */
    private disposed = false;

    constructor(options: FileEditorPanelOptions) {
        super({
            width: 760,
            title: options.file.basename,
            container: options.container,
            // 固定层级：压在 Obsidian 原生浮层（右键菜单等，约 1000）之下，避免菜单被面板遮挡
            zIndex: 800,
            onClose: () => {
                this.teardown();
                options.onClose?.();
            },
        });
        this.editorApp = options.app;
        this.file = options.file;
        this.body.addClass('file-editor-panel');
        this.renderChrome();
        void this.mountEditor();
    }

    /** 顶部路径栏 + 编辑器容器（先建好骨架，避免加载期间面板空白） */
    private renderChrome(): void {
        const toolbar = this.body.createDiv({ cls: 'file-editor-panel-toolbar' });
        const pathEl = toolbar.createDiv({ cls: 'file-editor-panel-path' });
        pathEl.setText(this.file.path);
        pathEl.title = this.file.path;
        this.statusEl = toolbar.createDiv({ cls: 'file-editor-panel-status' });
        this.setStatus(t('panel.fileSaved'));

        this.hostEl = this.body.createDiv({ cls: 'file-editor-panel-host' });

        // 右下角悬浮按钮：半透明向下箭头，点击定位到文字末尾
        const toEndBtn = this.body.createDiv({ cls: 'file-editor-panel-to-end' });
        setIcon(toEndBtn, 'chevron-down');
        toEndBtn.addEventListener('click', () => this.scrollToEnd());
    }

    /** 定位到文字末尾：光标移到文档结尾并滚动到底（编辑器未就绪时忽略） */
    private scrollToEnd(): void {
        const editor = this.editor;
        if (!editor) return;
        const cm = this.codeMirrorOf(editor);
        const length = cm?.state?.doc?.length ?? 0;
        try {
            cm?.dispatch?.({ selection: { anchor: length, head: length }, scrollIntoView: true });
        } catch {
            // CodeMirror 未就绪时忽略
        }
        // 兜底：部分版本 scrollIntoView 不生效，直接把滚动容器拉到底
        try {
            if (cm?.scrollDOM) cm.scrollDOM.scrollTop = cm.scrollDOM.scrollHeight;
        } catch {
            // 忽略
        }
        try {
            cm?.requestMeasure?.();
            cm?.focus?.();
        } catch {
            // 忽略
        }
        this.schedulePaintCaret(editor);
    }

    /** 取编辑器原型 → 在面板内 new 一个编辑器 → mock owner → 绑定内容写回 */
    private async mountEditor(): Promise<void> {
        const host = this.hostEl;
        if (!host) return;
        try {
            const Ctor = this.resolveEditorCtor();
            if (!Ctor) throw new Error('editor constructor unavailable');

            // 等面板完成布局（有非零宽高）后再构造编辑器，否则 CM6 会按不可见测量
            await this.waitForLayout(host);
            if (this.disposed) return;

            const editor = new Ctor(this.editorApp, host, {
                app: this.editorApp,
                onMarkdownScroll: (): void => undefined,
                getMode: (): string => 'source',
            });
            this.editor = editor;

            // 关键：让编辑器以为自己挂在 MarkdownView 上，否则滚动同步 / 内部命令会拿不到 editMode
            this.mockOwner(editor);

            // 初始内容
            const initial = await this.editorApp.vault.read(this.file);
            if (this.disposed) {
                this.teardown();
                return;
            }
            editor.set?.(initial);
            this.lastSavedValue = initial;

            // 内容变化写回文件（DOM input 事件 + 防抖）
            this.bindChange(editor);

            // 等两帧让 CodeMirror 完成布局后再聚焦（聚焦后光标才会显示）
            window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                    if (this.disposed) return;
                    this.focusEditor(editor);
                });
            });
        } catch (error) {
            // 嵌入失败时保持可用：清理并直接在 Obsidian 中打开该文件
            log('文件编辑面板嵌入失败', error);
            this.teardown();
            new Notice(t('panel.fileEmbedFailed'));
            void this.editorApp.workspace.getLeaf(false).openFile(this.file);
            this.close();
        }
    }

    /** 等待容器完成布局（有非零宽高），最多等 10 帧 */
    private waitForLayout(host: HTMLElement): Promise<void> {
        return new Promise((resolve) => {
            let frames = 0;
            const check = (): void => {
                frames += 1;
                if ((host.clientWidth > 0 && host.clientHeight > 0) || frames > 10) {
                    resolve();
                    return;
                }
                window.requestAnimationFrame(check);
            };
            window.requestAnimationFrame(check);
        });
    }

    /** mock owner：让编辑器认为自己属于某个 MarkdownView */
    private mockOwner(editor: MarkdownEditorLike): void {
        const owner = editor.owner;
        if (!owner) return;
        owner.editMode = editor;
        owner.editor = editor.editor ?? editor;
    }

    /** 取编辑器内部的 CodeMirror 6 视图 */
    private codeMirrorOf(editor: MarkdownEditorLike): CodeMirrorLike | undefined {
        return editor.editor?.cm ?? editor.cm;
    }

    /** 聚焦编辑器：CM6 需要 requestMeasure + focus，并接管 workspace.activeEditor */
    private focusEditor(editor: MarkdownEditorLike): void {
        const cm = this.codeMirrorOf(editor);
        try {
            cm?.requestMeasure?.();
            cm?.focus?.();
            // 光标放到文档开头（位置 0 必然在视口内）
            cm?.dispatch?.({ selection: { anchor: 0, head: 0 } });
        } catch {
            // CodeMirror 未就绪时忽略
        }
        try {
            editor.focus?.();
        } catch {
            // 内部 focus 不可用时忽略
        }
        // 接管 activeEditor，让 Obsidian 内部命令 / 光标管理认为存在活跃编辑器
        try {
            (this.editorApp.workspace as unknown as { activeEditor?: unknown }).activeEditor = editor.editor ?? editor;
        } catch {
            // 只读属性时忽略
        }
        // 兜底：直接聚焦 CodeMirror 的 contentDOM（部分版本 focus() 不生效）
        try {
            cm?.contentDOM?.focus();
        } catch {
            // 忽略
        }
        // 再补一次测量：聚焦后布局可能变化，光标需要重新绘制
        window.requestAnimationFrame(() => {
            if (this.disposed) return;
            try {
                cm?.requestMeasure?.();
            } catch {
                // 忽略
            }
            this.paintCaret(editor);
        });
    }

    /**
     * 手动绘制光标。
     * 该编辑器脱离 MarkdownView 后，CM6 的 cursorLayer 拿不到 coordsAtPos，不会生成 .cm-cursor 元素，
     * 因此这里自己往 .cm-scroller 里插一个光标 div（不能插 .cm-cursorLayer，它有 contain:size 会裁剪子元素）。
     */
    private paintCaret(editor: MarkdownEditorLike): void {
        const cm = this.codeMirrorOf(editor) as unknown as {
            coordsAtPos?: (pos: number, side?: number) => { left: number; top: number; bottom: number } | null;
            state?: { selection?: { main?: { head?: number; empty?: boolean } } };
            scrollDOM?: HTMLElement;
            requestMeasure?: () => void;
        };
        const scrollDOM = cm?.scrollDOM;
        const head = cm?.state?.selection?.main?.head;
        if (!scrollDOM || typeof head !== 'number') return;

        // 有选区时不画（选区本身可见），只处理 collapsed 光标
        const empty = cm?.state?.selection?.main?.empty !== false;
        if (!empty) {
            this.removeCaret();
            return;
        }

        const coords = cm?.coordsAtPos?.(head, 1);
        // 坐标拿不到（位置尚未渲染）：强制重新测量，延后一帧重试
        if (!coords) {
            cm?.requestMeasure?.();
            this.schedulePaintCaret(editor);
            return;
        }

        // coordsAtPos 返回的是视口坐标，需要换算成相对 scrollDOM 内容区的坐标
        const base = scrollDOM.getBoundingClientRect();
        const left = coords.left - base.left + scrollDOM.scrollLeft;
        const top = coords.top - base.top + scrollDOM.scrollTop;
        const height = coords.bottom - coords.top;

        if (!this.caretEl || !this.caretEl.isConnected) {
            this.caretEl = document.createElement('div');
            this.caretEl.addClass('sdt-manual-caret');
            scrollDOM.appendChild(this.caretEl);
        }
        // 只改位置，不重建元素：重建会让 CSS 动画从头开始，导致闪烁节奏错乱
        this.caretEl.style.left = `${left}px`;
        this.caretEl.style.top = `${top}px`;
        this.caretEl.style.height = `${height}px`;
    }

    /** 延后一帧重绘：等 CM6 把选区 / 文档更新写进 state 后再读，避免读到旧状态 */
    private schedulePaintCaret(editor: MarkdownEditorLike): void {
        if (this.paintFrame !== undefined) window.cancelAnimationFrame(this.paintFrame);
        this.paintFrame = window.requestAnimationFrame(() => {
            this.paintFrame = undefined;
            if (this.disposed) return;
            this.paintCaret(editor);
        });
    }

    /**
     * 点击后持续重算光标位置，直到坐标稳定。
     * Live Preview 点击标题（##）/ 列表等会异步展开标记符号，DOM 重排分多帧完成，
     * 单次或双帧取坐标都会偏。这里连续采样若干帧，坐标连续不变即停止。
     */
    private repaintUntilStable(editor: MarkdownEditorLike): void {
        const cm = this.codeMirrorOf(editor) as unknown as { requestMeasure?: () => void };
        try {
            cm?.requestMeasure?.();
        } catch {
            // 忽略
        }
        let last = '';
        let stableCount = 0;
        let frames = 0;
        const tick = (): void => {
            if (this.disposed) return;
            frames += 1;
            this.paintCaret(editor);
            const current = this.caretEl
                ? `${this.caretEl.style.left}|${this.caretEl.style.top}|${this.caretEl.style.height}`
                : '';
            if (current !== '' && current === last) {
                stableCount += 1;
            } else {
                stableCount = 0;
            }
            last = current;
            // 连续 3 帧不变视为稳定；最多采样 20 帧兜底
            if (stableCount >= 3 || frames >= 20) return;
            window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
    }

    /** 清理手动光标 */
    private removeCaret(): void {
        this.caretEl?.remove();
        this.caretEl = null;
    }

    /** 借临时嵌入视图取编辑器构造函数（取完立即 unload，不保留视图） */
    private resolveEditorCtor(): MarkdownEditorCtor | null {
        if (cachedEditorCtor) return cachedEditorCtor;
        const registry = (this.editorApp as unknown as { embedRegistry?: EmbedRegistryLike }).embedRegistry;
        const factory = registry?.embedByExtension?.md;
        if (!factory) return null;

        const tempEl = document.createElement('div');
        tempEl.addClass('file-editor-offscreen-host');
        document.body.appendChild(tempEl);
        let temp: EmbeddedEditorViewLike | null = null;
        try {
            temp = factory(
                {
                    app: this.editorApp,
                    containerEl: tempEl,
                    linktext: '',
                    sourcePath: '',
                    displayMode: false,
                },
                null,
                '',
            );
            temp.editable = true;
            temp.showEditor?.();
            // 编辑器实例挂在 editMode 上，其原型再往上一层即编辑器类（社区标准取法）
            const editMode = temp.editMode as object | undefined;
            if (!editMode) throw new Error('editMode unavailable');
            const proto = Object.getPrototypeOf(Object.getPrototypeOf(editMode)) as { constructor?: MarkdownEditorCtor };
            cachedEditorCtor = proto?.constructor ?? null;
            return cachedEditorCtor;
        } catch (error) {
            log('解析编辑器构造函数失败', error);
            return null;
        } finally {
            try {
                temp?.unload?.();
            } catch {
                // 临时视图卸载失败时忽略
            }
            tempEl.remove();
        }
    }

    /** 绑定内容变化：监听编辑器容器的 input 事件，防抖写回文件 */
    private bindChange(editor: MarkdownEditorLike): void {
        const cm = this.codeMirrorOf(editor) as unknown as {
            dom?: HTMLElement;
            contentDOM?: HTMLElement;
            scrollDOM?: HTMLElement;
        };
        const target = cm?.contentDOM ?? cm?.dom;
        if (!target) return;
        const handler = (): void => this.scheduleSave(editor);
        target.addEventListener('input', handler);
        // 剪切 / 粘贴 / 拖拽移动文本不一定派发 input 事件，单独监听
        target.addEventListener('cut', handler);
        target.addEventListener('paste', handler);
        target.addEventListener('drop', handler);
        // 删除类操作（退格 / 删除 / 撤销 / 重做）在部分情况下不派发 input，统一按键盘事件兜底
        target.addEventListener('keydown', handler);

        // 光标跟随：输入 / 键盘移动 / 滚动时重绘手动光标
        // 统一延后一帧，等 CM6 把选区写进 state 后再读，避免读到旧状态
        const repaint = (): void => this.schedulePaintCaret(editor);
        target.addEventListener('input', repaint);
        target.addEventListener('keyup', repaint);
        const scroller = cm?.scrollDOM;
        scroller?.addEventListener('scroll', repaint);

        // 点击：Live Preview 会异步展开标题（##）/ 列表等标记符号，DOM 重排分多帧完成，
        // 单次取坐标会偏。这里持续重算直到坐标稳定。
        const onClickRepaint = (): void => this.repaintUntilStable(editor);
        target.addEventListener('mouseup', onClickRepaint);
        target.addEventListener('click', onClickRepaint);

        // 选区变化（拖选、双击选词、Ctrl+A）时重绘，让光标在有选区时隐藏、取消选区时恢复
        const onSelectionChange = (): void => {
            if (this.disposed) return;
            repaint();
        };
        document.addEventListener('selectionchange', onSelectionChange);

        this.inputCleanup = () => {
            target.removeEventListener('input', handler);
            target.removeEventListener('cut', handler);
            target.removeEventListener('paste', handler);
            target.removeEventListener('drop', handler);
            target.removeEventListener('keydown', handler);
            target.removeEventListener('input', repaint);
            target.removeEventListener('keyup', repaint);
            target.removeEventListener('mouseup', onClickRepaint);
            target.removeEventListener('click', onClickRepaint);
            scroller?.removeEventListener('scroll', repaint);
            document.removeEventListener('selectionchange', onSelectionChange);
        };
    }

    /**
     * 防抖写回文件。
     * 以「编辑器内容 vs 最近一次写回内容」判断是否有改动，而不是依赖事件类型：
     * 删除文字、撤销 / 重做、拖拽移动等操作不一定派发 input 事件，按内容比对才不会漏判。
     */
    private scheduleSave(editor: MarkdownEditorLike): void {
        const value = this.readEditorValue(editor);
        // 内容与已保存内容一致（如只按了方向键、删了又撤回）：不标记未保存，也不写回
        if (value !== null && value === this.lastSavedValue) return;

        this.setStatus(t('panel.fileUnsaved'));
        if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = undefined;
            this.flushSave(editor);
        }, SAVE_DEBOUNCE_MS);
    }

    /** 立即写回文件（关闭面板 / 防抖到期时调用） */
    private flushSave(editor: MarkdownEditorLike): void {
        const value = this.readEditorValue(editor);
        if (value === null) return;
        // 内容没有实际变化：不写文件，状态保持已保存
        if (value === this.lastSavedValue) {
            this.setStatus(t('panel.fileSaved'));
            return;
        }
        this.lastSavedValue = value;
        void this.editorApp.vault.process(this.file, () => value)
            .then(() => this.setStatus(t('panel.fileSaved')))
            .catch((error) => log('写回任务文件失败', error));
    }

    /** 读取编辑器当前内容 */
    private readEditorValue(editor: MarkdownEditorLike): string | null {
        const cm = this.codeMirrorOf(editor);
        const fromCm = cm?.state?.doc?.toString();
        if (typeof fromCm === 'string') return fromCm;
        const fromEditor = editor.get?.();
        return typeof fromEditor === 'string' ? fromEditor : null;
    }

    private setStatus(text: string): void {
        this.statusEl?.setText(text);
    }

    /** 销毁编辑器（close / destroy 都会调用，内部只执行一次） */
    private teardown(): void {
        if (this.disposed) return;
        this.disposed = true;

        if (this.saveTimer !== undefined) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        // 关闭面板时防抖尚未到期：立即写回，避免最后一次编辑丢失（内容未变时不会写文件）
        if (this.editor) this.flushSave(this.editor);
        this.inputCleanup?.();
        this.inputCleanup = null;
        if (this.paintFrame !== undefined) {
            window.cancelAnimationFrame(this.paintFrame);
            this.paintFrame = undefined;
        }
        this.removeCaret();

        const editor = this.editor;
        this.editor = null;
        if (!editor) return;
        try {
            // 原生编辑器是 Component：先 unload 再 destroy，避免残留监听
            if (editor instanceof Component) editor.unload();
            else editor.unload?.();
        } catch {
            // 已卸载时忽略
        }
        try {
            editor.destroy?.();
        } catch {
            // 已销毁时忽略
        }
    }

    override destroy(): void {
        this.teardown();
        super.destroy();
    }
}
