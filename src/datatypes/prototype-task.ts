// 原型任务数据：界面视图「任务面板」中新建的主线 / 支线任务原型，独立持久化。
// 与收集盒任务（InboxItem）无关，仅作为界面视图的原型数据。

import type { TaskStatus } from './domain';
import type { TaskSection, TaskSectionDisplayMap } from './task-section';

/** 原型任务类型：主线 / 支线 */
export type PrototypeTaskType = 'main' | 'side';

/** 任务习惯设置 */
export interface TaskHabit {
    /** 是否启用习惯 */
    enabled: boolean;
    /** 习惯时间（HH:mm） */
    time: string;
    /** 生效星期（1 = 周一 … 7 = 周日） */
    weekdays: number[];
}

/** 任务目标条目（任务详情「目标」清单） */
export interface TaskGoalEntry {
    id: string;
    /** 目标名称 */
    text: string;
    /** 创建时间（时间戳） */
    createdAt: number;
    /** 截止日期（YYYY-MM-DD，可选） */
    dueDate?: string;
    /** 绑定的子任务 id 列表（可选，目标达成即推进对应子任务） */
    subtaskIds?: string[];
    /** 是否已手动标记完成（可选，缺省视为未完成） */
    done?: boolean;
    /** 分配的起始周（周键，如 2026-W45，可选） */
    startWeek?: string;
    /** 分配的结束周（周键，如 2026-W47，可选） */
    endWeek?: string;
}

/** 日目标条目（任务详情「一周目标」选项卡，按日期记录） */
export interface TaskDayGoalEntry {
    id: string;
    /** 目标名称 */
    text: string;
    /** 是否已完成（可选，缺省视为未完成） */
    done?: boolean;
    /** 创建时间（时间戳） */
    createdAt: number;
}

/** 原型任务 */
export interface PrototypeTask {
    id: string;
    /** 任务名称 */
    name: string;
    /** 任务类型 */
    type: PrototypeTaskType;
    /** 父任务 id（子任务使用；根任务为空） */
    parentId?: string;
    /** 任务描述 */
    description?: string;
    /** 任务分类 id（对应图例分类） */
    categoryId?: string;
    /** 任务状态（可选，旧任务无此字段，默认未开始） */
    status?: TaskStatus;
    /** 任务板块（清单 / 日目标 / 本周描述 / 目标 / 文件 / 习惯），数组顺序即展示顺序 */
    sections?: TaskSection[];
    /** 板块显示设置（auto / on / off，未配置按 auto；仅影响展示，不删除数据） */
    sectionDisplay?: TaskSectionDisplayMap;
    /** 是否已归档（归档任务在界面中隐藏，数据仍保留） */
    archived?: boolean;
    /** 创建时间戳 */
    createdAt: number;
}