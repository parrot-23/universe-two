// 计划排布领域仓库：管理界面视图「计划一周面板」上任务到天列的排布数据。
// 通过 baseRepo 拿到 planAssignmentData 引用，写操作后由调用方触发 baseRepo.saveAll()。
import type { PlanAssignment, PlanAssignmentData, WeekAssignment } from '../datatypes/plan-assignment';
import type { BaseRepo } from './base-repo';

export class PlanAssignmentRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 计划排布数据引用（视图读取用） */
    get data(): PlanAssignmentData {
        return this.baseRepo.data!.planAssignmentData;
    }

    /** 某一周某一天已排布的任务（按排布顺序） */
    dayAssignments(weekKey: string, weekday: number): PlanAssignment[] {
        return this.data.assignments.filter(
            (assignment) => assignment.weekKey === weekKey && assignment.weekday === weekday,
        );
    }

    /** 把任务排布到某一天；同一天重复排布同一任务时直接返回已有记录 */
    add(weekKey: string, weekday: number, taskId: string): PlanAssignment {
        const existing = this.data.assignments.find(
            (assignment) => assignment.weekKey === weekKey
                && assignment.weekday === weekday
                && assignment.taskId === taskId,
        );
        if (existing) return existing;
        const assignment: PlanAssignment = { weekKey, weekday, taskId, createdAt: Date.now() };
        this.data.assignments.push(assignment);
        return assignment;
    }

    /** 某一周已整周排布的任务（按排布顺序） */
    weekAssignments(weekKey: string): WeekAssignment[] {
        return this.data.weekAssignments.filter((assignment) => assignment.weekKey === weekKey);
    }

    /** 某个任务的全部整周排布（按排布顺序） */
    taskWeekAssignments(taskId: string): WeekAssignment[] {
        return this.data.weekAssignments.filter((assignment) => assignment.taskId === taskId);
    }

    /** 把任务整周排布到某一周；重复排布同一任务时直接返回已有记录 */
    addWeek(weekKey: string, taskId: string): WeekAssignment {
        const existing = this.data.weekAssignments.find(
            (assignment) => assignment.weekKey === weekKey && assignment.taskId === taskId,
        );
        if (existing) return existing;
        const assignment: WeekAssignment = { weekKey, taskId, createdAt: Date.now() };
        this.data.weekAssignments.push(assignment);
        return assignment;
    }

    /** 移除某一周已整周排布的任务；不存在时忽略 */
    removeWeek(weekKey: string, taskId: string): void {
        const assignments = this.data.weekAssignments;
        const index = assignments.findIndex(
            (assignment) => assignment.weekKey === weekKey && assignment.taskId === taskId,
        );
        if (index >= 0) assignments.splice(index, 1);
    }

    /** 某一周的具体描述（未填写时返回空串） */
    weekNote(weekKey: string): string {
        return this.data.weekNotes?.[weekKey] ?? '';
    }

    /** 写入某一周的具体描述；内容为空时删除该键 */
    setWeekNote(weekKey: string, text: string): void {
        const notes = (this.data.weekNotes ??= {});
        const trimmed = text.trim();
        if (trimmed) notes[weekKey] = trimmed;
        else delete notes[weekKey];
    }

    /** 移除某一天已排布的任务；不存在时忽略 */
    remove(weekKey: string, weekday: number, taskId: string): void {
        const assignments = this.data.assignments;
        const index = assignments.findIndex(
            (assignment) => assignment.weekKey === weekKey
                && assignment.weekday === weekday
                && assignment.taskId === taskId,
        );
        if (index >= 0) assignments.splice(index, 1);
    }
}
