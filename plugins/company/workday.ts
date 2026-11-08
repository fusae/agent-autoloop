import { createHash } from "node:crypto";
import type { CompanyConfig, Role } from "./company.ts";

export const permissions = {
  employee: ["write", "image", "revise", "package", "data", "review", "plan"],
  ceo: ["publish", "activate-staff", "weekly-target", "reply"],
  chairman: ["weekly-direction", "deploy", "spend", "account"],
} as const;
export type WorkOperation = (typeof permissions)[keyof typeof permissions][number];
export type WeeklyGoal = {
  business: string;
  role: Exclude<Role, "ceo">;
  week: string;
  direction: string;
  metrics: { name: string; target: number | null; unit: string }[];
};
export const localDay = (now: Date) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
export function weekOf(now: Date) {
  const d = new Date(localDay(now));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export function weeklyGoal(value: any): WeeklyGoal {
  if (
    !value ||
    !/^[A-Za-z0-9_-]{1,40}$/.test(value.business) ||
    !["product", "engineering", "qa", "growth", "support", "finance"].includes(value.role) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.week) ||
    !Number.isFinite(Date.parse(value.week)) ||
    weekOf(new Date(value.week)) !== value.week ||
    typeof value.direction !== "string" ||
    !value.direction.trim() ||
    value.direction.length > 160 ||
    !Array.isArray(value.metrics) ||
    !value.metrics.length ||
    value.metrics.length > 3
  )
    throw Error("周目标需要项目、岗位、周一日期、方向和1–3个指标");
  const metrics = value.metrics.map((m: any) => {
    if (
      !m ||
      typeof m.name !== "string" ||
      !m.name.trim() ||
      m.name.length > 40 ||
      typeof m.unit !== "string" ||
      !m.unit.trim() ||
      m.unit.length > 20 ||
      (m.target !== null && (typeof m.target !== "number" || !Number.isFinite(m.target) || m.target < 0))
    )
      throw Error("周目标指标需要名称、非负目标或null（观察基数）、单位");
    return { name: m.name.trim(), target: m.target, unit: m.unit.trim() };
  });
  return { business: value.business, role: value.role, week: value.week, direction: value.direction.trim(), metrics };
}
export function validateWorkday(config: Partial<CompanyConfig>) {
  if (
    config.workday !== undefined &&
    (!config.workday ||
      typeof config.workday.enabled !== "boolean" ||
      !/^(09|1\d|2[0-3]):[0-5]\d$/.test(config.workday.after))
  )
    throw Error("上班时间需为北京时间09:00或之后");
  if (
    config.workday?.startDate !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(config.workday.startDate) ||
      !Number.isFinite(Date.parse(config.workday.startDate)) ||
      new Date(config.workday.startDate).toISOString().slice(0, 10) !== config.workday.startDate)
  )
    throw Error("上班开始日期不正确");
  if (config.workday?.enabled && (!config.ceoMode || !config.dailyPlanning || !config.permissions))
    throw Error("上班需启用CEO、每日安排和权限表");
  if (config.permissions !== undefined && JSON.stringify(config.permissions) !== JSON.stringify(permissions))
    throw Error("权限表必须保留员工、CEO、董事长三级边界");
}
export function automatic(operation?: WorkOperation) {
  return !!operation && (permissions.employee as readonly string[]).includes(operation);
}
export function nextWorkday(now: Date, after: string, issued?: string, startDate?: string) {
  const date = startDate && startDate > localDay(now) ? startDate : localDay(now);
  const at = new Date(`${date}T${after}:00+08:00`);
  if (issued === date) at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString();
}
export const goalApproval = (goal: WeeklyGoal) =>
  "weekly:" + createHash("sha256").update(JSON.stringify(goal)).digest("hex");

export const production = (operation?: string) => ["write", "image", "revise", "package"].includes(operation ?? "");
export function draftStock(
  plans: import("./operations.ts").Plan[],
  goal: WeeklyGoal | undefined,
  results: import("./publication.ts").Publication[],
  now: Date,
) {
  const published = new Set(results.map((r) => r.key));
  const content = plans.filter(
    (p) => p.kind === "content" && p.owner === "growth" && (production(p.operation) || !p.operation),
  );
  const ready = content.filter(
    (p) => ["delivered", "publishing"].includes(p.status) && !published.has(p.publicationKey ?? ""),
  ).length;
  const making = content.filter((p) => ["planned", "working"].includes(p.status)).length;
  const thisWeek = results.filter(
    (r) =>
      localDay(new Date(r.publishedAt)) >= weekOf(now) &&
      localDay(new Date(r.publishedAt)) <= localDay(now) &&
      plans.some((p) => p.publicationKey === r.key),
  ).length;
  const target = goal?.week === weekOf(now) ? (goal.metrics.find((m) => m.unit === "篇")?.target ?? null) : null;
  return {
    published: thisWeek,
    ready,
    making,
    target,
    limit: 2,
    needsProduction: target !== null && thisWeek + ready < target && ready + making < 2,
  };
}
