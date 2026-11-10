import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Publication } from "./publication.ts";
import { localDay, weekOf } from "./workday.ts";
import type { Project, Plan } from "./operations.ts";

export type TopicProposal = {
  key: string;
  title: string;
  angle: string;
  reason: string;
  outline: string;
  app: string;
  platform: string;
  replaces?: string;
};
export type Topic = TopicProposal & {
  id: string;
  role: string;
  meeting?: string;
  week: string;
  createdAt: string;
  state: "screening" | "returned" | "withdrawn" | "ready" | "pending" | "approved" | "rejected";
  round: number;
  review?: string;
  rank?: number;
  batch?: string;
  opinion?: string;
  decidedAt?: string;
  decisionSource?: { event?: number; card?: number; message: string };
  plan?: string;
};
export type TopicBatch = { id: string; topics: string[]; at: string; card?: number; closed?: boolean };
export const topicId = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const word = (v: unknown, max: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw Error(`选题字段需要1–${max}字`);
  return v.trim();
};
export function topicProposals(value: unknown): TopicProposal[] {
  if (!Array.isArray(value) || value.length > 10) throw Error("每批最多10条选题");
  const result = value.map((v): TopicProposal => {
    if (!v || typeof v !== "object" || !/^[A-Za-z0-9_-]{1,40}$/.test(v.key)) throw Error("选题key不正确");
    return {
      key: v.key,
      title: word(v.title, 40),
      angle: word(v.angle, 60),
      reason: word(v.reason, 80),
      outline: word(v.outline, 100),
      app: word(v.app, 30),
      platform: word(v.platform, 20),
      ...(v.replaces ? { replaces: word(v.replaces, 40) } : {}),
    };
  });
  if (new Set(result.map((t) => t.key)).size !== result.length) throw Error("选题key重复");
  return result;
}
export function submitTopics(p: Project, role: string, proposals: TopicProposal[], now: Date, meeting?: string) {
  p.topics ??= [];
  for (const v of proposals) {
    const id = topicId(`${p.business}:${role}:${weekOf(now)}:${v.key}`);
    if (p.topics.some((t) => t.id === id)) continue;
    const parent = v.replaces ? p.topics.find((t) => t.id === v.replaces && t.role === role) : undefined;
    if (v.replaces && (!parent || parent.state !== "returned" || parent.round !== 0)) throw Error("初筛只允许换题一轮");
    if (parent) parent.state = "withdrawn";
    p.topics.push({
      ...v,
      id,
      role,
      week: weekOf(now),
      createdAt: now.toISOString(),
      state: "screening",
      round: parent ? 1 : 0,
      meeting: parent?.meeting ?? meeting,
    });
  }
}
export function screenTopic(t: Topic, approve: boolean, reason: string, rank: number) {
  if (t.state !== "screening") throw Error("选题已初筛");
  t.state = approve ? "ready" : t.round === 0 ? "returned" : "withdrawn";
  t.review = reason;
  t.rank = rank;
}
export function topicCard(p: Project, batch: TopicBatch) {
  const text = batch.topics
    .map((id, i) => {
      const t = p.topics!.find((t) => t.id === id)!;
      return `${i + 1}. ${t.title}${t.state === "approved" ? "（已通过）" : t.state === "rejected" ? "（已退回）" : ""}\n角度：${t.angle}\n依据：${t.reason}\n结构：${t.outline}\n关联：${t.app}｜平台：${t.platform}`;
    })
    .join("\n\n");
  return {
    key: `topics-${batch.id}`,
    title: "选题拍板",
    about: `topics:${batch.id}`,
    text: `业务：${p.business}\n请逐条通过或退回，可附意见；未回复不动笔。\n\n${text}\n\n选题批次：${batch.id}\n选题编号：${batch.topics.join(",")}`,
    options: ["全部通过", "全部退回"],
  };
}
export function cardTopics(text: string) {
  const batch = /\n选题批次：([a-f0-9]{24})\n选题编号：([a-f0-9,]+)$/.exec(text);
  if (!batch || !batch[2].split(",").every((id) => /^[a-f0-9]{24}$/.test(id))) return;
  return { id: batch[1], topics: batch[2].split(",") };
}
export type TopicChoice = { index: number; approve: boolean; opinion: string };
export function parseTopicReply(text: string, count: number): TopicChoice[] {
  const s = text.trim().replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, (v) => String("①②③④⑤⑥⑦⑧⑨⑩".indexOf(v) + 1));
  if (/^(全部|全都)(通过|退回|撤下)(?:[，,]另报新题)?[。！!]?$/.test(s))
    return Array.from({ length: count }, (_, index) => ({ index, approve: s.includes("通过"), opinion: text.trim() }));
  const only = /^只有\s*第?\s*(\d+)\s*(?:个|题)?\s*(?:我)?(?:是)?\s*满意(?:的)?[。！!，,]?$/.exec(s);
  if (only) {
    const index = Number(only[1]) - 1;
    // Satisfaction approves this item; it does not decide what to do with the others.
    return index >= 0 && index < count ? [{ index, approve: true, opinion: text.trim() }] : [];
  }
  const result: TopicChoice[] = [];
  for (const clause of s.split(/[，,；;\n]+(?=\s*\d)/).filter(Boolean)) {
    const m = /^\s*(\d+(?:\s*[、和]\s*\d+)*)\s*(通过|退回|撤下|换个角度)([\s\S]*)$/.exec(clause);
    if (!m) return [];
    for (const n of m[1].split(/[、和]/).map(Number)) {
      if (n < 1 || n > count || result.some((r) => r.index === n - 1)) return [];
      result.push({ index: n - 1, approve: m[2] === "通过", opinion: m[3].trim() || m[2] });
    }
  }
  return result;
}
export function decideTopics(
  p: Project,
  batch: TopicBatch,
  choices: TopicChoice[],
  at: string,
  source?: Topic["decisionSource"],
) {
  for (const choice of choices) {
    const t = p.topics?.find((t) => t.id === batch.topics[choice.index] && t.batch === batch.id);
    if (!t || t.state !== "pending") continue;
    t.state = choice.approve ? "approved" : "rejected";
    t.opinion = choice.opinion;
    t.decidedAt = at;
    if (source) t.decisionSource = source;
  }
}
export function topicCanWrite(
  p: Project,
  plan: Pick<Plan, "id" | "topic" | "kind" | "operation" | "createdAt">,
  startAt?: string,
) {
  if (!startAt || plan.kind !== "content" || ["data", "review", "plan"].includes(plan.operation ?? "")) return true;
  if (Date.parse(plan.createdAt) < Date.parse(startAt) && !plan.topic) return true;
  const t = p.topics?.find((t) => t.id === plan.topic);
  return !!t && t.state === "approved" && (!t.plan || t.plan === plan.id);
}
export function topicStats(p: Project, week?: string, publications: Publication[] = []) {
  const topics = (p.topics ?? []).filter((t) => !week || t.week === week);
  const approved = topics.filter((t) => t.state === "approved");
  const decided = topics.filter((t) => t.state === "approved" || t.state === "rejected");
  return {
    submitted: topics.length,
    decided: decided.length,
    approved: approved.length,
    approvalRate: decided.length ? approved.length / decided.length : null,
    pending: topics.filter((t) => t.state === "pending").length,
    ready: approved.filter((t) => !t.plan).length,
    writing: approved.filter(
      (t) => t.plan && !publications.some((r) => r.key === p.plans.find((a) => a.id === t.plan)?.publicationKey),
    ).length,
    published: approved.filter(
      (t) => t.plan && publications.some((r) => r.key === p.plans.find((a) => a.id === t.plan)?.publicationKey),
    ).length,
    drafts: approved
      .filter((t) => t.plan)
      .map((t) => ({
        topic: t.id,
        title: t.title,
        plan: t.plan,
        status: p.plans.find((a) => a.id === t.plan)?.status,
        publication:
          publications.find((r) => r.key === p.plans.find((a) => a.id === t.plan)?.publicationKey)?.key ?? null,
      })),
  };
}
export function topicOfficeHours(now: Date, after = "09:00") {
  const day = localDay(now);
  return (
    ![0, 6].includes(new Date(day).getUTCDay()) &&
    now >= new Date(`${day}T${after}:00+08:00`) &&
    now < new Date(`${day}T22:00:00+08:00`)
  );
}

export function taskTopic(directory: string, task: string) {
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const row of db.prepare("SELECT body FROM projects").all()) {
      const p = JSON.parse(String(row.body)) as Project;
      const plan = p.plans.find((a) => a.task === task && a.topic);
      if (plan) return plan.topic;
    }
  } finally {
    db.close();
  }
}
export function validateTopicSubmission(directory: string, task: string, proposals: TopicProposal[], now: Date) {
  const db = new DatabaseSync(join(directory, "operations.db"), { readOnly: true });
  try {
    for (const row of db.prepare("SELECT body FROM projects").all()) {
      const p = JSON.parse(String(row.body)) as Project;
      const employee = p.staff.find((s) => s.lastTask === task);
      if (!employee) continue;
      submitTopics(p, employee.role, proposals, now);
      return;
    }
    throw Error("选题必须由当前员工任务提交");
  } finally {
    db.close();
  }
}
