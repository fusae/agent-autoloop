import { createHash } from "node:crypto";
import { departments, type Role } from "./company.ts";
import type { ExecutiveDecision, Issue } from "./executive.ts";
import type { Plan } from "./operations.ts";
export const ARRANGEMENT_DETAILS = "\n\n安排详情\n";
const short = (s: string, n: number) => {
  const v = s.replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};
const states: Record<Plan["status"], string> = {
  proposed: "待审核",
  planned: "待执行",
  working: "执行中",
  blocked: "受阻",
  observing: "跟进效果",
  review: "待复盘",
  closed: "已结束",
  delivered: "待成果审核",
  publishing: "发布中",
};
const date = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(new Date(value))
        .replace("/", "月")
        .replace(" ", "日 ")
    : "未设置";
export function arrangementText(
  summary: string,
  d: ExecutiveDecision,
  projects: { id: string; name: string; plans: Plan[] }[],
  issues: Issue[],
  newQuestions = d.escalations.length,
) {
  const sections: string[] = [],
    details: string[] = [];
  if (summary.trim()) details.push(summary.trim());
  let hidden = 0;
  for (const project of projects) {
    const selected = new Map<string, { plan: Plan; state: string; reason: string }>();
    const add = (id: string, state?: string, reason?: string) => {
      const p = project.plans.find((p) => p.id === id);
      if (p) selected.set(id, { plan: p, state: state ?? states[p.status], reason: reason ?? p.result });
    };
    for (const a of d.directives.filter((a) => a.business === project.id))
      add(createHash("sha256").update(`${project.id}:ceo:${a.action.key}`).digest("hex").slice(0, 32));
    for (const a of d.approvals.filter((a) => a.business === project.id)) add(a.plan, undefined, a.reason);
    for (const a of (d.deliveries ?? []).filter((a) => a.business === project.id))
      add(a.plan, { revise: "修改交付", accept: "已验收", publish: "进入发布" }[a.verdict], a.reason);
    const goals = d.briefs.filter((b) => b.business === project.id);
    const daily = (d.staffPlans ?? []).filter((a) => a.business === project.id);
    const answers = d.answers.filter((a) => issues.find((i) => i.id === a.issue)?.business === project.id);
    if (!selected.size && !goals.length && !answers.length && !daily.length) continue;
    const lines = [short(project.name, 40)];
    for (const { plan: p, state, reason } of selected.values()) {
      const task = `任务：${short(p.title, 48)}\n${state} · ${departments[p.owner]}负责 · 截止 ${date(p.dueAt)}`;
      if (lines.length < 4 && sections.join("\n\n").length + lines.join("\n").length + task.length < 650)
        lines.push(task);
      else hidden++;
      details.push(`${project.name} · ${p.title}\n${reason}`);
    }
    if (!selected.size && goals.length) lines.push(`目标：${short(goals[0].objective, 72)}`);
    const activeDaily = daily.filter((a) => a.mode !== "standby");
    for (const a of activeDaily) {
      const text = `${departments[a.role]}：${short(a.focus, 50)} · ${date(a.reviewAt)}复查`;
      if (lines.length < 4 && sections.join("\n\n").length + lines.join("\n").length + text.length < 650)
        lines.push(text);
      else hidden++;
    }
    if (daily.length && !activeDaily.length && !selected.size && !goals.length) lines.push("今日安排：待命，按时复查");
    for (const a of daily)
      details.push(
        `${project.name} · ${departments[a.role]} · ${a.date}\n目标：${a.goal}\n今日：${a.focus}\n完成标准：${a.doneWhen}\n复查：${date(a.reviewAt)}`,
      );
    if (answers.length) lines.push(`已答复 ${answers.length} 项员工问题`);
    for (const a of answers) {
      const issue = issues.find((i) => i.id === a.issue)!;
      details.push(`${project.name} · ${departments[issue.role as Role] ?? "员工"}\n${a.answer}`);
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }
  if (hidden) sections.push(`另有 ${hidden} 项安排，展开详情查看。`);
  if (newQuestions) sections.push(`需要你决定：${newQuestions} 项，见决策卡片。`);
  if (!sections.length)
    sections.push(
      d.ownerReplies?.length
        ? `已记录你的 ${d.ownerReplies.length} 项答复。`
        : short(summary, 180) || "本轮没有新增安排。",
    );
  const main = sections.join("\n\n");
  const detail = [...new Set(details.filter(Boolean))].join("\n\n");
  return detail
    ? main + ARRANGEMENT_DETAILS + shortDetails(detail, 4000 - main.length - ARRANGEMENT_DETAILS.length)
    : main;
}
function shortDetails(text: string, max: number) {
  return text.length > max ? text.slice(0, max - 16) + "\n完整要求见任务记录。" : text;
}
