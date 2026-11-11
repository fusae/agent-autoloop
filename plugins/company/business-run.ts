import { registeredProactive } from "./proactive.ts";
import { recoverRabbitPublications } from "./rabbitrun-recovery.ts";
import { syncDecisionCards } from "./decision-cards.ts";
import { publicationResults } from "./publication-policy.ts";
import { manualXNotice } from "./rabbitrun.ts";
import { collectFeedback } from "./feedback.ts";
import { ModelBudget } from "./model-budget.ts";
import { scheduledReport } from "./reporting.ts";
import { localDay } from "./workday.ts";
import { workflows } from "./company.ts";
import { syncOwnerReplyCards, syncTopicCards } from "./owner-replies.ts";
import { failedWork, pendingVerifications } from "./recovery.ts";
import { hubClient } from "../../protocol/client.ts";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { collectSources } from "./sources.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Operations } from "./operations.ts";
import { Businesses } from "./business.ts";
import { Company, type Context } from "./company.ts";
const [configFile, contextFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, "utf8"));
const office = new Company(config);
const businesses = new Businesses(dirname(configFile));
const operations = new Operations(dirname(configFile));
try {
  const context: Context = JSON.parse(readFileSync(contextFile, "utf8"));
  const batch = createHash("sha256")
    .update(
      JSON.stringify({
        events: context.events.map((e) => [e.source, e.id]).sort(),
        answers: context.answers.map((a) => a.card).sort((a, b) => a - b),
      }),
    )
    .digest("hex");
  await collectSources(dirname(configFile));
  recoverRabbitPublications(dirname(configFile), office, operations);
  const tasks = office.tasks(),
    now = new Date();
  const depth = Math.max(0, ...context.events.map((e) => e.hops ?? 0));
  const proactive = operations.plan(batch, businesses.list(), tasks, now, context.answers, depth, context.events);
  const legacy = depth <= 1 ? businesses.plan(batch, tasks, now, 100 - (proactive.events?.length ?? 0)) : {};
  let failures: ReturnType<typeof failedWork> = [];
  const hubFile = join(dirname(configFile), "hub/config.json");
  if (existsSync(hubFile)) {
    const cfg = JSON.parse(readFileSync(hubFile, "utf8"));
    try {
      const client = hubClient(cfg.url, cfg.owner),
        runs: any[] = [];
      try {
        await syncOwnerReplyCards(dirname(configFile), operations.executive(), client);
        await syncTopicCards(dirname(configFile), client);
        await syncDecisionCards(dirname(configFile), client);
      } catch {
        /* Card sync is retried on the next tick without blocking task recovery. */
      }
      let before: number | undefined;
      for (let page = 0; page < 5; page++) {
        const state = await client.state(before),
          chunk = state.runs ?? [];
        if (!chunk.length) break;
        runs.push(...chunk);
        before = Math.min(...chunk.map((r: any) => r.id));
        if (chunk.length < 20) break;
      }
      failures = depth <= 1 ? failedWork(office, runs, now, pendingVerifications(dirname(configFile))) : [];
    } catch {
      /* Hub outages are already retried by the worker. */
    }
  }
  const resume = (task: (typeof tasks)[number]) => ({
    id: `company:resume:${task.id}:${batch}`,
    type: "company.task.resume",
    subject: task.id,
    summary: "继续排队工作",
    detail: "{}",
  });
  const paused = operations.pausedTasks(businesses.list(), tasks, now);
  const queued = tasks.filter((t) => t.status === "queued" && !paused.has(t.id));
  const resumes = config.dailyModelRuns ? [] : queued.map(resume);
  if (config.dailyModelRuns) {
    const budget = new ModelBudget(dirname(configFile), config);
    try {
      for (const task of queued) {
        const reportDate =
          task.kind === "ceo"
            ? ((config.reporting?.enabled ? scheduledReport(dirname(configFile), task.id) : undefined) ??
              registeredProactive(dirname(configFile), task.id)?.date)
            : undefined;
        // Expired scheduled work resumes only to record its terminal state, without a model.
        if (
          !(reportDate && reportDate < localDay(now)) &&
          !budget.available(workflows[task.kind][task.stage], now, task.id)
        )
          continue;
        resumes.push(resume(task));
      }
      const usage = budget.snapshot(now);
      if (usage.limited && existsSync(hubFile)) {
        const cfg = JSON.parse(readFileSync(hubFile, "utf8"));
        await hubClient(cfg.url, cfg.source.key).tell({
          key: `company-model-limit-${usage.date}`,
          text: `今天的模型调用已达到上限（已用 ${usage.total} 次）。未完成工作已保留，明天继续；你的飞书消息仍会处理。`,
        });
      }
    } finally {
      budget.close();
    }
  }
  if (existsSync(hubFile)) {
    const cfg = JSON.parse(readFileSync(hubFile, "utf8"));
    for (const proof of publicationResults(dirname(configFile)).filter((p) => p.x && p.x.state !== "published")) {
      await hubClient(cfg.url, cfg.source.key).tell({
        key: `rabbitrun-x-manual-${proof.key}`,
        text: manualXNotice(proof.key),
      });
    }
  }
  await collectFeedback(
    dirname(configFile),
    operations.executive(),
    now,
    undefined,
    existsSync(hubFile)
      ? async (key, text) => {
          const cfg = JSON.parse(readFileSync(hubFile, "utf8"));
          return hubClient(cfg.url, cfg.source.key).tell({ key, text });
        }
      : undefined,
  );
  const events = [...(proactive.events ?? []), ...(legacy.events ?? []), ...failures, ...resumes].slice(0, 100);
  const receipt = { ...proactive, ...(events.length ? { events } : {}) };
  if (config.health?.enabled) {
    const heartbeat = join(dirname(configFile), "health-heartbeat.json");
    writeFileSync(heartbeat + ".tmp", JSON.stringify({ at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(heartbeat + ".tmp", heartbeat);
  }
  process.stdout.write(`经营周期已检查。\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\`\n`);
} finally {
  operations.close();
  businesses.close();
  office.close();
}
