import { createHash } from "node:crypto";
import type { CompanyConfig, Role, Task } from "./company.ts";
import type { Leadership } from "./executive.ts";
import type { Project } from "./operations.ts";
import type { Publication } from "./publication.ts";
import { draftStock, localDay, weekOf } from "./workday.ts";
import { waitingReason } from "./waiting.ts";

export type HealthFinding = {
  id: string;
  kind: string;
  business?: string;
  role?: Role;
  task?: string;
  plan?: string;
  title: string;
  impact: string;
  evidence: string;
  suggestion: string;
  severity: number;
  reminderOnly?: boolean;
};
export type HealthIncident = HealthFinding & {
  reviewVersion?: string;
  firstAt: string;
  lastAt: string;
  resolvedAt?: string;
  notifiedAt?: string;
  notifiedSeverity?: number;
  actions: { at: string; action: string; result: string }[];
};
export type HealthState = {
  checkedAt?: string;
  revision: number;
  pending: boolean;
  incidents: HealthIncident[];
};
export type HealthRuntime = {
  rounds: {
    id: number;
    role: Role;
    task?: string;
    at: string;
    state: string;
    attempts: number;
    assignment?: number;
    progress?: string;
    failure?: "auth" | "timeout" | "failed";
  }[];
  usageKnown?: boolean;
  employees: Record<string, number>;
  roles: Partial<Record<Role, number>>;
  cards: { id: number; key: string; title: string; state: string; at: string; delivered: boolean }[];
};
export const healthId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
export function healthDue(state: HealthState | undefined, now: Date) {
  const local = new Date(now.getTime() + 8 * 3600_000);
  return (
    local.getUTCDay() !== 0 &&
    local.getUTCDay() !== 6 &&
    local.getUTCHours() >= 9 &&
    local.getUTCHours() < 22 &&
    (!state?.checkedAt || Math.floor(now.getTime() / 900000) > Math.floor(Date.parse(state.checkedAt) / 900000))
  );
}
export function failureKind(error: string): "auth" | "timeout" | "failed" {
  return /auth|unauthor|401|403|oauth|登录|认证|密钥|token.*expir/i.test(error)
    ? "auth"
    : /timeout|timed out|超时/i.test(error)
      ? "timeout"
      : "failed";
}
function outputSignature(task: Task | undefined, round: HealthRuntime["rounds"][number] | undefined) {
  if (!round) return "";
  if (round.progress) return round.progress;
  // The office records the report after the worker finishes; match assignments, not wall-clock ordering.
  const report = task?.reports
    .filter((r) => !round.assignment || (r.assignment === round.assignment && r.role === round.role))
    .at(-1);
  if (!report) return "";
  const d = report.executive;
  const output = [
    report.artifacts,
    report.inspection?.actions ?? [],
    report.inspection?.reviews ?? [],
    report.inspection?.questions ?? [],
    report.verdict !== "pass" ? [report.verdict] : [],
    ...(d
      ? [
          d.briefs,
          d.directives,
          d.approvals,
          d.deliveries ?? [],
          d.answers,
          d.escalations,
          d.staffPlans ?? [],
          d.weeklyGoals ?? [],
          d.ownerReplies ?? [],
          (d.responses ?? []).filter((r) => r.action !== "observe").map(({ anomaly, action }) => ({ anomaly, action })),
          d.report ? [d.report] : [],
        ]
      : []),
  ];
  return output.some((v) => v.length) ? JSON.stringify(output) : "";
}
export function detectHealth(input: {
  now: Date;
  config: Partial<CompanyConfig>;
  chief: Leadership;
  tasks: Task[];
  projects: (Project & { name: string; createdAt: string })[];
  runtime: HealthRuntime;
  publications: Publication[];
}): HealthFinding[] {
  const { now, config, chief, tasks, projects, runtime, publications } = input;
  const found: HealthFinding[] = [],
    date = localDay(now),
    ms = now.getTime();
  const add = (key: string, v: Omit<HealthFinding, "id">) => found.push({ ...v, id: healthId(key) });
  const reviewing =
    tasks.some((t) => t.kind === "ceo" && ["active", "queued"].includes(t.status)) ||
    (!!chief.lastTask && !tasks.some((t) => t.id === chief.lastTask));
  for (const p of projects) {
    for (const s of p.staff.filter((s) => s.pausedByCEO)) {
      for (const i of chief.health?.incidents.filter(
        (i) => !i.resolvedAt && i.business === p.business && i.role === s.role,
      ) ?? [])
        if (!found.some((f) => f.id === i.id)) found.push({ ...i, suggestion: "CEO已暂停后续派工，核实原问题后恢复" });
    }
    const staff = p.staff.filter((s) => s.enabled && (!config.activeRoles || config.activeRoles.includes(s.role)));
    const missing = staff.filter((s) => s.weeklyGoal?.week !== weekOf(now));
    if (missing.length)
      add(`goal:${p.business}:${weekOf(now)}`, {
        kind: "missing-goal",
        business: p.business,
        title: `${p.name}缺少本周目标`,
        impact: "员工无法按目标开工",
        evidence: `缺少目标岗位：${missing.map((s) => s.role).join("、")}`,
        suggestion: "沿用已确认方向，用weeklyGoals补齐本周指标",
        severity: 1,
      });
    for (const s of staff) {
      const key = `${p.business}:${s.role}`,
        own = p.activity.filter((a) => a.role === s.role);
      const count =
        runtime.employees[key] ??
        (runtime.usageKnown
          ? 0
          : runtime.rounds.filter(
              (r) => r.role === s.role && localDay(new Date(r.at)) === date && own.some((a) => a.task === r.task),
            ).length);
      const unmet =
        s.weeklyGoal?.week === weekOf(now) &&
        (s.role === "growth" && s.weeklyGoal.metrics.some((m) => m.unit === "篇")
          ? draftStock(p.plans, s.weeklyGoal, publications, now).published <
            (s.weeklyGoal.metrics.find((m) => m.unit === "篇")?.target ?? 0)
          : s.weeklyGoal.metrics.some((m) => m.target !== null && m.target > 0));
      const start = Math.max(Date.parse(`${date}T09:00:00+08:00`), Date.parse(p.createdAt));
      if (unmet && !count && ms - start >= 3600_000)
        add(`not-started:${key}:${date}`, {
          kind: "not-started",
          business: p.business,
          role: s.role,
          title: `${p.name} · ${s.name ?? s.role}未开工`,
          impact: "本周目标未完成，今天超过60分钟零轮次",
          evidence: `实际模型轮次0；安排${s.daily?.mode ?? "缺失"}`,
          suggestion: "检查等待及今日安排，补齐后按原调度开工",
          severity: ms - start >= 4 * 3600_000 ? 2 : 1,
        });
      for (const daily of [s.daily, ...(s.followups ?? [])]) {
        if (!daily) continue;
        const reason = waitingReason(daily, p.business, chief, p.plans);
        if (reason)
          add(`wait:${key}`, {
            kind: "invalid-wait",
            business: p.business,
            role: s.role,
            title: `${p.name} · ${s.name ?? s.role}等待无效`,
            impact: "安排阻止正常工作",
            evidence: reason,
            suggestion: "撤销无效等待，按现有目标继续",
            severity: 1,
          });
      }
      const used = runtime.employees[key] ?? 0,
        limit = config.dailyModelRuns?.employee ?? config.dailyModelRuns?.[s.role];
      if (limit && used >= limit * 0.8)
        add(`quota:${key}:${date}`, {
          kind: "quota",
          business: p.business,
          role: s.role,
          title: `${p.name} · ${s.name ?? s.role}额度接近上限`,
          impact: "后续任务可能排到明天",
          evidence: `已用${used}/${limit}轮`,
          suggestion: "优先完成关键任务；确需改额度才请董事长决定",
          severity: used >= limit ? 2 : 1,
        });
    }
    for (const plan of p.plans) {
      if (
        plan.status === "delivered" &&
        plan.deliveredAt &&
        ms - Date.parse(plan.deliveredAt) >= 30 * 60000 &&
        !reviewing
      )
        add(`review:${plan.id}`, {
          kind: "review-overdue",
          business: p.business,
          plan: plan.id,
          task: plan.task ?? undefined,
          title: `${p.name}交付超过30分钟未审核`,
          impact: "交付无法继续进入下一步",
          evidence: `计划${plan.id}，交付时间${plan.deliveredAt}，无排队或运行审核`,
          suggestion: "重新派审，读取当前交付版本",
          severity: ms - Date.parse(plan.deliveredAt) >= 2 * 3600_000 ? 2 : 1,
        });
      const task = tasks.find((t) => t.id === plan.task);
      if (task?.kind === "publish-content" && ["blocked", "rejected"].includes(task.status))
        add(`publication:${plan.id}`, {
          kind: "publish-failed",
          business: p.business,
          plan: plan.id,
          task: task.id,
          title: `${p.name}发布通道失败`,
          impact: "未取得有效发布回执",
          evidence: `任务${task.id}；故障类型${failureKind(task.reason)}`,
          suggestion: "核对回执；账号或平台问题升级董事长，不重发、不代确认",
          severity: 2,
        });
    }
  }
  const groups = new Map<string, typeof runtime.rounds>();
  for (const r of runtime.rounds.filter((r) => ["done", "nothing", "failed", "waiting"].includes(r.state))) {
    const project = projects.find((p) => p.activity.some((a) => a.task === r.task));
    if (
      r.role !== "ceo" &&
      (!project ||
        !project.staff.some(
          (s) => s.role === r.role && s.enabled && (!config.activeRoles || config.activeRoles.includes(s.role)),
        ))
    )
      continue;
    if (tasks.some((t) => t.id === r.task && t.status === "superseded")) continue;
    const key = r.role === "ceo" ? "ceo" : `${project?.business ?? "unknown"}:${r.role}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, all] of groups) {
    const rounds = all.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id),
      last = rounds[0];
    if (!last || ms - Date.parse(last.at) > 86400_000) continue;
    const project = projects.find((p) => p.activity.some((a) => a.task === last.task));
    const breakAt = rounds.findIndex((r) => !r.failure);
    const failures = Math.max(last.attempts, breakAt < 0 ? rounds.length : breakAt);
    if (last.failure && (last.failure !== "failed" || failures >= 2))
      add(`failure:${key}`, {
        kind: last.failure,
        business: project?.business,
        role: last.role,
        task: last.task,
        title: `${project?.name ?? "公司"} · ${last.role}运行异常`,
        impact: "任务无法取得有效结果",
        evidence: `轮次${last.id}，${last.failure === "auth" ? "认证失败" : last.failure === "timeout" ? "执行超时" : "连续失败至少2次"}`,
        suggestion:
          last.failure === "auth"
            ? "请董事长恢复认证，不读取或修改密钥"
            : "核对故障，必要时重试非发布任务，失败两次后升级",
        severity: last.failure === "auth" || failures >= 3 ? 2 : 1,
      });
    const recent = rounds.slice(0, 3),
      signatures = recent.map((r) =>
        outputSignature(
          tasks.find((t) => t.id === r.task),
          r,
        ),
      );
    if (
      recent.length === 3 &&
      recent.every((r) => ["done", "nothing"].includes(r.state) && !r.failure) &&
      (signatures.every((s) => !s) ||
        (signatures.every((s) => s === signatures[0]) &&
          signatures[0] ===
            outputSignature(
              tasks.find((t) => t.id === rounds[3]?.task),
              rounds[3],
            )))
    )
      add(`idle:${key}`, {
        kind: "idle",
        business: project?.business,
        role: last.role,
        task: last.task,
        title: `${project?.name ?? "公司"} · ${last.role}连续空转`,
        impact: "连续3轮未产生新交付或结构化状态变化",
        evidence: `轮次${recent.map((r) => r.id).join("、")}`,
        suggestion: "调整当天计划或暂停重复任务，不再空查",
        severity: 1,
      });
  }
  const ceoLimit = config.dailyModelRuns?.ceo,
    ceoUsed = runtime.roles.ceo ?? 0;
  if (ceoLimit && ceoUsed >= 0.8 * ceoLimit)
    add(`quota:ceo:${date}`, {
      kind: "quota",
      role: "ceo",
      title: "CEO额度接近上限",
      impact: "管理任务可能排到明天",
      evidence: `已用${ceoUsed}/${ceoLimit}轮`,
      suggestion: "合并处理异常；需要增加额度时请董事长决定",
      severity: ceoUsed >= ceoLimit ? 2 : 1,
    });
  for (const card of runtime.cards.filter(
    (c) => c.title === "发布确认" && c.state === "open" && ms - Date.parse(c.at) >= 4 * 3600_000,
  ))
    add(`approval:${card.id}`, {
      kind: "approval-overdue",
      title: "发布确认已等待超过4小时",
      impact: "稿件仍未获董事长确认",
      evidence: `确认卡${card.id}，创建时间${card.at}`,
      suggestion: "仅提醒董事长一次，不能代确认或代发",
      severity: 1,
      reminderOnly: true,
    });
  for (const proof of publications.filter(
    (p) => p.x && p.x.state !== "published" && ms - Date.parse(p.publishedAt) >= 86400_000,
  ))
    add(`x:${proof.key}`, {
      kind: "x-overdue",
      title: "X稿件待发超过1天",
      impact: "X仍未登记手动发布",
      evidence: `稿件${proof.key}，待发起点${proof.publishedAt}`,
      suggestion: "仅提醒董事长一次，不能代发或代确认",
      severity: 1,
      reminderOnly: true,
    });
  if (config.reporting?.enabled && ms >= Date.parse(`${date}T20:45:00+08:00`)) {
    const entry = chief.eveningReports?.find((r) => r.date === date);
    const delivered = runtime.cards.some((c) => c.key === `ceo-evening-${date}` && c.delivered);
    if (!entry?.processed || !delivered)
      add(`report:${date}`, {
        kind: "report-missing",
        role: "ceo",
        title: "今天日报尚未生成或送达",
        impact: "董事长无法看到当天经营结果",
        evidence: `日报${entry?.processed ? "已生成但未送达" : "尚未生成"}`,
        suggestion: "沿用当日日报任务；已生成则检查飞书投递，不重复生成",
        severity: ms >= Date.parse(`${date}T21:15:00+08:00`) ? 2 : 1,
      });
  }
  return found;
}
export function reconcileHealth(state: HealthState | undefined, findings: HealthFinding[], now: Date): HealthState {
  const next: HealthState = structuredClone(state ?? { revision: 0, pending: false, incidents: [] });
  next.checkedAt = now.toISOString();
  for (const finding of findings) {
    let old = next.incidents.find((i) => i.id === finding.id);
    if (!old || old.resolvedAt || finding.severity > old.severity) {
      next.revision++;
      next.pending = true;
    }
    if (!old) {
      old = { ...finding, firstAt: now.toISOString(), lastAt: now.toISOString(), actions: [] };
      next.incidents.push(old);
    } else {
      Object.assign(old, finding, { lastAt: now.toISOString() });
      delete old.resolvedAt;
    }
  }
  for (const old of next.incidents)
    if (!old.resolvedAt && !findings.some((f) => f.id === old.id)) old.resolvedAt = now.toISOString();
  return next;
}
export function canNotify(incident: HealthIncident, now: Date) {
  return (
    !incident.notifiedAt ||
    (!incident.reminderOnly &&
      (now.getTime() - Date.parse(incident.notifiedAt) >= 86400_000 ||
        incident.severity > (incident.notifiedSeverity ?? 0)))
  );
}
export function healthReport(state: HealthState | undefined, date: string) {
  const lines = (state?.incidents ?? [])
    .filter((i) => localDay(new Date(i.firstAt)) === date || i.actions.some((a) => localDay(new Date(a.at)) === date))
    .map(
      (i) =>
        `${i.title}：${
          i.actions
            .filter((a) => localDay(new Date(a.at)) === date)
            .map((a) => a.result)
            .join("；") || "已发现，待处理"
        }${i.resolvedAt ? "（已核实恢复）" : "（仍在跟进）"}`,
    );
  return lines.length ? "\n\n今天 CEO 发现并处理的问题\n" + lines.join("\n").slice(0, 1500) : "";
}
