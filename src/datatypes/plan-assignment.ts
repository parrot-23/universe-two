// 计划排布数据契约：界面视图「计划一周面板」中，把任务排布到某一天列上的结果。
// 一条记录 = 周键 + 星期 + 任务 id，独立持久化，与原型任务数据分离。

/** 计划排布：某周某一天排布的任务 */
export interface PlanAssignment {
    /** 周键，如 2026-W43 */
    weekKey: string;
    /** 星期：1=周一 … 7=周日 */
    weekday: number;
    /** 原型任务 id */
    taskId: string;
    /** 排布时间戳 */
    createdAt: number;
}

/** 整周排布：某年某周整体排布的任务（年视图周格子） */
export interface WeekAssignment {
    /** 周键，如 2026-W43 */
    weekKey: string;
    /** 原型任务 id */
    taskId: string;
    /** 排布时间戳 */
    createdAt: number;
}

/** 计划排布数据 */
export interface PlanAssignmentData {
    /** 按天排布（周视图） */
    assignments: PlanAssignment[];
    /** 按周排布（年视图），旧数据缺失时视为空 */
    weekAssignments: WeekAssignment[];
    /** 周描述：周键 → 本周的具体描述文本，旧数据缺失时视为空 */
    weekNotes?: Record<string, string>;
}
