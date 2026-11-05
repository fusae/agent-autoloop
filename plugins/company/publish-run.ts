import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { executePublication } from "./publication.ts";
import { taskId, type Receipt } from "./company.ts";

const [configFile, contextFile] = process.argv.slice(2);
const directory = dirname(configFile),
  context = JSON.parse(readFileSync(contextFile, "utf8"));
const events: NonNullable<Receipt["events"]> = [];
for (const event of context.events) {
  if (event.source !== "company-office" || event.type !== "company.work.publish") continue;
  const data = JSON.parse(event.detail),
    task = taskId(event.subject);
  let report;
  try {
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    const office = new DatabaseSync(config.database, { readOnly: true });
    const operations = new DatabaseSync(join(directory, "operations.db"), { readOnly: true });
    try {
      const row = office.prepare("SELECT body FROM tasks WHERE id=?").get(task);
      const current = row ? JSON.parse(row.body as string) : null;
      const approved = operations
        .prepare("SELECT body FROM projects")
        .all()
        .some((row) =>
          JSON.parse(row.body as string).plans.some(
            (p: any) => p.task === task && p.publicationKey === data.publication && p.deliveryDecision === "publish",
          ),
        );
      if (
        !current ||
        current.kind !== "publish-content" ||
        current.status !== "active" ||
        current.stage !== 0 ||
        current.assignment !== data.assignment ||
        current.publication !== data.publication ||
        !approved
      )
        throw Error("发布任务不在当前已审核范围内");
    } finally {
      office.close();
      operations.close();
    }
    const proof = executePublication(directory, data.publication);
    const artifact = `tasks/${task}/publication.json`;
    mkdirSync(join(directory, "workspace/tasks", task), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "workspace", artifact), JSON.stringify(proof, null, 2), { mode: 0o600 });
    report = {
      assignment: data.assignment,
      verdict: "pass",
      summary: "平台已确认内容发布，交验收核对",
      artifacts: [artifact],
      evidence: [`${proof.channel}：${proof.url}`.slice(0, 150)],
      publication: proof,
    };
  } catch (error) {
    report = {
      assignment: data.assignment,
      verdict: "blocked",
      summary: (error as Error).message.slice(0, 400),
      artifacts: [],
      evidence: ["固定发布入口未取得可核验的平台结果"],
    };
  }
  events.push({
    id: `${task}:${data.assignment}:result`,
    type: "company.result",
    subject: task,
    summary: report.summary,
    detail: JSON.stringify(report),
  });
}
process.stdout.write(`发布处理结束。\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events })}\n\`\`\`\n`);
