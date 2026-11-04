// Only terminal worker runs are reconciled; queued retries and live executions remain owned by the hub.
import { workflows, type Receipt, type Company } from "./company.ts";
export function failedWork(office: Company, runs: any[], now = new Date()): NonNullable<Receipt["events"]> {
  const events: NonNullable<Receipt["events"]> = [];
  for (const t of office.tasks()) {
    if (t.status !== "active") continue;
    const role = workflows[t.kind][t.stage],
      last = office.history(t.id).at(-1);
    const run = runs
      .filter((r) => r.agent === `company-${role}` && r.events?.some((e: any) => e.subject === t.id))
      .sort((a, b) => b.id - a.id)[0];
    if (!run || !["failed", "cancelled", "done", "nothing"].includes(run.state) || !run.finishedAt) continue;
    if (
      Date.parse(run.createdAt) < Date.parse(String(last?.at)) - 1000 ||
      now.getTime() - Date.parse(run.finishedAt) < 90000
    )
      continue;
    events.push({
      id: `company:failed:${t.id}:${t.assignment}:${run.id}`,
      type: "company.task.failed",
      subject: t.id,
      summary: "执行状态核对",
      detail: JSON.stringify({
        assignment: t.assignment,
        reason: `运行失败：${String(run.error || "执行结束但未提交有效部门报告").slice(0, 250)}`,
      }),
    });
  }
  return events.slice(0, 20);
}
