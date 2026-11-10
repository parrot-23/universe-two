// 任务板块（section）：挂在原型任务上的统一板块模型。
// 所有任务附属数据（清单 / 日目标 / 本周描述 / 目标 / 文件 / 习惯）都以板块形式存放在 task.sections 中，
// 数组顺序即展示顺序；缺省表示该任务没有任何板块。

import type { ChecklistItem } from './domain';
import type { TaskDayGoalEntry, TaskGoalEntry, TaskHabit } from './prototype-task';

/** 各板块类型对应的载荷结构 */
export interface TaskSectionPayloadMap {
    /** 清单 */
    checklist: { items: ChecklistItem[] };
    /** 日目标（键为日期 YYYY-MM-DD） */
    dayGoals: { entries: Record<string, TaskDayGoalEntry[]> };
    /** 本周描述（键为周键 YYYY-Www） */
    weekNote: { notes: Record<string, string> };
    /** 目标清单 */
    goals: { items: TaskGoalEntry[] };
    /** 任务文件 */
    files: { fileDir?: string; fileTimestamp?: boolean };
    /** 习惯 */
    habit: TaskHabit;
}

/** 板块类型 */
export type SectionType = keyof TaskSectionPayloadMap;

/** 板块公共字段 */
export interface TaskSectionCommon {
    /** 板块实例 id */
    id: string;
    /** 是否折叠（仅影响展示） */
    collapsed?: boolean;
    /** 创建时间戳 */
    createdAt: number;
    /** 最近更新时间戳 */
    updatedAt?: number;
}

/** 板块：按 type 可辨识的联合类型 */
export type TaskSection = {
    [K in SectionType]: TaskSectionCommon & {
        type: K;
        payload: TaskSectionPayloadMap[K];
    };
}[SectionType];

/** 指定类型的板块 */
export type TaskSectionOf<K extends SectionType> = Extract<TaskSection, { type: K }>;
