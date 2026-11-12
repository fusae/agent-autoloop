import { xStatus } from "./rabbitrun.ts";
import {
  businessPublishPolicy,
  previewEnabled,
  previewDelivery,
  validatePublishPolicy,
  publicationChannel,
  publicationResults,
  publicationUsage,
} from "./publication-policy.ts";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { executePublication, type Publication } from "./publication.ts";
import { taskId, type Receipt } from "./company.ts";
import type { Result } from "../../protocol/validate.ts";

const [configFile, contextFile] = process.argv.slice(2);
const directory = dirname(configFile),
  context = JSON.parse(readFileSync(contextFile, "utf8"));
const events: NonNullable<Receipt["events"]> = [];
const later: NonNullable<Result["later"]> = [];
const inputs = [
  ...context.events
    .filter((e: any) => e.source === "company-office" && e.type === "company.work.publish")
    .map((e: any) => ({ ...JSON.parse(e.detail), task: e.subject, attempt: 0 })),
  ...(context.timers ?? [])
    .filter((t: any) => t.key.startsWith("publish-lookup-"))
    .map((t: any) => JSON.parse(t.about)),
];
for (const data of inputs) {
  const task = taskId(data.task);
  if (!Number.isSafeInteger(data.attempt) || data.attempt < 0 || data.attempt > 2) continue;
  const timer = `publish-lookup-${task}-${data.assignment}`;
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
        !approved ||
        (config.pipelineMode && (project.business === "jizhu" || approved.pipelineChecked !== data.publication))
      ) {
        if (data.attempt > 0) continue;
        throw Error("发布任务不在当前已审核范围内");
      }
      const channel = publicationChannel(directory, project.business);
      const policy = businessPublishPolicy(config, project.business);
      if (
        data.attempt === 0 &&
        channel &&
        (policy.publishDailyLimit !== undefined || policy.publishApproval !== undefined || policy.alwaysConfirm)
      ) {
        const results = publicationResults(directory);
        const reservations = projects.flatMap((p) => p.publishReservations ?? []);
        const usage = publicationUsage(results, reservations, channel, new Date(), directory);
        if (
          (approved.publishApproval ||
            policy.alwaysConfirm ||
            usage.successes < (policy.publishApproval?.confirmFirst ?? 0)) &&
          (approved.publishApproval?.state !== "approved" || approved.publishApproval.key !== data.publication)
        )
          throw Error("本篇发布尚未取得负责人确认，禁止执行");
        if (
          !policy.alwaysConfirm &&
          previewEnabled(config, usage.successes) &&
          !approved.publishApproval &&
          !results.some((p) => p.key === data.publication)
        ) {
          const preview = approved.publishPreview;
          if (!preview || preview.key !== data.publication) throw Error("本篇尚未发送发布预告，禁止执行");
          const delivery = previewDelivery(directory, preview);
          if (
            !delivery.deliveredAt ||
            delivery.cancelled ||
            Date.now() < Math.max(Date.parse(preview.publishAt), Date.parse(delivery.deliveredAt) + 3600_000)
          )
            throw Error("发布预告未送达满一小时或已取消，禁止执行");
        }
        if (
          policy.publishDailyLimit !== undefined &&
          !results.some((p) => p.key === data.publication) &&
          (!reservations.some((r: any) => r.key === data.publication && r.channel === channel) ||
            usage.today + usage.pending > policy.publishDailyLimit)
        )
          throw Error("发布任务缺少同渠道的有效额度预留，禁止执行");
      }
    } finally {
      office.close();
      operations.close();
    }
    // Legacy timers are lookup-only; all new readbacks finish in this invocation.
    const proof: Publication = executePublication(directory, data.publication, data.attempt > 0);
    const artifact = `tasks/${task}/publication.json`;
    mkdirSync(join(directory, "workspace/tasks", task), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "workspace", artifact), JSON.stringify(proof, null, 2), { mode: 0o600 });
    report = {
      assignment: data.assignment,
      verdict: "pass",
      summary: proof.x ? `币安广场已发布；${xStatus(proof.x)}` : "平台已确认内容发布，交验收核对",
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
  later.push({ key: timer, cancel: true });
}
process.stdout.write(`发布处理结束。\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events, later })}\n\`\`\`\n`);
