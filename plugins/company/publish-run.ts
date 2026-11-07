import {
  validatePublishPolicy,
  publicationChannel,
  publicationResults,
  publicationUsage,
} from "./publication-policy.ts";
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
      validatePublishPolicy(config);
      const projects = operations
        .prepare("SELECT body FROM projects")
        .all()
        .map((row) => JSON.parse(row.body as string));
      const project = projects.find((p) =>
        p.plans.some(
          (p: any) => p.task === task && p.publicationKey === data.publication && p.deliveryDecision === "publish",
        ),
      );
      const approved = project?.plans.find(
        (p: any) => p.task === task && p.publicationKey === data.publication && p.deliveryDecision === "publish",
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
      const channel = publicationChannel(directory, project.business);
      if (channel && (config.publishDailyLimit !== undefined || config.publishApproval !== undefined)) {
        const results = publicationResults(directory);
        const reservations = projects.flatMap((p) => p.publishReservations ?? []);
        const usage = publicationUsage(results, reservations, channel, new Date());
        if (
          (approved.publishApproval || usage.successes < (config.publishApproval?.confirmFirst ?? 0)) &&
          (approved.publishApproval?.state !== "approved" || approved.publishApproval.key !== data.publication)
        )
          throw Error("本篇发布尚未取得负责人确认，禁止执行");
        if (
          config.publishDailyLimit !== undefined &&
          !results.some((p) => p.key === data.publication) &&
          (!reservations.some((r: any) => r.key === data.publication && r.channel === channel) ||
            usage.today + usage.pending > config.publishDailyLimit)
        )
          throw Error("发布任务缺少同渠道的有效额度预留，禁止执行");
      }
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
