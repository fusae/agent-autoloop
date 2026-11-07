export type ActionProposal = {
  key: string;
  title: string;
  kind: "software" | "content" | "support" | "finance";
  goal: string;
  acceptance: string[];
  priority: number;
  dueDays: number;
  followUpDays: number;
  measure: string;
};
export type Inspection = {
  state: "idle" | "action" | "blocked";
  actions: ActionProposal[];
  questions?: { key: string; question: string; context: string }[];
  reviews: {
    key: string;
    outcome: "improved" | "unchanged" | "worse" | "unknown";
    evidence: string;
    nextDays: number;
  }[];
};
export function inspection(value: unknown): Inspection {
  const obj = (v: unknown): Record<string, any> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("检查结果需要对象");
    return v as Record<string, any>;
  };
  const str = (v: unknown, max: number) => {
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`检查字段需要 1–${max} 字`);
    return v.trim();
  };
  const key = (v: unknown) => {
    const s = str(v, 40);
    if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error("计划编号格式不正确");
    return s;
  };
  const integer = (v: unknown, max: number) => {
    if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > max) throw new Error("检查数值超出范围");
    return Number(v);
  };
  const d = obj(value);
  if (!["idle", "action", "blocked"].includes(d.state)) throw new Error("检查状态不正确");
  if (!Array.isArray(d.actions) || d.actions.length > 3 || !Array.isArray(d.reviews) || d.reviews.length > 3)
    throw new Error("每次最多提出 3 项工作和 3 项复盘");
  const actions = d.actions.map((raw: unknown): ActionProposal => {
    const a = obj(raw);
    if (!["software", "content", "support", "finance"].includes(a.kind)) throw new Error("只能安排内部工作");
    if (!Array.isArray(a.acceptance) || !a.acceptance.length || a.acceptance.length > 3)
      throw new Error("acceptance 验收标准需要 1–3 项，每项最多 100 字");
    return {
      key: key(a.key),
      title: str(a.title, 80),
      kind: a.kind,
      goal: str(a.goal, 240),
      acceptance: a.acceptance.map((s: unknown) => str(s, 100)),
      priority: integer(a.priority, 3),
      dueDays: integer(a.dueDays, 14),
      followUpDays: integer(a.followUpDays, 30),
      measure: str(a.measure, 120),
    };
  });
  if (d.state !== "action" && actions.length) throw new Error("非行动状态不能包含新任务");
  if (d.state === "action" && !actions.length && !d.reviews.length) throw new Error("行动状态缺少工作或复盘");
  const reviews = d.reviews.map((raw: unknown): Inspection["reviews"][number] => {
    const r = obj(raw);
    if (!["improved", "unchanged", "worse", "unknown"].includes(r.outcome)) throw new Error("复盘结论不正确");
    return { key: key(r.key), outcome: r.outcome, evidence: str(r.evidence, 200), nextDays: integer(r.nextDays, 30) };
  });
  if (new Set(actions.map((a: ActionProposal) => a.key)).size !== actions.length) throw new Error("计划编号不能重复");
  if (d.questions !== undefined && (!Array.isArray(d.questions) || d.questions.length > 3))
    throw new Error("每次最多提出 3 个问题");
  const questions = (d.questions ?? []).map((v: unknown) => {
    const q = obj(v);
    return { key: key(q.key), question: str(q.question, 300), context: str(q.context, 300) };
  });
  return { state: d.state, actions, reviews, ...(questions.length ? { questions } : {}) };
}
