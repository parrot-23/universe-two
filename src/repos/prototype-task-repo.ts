// 原型任务领域仓库：管理界面视图「任务面板」新建的主线 / 支线任务原型。
// 通过 baseRepo 拿到 prototypeTasks 引用，写操作后由调用方触发 baseRepo.saveAll()。
import type { PrototypeTask, PrototypeTaskType } from '../datatypes/prototype-task';
import type { BaseRepo } from './base-repo';

export class PrototypeTaskRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 原型任务列表引用（视图读取用，已剔除归档任务） */
    get tasks(): PrototypeTask[] {
        return this.allTasks.filter((task) => task.archived !== true);
    }

    /** 全量原型任务（含归档，仓库内部读写用） */
    get allTasks(): PrototypeTask[] {
        return this.baseRepo.data!.prototypeTasks;
    }

    /** 已归档的根任务（归档列表展示用，按创建时间从新到旧） */
    get archivedRootTasks(): PrototypeTask[] {
        return this.allTasks
            .filter((task) => task.archived === true && !task.parentId)
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /** 新增原型任务（parentId 存在时作为该任务的子任务） */
    add(name: string, type: PrototypeTaskType, parentId?: string): PrototypeTask {
        const task: PrototypeTask = {
            id: `prototype_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            type,
            createdAt: Date.now(),
        };
        if (parentId) task.parentId = parentId;
        this.allTasks.push(task);
        return task;
    }

    /** 归档任务：从所有界面隐藏，数据仍保留在存储中 */
    archive(taskId: string): void {
        const task = this.allTasks.find((item) => item.id === taskId);
        if (task) task.archived = true;
    }

    /** 移出归档：恢复任务到正常任务列表 */
    unarchive(taskId: string): void {
        const task = this.allTasks.find((item) => item.id === taskId);
        if (task) task.archived = undefined;
    }

    /** 删除任务：连同其所有后代任务一并删除，返回被删除的任务 id 列表 */
    remove(taskId: string): string[] {
        const all = this.allTasks;
        if (!all.some((item) => item.id === taskId)) return [];
        const removedIds = new Set<string>();
        const collect = (id: string): void => {
            if (removedIds.has(id)) return;
            removedIds.add(id);
            for (const task of all) {
                if (task.parentId === id) collect(task.id);
            }
        };
        collect(taskId);
        for (let i = all.length - 1; i >= 0; i -= 1) {
            if (removedIds.has(all[i].id)) all.splice(i, 1);
        }
        return Array.from(removedIds);
    }

    /** 更新任务名称 / 描述 / 分类 / 类型（任务不存在时忽略） */
    update(
        taskId: string,
        patch: { name?: string; description?: string; categoryId?: string; type?: PrototypeTaskType },
    ): void {
        const task = this.tasks.find((item) => item.id === taskId);
        if (!task) return;
        if (patch.name !== undefined) task.name = patch.name;
        if (patch.description !== undefined) task.description = patch.description;
        if (patch.categoryId !== undefined) task.categoryId = patch.categoryId;
        if (patch.type !== undefined) task.type = patch.type;
    }
}