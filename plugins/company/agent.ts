import { writeFileSync } from "node:fs";
import codex from "../codex/agent.ts";
import claude from "../claude/agent.ts";
import type { Adapter, Reading, Turn } from "../../worker/agents.ts";
import { join } from "node:path";

import { readMessage, resultFrom } from "../../worker/contract.ts";
import { executiveDecision } from "./executive.ts";
import { inspection } from "./inspection.ts";

// Session tags survive worker restarts without a mutable, cross-run engine lookup.
const sessionTag = /^company:(codex|claude):(.+)$/;
function modelReading(engine: "codex" | "claude", stdout: string, code: number | null, stderr: string): Reading {
  const reading: Reading = (engine === "codex" ? codex : claude).read(stdout, code, stderr);
  if (reading.session) reading.session = `company:${engine}:${reading.session}`;
  if (!reading.text || reading.error) return reading;
  const { result, problem } = resultFrom(readMessage(reading.text), {});
  if (problem) return reading;
  try {
    for (const event of result.events ?? []) {
      if (!["company.ceo.decision", "company.result"].includes(event.type)) continue;
      const detail = JSON.parse(event.detail ?? "{}");
      if (event.type === "company.ceo.decision" || detail.executive !== undefined) executiveDecision(detail.executive);
      if (detail.inspection !== undefined) inspection(detail.inspection);
    }
  } catch (error) {
    reading.receiptProblem = (error as Error).message;
  }
  return reading;
}

// Fixed coordinators and budgeted model employees share the installed company entry point.
export default {
  command(turn: Turn) {
    const config = turn.command?.[0];
    if (!config) throw new Error("company Agent 的 command 需要公司配置文件路径");
    if (turn.command?.[1] === "model") {
      const file = join(turn.folder, "company-model-turn.json");
      const engine = turn.command[3];
      const unwrap = (session: string) => {
        const tagged = sessionTag.exec(session);
        if (!tagged) return session; // Existing untagged sessions still resume with the trusted rule's engine.
        if (tagged[1] !== engine) throw new Error("公司模型会话与岗位入口不一致");
        return tagged[2];
      };
      writeFileSync(
        file,
        JSON.stringify({ ...turn, session: unwrap(turn.session), resume: turn.resume ? unwrap(turn.resume) : null }),
        { mode: 0o600 },
      );
      return [process.execPath, join(import.meta.dirname, "model-run.ts"), file];
    }
    return [
      process.execPath,
      join(
        import.meta.dirname,
        turn.command?.[1] === "business"
          ? "business-run.ts"
          : turn.command?.[1] === "publish"
            ? "publish-run.ts"
            : "run.ts",
      ),
      config,
      turn.contextFile,
    ];
  },
  read(stdout: string, code: number | null, stderr: string) {
    const first = stdout.split("\n")[0];
    try {
      const marker = JSON.parse(first);
      if (marker.companyModel === "codex") return modelReading("codex", stdout, code, stderr);
      if (marker.companyModel === "claude") return modelReading("claude", stdout, code, stderr);
      if (marker.companyDeferred)
        return {
          text: `今日模型次数已用完，工作保留到明天。\n\n\`\`\`agent-autoloop\n${JSON.stringify(marker.companyDeferred)}\n\`\`\``,
          finished: true,
        };
    } catch {
      /* Fixed coordinators print ordinary receipts. */
    }
    if (code === null) return {};
    return code === 0 ? { text: stdout } : { error: stderr.trim().slice(-500) || "公司任务调度失败" };
  },
  link(session: string) {
    const tagged = sessionTag.exec(session);
    if (!tagged) return "";
    return (tagged[1] === "codex" ? codex : claude).link(tagged[2]);
  },
} satisfies Adapter;
