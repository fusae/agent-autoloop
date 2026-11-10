import { weeklyGoal, type WeeklyGoal } from "./workday.ts";
import { inspection, type ActionProposal } from "./inspection.ts";
export type StaffPlan = {
  waiting?: { kind: "owner" | "plan"; id: string };
  business: string;
  role: "product" | "engineering" | "qa" | "growth" | "support" | "finance";
  date: string;
  goal: string;
  focus: string;
  doneWhen: string;
  mode: "work" | "followup" | "standby";
  plan?: string;
  reviewAt: string;
};
export type ExecutiveDecision = {
  topicDecisions?: {
    business: string;
    batch: string;
    source?: "ceo";
    event?: number;
    card?: number;
    choices: import("./topics.ts").TopicChoice[];
  }[];
  topicReviews?: { business: string; topic: string; approve: boolean; reason: string; rank: number; score?: number }[];
  topicReplies?: { business: string; batch: string; event: number }[];
  responses?: {
    anomaly: string;
    action: "clear-wait" | "retry" | "review" | "pause" | "resume" | "plan" | "escalate" | "observe";
    reason: string;
    category?: "code" | "auth" | "quota" | "platform" | "decision" | "spend" | "identity";
    request?: string;
  }[];
  report?: string;
  weeklyGoals?: WeeklyGoal[];
  manualMetrics?: Pick<
    import("./feedback.ts").ManualMetric,
    "publication" | "event" | "reads" | "likes" | "collects" | "comments"
  >[];
  staffPlans?: StaffPlan[];
  briefs: { business: string; objective: string }[];
  directives: { business: string; action: ActionProposal }[];
  approvals: { business: string; plan: string; approve: boolean; reason: string }[];
  deliveries?: {
    business: string;
    plan: string;
    task: string;
    reviewVersion?: string;
    verdict: "revise" | "accept" | "publish";
    files?: string[];
    reason: string;
  }[];
  ownerReplies?: { question: string; event: number }[];
  answers: { issue: string; answer: string; evidence: string }[];
  escalations: {
    category?: "maintenance" | "spend" | "identity";
    key: string;
    business?: string;
    issues: string[];
    question: string;
    context: string;
    options?: string[];
  }[];
};
export type Issue = {
  id: string;
  business: string;
  role: string;
  task: string | null;
  question: string;
  context: string;
  state: "open" | "owner" | "answered";
  answer: string | null;
  at: string;
};
export type OwnerQuestion = {
  recipient?: "maintainer" | "chairman";
  answerEvent?: number;
  options?: string[];
  id: string;
  key: string;
  issues: string[];
  question: string;
  context: string;
  state: "open" | "answered" | "deferred";
  answer: string | null;
  at: string;
};
export type Knowledge = {
  context?: string;
  id: string;
  business: string;
  issue: string;
  answer: string;
  source: "owner" | "ceo";
  evidence: string;
  at: string;
};
export type Leadership = {
  proactiveRounds?: import("./proactive.ts").ProactiveRound[];
  weeklyCycles?: import("./weekly.ts").WeeklyCycle[];
  health?: import("./health.ts").HealthState;
  eveningReports?: { date: string; task: string; processed?: boolean; failureNotified?: boolean }[];
  manualMetrics?: import("./feedback.ts").ManualMetric[];
  enabled: boolean;
  lastTask: string | null;
  processed: string | null;
  fingerprint: string | null;
  lastReportDay: string | null;
  briefs: Record<string, string>;
  issues: Issue[];
  questions: OwnerQuestion[];
  knowledge: Knowledge[];
  decisions: { task: string; summary: string; at: string; decision: ExecutiveDecision; authority?: string }[];
  runs: { task: string; at: string }[];
  answeredCards: number[];
  ownerReplyEvents?: string[];
  retries: Record<string, number>;
  nextReviewAt?: string;
  eventInputs?: string;
  eventOutcomes?: Record<string, string>;
  unchangedReviews?: number;
  stalled?: { fingerprint: string; at: string; reason: string };
  pendingRetries?: { task: string; decision: string }[];
  repairs?: Record<
    string,
    { attempts: number; assignment: number; nextAt: string; exhausted: boolean; reason: string }
  >;
};
export function executiveDecision(v: unknown): ExecutiveDecision {
  const object = (v: unknown): Record<string, any> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("CEO 决策需要对象");
    return v as Record<string, any>;
  };
  const text = (v: unknown, n: number, field = "字段") => {
    if (typeof v !== "string" || !v.trim() || v.length > n)
      throw new Error(`CEO ${field} 需要 1–${n} 字，实际 ${typeof v === "string" ? v.length : "非文字"}`);
    return v.trim();
  };
  const id = (v: unknown) => {
    const s = text(v, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("CEO 决策编号不正确");
    return s;
  };
  const d = object(v);
  const list = (key: string, max: number) => {
    if (!Array.isArray(d[key]) || d[key].length > max) throw new Error(`CEO ${key} 数量不正确`);
    return d[key].map(object);
  };
  return {
    ...(d.topicDecisions !== undefined
      ? {
          topicDecisions: list("topicDecisions", 10).map((a) => {
            if (
              a.source !== "ceo" &&
              ((a.event === undefined) === (a.card === undefined) ||
                !Number.isSafeInteger(a.event ?? a.card) ||
                (a.event ?? a.card) < 1)
            )
              throw Error("代录董事长拍板必须引用一个真实消息事件或已回答卡片");
            if (!Array.isArray(a.choices) || !a.choices.length || a.choices.length > 8)
              throw Error("拍板需要1–8项通过或退回决定");
            const choices = a.choices.map((v: any) => {
              if (!Number.isSafeInteger(v.index) || v.index < 0 || v.index > 7 || typeof v.approve !== "boolean")
                throw Error("拍板选题序号或决定不正确");
              return { index: v.index, approve: v.approve, opinion: text(v.opinion, 200, "拍板意见") };
            });
            if (new Set(choices.map((v: any) => v.index)).size !== choices.length) throw Error("拍板选题不能重复");
            return {
              business: id(a.business),
              batch: id(a.batch),
              ...(a.source === "ceo"
                ? { source: "ceo" as const }
                : a.event !== undefined
                  ? { event: a.event }
                  : { card: a.card }),
              choices,
            };
          }),
        }
      : {}),
    ...(d.topicReviews !== undefined
      ? {
          topicReviews: list("topicReviews", 30).map((a) => {
            if (typeof a.approve !== "boolean" || !Number.isInteger(a.rank) || a.rank < 1 || a.rank > 30)
              throw Error("选题初筛需要approve和排序rank");
            return {
              business: id(a.business),
              ...(a.score !== undefined
                ? {
                    score: (() => {
                      if (!Number.isInteger(a.score) || a.score < 0 || a.score > 10) throw Error("选题评分需要0–10分");
                      return a.score;
                    })(),
                  }
                : {}),
              topic: id(a.topic),
              approve: a.approve,
              reason: text(a.reason, 160),
              rank: a.rank,
            };
          }),
        }
      : {}),
    ...(d.topicReplies !== undefined
      ? {
          topicReplies: list("topicReplies", 10).map((a) => {
            if (!Number.isSafeInteger(a.event) || a.event < 1) throw Error("选题答复需要真实消息编号");
            return { business: id(a.business), batch: id(a.batch), event: a.event };
          }),
        }
      : {}),
    ...(d.responses !== undefined
      ? {
          responses: list("responses", 6).map((a) => {
            if (!["clear-wait", "retry", "review", "pause", "resume", "plan", "escalate", "observe"].includes(a.action))
              throw Error("异常处理动作不在CEO权限内");
            if (
              a.action === "escalate" &&
              !["code", "auth", "quota", "platform", "decision", "spend", "identity"].includes(a.category)
            )
              throw Error("上报需要说明董事长处理类别");
            return {
              anomaly: id(a.anomaly),
              action: a.action as NonNullable<ExecutiveDecision["responses"]>[number]["action"],
              reason: text(a.reason, 200, "responses.reason"),
              ...(a.action === "escalate"
                ? { category: a.category, request: text(a.request, 160, "responses.request") }
                : {}),
            };
          }),
        }
      : {}),
    ...(d.report !== undefined ? { report: text(d.report, 1800, "report") } : {}),
    ...(d.weeklyGoals !== undefined ? { weeklyGoals: list("weeklyGoals", 6).map(weeklyGoal) } : {}),
    ...(d.manualMetrics !== undefined
      ? {
          manualMetrics: list("manualMetrics", 20).map((a) => {
            if (
              typeof a.publication !== "string" ||
              !/^(?:[a-f0-9]{32}(?::x)?|manual:[A-Za-z0-9_-]{1,80})$/.test(a.publication) ||
              !Number.isSafeInteger(a.event) ||
              a.event < 1 ||
              !["reads", "likes", "collects", "comments"].some((k) => a[k] !== undefined) ||
              ["reads", "likes", "collects", "comments"].some(
                (k) => a[k] !== undefined && (!Number.isSafeInteger(a[k]) || a[k] < 0),
              )
            )
              throw Error("人工阅读量需要已发布编号、本人消息事件和非负整数");
            return {
              publication: a.publication,
              event: a.event,
              ...Object.fromEntries(
                ["reads", "likes", "collects", "comments"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]),
              ),
            };
          }),
        }
      : {}),
    ...(d.staffPlans !== undefined
      ? {
          staffPlans: list("staffPlans", 6).map((a): StaffPlan => {
            if (!["product", "engineering", "qa", "growth", "support", "finance"].includes(a.role))
              throw Error("每日安排岗位不正确");
            if (!["work", "followup", "standby"].includes(a.mode)) throw Error("每日安排类型不正确");
            const date = text(a.date, 10, "staffPlans.date");
            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
              !Number.isFinite(Date.parse(date)) ||
              new Date(date).toISOString().slice(0, 10) !== date
            )
              throw Error("每日安排日期不正确");
            const reviewAt = text(a.reviewAt, 35, "staffPlans.reviewAt");
            if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(reviewAt) || !Number.isFinite(Date.parse(reviewAt)))
              throw Error("每日安排复查时间需要带时区的日期时间");
            if (a.mode === "work" && !a.plan) throw Error("执行安排必须关联已有计划或本轮指令key");
            return {
              ...(a.waiting !== undefined
                ? {
                    waiting: (() => {
                      const wait = object(a.waiting);
                      if (!["owner", "plan"].includes(wait.kind)) throw Error("等待条件类型不正确");
                      return { kind: wait.kind as "owner" | "plan", id: id(wait.id) };
                    })(),
                  }
                : {}),
              business: id(a.business),
              role: a.role,
              date,
              goal: text(a.goal, 120, "staffPlans.goal"),
              focus: text(a.focus, 160, "staffPlans.focus"),
              doneWhen: text(a.doneWhen, 120, "staffPlans.doneWhen"),
              mode: a.mode,
              ...(a.plan ? { plan: id(a.plan) } : {}),
              reviewAt: new Date(reviewAt).toISOString(),
            };
          }),
        }
      : {}),
    briefs: list("briefs", 5).map((a) => ({
      business: id(a.business),
      objective: text(a.objective, 300, "briefs.objective"),
    })),
    directives: list("directives", 3).map((a) => ({
      business: id(a.business),
      action: inspection({ state: "action", actions: [a.action], reviews: [] }).actions[0],
    })),
    approvals: list("approvals", 6).map((a) => {
      if (typeof a.approve !== "boolean") throw new Error("计划决定需要布尔值");
      return { business: id(a.business), plan: id(a.plan), approve: a.approve, reason: text(a.reason, 200) };
    }),
    ...(d.deliveries !== undefined
      ? {
          deliveries: list("deliveries", 6).map((a) => {
            if (!["revise", "accept", "publish"].includes(a.verdict)) throw new Error("成果审核结论不正确");
            if (a.verdict === "publish" && (!Array.isArray(a.files) || !a.files.length || a.files.length > 5))
              throw Error("发布审核需要明确选择1–5个正文文件");
            if (
              a.reviewVersion !== undefined &&
              (typeof a.reviewVersion !== "string" || !/^[a-f0-9]{64}$/.test(a.reviewVersion))
            )
              throw new Error("成果审核版本需要交付资料中的 SHA-256");
            return {
              business: id(a.business),
              plan: id(a.plan),
              task: id(a.task),
              ...(a.reviewVersion !== undefined ? { reviewVersion: a.reviewVersion } : {}),
              verdict: a.verdict,
              reason: text(a.reason, 200),
              ...(a.verdict === "publish" ? { files: a.files.map((v: unknown) => text(v, 150, "files")) } : {}),
            };
          }),
        }
      : {}),
    ...(d.ownerReplies !== undefined
      ? {
          ownerReplies: list("ownerReplies", 5).map((a) => {
            if (!Number.isSafeInteger(a.event) || a.event < 1) throw Error("负责人答复需要真实消息事件编号");
            return { question: id(a.question), event: a.event };
          }),
        }
      : {}),
    answers: list("answers", 5).map((a) => ({
      issue: id(a.issue),
      answer: text(a.answer, 700),
      evidence: text(a.evidence, 200),
    })),
    escalations: list("escalations", 2).map((a) => {
      if (a.category !== undefined && !["maintenance", "spend", "identity"].includes(a.category))
        throw Error("上报类别不正确");
      if (!Array.isArray(a.issues) || a.issues.length > 8 || (!a.issues.length && !a.business))
        throw new Error("上报需关联1–8个未解决问题；CEO新发现的问题可提供business项目编号并用issues:[]");
      return {
        ...(a.category !== undefined ? { category: a.category } : {}),
        key: (() => {
          const key = text(a.key, 80, "escalations.key");
          if (!/^[A-Za-z0-9_-]+$/.test(key)) throw Error("上报编号只能用字母、数字、下划线和横线");
          return key;
        })(),
        ...(a.business !== undefined ? { business: id(a.business) } : {}),
        issues: a.issues.map(id),
        question: text(a.question, 800),
        context: text(a.context, 400),
        ...(a.options !== undefined
          ? {
              options: (() => {
                if (!Array.isArray(a.options) || a.options.length < 2 || a.options.length > 5)
                  throw new Error("上报选项需要2–5项");
                return a.options.map((v: unknown) => text(v, 40, "options"));
              })(),
            }
          : {}),
      };
    }),
  };
}
