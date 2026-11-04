import { inspection, type ActionProposal } from "./inspection.ts";
export type ExecutiveDecision = {
  briefs: { business: string; objective: string }[];
  directives: { business: string; action: ActionProposal }[];
  approvals: { business: string; plan: string; approve: boolean; reason: string }[];
  answers: { issue: string; answer: string; evidence: string }[];
  escalations: { key: string; issues: string[]; question: string; context: string }[];
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
};
export function executiveDecision(v: unknown): ExecutiveDecision {
  const object = (v: unknown): Record<string, any> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("CEO 决策需要对象");
    return v as Record<string, any>;
  };
  const text = (v: unknown, n: number) => {
    if (typeof v !== "string" || !v.trim() || v.length > n) throw new Error("CEO 决策字段长度不正确");
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
    briefs: list("briefs", 5).map((a) => ({ business: id(a.business), objective: text(a.objective, 300) })),
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
      if (!Array.isArray(a.issues) || !a.issues.length || a.issues.length > 8)
        throw new Error("上报需要关联 1–8 个问题");
      return {
        key: id(a.key),
        issues: a.issues.map(id),
        question: text(a.question, 800),
        context: text(a.context, 400),
      };
    }),
  };
}
