import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
const entry = JSON.parse(readFileSync(join(turn.folder, "entry.json"), "utf8"));
const key = `model:${entry.run}:${entry.attempt}:${entry.turn}`;
// The rule comes from the claimed trusted job, never from a message's text or payload.
const owner = role === "ceo" && entry.job.rule.name === "CEO · 业务答复";
const budget = new ModelBudget(dirname(configFile), config);
const adapter = engine === "codex" ? codex : engine === "claude" ? claude : null;
if (!adapter) throw new Error("模型入口只支持 codex 或 claude");
const command = adapter.command(turn);
const context: Context = JSON.parse(readFileSync(turn.contextFile, "utf8"));
const event = context.events.findLast((e) => e.source === "company-office" && e.type === `company.work.${role}`);
let allowed: boolean;
try {
  allowed = budget.start(role as Role, key, owner, new Date(), event?.subject);
} finally {
  budget.close();
}
if (!allowed) {
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
} else {
  process.stdout.write(JSON.stringify({ companyModel: engine }) + "\n");
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
