import { inspection, type ActionProposal } from "./inspection.ts";
export type ExecutiveDecision = {
  briefs: { business: string; objective: string }[];
  directives: { business: string; action: ActionProposal }[];
  approvals: { business: string; plan: string; approve: boolean; reason: string }[];
  answers: { issue: string; answer: string; evidence: string }[];
  escalations: { key: string; business?: string; issues: string[]; question: string; context: string }[];
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
  id: string;
  business: string;
  issue: string;
  answer: string;
  source: "owner" | "ceo";
  evidence: string;
  at: string;
};
export type Leadership = {
  enabled: boolean;
  lastTask: string | null;
  processed: string | null;
  fingerprint: string | null;
  lastReportDay: string | null;
  briefs: Record<string, string>;
  issues: Issue[];
  questions: OwnerQuestion[];
  knowledge: Knowledge[];
  decisions: { task: string; summary: string; at: string; decision: ExecutiveDecision }[];
  runs: { task: string; at: string }[];
  answeredCards: number[];
  retries: Record<string, number>;
  nextReviewAt?: string;
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
    answers: list("answers", 5).map((a) => ({
      issue: id(a.issue),
      answer: text(a.answer, 700),
      evidence: text(a.evidence, 200),
    })),
    escalations: list("escalations", 2).map((a) => {
      if (!Array.isArray(a.issues) || a.issues.length > 8 || (!a.issues.length && !a.business))
        throw new Error("上报需关联1–8个未解决问题；CEO新发现的问题可提供business项目编号并用issues:[]");
      return {
        key: (() => {
          const key = text(a.key, 80, "escalations.key");
          if (!/^[A-Za-z0-9_-]+$/.test(key)) throw Error("上报编号只能用字母、数字、下划线和横线");
          return key;
        })(),
        ...(a.business !== undefined ? { business: id(a.business) } : {}),
        issues: a.issues.map(id),
        question: text(a.question, 800),
        context: text(a.context, 400),
      };
    }),
  };
}
