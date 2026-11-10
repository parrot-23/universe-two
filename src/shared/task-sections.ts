// 任务板块访问器：所有读写任务板块的地方统一走这里。
// 视图与仓库不再直接操作具体字段，避免板块结构变化时到处改动。

import type { ChecklistItem } from '../datatypes/domain';
import type { PrototypeTask, TaskDayGoalEntry, TaskGoalEntry, TaskHabit } from '../datatypes/prototype-task';
import type { SectionType, TaskSection, TaskSectionOf, TaskSectionPayloadMap } from '../datatypes/task-section';
import { SECTION_REGISTRY } from './section-registry';

/** 生成板块实例 id */
function createSectionId(): string {
    return `section_${crypto.randomUUID()}`;
}

/** 各板块类型的初始载荷 */
function createPayload<K extends SectionType>(type: K): TaskSectionPayloadMap[K] {
    switch (type) {
        case 'checklist':
            return { items: [] } as TaskSectionPayloadMap[K];
        case 'dayGoals':
            return { entries: {} } as TaskSectionPayloadMap[K];
        case 'weekNote':
            return { notes: {} } as TaskSectionPayloadMap[K];
        case 'goals':
            return { items: [] } as TaskSectionPayloadMap[K];
        case 'files':
            return {} as TaskSectionPayloadMap[K];
        case 'habit':
            return { enabled: false, time: '09:00', weekdays: [1, 2, 3, 4, 5, 6, 7] } as TaskSectionPayloadMap[K];
    }
}

/** 读取任务的全部板块（无板块时返回空数组） */
export function getSections(task: PrototypeTask): TaskSection[] {
    return task.sections ?? [];
}

/** 读取指定类型的板块（不存在时返回 undefined） */
export function getSection<K extends SectionType>(task: PrototypeTask, type: K): TaskSectionOf<K> | undefined {
    return task.sections?.find((section): section is TaskSectionOf<K> => section.type === type);
}

/** 是否存在指定类型的板块 */
export function hasSection(task: PrototypeTask, type: SectionType): boolean {
    return !!getSection(task, type);
}

/** 获取指定类型的板块，不存在时创建（打开胶囊 / 首次写入时使用） */
export function ensureSection<K extends SectionType>(task: PrototypeTask, type: K): TaskSectionOf<K> {
    const existing = getSection(task, type);
    if (existing) return existing;
    const section = {
        id: createSectionId(),
        type,
        payload: createPayload(type),
        createdAt: Date.now(),
    } as unknown as TaskSectionOf<K>;
    if (!task.sections) task.sections = [];
    task.sections.push(section);
    return section;
}

/** 移除指定类型的板块（仅显式「移除板块」时调用） */
export function removeSection(task: PrototypeTask, type: SectionType): void {
    if (!task.sections) return;
    task.sections = task.sections.filter((section) => section.type !== type);
}

/** 解析持久化的板块数组（兼容旧数据 / 非法数据：返回 undefined 表示无板块） */
export function parseTaskSections(raw: unknown): TaskSection[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const sections: TaskSection[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.type !== 'string') continue;
        const def = SECTION_REGISTRY[r.type as SectionType];
        // 未知板块类型：保留原条目（不渲染），避免新版数据被旧版覆盖丢失
        if (!def) {
            sections.push(item as TaskSection);
            continue;
        }
        const payload = def.parsePayload(r.payload);
        if (!payload) continue;
        sections.push({
            id: r.id,
            type: r.type,
            payload,
            createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
            ...(r.collapsed === true ? { collapsed: true } : {}),
            ...(typeof r.updatedAt === 'number' ? { updatedAt: r.updatedAt } : {}),
        } as unknown as TaskSection);
    }
    return sections.length > 0 ? sections : undefined;
}

/* ---------------- 旧字段迁移 ---------------- */

/**
 * 由旧版任务字段生成板块数组（一次性迁移使用）。
 * 旧字段顺序：清单 / 日目标 / 本周描述 / 目标 / 文件 / 习惯。
 */
export function createSectionsFromLegacy(raw: Record<string, unknown>): TaskSection[] | undefined {
    const sections: TaskSection[] = [];
    const push = (type: SectionType, payload: unknown) => {
        if (!payload) return;
        // 旧数据里的空载荷不生成板块（新数据中的空板块由显式写入产生，不会走到这里）
        if (SECTION_REGISTRY[type].isEmpty(payload)) return;
        sections.push({ id: createSectionId(), type, payload, createdAt: 0 } as unknown as TaskSection);
    };
    push('checklist', SECTION_REGISTRY.checklist.parsePayload(raw.checklist));
    push('dayGoals', SECTION_REGISTRY.dayGoals.parsePayload(raw.dayGoals));
    push('weekNote', SECTION_REGISTRY.weekNote.parsePayload(raw.weekGoals));
    push('goals', SECTION_REGISTRY.goals.parsePayload(raw.goals));
    push('files', SECTION_REGISTRY.files.parsePayload({ fileDir: raw.fileDir, fileTimestamp: raw.fileTimestamp }));
    push('habit', SECTION_REGISTRY.habit.parsePayload(raw.habit));
    return sections.length > 0 ? sections : undefined;
}

