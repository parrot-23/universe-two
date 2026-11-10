// GTD 领域仓库：封装收集箱条目与源的增删改业务逻辑。
// 视图不再直接 push/filter 数据，改调本仓库方法；底层仍操作 base-repo 持有的同一 gtdData 引用。
import type { GtdData, GtdItem, GtdSource, GtdSourceType } from '../datatypes/gtd';
import type { ChecklistItem } from '../datatypes/domain';
import type { PrototypeTask } from '../datatypes/prototype-task';
import { appendChecklist } from '../shared/task-sections';
import type { BaseRepo } from './base-repo';

/**
 * GTD 领域仓库：只管 gtdData（收集箱条目 + 源列表）。
 * 通过 baseRepo 拿到 gtdData 引用，写操作后由调用方触发 baseRepo.saveAll()。
 */
export class GtdRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 获取 GTD 数据引用（视图读取用） */
    get data(): GtdData {
        return this.baseRepo.data!.gtdData;
    }

    /** 追加一条收集箱条目（收集视图输入） */
    addItem(content: string): GtdItem {
        const item: GtdItem = {
            id: crypto.randomUUID(),
            content,
            createdAt: Date.now(),
            status: 'inbox',
        };
        this.data.items.push(item);
        return item;
    }

    /** 删除一条收集箱条目（原地替换数组内容，保持数组引用不变） */
    removeItem(id: string): void {
        const items = this.data.items;
        items.splice(0, items.length, ...items.filter((it) => it.id !== id));
    }

    /** 追加一个源（组织视图设置页） */
    addSource(type: GtdSourceType): GtdSource {
        const source: GtdSource = {
            id: crypto.randomUUID(),
            type,
            createdAt: Date.now(),
        };
        this.data.sources.push(source);
        return source;
    }

    /** 删除一个源（原地替换数组内容，保持数组引用不变） */
    removeSource(id: string): void {
        const sources = this.data.sources;
        sources.splice(0, sources.length, ...sources.filter((s) => s.id !== id));
    }

    /** 未处理条目（收集/梳理视图左栏） */
    getPendingItems(): GtdItem[] {
        return this.data.items.filter((it) => it.status === 'inbox');
    }

    /** 已处理条目（回顾视图回廊） */
    getProcessedItems(): GtdItem[] {
        return this.data.items.filter((it) => it.status === 'processed');
    }

    /**
     * 梳理：把收集条目内容放入目标任务的清单，并标记该条目为已处理。
     * @param itemId 收集条目 id
     * @param task 目标任务
     * @returns 是否成功（条目或任务不存在时返回 false）
     */
    clarify(itemId: string, task: PrototypeTask | undefined): boolean {
        const item = this.data.items.find((it) => it.id === itemId);
        if (!item || !task) return false;

        const entry: ChecklistItem = {
            id: `checklist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text: item.content,
            createdAt: Date.now(),
        };
        appendChecklist(task, entry);

        item.status = 'processed';
        return true;
    }
}
