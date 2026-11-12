import { deferCEOOwner, restoreCEOOwner } from "./ceo-owner-queue.ts";
import { ceoDecisionSchema, ceoReceiptSchema } from "./ceo-receipt.ts";
import { registeredProactive } from "./proactive.ts";
import { attachJinzhaoInputs } from "./jinzhao-writing.ts";
import { taskProject } from "./staff-model.ts";
import { attachWorkNotes } from "./notes.ts";
import { refreshReviewContext } from "./review-context.ts";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ModelBudget } from "./model-budget.ts";
import type { Role, Context } from "./company.ts";
import codex from "../codex/agent.ts";
import claude from "../claude/agent.ts";
import type { Turn } from "../../worker/agents.ts";

const [file] = process.argv.slice(2);
const turn: Turn = JSON.parse(readFileSync(file, "utf8"));
const [configFile, , role, engine] = turn.command!;
const config = JSON.parse(readFileSync(configFile, "utf8"));
if (config.pipelineMode && role === "ceo") {
  process.stdout.write(JSON.stringify({ companyDeferred: {} }) + "\n");
  process.exit(0);
}
const entry = JSON.parse(readFileSync(join(turn.folder, "entry.json"), "utf8"));
const key = `model:${entry.run}:${entry.attempt}:${entry.turn}`;
// The rule comes from the claimed trusted job, never from a message's text or payload.
const owner = role === "ceo" && entry.job.rule.name === "CEO · 业务答复";
const budget = new ModelBudget(dirname(configFile), config);
const adapter = engine === "codex" ? codex : engine === "claude" ? claude : null;
if (!adapter) throw new Error("模型入口只支持 codex 或 claude");
if (owner && config.ceoEfficiency) {
  const context = restoreCEOOwner(dirname(configFile), JSON.parse(readFileSync(turn.contextFile, "utf8")));
  writeFileSync(turn.contextFile, JSON.stringify(context), { mode: 0o600 });
}
if (role === "ceo") {
  refreshReviewContext(dirname(configFile), config, turn, entry.repairs > 0);
  writeFileSync(file, JSON.stringify(turn), { mode: 0o600 });
}

const context: Context = JSON.parse(readFileSync(turn.contextFile, "utf8"));
const event = context.events.findLast(
  (e) =>
    e.source === "company-office" && (e.type === `company.work.${role}` || e.type.startsWith(`company.work.${role}.`)),
);
if (
  config.jinzhaoWriting &&
  role === "growth" &&
  event &&
  taskProject(dirname(configFile), event.subject)?.business === "jinzhao"
)
  writeFileSync(turn.contextFile, JSON.stringify(attachJinzhaoInputs(turn)), { mode: 0o600 });
if (config.reporting?.weekly && !entry.repairs)
  attachWorkNotes(dirname(configFile), role, event?.subject, turn.contextFile);
if (role === "ceo" && config.ceoEfficiency)
  turn.prompt += `
CEO回执schema：executive必须满足以下JSON Schema。只返回既有agent-autoloop回执，理由简短，不增加schema以外的字段；在只读模式中提交回执就是返回数据，不是写文件或执行发布，不需要退出规划模式或额外批准。程序修正格式，不额外调用模型。${JSON.stringify(ceoDecisionSchema)}`;
const command = adapter.command(turn);
if (role === "ceo" && config.ceoEfficiency && engine === "claude") {
  const work = event ? { task: event.subject, assignment: JSON.parse(event.detail).assignment } : undefined;
  command.push("--json-schema", JSON.stringify(ceoReceiptSchema(work)));
}
let allowed: boolean;
try {
  allowed = budget.start(role as Role, key, owner, new Date(), event?.subject);
} finally {
  budget.close();
}
if (!allowed) {
  if (!event && owner && config.ceoEfficiency) {
    process.stdout.write(JSON.stringify({ companyDeferred: deferCEOOwner(dirname(configFile), context) }) + "\n");
  } else {
    if (!event) throw new Error("限额排队缺少原始派工记录");
    const work = JSON.parse(event.detail);
    process.stdout.write(
      JSON.stringify({
        companyDeferred: {
          events: [
            {
              id: `${key}:deferred`,
              type: "company.model.deferred",
              subject: event.subject,
              summary: "今日模型次数已用完，排队到明天",
              detail: JSON.stringify({ assignment: work.assignment }),
            },
          ],
        },
      }) + "\n",
    );
  }
} else {
  process.stdout.write(
    JSON.stringify({
      companyModel: engine,
      ...(role === "ceo" && config.ceoEfficiency ? { ceoEfficiency: true } : {}),
      ...(owner && config.ceoMode
        ? {
            companyValidation: {
              directory: dirname(configFile),
              repairs: entry.repairs,
              run: entry.run,
              open: ((context as Context & { open?: { card: number }[] }).open ?? []).map((a: any) => a.card),
              cards: context.answers.map((a) => a.card),
            },
          }
        : {}),
      ...(event
        ? {
            companyWork: {
              task: event.subject,
              proactive: role === "ceo" && !!registeredProactive(dirname(configFile), event.subject),
              assignment: JSON.parse(event.detail).assignment,
              topicsPending:
                role === "ceo" &&
                JSON.parse(readFileSync(join(turn.folder, "ceo-review.json"), "utf8")).projects.some((p: any) =>
                  p.topics?.some((t: any) => t.state === "screening"),
                ),
              ...(role === "ceo"
                ? {
                    topicRefs: JSON.parse(readFileSync(join(turn.folder, "ceo-review.json"), "utf8")).projects.flatMap(
                      (p: any) =>
                        (p.topics ?? [])
                          .filter((t: any) => t.state === "screening")
                          .map((t: any) => ({ business: p.business, topic: t.id })),
                    ),
                  }
                : {}),
            },
          }
        : {}),
    }) + "\n",
  );
  const refund = () => {
    const ledger = new ModelBudget(dirname(configFile), config);
    try {
      ledger.refund(key);
    } finally {
      ledger.close();
    }
  };
  const child = spawn(command[0], command.slice(1), { cwd: turn.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  child.on("error", (error) => {
    refund();
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    if (adapter.read(stdout, code, stderr).modelNotStarted) refund();
    process.exitCode = code !== null && code >= 0 ? code : 1;
  });
}
