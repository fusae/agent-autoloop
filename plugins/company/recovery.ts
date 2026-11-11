// Only terminal worker runs are reconciled; queued retries and live executions remain owned by the hub.
import { workflows, type Receipt, type Company } from "./company.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type PendingVerification = { rule: string; key: string; about: string };
export function pendingVerifications(directory: string): PendingVerification[] {
  const file = join(directory, "hub/hub.db");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT rule,key,about FROM timers WHERE event_id IS NULL").all() as PendingVerification[];
  } finally {
    db.close();
  }
}

export function failedWork(
  office: Company,
  runs: any[],
  now = new Date(),
  waiting: PendingVerification[] = [],
): NonNullable<Receipt["events"]> {
  const events: NonNullable<Receipt["events"]> = [];
  for (const t of office.tasks()) {
    if (t.status !== "active") continue;
    const role = workflows[t.kind][t.stage],
      last = office.history(t.id).at(-1),
      agents =
        t.kind === "publish-content"
          ? [t.stage === 0 ? "company-publisher" : "company-verifier", `company-${role}`]
          : [`company-${role}`];
    const run = runs
      .filter((r) => agents.includes(r.agent) && r.events?.some((e: any) => e.subject === t.id))
      .sort((a, b) => b.id - a.id)[0];
    if (!run || !["failed", "cancelled", "done", "nothing"].includes(run.state) || !run.finishedAt) continue;
    if (
      Date.parse(run.createdAt) < Date.parse(String(last?.at)) - 1000 ||
      now.getTime() - Date.parse(run.finishedAt) < 90000
    )
      continue;
    // A completed fixed-program turn may have scheduled a lookup instead of a department report.
    if (
      t.kind === "publish-content" &&
      run.state === "done" &&
      waiting.some((timer) => {
        if (
          timer.rule !== run.rule ||
          timer.key !== `${t.stage === 0 ? "publish-lookup" : "verify"}-${t.id}-${t.assignment}`
        )
          return false;
        try {
          const data = JSON.parse(timer.about);
          return (
            data.task === t.id &&
            data.assignment === t.assignment &&
            data.publication === t.publication &&
            Number.isSafeInteger(data.attempt) &&
            data.attempt >= 1 &&
            data.attempt <= 2
          );
        } catch {
          return false;
        }
      })
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
