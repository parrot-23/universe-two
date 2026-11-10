// 任务库目录工具：按任务树推导并创建任务目录（<项目库根目录>/<根任务>/<子任务…>/<任务文件>）。
// 任务目录仅由本模块按规则计算，结果写入任务的「任务文件」板块（值为「任务文件」目录），不提供手动绑定。
import { TFolder, type App } from 'obsidian';

import type { PrototypeTask } from '../datatypes/prototype-task';
import { t } from '../i18n';
import { getTaskFileDir, setTaskFileDir } from './task-sections';

/** 任务文件目录名（跟随界面语言） */
export function getTaskFilesFolderName(): string {
    return t('taskLibrary.filesFolder');
}

/** 清理为合法目录名：替换非法字符，去掉首尾空白与点号 */
export function sanitizeFolderName(name: string): string {
    const cleaned = name
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/[#^[\]]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .replace(/\.+$/, '');
    return cleaned || t('taskLibrary.untitled');
}

/** 目录路径的父目录（无父目录时返回空串） */
function dirname(path: string): string {
    const index = path.lastIndexOf('/');
    return index >= 0 ? path.slice(0, index) : '';
}

/** 路径是否位于指定根目录之下 */
function isUnderRoot(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

/** 在 Obsidian 左侧文件浏览器中定位目录（文件浏览器未打开时先打开） */
export function revealFolderInExplorer(app: App, folder: TFolder): void {
    const reveal = (): boolean => {
        const view = app.workspace.getLeavesOfType('file-explorer')[0]?.view as
            { revealInFolder?: (target: TFolder) => void } | undefined;
        if (!view?.revealInFolder) return false;
        view.revealInFolder(folder);
        return true;
    };
    if (reveal()) return;
    // 文件浏览器未打开时先执行其打开命令（该 API 未包含在公开类型中）
    const commands = (app as unknown as {
        commands?: { executeCommandById: (commandId: string) => boolean };
    }).commands;
    commands?.executeCommandById('file-explorer:open');
    window.setTimeout(() => reveal(), 100);
}

/** 确保目录存在（逐级创建，已存在时忽略） */
async function ensureFolder(app: App, path: string): Promise<void> {
    if (!path) return;
    if (app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
    try {
        await app.vault.createFolder(path);
    } catch {
        // 目录已存在或创建失败时忽略，后续列表 / 新建文件会给出反馈
    }
}

/** 在父目录下生成不与其它任务冲突的目录路径（同名时追加「 (2)」「 (3)」…） */
function uniqueTaskDir(parentDir: string, task: PrototypeTask, root: string, tasks: PrototypeTask[]): string {
    const baseName = sanitizeFolderName(task.name);
    const claimed = new Set(
        tasks
            .filter((item) => item.id !== task.id && getTaskFileDir(item) && isUnderRoot(getTaskFileDir(item), root))
            .map((item) => dirname(getTaskFileDir(item)).toLowerCase()),
    );
    let name = baseName;
    let index = 2;
    while (claimed.has(`${parentDir}/${name}`.toLowerCase())) {
        name = `${baseName} (${index})`;
        index += 1;
    }
    return `${parentDir}/${name}`;
}

/** 确保任务目录的结果 */
export interface EnsureTaskDirResult {
    /** 任务文件目录；null 表示未配置项目库 */
    dir: string | null;
    /** 是否有任务的「任务文件」板块被写入（调用方据此持久化） */
    changed: boolean;
}

/**
 * 确保当前任务的任务文件目录存在：
 * 目录按任务树推导（<项目库>/<根任务>/<子任务…>/<任务文件>），但只创建当前任务这一层，
 * 不会遍历上级任务、也不会给上级任务写入任务文件板块或创建其「任务文件」目录。
 * 已记录且位于项目库内的目录保持不变；不在项目库内（旧的手动绑定）会按规则重新绑定。
 */
export async function ensureTaskFileDir(
    app: App,
    root: string,
    tasks: PrototypeTask[],
    task: PrototypeTask,
): Promise<EnsureTaskDirResult> {
    if (!root) return { dir: null, changed: false };
    const byId = new Map(tasks.map((item) => [item.id, item]));

    // 自根任务到当前任务的链（根任务在前），仅用于推导当前任务的目录路径
    const chain: PrototypeTask[] = [];
    const visited = new Set<string>();
    let current: PrototypeTask | undefined = task;
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        chain.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    let changed = false;
    let parentDir = root;
    for (const node of chain) {
        // 上级任务只取已记录的目录作为父级，不创建、不写入
        if (node.id !== task.id) {
            const recordedDir = getTaskFileDir(node);
            const recorded = recordedDir && isUnderRoot(recordedDir, root) ? dirname(recordedDir) : '';
            parentDir = recorded || `${parentDir}/${sanitizeFolderName(node.name)}`;
            continue;
        }
        const recordedDir = getTaskFileDir(node);
        let taskDir = recordedDir && isUnderRoot(recordedDir, root) ? dirname(recordedDir) : '';
        if (!taskDir) {
            taskDir = uniqueTaskDir(parentDir, node, root, tasks);
            setTaskFileDir(node, `${taskDir}/${getTaskFilesFolderName()}`);
            changed = true;
        }
        await ensureFolder(app, taskDir);
        await ensureFolder(app, getTaskFileDir(node));
    }

    return { dir: getTaskFileDir(task) || null, changed };
}

/**
 * 任务改名后同步重命名其目录（子任务目录随父目录一起移动），并更新相关任务的任务文件板块。
 * 仅处理位于项目库内的目录；返回是否有改动（调用方据此持久化）。
 */
export async function renameTaskDir(
    app: App,
    root: string,
    tasks: PrototypeTask[],
    task: PrototypeTask,
): Promise<boolean> {
    const taskFileDir = getTaskFileDir(task);
    if (!root || !taskFileDir || !isUnderRoot(taskFileDir, root)) return false;
    const oldDir = dirname(taskFileDir);
    const parentDir = dirname(oldDir);
    if (!oldDir || !parentDir || !isUnderRoot(oldDir, root)) return false;

    const newDir = uniqueTaskDir(parentDir, task, root, tasks);
    if (newDir === oldDir) return false;

    // 目标目录已被占用（历史遗留目录）时追加序号，避免重命名失败
    let targetDir = newDir;
    if (app.vault.getAbstractFileByPath(targetDir)) {
        const baseName = sanitizeFolderName(task.name);
        let index = 2;
        while (app.vault.getAbstractFileByPath(targetDir)) {
            targetDir = `${parentDir}/${baseName} (${index})`;
            index += 1;
        }
    }

    const folder = app.vault.getAbstractFileByPath(oldDir);
    if (folder instanceof TFolder) {
        try {
            await app.vault.rename(folder, targetDir);
        } catch {
            return false;
        }
    }
    // 任务自身与后代任务的任务文件目录统一改写前缀（「任务文件」子目录名保持不变）
    const prefix = `${oldDir}/`;
    for (const item of tasks) {
        const dir = getTaskFileDir(item);
        if (dir && dir.startsWith(prefix)) {
            setTaskFileDir(item, `${targetDir}/${dir.slice(prefix.length)}`);
        }
    }
    return true;
}
