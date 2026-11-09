import { retrospective } from "./weekly.ts";
import { writeFileSync } from "node:fs";
import codex from "../codex/agent.ts";
import claude from "../claude/agent.ts";
import type { Adapter, Reading, Turn } from "../../worker/agents.ts";
import { join } from "node:path";

import { readMessage, resultFrom } from "../../worker/contract.ts";
import { executiveDecision } from "./executive.ts";
import { dailyReport } from "./reporting.ts";
import { inspection } from "./inspection.ts";

// Session tags survive worker restarts without a mutable, cross-run engine lookup.
const sessionTag = /^company:(codex|claude):(.+)$/;
function modelReading(
  engine: "codex" | "claude",
  stdout: string,
  code: number | null,
  stderr: string,
  work?: { task: string; assignment: number; topicsPending?: boolean },
): Reading {
  const reading: Reading = (engine === "codex" ? codex : claude).read(stdout, code, stderr);
  if (reading.session) reading.session = `company:${engine}:${reading.session}`;
  if (!reading.text || reading.error) return reading;
  const { result, problem } = resultFrom(readMessage(reading.text), {});
  if (problem) return reading;
  try {
    if (
      work &&
      ["done", "nothing"].includes(result.outcome) &&
      !result.events?.some(
        (event) =>
          event.type === "company.result" &&
          event.subject === work.task &&
          JSON.parse(event.detail ?? "{}").assignment === work.assignment,
      )
    )
      throw Error(
        "本轮派工缺少 company.result 部门报告：即使没事可做，也须在 agent-autoloop 代码块的 events 中提交原 task、assignment 的报告；只补回执，不重做业务。",
      );
    // A bare business JSON block is not a hub receipt; do not silently discard a completed report.
    if (!result.events?.length) {
      for (const block of reading.text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
        let detail: any;
        try {
          detail = JSON.parse(block[1]);
        } catch {
          continue;
        }
        if (Number.isInteger(detail?.assignment) && typeof detail?.verdict === "string")
          throw Error(
            "部门报告未装入回执：使用 agent-autoloop 代码块及 events 数组，提交 company.result；subject 和 assignment 取本轮派工资料，detail 为已有报告的 JSON 字符串，不重做业务。",
          );
      }
    }
    for (const event of result.events ?? []) {
      if (!["company.ceo.decision", "company.result"].includes(event.type)) continue;
      const detail = JSON.parse(event.detail ?? "{}");
      if (work?.topicsPending && event.type === "company.result" && event.subject === work.task) {
        const d = executiveDecision(detail.executive);
        if (
          !d.report &&
          ![
            d.topicReviews,
            d.deliveries,
            d.directives,
            d.approvals,
            d.answers,
            d.escalations,
            d.staffPlans,
            d.weeklyGoals,
          ].some((v) => v?.length)
        )
          throw Error(
            "本次资料仍有 state=screening 的待初筛选题，不能交空决策或只说无待审稿件；按既有规范提交 topicReviews，真实受阻则说明并上报，不代董事长批准，不重做已完成业务。",
          );
      }
      if (event.type === "company.ceo.decision" || detail.executive !== undefined) executiveDecision(detail.executive);
      if (detail.retrospective !== undefined) retrospective(detail.retrospective);
      if (detail.dailyReport !== undefined) dailyReport(detail.dailyReport);
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
          : turn.command?.[1] === "verify"
            ? "verify-run.ts"
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
      if (marker.companyModel === "codex") return modelReading("codex", stdout, code, stderr, marker.companyWork);
      if (marker.companyModel === "claude") return modelReading("claude", stdout, code, stderr, marker.companyWork);
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
