import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompanyConfig, Report, Role, Task } from "./company.ts";
import { publicationResults } from "./publication-policy.ts";
import { draftStock, production, localDay, type WeeklyGoal } from "./workday.ts";

export type DailyReport = { done: string; result: string; blockers: string; tomorrow: string };
export type EmployeeReport = {
  date: string;
  entries: { task: string; assignment: number; at: string; report: DailyReport }[];
  summary: string;
  weeklyGoal?: WeeklyGoal;
};
export function dailyReport(value: any): DailyReport {
  const result = {} as DailyReport;
  for (const key of ["done", "result", "blockers", "tomorrow"] as const) {
    if (typeof value?.[key] !== "string" || !value[key].trim() || value[key].length > 180)
      throw Error("日报四项各需1–180字：做了什么、结果、卡点、明天打算");
    result[key] = value[key].trim();
  }
  return result;
}
export function validateReporting(config: Partial<CompanyConfig>) {
  if (config.reporting !== undefined && typeof config.reporting?.enabled !== "boolean") throw Error("汇报开关不正确");
  if (config.reporting?.weekly !== undefined && typeof config.reporting.weekly !== "boolean")
    throw Error("周复盘开关不正确");
  if (config.reporting?.weekly && !config.reporting.enabled) throw Error("周复盘需要启用汇报");
  if (config.reporting?.enabled && !config.ceoMode) throw Error("汇报需要启用CEO");
  if (config.workday?.prepareDrafts !== undefined && typeof config.workday.prepareDrafts !== "boolean")
    throw Error("提前备稿开关不正确");
}
export const reportTime = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`).toISOString();
export const ceoReportTime = (config: Partial<CompanyConfig>) => (config.health?.enabled ? "20:30" : "21:00");
export function nextReportTime(now: Date, time: string, done: boolean) {
  const at = new Date(reportTime(localDay(now), time));
  if (done) at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString();
}
// Old receipts have no timestamp; the existing office journal supplies their actual completion time.
export function employeeEntries(directory: string, tasks: Task[], role: Role, date: string) {
  let db: DatabaseSync | undefined;
  try {
    const file = join(directory, "company.db");
    if (existsSync(file)) db = new DatabaseSync(file, { readOnly: true });
    return tasks
      .filter((t) => t.kind !== "publish-content")
      .flatMap((t) =>
        t.reports
          .filter((r) => r.role === role)
          .flatMap((r) => {
            let at = r.at;
            if (!at && db) {
              const row = db
                .prepare(
                  "SELECT at FROM journal WHERE task=? AND kind=? AND json_extract(body,'$.assignment')=? ORDER BY seq LIMIT 1",
                )
                .get(t.id, `reported:${role}`, r.assignment);
              at = row?.at as string | undefined;
            }
            if (!at || localDay(new Date(at)) !== date) return [];
            return [{ task: t.id, assignment: r.assignment, at, report: r.dailyReport ?? fallbackReport(t, r) }];
          }),
      )
      .sort((a, b) => a.at.localeCompare(b.at));
  } finally {
    db?.close();
  }
}
function fallbackReport(task: Task, report: Report): DailyReport {
  return {
    done: task.title,
    result: report.summary,
    blockers:
      report.verdict === "pass"
        ? report.inspection?.questions?.map((q) => q.question).join("；") || "未报告卡点"
        : report.summary,
    tomorrow: "未提供，按周目标和未完事项安排",
  };
}

export function validateDraftPlan(
  directory: string,
  task: string,
  decision: import("./inspection.ts").Inspection,
  now: Date,
  topics = false,
) {
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const row of db.prepare("SELECT body FROM projects").all()) {
      const p = JSON.parse(row.body as string) as {
        plans: import("./operations.ts").Plan[];
        staff: import("./operations.ts").Employee[];
      };
      const employee = p.staff.find((s) => (s.workday?.task === task || s.lastTask === task) && s.role === "growth");
      if (!employee) continue;
      const stock = draftStock(p.plans, employee.weeklyGoal, publicationResults(directory), now);
      const making = decision.actions.filter((a) => (production(a.operation) || !a.operation) && a.kind === "content");
      if (
        !topics &&
        employee.workday?.task === task &&
        stock.needsProduction &&
        !making.length &&
        !stock.making &&
        !decision.noProductionReason
      )
        throw Error(
          "周目标未达且备稿不足2篇，今日计划须包含制作，或用inspection.noProductionReason说明理由；不能只因今日无发布名额而停工",
        );
      const added = making.filter((a) => !p.plans.some((p) => p.id === a.key || p.key === a.key)).length;
      if (added && stock.ready + stock.making + added > 2)
        throw Error("每项目待发备稿及制作中的稿件合计最多2篇，请复用已有稿件");
    }
  } finally {
    db.close();
  }
}

export function scheduledReport(directory: string, task?: string): string | undefined {
  const file = join(directory, "operations.db");
  if (!task || !existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM leadership WHERE id='company'").get();
    return row ? JSON.parse(row.body as string).eveningReports?.find((r: any) => r.task === task)?.date : undefined;
  } finally {
    db.close();
  }
}