/* ---------------- 清单 ---------------- */

/** 读取清单条目 */
export function getChecklist(task: PrototypeTask): ChecklistItem[] {
    return getSection(task, 'checklist')?.payload.items ?? [];
}

/** 写入清单条目（空数组也保留板块） */
export function setChecklist(task: PrototypeTask, items: ChecklistItem[]): void {
    const section = ensureSection(task, 'checklist');
    section.payload.items = items;
    section.updatedAt = Date.now();
}

/** 追加一条清单条目 */
export function appendChecklist(task: PrototypeTask, item: ChecklistItem): void {
    setChecklist(task, [...getChecklist(task), item]);
}

/* ---------------- 日目标 ---------------- */

/** 读取某天的日目标 */
export function getDayGoalEntries(task: PrototypeTask, dayKey: string): TaskDayGoalEntry[] {
    return getSection(task, 'dayGoals')?.payload.entries[dayKey] ?? [];
}

/** 写入某天的日目标（空数组即删除该天条目） */
export function setDayGoalEntries(task: PrototypeTask, dayKey: string, entries: TaskDayGoalEntry[]): void {
    const existing = getSection(task, 'dayGoals');
    if (!existing && entries.length === 0) return;
    const section = existing ?? ensureSection(task, 'dayGoals');
    if (entries.length > 0) section.payload.entries[dayKey] = entries;
    else delete section.payload.entries[dayKey];
    section.updatedAt = Date.now();
}

/* ---------------- 本周描述 ---------------- */

/** 读取某周的本周描述 */
export function getWeekNote(task: PrototypeTask, weekKey: string): string {
    return getSection(task, 'weekNote')?.payload.notes[weekKey] ?? '';
}

/** 写入某周的本周描述（空字符串即删除该周条目） */
export function setWeekNote(task: PrototypeTask, weekKey: string, note: string): void {
    const existing = getSection(task, 'weekNote');
    if (!note.trim()) {
        if (!existing) return;
        delete existing.payload.notes[weekKey];
        existing.updatedAt = Date.now();
        return;
    }
    const section = existing ?? ensureSection(task, 'weekNote');
    section.payload.notes[weekKey] = note;
    section.updatedAt = Date.now();
}

/* ---------------- 目标 ---------------- */

/** 读取目标清单 */
export function getTaskGoals(task: PrototypeTask): TaskGoalEntry[] {
    return getSection(task, 'goals')?.payload.items ?? [];
}

/** 写入目标清单（空数组也保留板块） */
export function setTaskGoals(task: PrototypeTask, goals: TaskGoalEntry[]): void {
    const section = ensureSection(task, 'goals');
    section.payload.items = goals;
    section.updatedAt = Date.now();
}

/* ---------------- 任务文件 ---------------- */

/** 读取任务文件目录（未生成时为空字符串） */
export function getTaskFileDir(task: PrototypeTask): string {
    return getSection(task, 'files')?.payload.fileDir ?? '';
}

/** 读取任务文件新建时是否加时间戳 */
export function getTaskFileTimestamp(task: PrototypeTask): boolean {
    return getSection(task, 'files')?.payload.fileTimestamp === true;
}

/** 写入任务文件目录 */
export function setTaskFileDir(task: PrototypeTask, dir: string): void {
    const section = ensureSection(task, 'files');
    if (dir) section.payload.fileDir = dir;
    else delete section.payload.fileDir;
    section.updatedAt = Date.now();
}

/** 写入任务文件是否加时间戳 */
export function setTaskFileTimestamp(task: PrototypeTask, enabled: boolean): void {
    const section = ensureSection(task, 'files');
    if (enabled) section.payload.fileTimestamp = true;
    else delete section.payload.fileTimestamp;
    section.updatedAt = Date.now();
}

/** 复制任务文件配置到另一个任务 */
export function copyTaskFiles(task: PrototypeTask, target: PrototypeTask): void {
    const dir = getTaskFileDir(task);
    const timestamp = getTaskFileTimestamp(task);
    if (!dir && !timestamp) return;
    const section = ensureSection(target, 'files');
    if (dir) section.payload.fileDir = dir;
    if (timestamp) section.payload.fileTimestamp = true;
    section.updatedAt = Date.now();
}

/* ---------------- 习惯 ---------------- */

/** 读取习惯设置（未创建板块时返回 undefined） */
export function getTaskHabit(task: PrototypeTask): TaskHabit | undefined {
    return getSection(task, 'habit')?.payload;
}

/** 写入习惯设置 */
export function setTaskHabit(task: PrototypeTask, habit: TaskHabit): void {
    const section = ensureSection(task, 'habit');
    section.payload = habit;
    section.updatedAt = Date.now();
}
