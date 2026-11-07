import {
  validatePublishPolicy,
  publicationChannel,
  publicationResults,
  publicationUsage,
  publicationPreview,
  nextPublishDay,
  type PublishApproval,
  type PublishReservation,
} from "./publication-policy.ts";
import { arrangementText } from "./arrangement.ts";
import { ownerReplyEvidence } from "./owner-replies.ts";
import { freezePublication } from "./publication.ts";
import { sourceSnapshots } from "./sources.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  departments,
  taskId,
  taskRequest,
  workflows,
  type Role,
  type Task,
  type Receipt,
  type CompanyConfig,
} from "./company.ts";
import { executiveDecision, type Leadership, type ExecutiveDecision, type Issue, type StaffPlan } from "./executive.ts";
import type { Context } from "./company.ts";
import type { Business, Metric } from "./business.ts";
import type { ActionProposal, Inspection } from "./inspection.ts";

type Portfolio = (Business & { metrics: Metric[] })[];
type EmployeePlan = Omit<StaffPlan, "business" | "role"> & { issuedAt: string; checkedAt?: string; checkTask?: string };
function sameFollowup(a: EmployeePlan, b: EmployeePlan) {
  return (
    a.mode === "followup" &&
    b.mode === "followup" &&
    a.plan === b.plan &&
    Date.parse(a.reviewAt) === Date.parse(b.reviewAt)
  );
}
function mergeFollowups(s: Employee) {
  if (!s.followups?.length) return;
  const kept: EmployeePlan[] = [];
  for (const f of s.followups) {
    const current = s.daily && sameFollowup(s.daily, f) ? s.daily : kept.find((k) => sameFollowup(k, f));
    if (!current) {
      kept.push(f);
      continue;
    }
    // Keep the receipt link if either copy was already dispatched; merging must not run it again.
    current.checkTask ??= f.checkTask;
    current.checkedAt ??= f.checkedAt;
  }
  s.followups = kept;
}
export type Employee = {
  daily?: EmployeePlan;
  followups?: EmployeePlan[];
  role: Role;
  duty: string;
  checks: string[];
  cadence: "daily" | "weekly";
  enabled: boolean;
  nextAt: string;
  lastTask: string | null;
  processed: string | null;
  lastChecked: string | null;
  finding: string;
  fingerprint: string | null;
  reviewKeys?: string[];
};
export type Plan = ActionProposal & {
  id: string;
  proposedBy: Role;
  owner: Role;
  sourceTask: string;
  task: string | null;
  status:
    "proposed" | "planned" | "working" | "blocked" | "observing" | "review" | "closed" | "delivered" | "publishing";
  revision?: number;
  deliveryTask?: string;
  deliveryDecision?: "revise" | "accept" | "publish";
  publicationKey?: string;
  publishApproval?: PublishApproval;
  publishWait?: { reason: string; nextAt?: string };
  createdAt: string;
  dueAt: string;
  followUpAt: string | null;
  deliveredAt: string | null;
  outcome: Inspection["reviews"][number] | null;
  result: string;
};
type Signal = { id: string; title: string; detail: string; source: string; role: Role | "all"; at: string };
type Project = {
  publishReservations?: PublishReservation[];
  business: string;
  owner: Role;
  maxDailyTasks: number;
  maxActive: number;
  staff: Employee[];
  plans: Plan[];
  signals: Signal[];
  activity: { task: string; role: Role; kind: "check" | "work"; at: string }[];
};
const duties: Record<Exclude<Role, "ceo">, [string, string[]]> = {
  product: [
    "项目负责人：维护目标、优先级和跨部门计划",
    ["目标与指标差距", "计划进度、阻塞和逾期", "完成工作的业务效果"],
  ],
  engineering: ["维护产品可靠性，排查缺陷，准备修复", ["已提供的错误日志与故障", "产品维护清单", "修复后的验证依据"]],
  qa: ["维护验收标准，核验交付质量", ["验收失败和遗漏", "关键使用流程", "交付与真实效果的区别"]],
  growth: ["维护获客渠道、内容计划和激活效果", ["渠道与新增用户", "内容事实与使用场景", "已执行实验的效果"]],
  support: ["整理用户反馈，维护问题清单和回复资料", ["投诉与使用障碍", "未解决问题", "回复草稿与产品事实"]],
  finance: ["核对收入、费用和预算资料", ["收入与支出凭据", "成本异常", "预算和缺失账目"]],
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const day = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const after = (d: Date, days: number) => new Date(d.getTime() + days * 86400_000).toISOString();
const roles = Object.keys(departments).filter((r) => r !== "ceo") as Exclude<Role, "ceo">[];
const words = (v: unknown, max: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`内容需要 1–${max} 字`);
  return v.trim();
};
export class Operations {
  private db: DatabaseSync;
  private directory: string;
  private dailyPlanning: boolean;
  private config: Partial<CompanyConfig>;
  private onDuty(s: Employee) {
    return s.enabled && (!this.config.activeRoles || this.config.activeRoles.includes(s.role));
  }
  constructor(directory: string) {
    this.directory = directory;
    const configFile = join(directory, "company.json");
    this.config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
    validatePublishPolicy(this.config);
    this.dailyPlanning = this.config.dailyPlanning === true;
    mkdirSync(join(directory, "workspace/knowledge/operations"), { recursive: true, mode: 0o700 });
    const file = join(directory, "operations.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS leadership(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY,project TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);`);
  }
  executive(): Leadership {
    const row = this.db.prepare("SELECT body FROM leadership WHERE id='company'").get();
    return row
      ? JSON.parse(row.body as string)
      : {
          enabled: false,
          lastTask: null,
          processed: null,
          fingerprint: null,
          lastReportDay: null,
          briefs: {},
          issues: [],
          questions: [],
          knowledge: [],
          decisions: [],
          runs: [],
          answeredCards: [],
          retries: {},
        };
  }
  private saveExecutive(c: Leadership) {
    this.db
      .prepare("INSERT INTO leadership VALUES ('company',?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(JSON.stringify(c));
  }
  leadership(enabled: boolean, now = new Date()) {
    const c = this.executive();
    c.enabled = enabled;
    this.saveExecutive(c);
    return c;
  }
  close() {
    this.db.close();
  }
  private get(id: string, now = new Date()): Project {
    taskId(id);
    const row = this.db.prepare("SELECT body FROM projects WHERE id=?").get(id);
    if (row) return JSON.parse(row.body as string);
    return {
      business: id,
      owner: "product",
      maxDailyTasks: 12,
      maxActive: 3,
      staff: roles.map((role) => ({
        role,
        duty: duties[role][0],
        checks: duties[role][1],
        cadence: role === "finance" || role === "qa" ? "weekly" : "daily",
        enabled: true,
        nextAt: now.toISOString(),
        lastTask: null,
        processed: null,
        lastChecked: null,
        finding: "尚未检查",
        fingerprint: null,
      })),
      plans: [],
      signals: [],
      activity: [],
    };
  }
  private save(p: Project, kind: string, now: Date) {
    const body = JSON.stringify(p);
    this.db
      .prepare("INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(p.business, body);
    this.db
      .prepare("INSERT INTO journal(project,kind,at,body) VALUES (?,?,?,?)")
      .run(p.business, kind, now.toISOString(), body);
  }
  configure(id: string, role: string, data: Record<string, unknown>, now = new Date()) {
    if (!roles.includes(role as Exclude<Role, "ceo">)) throw new Error("员工不存在");
    const p = this.get(id, now),
      s = p.staff.find((s) => s.role === role)!;
    if (data.duty !== undefined) s.duty = words(data.duty, 500);
    if (data.checks !== undefined) {
      if (!Array.isArray(data.checks) || !data.checks.length || data.checks.length > 6)
        throw new Error("检查事项需要 1–6 项");
      s.checks = data.checks.map((v) => words(v, 120));
    }
    if (data.enabled !== undefined) {
      if (typeof data.enabled !== "boolean") throw new Error("启用状态不正确");
      s.enabled = data.enabled;
    }
    if (data.cadence !== undefined) {
      if (data.cadence !== "daily" && data.cadence !== "weekly") throw new Error("检查周期不正确");
      s.cadence = data.cadence;
    }
    s.fingerprint = null;
    s.nextAt = now.toISOString();
    this.save(p, "responsibility", now);
    return s;
  }
  settings(id: string, data: Record<string, unknown>, now = new Date()) {
    const p = this.get(id, now);
    for (const [key, max] of [
      ["maxDailyTasks", 50],
      ["maxActive", 6],
    ] as const) {
      // Older clients may still send this field; retain it without using it as a dispatch gate.
      if (key === "maxDailyTasks" && data[key] === undefined) continue;
      if (!Number.isInteger(data[key]) || Number(data[key]) < 1 || Number(data[key]) > max)
        throw new Error("派工额度超出范围");
      p[key] = Number(data[key]);
    }
    this.save(p, "settings", now);
    return p;
  }
  signal(id: string, data: Record<string, unknown>, now = new Date()) {
    const p = this.get(id, now),
      role = data.role ?? "all";
    if (role !== "all" && !roles.includes(role as Exclude<Role, "ceo">)) throw new Error("员工不存在");
    const signal: Signal = {
      id: randomUUID(),
      title: words(data.title, 100),
      detail: words(data.detail, 1000),
      source: words(data.source, 200),
      role: role as Signal["role"],
      at: now.toISOString(),
    };
    p.signals = [...p.signals, signal].slice(-100);
    this.save(p, "signal", now);
    return signal;
  }
  snapshot(businesses: Portfolio, tasks: Task[], now = new Date()) {
    return businesses.map((b) => {
      const p = this.get(b.id, new Date(b.createdAt));
      return {
        ...p,
        owner: p.owner,
        manager: this.executive().enabled ? "ceo" : null,
        name: b.name,
        enabled: !!b.autonomy,
        status: b.status,
        todayTasks: p.activity.filter((a) => day(new Date(a.at)) === day(now)).length,
        staff: p.staff.map((s) => {
          const assigned = p.activity
            .map((a) => tasks.find((t) => t.id === a.task))
            .sort((a, b) => Number(b?.status === "active") - Number(a?.status === "active"))
            .find(
              (t) =>
                t &&
                this.currentTask(p, t.id) &&
                ["active", "blocked", "awaiting_approval"].includes(t.status) &&
                workflows[t.kind]?.[t.stage] === s.role,
            );
          const work =
            p.plans.find((a) => assigned && a.task === assigned.id) ??
            p.plans.find(
              (a) =>
                a.owner === s.role &&
                ["planned", "working", "blocked", "proposed", "review", "delivered", "publishing"].includes(a.status),
            );
          const t = assigned ?? tasks.find((t) => t.id === (work?.task ?? s.lastTask));
          const currentTask = t ? (({ approval: _approval, ...safe }) => safe)(t) : null;
          const issue = this.executive().issues.find(
            (i) => i.business === b.id && i.role === s.role && i.state !== "answered",
          );
          let workStatus = "等待新情况",
            nextAction = "暂无待执行工作；新资料或到期复盘会唤醒";
          if (!b.autonomy || b.status !== "active" || !s.enabled) {
            workStatus = !s.enabled ? "已停用" : b.status === "paused" ? "已暂停" : "未启动";
            nextAction = `${workStatus}${work ? `：${work.title}` : ""}`;
          } else if (assigned) {
            workStatus =
              assigned.status === "blocked" ? "受阻" : assigned.status === "awaiting_approval" ? "待审批" : "处理中";
            nextAction = assigned.status === "blocked" ? assigned.reason : assigned.title;
          } else if (work) {
            workStatus = ["working", "publishing"].includes(work.status)
              ? "等待交接"
              : ["proposed", "delivered"].includes(work.status)
                ? "待 CEO 审核"
                : work.status === "blocked"
                  ? "受阻"
                  : work.status === "review"
                    ? "待复盘"
                    : "待派工";
            const busy = p.activity.filter(
              (a) => !tasks.some((t) => t.id === a.task) || tasks.some((t) => t.id === a.task && t.status === "active"),
            ).length;
            const reason =
              work.status === "planned"
                ? busy >= p.maxActive
                  ? "等待在途任务完成"
                  : "等待下一次派工检查"
                : work.status === "blocked"
                  ? work.result
                  : work.status === "working" && t
                    ? `${departments[workflows[t.kind]?.[t.stage]] ?? "下一岗位"}处理中`
                    : workStatus;
            nextAction = `${work.title}：${reason}`;
          } else if (issue) {
            workStatus = issue.state === "owner" ? "待负责人答复" : "待 CEO 处理";
            nextAction = issue.question;
          }
          const daily = s.daily;
          if (
            !assigned &&
            !work &&
            !issue &&
            this.onDuty(s) &&
            b.autonomy &&
            b.status === "active" &&
            this.dailyPlanning
          ) {
            workStatus =
              !daily || daily.date !== day(now) ? "待 CEO 今日安排" : daily.mode === "standby" ? "待命" : "待复查";
            nextAction = !daily || daily.date !== day(now) ? "CEO更新今日目标和工作" : daily.focus;
          }
          if (!assigned && !work && !issue && !this.onDuty(s)) {
            workStatus = "未在岗";
            nextAction = "有具体工作时可临时派工";
          }
          return {
            ...s,
            onDuty: this.onDuty(s),
            inspections: this.config.inspections ?? true,
            currentTask,
            workStatus,
            nextAction,
          };
        }),
        alerts: p.plans
          .filter(
            (a) =>
              a.status === "blocked" ||
              (["planned", "working", "publishing", "delivered"].includes(a.status) &&
                Date.parse(a.dueAt) < now.getTime()),
          )
          .map((a) => ({
            plan: a.id,
            title: a.title,
            reason: a.status === "blocked" ? a.result : "任务逾期",
            task: a.task,
          })),
      };
    });
  }
  private currentTask(p: Project, task: string) {
    return p.plans.some((a) => a.task === task && a.status !== "closed") || p.staff.some((s) => s.lastTask === task);
  }
  private profile(p: Project, b: Portfolio[number], tasks: Task[]) {
    const file = join(this.directory, "workspace/knowledge/operations", b.id + ".json"),
      temp = file + "." + randomUUID() + ".tmp";
    // Persist only public task fields; approval tokens must never become model context.
    const recent = p.activity.slice(-30).map((a) => {
      const t = tasks.find((t) => t.id === a.task);
      return { ...a, status: t?.status ?? "dispatching", reports: t?.reports ?? [] };
    });
    writeFileSync(
      temp,
      JSON.stringify(
        {
          business: b,
          owner: p.owner,
          manager: this.executive().enabled ? "ceo" : null,
          ceoGoal: this.executive().briefs[b.id] ?? null,
          dailyPlanning: this.dailyPlanning,
          knowledge: this.executive().knowledge.filter((k) => k.business === b.id),
          staff: p.staff,
          plans: p.plans,
          signals: p.signals,
          recent,
          limits: { maxActive: p.maxActive },
          evidence: sourceSnapshots(this.directory)[b.id] ?? null,
          sources: {
            metrics: sourceSnapshots(this.directory)[b.id]?.database.data
              ? "已接入只读数据库汇总，见 evidence.database；具体指标按口径核验"
              : b.metrics.length
                ? "人工录入"
                : "未接入",
            feedback: sourceSnapshots(this.directory)[b.id]?.database.data
              ? "数据源包含可用反馈汇总时见 evidence.database；没有反馈表不代表零反馈"
              : "人工录入",
            production: "未接入",
            publishing: "内容完成后由 CEO 审核；发布入口执行，失败交 CEO 处理",
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(temp, file);
  }
  private ceoInputs(c: Leadership, businesses: Portfolio, tasks: Task[], now: Date) {
    return hash(
      JSON.stringify({
        day: day(new Date(now.getTime() - 9 * 3600_000)),
        businesses: businesses
          .filter((b) => b.autonomy && b.status === "active")
          .map((b) => ({
            id: b.id,
            objective: b.objective,
            description: b.description,
            metrics: b.metrics,
            evidenceRevision: sourceSnapshots(this.directory)[b.id]?.revision ?? null,
            project: this.get(b.id, now),
          }))
          .map(({ project, ...b }) => ({
            ...b,
            plans: project.plans.map((a) => [a.id, a.status, a.priority, a.result]),
            signals: project.signals,
            ...(this.dailyPlanning
              ? {
                  staffPlans: project.staff
                    .filter((s) => this.onDuty(s))
                    .map((s) => [
                      s.role,
                      s.daily ?? null,
                      s.followups ?? [],
                      !!s.daily &&
                        Date.parse(s.daily.reviewAt) <= now.getTime() &&
                        (!s.daily.checkedAt || s.daily.checkedAt < s.daily.reviewAt),
                    ]),
                }
              : {}),
            work: project.activity.map((a) => {
              const t = tasks.find((t) => t.id === a.task);
              return [a.task, t?.status, t?.assignment, t?.reason];
            }),
          })),
        issues: c.issues.filter((i) => i.state === "open"),
        knowledge: c.knowledge,
        briefs: c.briefs,
      }),
    );
  }
  private manage(
    c: Leadership,
    businesses: Portfolio,
    tasks: Task[],
    answers: Context["answers"],
    receipt: Receipt,
    now: Date,
  ) {
    const active = businesses.filter((b) => b.autonomy && b.status === "active");
    // Verified completion resolves internal blockers; never infer an owner's answer or close their pending decision.
    for (const issue of c.issues.filter((i) => i.state === "open" && active.some((b) => b.id === i.business))) {
      const task = tasks.find((t) => t.id === issue.task),
        report = task?.reports.at(-1);
      if (task?.status === "superseded") {
        issue.state = "answered";
        issue.answer = `原任务已取代关闭：${task.reason}`;
      }
      if (task?.status === "completed" && report?.verdict === "pass" && report.inspection?.state !== "blocked") {
        issue.state = "answered";
        issue.answer = `原任务已通过验收：${task.reason}`;
      }
    }
    const addIssue = (issue: Issue) => {
      if (!c.issues.some((i) => i.id === issue.id)) c.issues.push(issue);
    };
    for (const b of active) {
      if (!c.briefs[b.id] && !c.knowledge.some((k) => k.business === b.id && k.source === "owner"))
        addIssue({
          id: hash(`onboarding:${b.id}`),
          business: b.id,
          role: "ceo",
          task: null,
          question: `${b.name} 目前进展到哪一步，真实数据在哪里，当前最优先的目标是什么？`,
          context: "先核对档案，已知的不要重复问；缺少的由 CEO 汇总向负责人了解。",
          state: "open",
          answer: null,
          at: now.toISOString(),
        });
      const p = this.get(b.id, now);
      for (const activity of p.activity) {
        const t = tasks.find((t) => t.id === activity.task),
          report = t?.reports.at(-1);
        if (!t || !this.currentTask(p, t.id)) continue;
        if (t.status !== "blocked" && !(t.status === "completed" && report?.inspection?.state === "blocked")) continue;
        const qs = report?.inspection?.questions?.length
          ? report.inspection.questions
          : [{ key: "blocked", question: t.reason, context: report?.evidence.join("；") ?? "任务未完成" }];
        for (const q of qs)
          addIssue({
            id: hash(`${b.id}:${t.id}:${t.assignment}:${q.key}`),
            business: b.id,
            role: activity.role,
            task: t.id,
            question: q.question,
            context: q.context,
            state: "open",
            answer: null,
            at: now.toISOString(),
          });
      }
    }
    for (const answer of answers) {
      if (c.answeredCards.includes(answer.card)) continue;
      const q = c.questions.find((q) => `ceo:${q.id}` === answer.about && q.state === "open");
      if (!q) continue;
      c.answeredCards.push(answer.card);
      const selected = answer.choice === null ? undefined : (q.options ?? ["资料已补充", "暂缓"])[answer.choice];
      if (selected === "暂缓" && !answer.text) {
        q.state = "deferred";
        q.answer = "暂缓";
        continue;
      }
      q.state = "answered";
      q.answer = (answer.text?.trim() || selected || "负责人确认已处理，请核对更新后的资料").slice(0, 4000);
      for (const issue of c.issues.filter((i) => q.issues.includes(i.id))) {
        issue.state = "open";
        // New owner evidence permits another CEO-led attempt; replayed cards never reach here.
        if (issue.task) c.retries[issue.task] = 0;
        c.knowledge.push({
          id: hash(`${answer.card}:${issue.id}`),
          business: issue.business,
          issue: issue.id,
          answer: q.answer,
          source: "owner",
          evidence: `负责人回复 C${answer.card}`,
          at: now.toISOString(),
        });
      }
    }
    const task = tasks.find((t) => t.id === c.lastTask);
    if (!task || task.status !== "completed" || c.processed === `${task.id}:${task.assignment}`) return;
    const report = task.reports.at(-1),
      d = report?.executive;
    if (!d) return;
    c.processed = `${task.id}:${task.assignment}`;
    const error = this.applyDecision(c, businesses, tasks, d, task.id, report!.summary, receipt, now);
    if (error) {
      c.fingerprint = null;
      if (active[0])
        addIssue({
          id: hash(`invalid:${task.id}`),
          business: active[0].id,
          role: "ceo",
          task: null,
          question: error,
          context: report!.summary,
          state: "open",
          answer: null,
          at: now.toISOString(),
        });
      return;
    }
    if (c.lastReportDay !== day(now) && !receipt.ask?.length) {
      receipt.notice ??= [];
      receipt.notice.push({ key: `ceo-report-${day(now)}`, title: "CEO · 工作汇报", text: report!.summary });
      c.lastReportDay = day(now);
    }
  }
  private applyDecision(
    c: Leadership,
    businesses: Portfolio,
    tasks: Task[],
    d: ExecutiveDecision,
    decisionId: string,
    summary: string,
    receipt: Receipt,
    now: Date,
  ): string | null {
    const active = businesses.filter((b) => b.autonomy && b.status === "active");
    const known = (id: string) => active.some((b) => b.id === id);
    const valid =
      d.briefs.every((a) => known(a.business)) &&
      d.directives.every((a) => known(a.business)) &&
      d.approvals.every((a) => known(a.business) && this.get(a.business, now).plans.some((p) => p.id === a.plan)) &&
      d.answers.every((a) => c.issues.some((i) => i.id === a.issue)) &&
      d.escalations.every(
        (a) =>
          (!a.business || known(a.business)) &&
          a.issues.every((id) => c.issues.some((i) => i.id === id && (!a.business || i.business === a.business))),
      );
    if (!valid) return "CEO 决策引用了不存在或暂停的项目、计划或问题，请重新核对编号。";
    const staffPlans = d.staffPlans ?? [];
    if (staffPlans.length && !this.dailyPlanning) return "每日规划尚未启用";
    if (new Set(staffPlans.map((a) => `${a.business}:${a.role}`)).size !== staffPlans.length)
      return "同一员工不能重复安排";
    const resolved = new Map<StaffPlan, string>();
    for (const a of staffPlans) {
      const p = known(a.business) ? this.get(a.business, now) : undefined;
      if (!p?.staff.some((s) => s.role === a.role && s.enabled)) return "每日安排引用了未知、暂停项目或停用员工";
      if (
        a.date !== day(now) ||
        Date.parse(a.reviewAt) <= now.getTime() ||
        Date.parse(a.reviewAt) > now.getTime() + 7 * 86400_000
      )
        return "每日安排必须属于今天，复查时间在未来7天以内";
      if (a.plan) {
        const fresh = d.directives.find((d) => d.business === a.business && d.action.key === a.plan);
        const existing = p.plans.find(
          (p) => p.id === a.plan || (fresh && p.id === hash(`${a.business}:ceo:${fresh.action.key}`)),
        );
        const target = existing ?? fresh?.action;
        if (!target || workflows[target.kind][0] !== a.role) return "每日安排必须关联本员工负责的真实计划或本轮指令key";
        if (a.mode === "work" && existing?.status === "closed")
          return "已关闭计划不能重新当作执行任务，请安排跟进或新的实际工作";
        resolved.set(a, existing?.id ?? hash(`${a.business}:ceo:${fresh!.action.key}`));
      }
    }
    if (d.escalations.some((a) => a.issues.some((id) => c.issues.find((i) => i.id === id)?.state === "answered")))
      return "上报引用了已答复的问题，不能作为新的待决事项。请先使用已有答案；确有新缺口时提供 business 项目编号和 issues:[]，不要借用历史问题编号。";
    if (new Set((d.ownerReplies ?? []).map((r) => r.question)).size !== (d.ownerReplies ?? []).length)
      return "同一问题不能重复关联负责人答复";
    const ownerReplies: { question: string; event: number; text: string; message: string; context?: string }[] = [];
    try {
      for (const reply of d.ownerReplies ?? []) {
        const q = c.questions.find((q) => q.id === reply.question);
        if (!q || !q.issues.every((id) => c.issues.some((i) => i.id === id && known(i.business))))
          return "负责人答复引用了未知或暂停项目的问题";
        if (c.ownerReplyEvents?.includes(`${q.id}:${reply.event}`)) continue;
        ownerReplies.push({ ...reply, ...ownerReplyEvidence(this.directory, reply.event, q.at) });
      }
    } catch (error) {
      return `答复未记录：${(error as Error).message}`;
    }
    const deliveries = d.deliveries ?? [];
    if (new Set(deliveries.map((a) => `${a.business}:${a.plan}`)).size !== deliveries.length)
      return "同一成果不能重复审核";
    for (const a of deliveries) {
      const p = known(a.business) ? this.get(a.business, now).plans.find((p) => p.id === a.plan) : undefined;
      if (
        !p ||
        p.task !== a.task ||
        !(
          (p.status === "delivered" && tasks.find((t) => t.id === a.task)?.status === "completed") ||
          (a.verdict === "revise" && p.status === "blocked" && tasks.find((t) => t.id === a.task)?.status === "blocked")
        )
      )
        return "成果已变化或不在待审核状态，请核对当前计划和交付任务。";
      if (a.verdict === "publish" && p.kind !== "content") return "当前发布入口仅支持已审核的运营内容";
    }
    const publications = new Map<string, string>();
    try {
      for (const a of deliveries.filter((a) => a.verdict === "publish"))
        publications.set(
          a.plan,
          freezePublication(
            this.directory,
            a.business,
            a.plan,
            tasks.find((t) => t.id === a.task)!,
            a.files,
          ),
        );
    } catch (error) {
      return `审核未通过：${(error as Error).message}`;
    }
    for (const business of new Set(d.directives.map((v) => v.business))) {
      const p = this.get(business, now);
      const additions = new Set(
        d.directives
          .filter((v) => v.business === business)
          .map((v) => hash(`${business}:ceo:${v.action.key}`))
          .filter((id) => !p.plans.some((p) => p.id === id)),
      );
      if (p.plans.filter((p) => p.status !== "closed").length + additions.size > 30)
        return "该项目已有 30 项未结束计划，请先处理已有工作。";
    }
    if (this.config.ceoWake === "events") {
      delete c.nextReviewAt;
    } else c.nextReviewAt = new Date(now.getTime() + 30 * 60000).toISOString();
    c.decisions.push({ task: decisionId, summary, at: now.toISOString(), decision: d });
    for (const brief of d.briefs) c.briefs[brief.business] = brief.objective;
    for (const directive of d.directives) {
      const p = this.get(directive.business, now),
        a = directive.action,
        id = hash(`${p.business}:ceo:${a.key}`);
      if (p.plans.some((v) => v.id === id) || p.plans.filter((v) => v.status !== "closed").length >= 30) continue;
      p.plans.push({
        ...a,
        id,
        proposedBy: "ceo",
        owner: workflows[a.kind][0],
        sourceTask: decisionId,
        task: null,
        status: "planned",
        createdAt: now.toISOString(),
        dueAt: after(now, a.dueDays),
        followUpAt: null,
        deliveredAt: null,
        outcome: null,
        result: "CEO 已派工",
      });
      this.save(p, "ceo-directive", now);
    }
    for (const a of staffPlans) {
      const p = this.get(a.business, now),
        s = p.staff.find((s) => s.role === a.role)!;
      const { business: _business, role: _role, ...daily } = a;
      if (a.plan) daily.plan = resolved.get(a)!;
      const { issuedAt: _issued, checkedAt: _checked, checkTask: _checkTask, ...previous } = s.daily ?? {};
      if (JSON.stringify(previous) === JSON.stringify(daily)) continue;
      if (s.daily?.mode === "followup" && !s.daily.checkedAt && daily.mode === "work") {
        s.followups ??= [];
        if (!s.followups.some((f) => sameFollowup(f, s.daily!))) s.followups.push(s.daily);
      }
      s.daily = { ...daily, issuedAt: now.toISOString() };
      mergeFollowups(s);
      s.nextAt = a.reviewAt;
      this.save(p, "ceo-daily-plan", now);
    }
    if (
      staffPlans.length &&
      active.some((b) => this.get(b.id, now).staff.some((s) => this.onDuty(s) && s.daily?.date !== day(now)))
    )
      c.nextReviewAt = now.toISOString();
    for (const a of d.approvals) {
      const p = this.get(a.business, now),
        plan = p.plans.find((p) => p.id === a.plan)!;
      if (plan.status !== "proposed") continue;
      plan.status = a.approve ? "planned" : "closed";
      plan.result = a.reason;
      this.save(p, "ceo-approval", now);
    }
    for (const a of deliveries) {
      const p = this.get(a.business, now),
        plan = p.plans.find((p) => p.id === a.plan)!;
      plan.deliveryTask = tasks.find((t) => t.id === a.task)?.kind === "publish-content" ? plan.deliveryTask : a.task;
      plan.deliveryDecision = a.verdict;
      plan.result = a.reason;
      plan.followUpAt = null;
      plan.outcome = null;
      if (a.verdict === "revise") {
        for (const issue of c.issues.filter((i) => i.task === a.task && i.state === "open")) {
          issue.state = "answered";
          issue.answer = `CEO 已退回新一版任务：${a.reason}`;
        }
        c.pendingRetries = (c.pendingRetries ?? []).filter((r) => r.task !== a.task);
        delete plan.publicationKey;
        delete plan.publishApproval;
        delete plan.publishWait;
        plan.revision = (plan.revision ?? 0) + 1;
        plan.task = null;
        plan.status = "planned";
        plan.dueAt = after(now, plan.dueDays);
        plan.deliveredAt = null;
      } else if (a.verdict === "publish") {
        plan.publicationKey = publications.get(a.plan)!;
        delete plan.publishApproval;
        delete plan.publishWait;
        plan.task = null;
        plan.status = "publishing";
      } else plan.status = "closed";
      this.save(p, "ceo-delivery", now);
    }
    for (const reply of ownerReplies) {
      const q = c.questions.find((q) => q.id === reply.question)!;
      q.state = "answered";
      q.answer = reply.text;
      q.answerEvent = reply.event;
      (c.ownerReplyEvents ??= []).push(`${q.id}:${reply.event}`);
      for (const i of c.issues.filter((i) => q.issues.includes(i.id))) {
        i.state = "open";
        if (i.task) c.retries[i.task] = 0;
        c.knowledge.push({
          id: hash(`owner-event:${q.id}:${reply.event}:${i.id}`),
          business: i.business,
          issue: i.id,
          answer: reply.text,
          source: "owner",
          evidence: `负责人消息事件 ${reply.event}`,
          context: reply.context ?? q.question,
          at: now.toISOString(),
        });
      }
    }
    if (deliveries.length || ownerReplies.length) {
      // A bounded review batch must not make the remaining deliverables wait another 30 minutes.
      c.nextReviewAt = now.toISOString();
      c.unchangedReviews = 0;
    }
    for (const a of d.answers) {
      const i = c.issues.find((i) => i.id === a.issue)!;
      if (i.state !== "open") continue;
      const t = tasks.find((t) => t.id === i.task);
      const escalated = d.escalations.some((e) => e.issues.includes(i.id));
      if (!escalated && t?.status === "blocked" && (c.retries[t.id] ?? 0) >= 2) continue;
      i.state = escalated ? "open" : "answered";
      i.answer = a.answer;
      c.knowledge.push({
        id: hash(`${decisionId}:${i.id}`),
        business: i.business,
        issue: i.id,
        answer: a.answer,
        source: "ceo",
        evidence: a.evidence,
        at: now.toISOString(),
      });
      const p = this.get(i.business, now);
      p.signals.push({
        id: hash(`answer:${decisionId}:${i.id}`),
        title: "CEO 答复",
        detail: a.answer,
        source: a.evidence,
        role: roles.includes(i.role as any) ? (i.role as Role) : "all",
        at: now.toISOString(),
      });
      this.save(p, "ceo-answer", now);
      if (!escalated && t?.status === "blocked") {
        c.pendingRetries ??= [];
        if (!c.pendingRetries.some((v) => v.task === t.id)) c.pendingRetries.push({ task: t.id, decision: decisionId });
      }
    }
    for (const e of d.escalations) {
      // CEO may discover a blocker directly; create its durable issue in this same decision transaction.
      const linked = [...e.issues];
      if (!linked.length && e.business) {
        const id = hash(`ceo-question:${e.business}:${e.key}`);
        if (!c.issues.some((i) => i.id === id))
          c.issues.push({
            id,
            business: e.business,
            role: "ceo",
            task: null,
            question: e.question,
            context: e.context,
            state: "open",
            answer: null,
            at: now.toISOString(),
          });
        linked.push(id);
      }
      const ids = linked.filter((id) => c.issues.some((i) => i.id === id && i.state === "open"));
      if (
        !ids.length ||
        c.questions.some(
          (q) =>
            q.key === e.key &&
            q.state === "open" &&
            (!e.business || q.issues.some((id) => c.issues.some((i) => i.id === id && i.business === e.business))),
        )
      )
        continue;
      const q = {
        id: hash(e.business ? `${decisionId}:${e.business}:${e.key}` : `${decisionId}:${e.key}`),
        key: e.key,
        issues: ids,
        question: e.question,
        context: e.context,
        options: e.options ?? ["资料已补充", "暂缓"],
        state: "open" as const,
        answer: null,
        at: now.toISOString(),
      };
      c.questions.push(q);
      for (const i of c.issues.filter((i) => ids.includes(i.id))) i.state = "owner";
      receipt.ask ??= [];
      receipt.ask.push({
        key: `ceo-${q.id}`,
        title: "CEO · 待你决策",
        text: `${q.question}\n\n${q.context}`,
        options: q.options,
        about: `ceo:${q.id}`,
      });
    }
    return null;
  }
  private conversation(
    c: Leadership,
    businesses: Portfolio,
    tasks: Task[],
    events: Context["events"],
    receipt: Receipt,
    now: Date,
  ) {
    for (const e of events) {
      if (e.source !== "company-ceo" || e.type !== "company.ceo.decision") continue;
      const decisionId = `CHAT-${hash(`${e.source}:${e.id}`)}`;
      const key = `ceo-chat-${hash(`${e.source}:${e.id}`)}`;
      if (this.db.prepare("SELECT 1 FROM batches WHERE id=?").get(key)) continue;
      let text = "",
        summary = "",
        decision: ExecutiveDecision | undefined;
      try {
        if (!c.enabled) throw Error("CEO 管理尚未启用");
        const data = JSON.parse(e.detail);
        summary = words(data.summary, 400);
        decision = executiveDecision(data.executive);
      } catch (error) {
        text = `安排未执行：${(error as Error).message}`;
      }
      if (decision) {
        const d = decision;
        const priorQuestions = receipt.ask?.length ?? 0;
        const error = this.applyDecision(c, businesses, tasks, d, decisionId, summary, receipt, now);
        if (error) text = `安排未执行：${error}`;
        else {
          text = arrangementText(
            summary,
            d,
            businesses.map((b) => ({ id: b.id, name: b.name, plans: this.get(b.id, now).plans })),
            c.issues,
            (receipt.ask?.length ?? 0) - priorQuestions,
          );
          c.fingerprint = null;
          delete c.stalled;
        }
      }
      receipt.notice ??= [];
      receipt.notice.push({ key, title: "CEO · 工作安排", text });
      this.db.prepare("INSERT INTO batches VALUES (?,?)").run(key, JSON.stringify({ text }));
    }
  }
  private recover(c: Leadership, businesses: Portfolio, tasks: Task[], receipt: Receipt, now: Date) {
    c.repairs ??= {};
    const active = new Set(
      businesses
        .filter((b) => b.autonomy && b.status === "active")
        .flatMap((b) => {
          const p = this.get(b.id, now);
          return p.activity.filter((a) => this.currentTask(p, a.task)).map((a) => a.task);
        }),
    );
    for (const t of tasks) {
      if (
        t.status !== "blocked" ||
        !(
          t.id === c.lastTask ||
          (active.has(t.id) && (t.reason.startsWith("部门报告格式不合格") || t.reason.startsWith("运行失败")))
        )
      )
        continue;
      const r = (c.repairs[t.id] ??= {
        attempts: 0,
        assignment: 0,
        nextAt: now.toISOString(),
        exhausted: false,
        reason: t.reason,
      });
      r.reason = t.reason;
      if (r.exhausted || r.assignment === t.assignment) continue;
      if (r.attempts >= 2) {
        r.exhausted = true;
        // Employee failures are already issues for the CEO. Only a broken CEO bypasses that escalation path.
        if (t.id === c.lastTask) {
          receipt.notice ??= [];
          receipt.notice.push({
            key: `repair-exhausted-${t.id}`,
            title: "CEO 运行异常",
            text: `${t.title} 连续修复两次仍未通过：${t.reason}。其他工作继续；补充资料或下个经营日再恢复管理。`,
          });
          c.lastTask = null;
          c.fingerprint = this.ceoInputs(c, businesses, tasks, now);
          c.nextReviewAt = after(now, 1);
        }
        continue;
      }
      if (Date.parse(r.nextAt) > now.getTime()) continue;
      r.attempts++;
      r.assignment = t.assignment;
      r.nextAt = new Date(now.getTime() + 5 * 60000).toISOString();
      // Refresh management context before repairing an old task, including owner replies received meanwhile.
      const file = join(this.directory, "workspace/knowledge/ceo.json");
      if (t.id === c.lastTask) this.writeCEOContext(c, businesses, tasks, now, file);
      receipt.events ??= [];
      receipt.events.push({
        id: `company:repair:${t.id}:${t.assignment}`,
        type: "company.task.retry",
        subject: t.id,
        summary: "自动修正报告",
        detail: "{}",
      });
    }
  }
  private writeCEOContext(c: Leadership, businesses: Portfolio, tasks: Task[], now: Date, file: string) {
    const active = businesses.filter((b) => b.autonomy && b.status === "active");
    writeFileSync(
      file + ".tmp",
      JSON.stringify(
        {
          projects: active.map((b) => ({ ...b, ...this.get(b.id, now) })),
          issues: c.issues.filter((i) => i.state !== "answered"),
          knowledge: c.knowledge,
          sources: sourceSnapshots(this.directory),
          questions: c.questions,
          briefs: c.briefs,
          controls: {
            activeRoles: this.config.activeRoles ?? roles,
            inspections: this.config.inspections ?? true,
            ceoWake: this.config.ceoWake ?? "legacy",
            dailyModelRuns: this.config.dailyModelRuns ?? null,
          },
          ...(this.dailyPlanning
            ? {
                planningDate: day(now),
                missingDailyPlans: active.flatMap((b) =>
                  this.get(b.id, now)
                    .staff.filter((s) => this.onDuty(s) && s.daily?.date !== day(now))
                    .map((s) => ({ business: b.id, role: s.role })),
                ),
              }
            : {}),
          decisions: c.decisions.slice(-10),
          retryCounts: c.retries,
          repairs: c.repairs,
          limits: { unchangedReviews: 2, blockedRetries: 2 },
          stalled: c.stalled,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(file + ".tmp", file);
  }
  private eventInputs(c: Leadership, businesses: Portfolio, tasks: Task[], now: Date) {
    const relevant = new Set(
      businesses
        .filter((b) => b.autonomy && b.status === "active")
        .flatMap((b) => this.get(b.id, now).activity.map((a) => a.task)),
    );
    c.eventOutcomes ??= {};
    for (const t of tasks) {
      if (!relevant.has(t.id) || t.kind === "ceo" || !["blocked", "completed"].includes(t.status)) continue;
      const inspection = t.reports.at(-1)?.inspection;
      if (
        t.kind.startsWith("check-") &&
        t.status === "completed" &&
        inspection?.state === "idle" &&
        !inspection.questions?.length &&
        !inspection.actions.length
      )
        continue;
      c.eventOutcomes[t.id] = JSON.stringify([t.assignment, t.status, t.reason]);
    }
    return hash(
      JSON.stringify({
        day: day(new Date(now.getTime() - 9 * 3600_000)),
        results: Object.entries(c.eventOutcomes).sort(),
        answers: c.answeredCards,
      }),
    );
  }
  private scheduleCEO(c: Leadership, businesses: Portfolio, tasks: Task[], receipt: Receipt, now: Date) {
    const active = businesses.filter((b) => b.autonomy && b.status === "active");
    if (!active.length) return;
    const latest = tasks.find((t) => t.id === c.lastTask);
    if (this.config.ceoWake === "events") delete c.nextReviewAt;
    if (latest?.status === "queued") {
      this.writeCEOContext(c, businesses, tasks, now, join(this.directory, "workspace/knowledge/ceo.json"));
      if (this.config.ceoWake === "events") c.eventInputs = this.eventInputs(c, businesses, tasks, now);
    }
    if (c.lastTask && latest?.status !== "completed") return;
    const eventInputs = this.eventInputs(c, businesses, tasks, now);
    if (this.config.ceoWake === "events") {
      delete c.nextReviewAt;
      if (c.eventInputs === eventInputs) return;
    }
    const fingerprint = this.ceoInputs(c, businesses, tasks, now);
    const agenda =
      (this.dailyPlanning &&
        active.some((b) => this.get(b.id, now).staff.some((s) => this.onDuty(s) && s.daily?.date !== day(now)))) ||
      c.issues.some((i) => i.state === "open") ||
      active.some((b) =>
        this.get(b.id, now).plans.some(
          (p) => p.status === "proposed" || p.status === "review" || p.status === "delivered",
        ),
      );
    const unchanged = fingerprint === c.fingerprint;
    if (unchanged && this.config.ceoWake !== "events") {
      if (!(agenda && c.nextReviewAt && Date.parse(c.nextReviewAt) <= now.getTime())) return;
      if ((c.unchangedReviews ?? 0) >= 2) {
        if (c.stalled?.fingerprint !== fingerprint) {
          const pending = [
            ...c.issues.filter((i) => i.state === "open").map((i) => i.question),
            ...active.flatMap((b) =>
              this.get(b.id, now)
                .plans.filter((p) => p.status === "proposed" || p.status === "review" || p.status === "delivered")
                .map((p) => p.title),
            ),
          ];
          c.stalled = {
            fingerprint,
            at: now.toISOString(),
            reason: `相同资料已复查两次，仍无处理结果：${pending.slice(0, 3).join("；")}`,
          };
          // An unanswered management blocker needs a reply path, not a terminal status notice.
          for (const b of active) {
            for (const p of this.get(b.id, now).plans.filter(
              (p) => p.status === "proposed" || p.status === "review" || p.status === "delivered",
            )) {
              const id = hash(`stalled-plan:${p.id}:${p.status}`);
              if (!c.issues.some((i) => i.context.startsWith(`计划 ${p.id}：`) && i.state !== "answered"))
                c.issues.push({
                  id: hash(`${id}:${fingerprint}`),
                  business: b.id,
                  role: "ceo",
                  task: null,
                  question: `${b.name} · ${p.title}：${p.status === "proposed" ? "CEO 未决定是否执行" : p.status === "delivered" ? "CEO 未审核已交付成果" : "CEO 未处理效果复盘"}`,
                  context: `计划 ${p.id}：${p.result}`,
                  state: "open",
                  answer: null,
                  at: now.toISOString(),
                });
            }
          }
          // Automatic fallback cannot distinguish a new blocker from another department's follow-up.
          // Keep those internal when that project already has an owner decision; explicit CEO escalations still work.
          const waitingBusinesses = new Set(
            c.questions
              .filter((q) => q.state === "open" || q.state === "deferred")
              .flatMap((q) => c.issues.filter((i) => q.issues.includes(i.id)).map((i) => i.business)),
          );
          const issues = c.issues.filter((i) => i.state === "open" && !waitingBusinesses.has(i.business)).slice(0, 8);
          if (issues.length) {
            const names = [...new Set(issues.map((i) => active.find((b) => b.id === i.business)?.name ?? i.business))];
            const question = `项目：${names.join("、")}\n情况：CEO 两次复查仍未给出可执行方案。\n需要你决定：重新制定方案，还是暂缓？`;
            this.applyDecision(
              c,
              businesses,
              tasks,
              {
                briefs: [],
                directives: [],
                approvals: [],
                answers: [],
                escalations: [
                  {
                    key: `stalled-${fingerprint}`,
                    issues: issues.map((i) => i.id),
                    question,
                    context: [...new Set(issues.map((i) => i.question))].join("；").slice(0, 400),
                    options: ["重新制定方案", "暂缓"],
                  },
                ],
              },
              `stalled-${fingerprint}`,
              c.stalled.reason,
              receipt,
              now,
            );
            c.fingerprint = this.ceoInputs(c, businesses, tasks, now);
            c.stalled.fingerprint = c.fingerprint;
          }
        }
        return;
      }
    } else {
      c.unchangedReviews = 0;
      delete c.stalled;
    }
    if (unchanged) c.unchangedReviews = (c.unchangedReviews ?? 0) + 1;
    const id = "CEO-" + hash(`${fingerprint}:${c.lastTask ?? "initial"}`);
    this.writeCEOContext(c, businesses, tasks, now, join(this.directory, "workspace/knowledge/ceo.json"));
    const request = taskRequest({
      title: "CEO · 经营管理",
      kind: "ceo",
      goal: "读取 knowledge/ceo.json 及项目资料。先查已知事实，给员工明确目标；启用每日规划时提交staffPlans，写明今天做什么、完成标准和复查时间，复用已有任务，不让员工反复空查。审核成果、解决阻塞，完成后接续下一步；无法处理才提问负责人。用结构化决策反馈。",
      acceptance: [
        "先处理员工问题与已有计划，不重复派工或重复提问",
        "未知数据不得编造；汇报区分交付、实际执行和业务效果",
      ],
    });
    receipt.events ??= [];
    receipt.events.push({
      id: `company:ceo:${id}`,
      type: "company.task.create",
      subject: id,
      summary: request.title,
      detail: JSON.stringify(request),
    });
    if (this.config.ceoWake === "events") {
      c.eventInputs = eventInputs;
      delete c.nextReviewAt;
    } else c.nextReviewAt = new Date(now.getTime() + 30 * 60000).toISOString();
    c.lastTask = id;
    c.fingerprint = fingerprint;
    c.runs.push({ task: id, at: now.toISOString() });
  }
  private admitPublication(project: Project, plan: Plan, businessName: string, receipt: Receipt, now: Date): boolean {
    if (this.config.publishDailyLimit === undefined && this.config.publishApproval === undefined) return true;
    const channel = publicationChannel(this.directory, project.business);
    if (!channel) return true;
    const results = publicationResults(this.directory);
    const reservations = this.db
      .prepare("SELECT body FROM projects")
      .all()
      .flatMap((row) => {
        const p = JSON.parse(row.body as string) as Project;
        return p.business === project.business ? [] : (p.publishReservations ?? []);
      })
      .concat(project.publishReservations ?? []);
    const usage = publicationUsage(results, reservations, channel, now);
    let approval = plan.publishApproval;
    if (approval?.state === "deferred" && Date.parse(approval.nextAt!) > now.getTime()) return false;
    if (
      approval?.state !== "approved" &&
      (approval || usage.successes < (this.config.publishApproval?.confirmFirst ?? 0))
    ) {
      if (!approval || approval.state === "deferred") {
        const round = (approval?.round ?? 0) + 1;
        const about = `publish:${plan.publicationKey}:${round}`;
        approval = plan.publishApproval = { key: plan.publicationKey!, about, round, state: "pending" };
        (receipt.ask ??= []).push({
          key: about,
          about,
          title: "发布确认",
          text: publicationPreview(this.directory, plan.publicationKey!, businessName),
          options: ["发布", "退回修改", "暂缓"],
        });
      }
      plan.result = "已通过 CEO 审核，等待负责人发布确认";
      return false;
    }
    if (this.config.publishDailyLimit !== undefined && usage.today + usage.pending >= this.config.publishDailyLimit) {
      plan.publishWait = {
        reason: usage.pending ? "同渠道有发布尚待核实，保留原稿等待" : "今日渠道发布额度已用完，顺延次日",
        nextAt: nextPublishDay(now),
      };
      plan.result = plan.publishWait.reason;
      return false;
    }
    delete plan.publishWait;
    if (this.config.publishDailyLimit !== undefined)
      (project.publishReservations ??= []).push({ key: plan.publicationKey!, channel, at: now.toISOString() });
    return true;
  }
  plan(
    batch: string,
    businesses: Portfolio,
    tasks: Task[],
    now = new Date(),
    answers: Context["answers"] = [],
    depth = 0,
    events: Context["events"] = [],
  ): Receipt {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cached = this.db.prepare("SELECT body FROM batches WHERE id=?").get(batch);
      if (cached) {
        this.db.exec("COMMIT");
        return JSON.parse(cached.body as string);
      }
      const receipt: Receipt = {},
        chief = this.executive();
      if (this.config.ceoWake === "events") delete chief.nextReviewAt;
      const beforeCEO = this.ceoInputs(chief, businesses, tasks, now),
        beforeProcessed = chief.processed;
      if (chief.enabled) this.manage(chief, businesses, tasks, answers, receipt, now);
      this.conversation(chief, businesses, tasks, events, receipt, now);
      if (chief.enabled) {
        if (depth <= 1) {
          this.recover(chief, businesses, tasks, receipt, now);
          for (const pending of chief.pendingRetries ?? []) {
            const t = tasks.find((t) => t.id === pending.task);
            if (t?.status !== "blocked" || (chief.retries[t.id] ?? 0) >= 2) continue;
            if (receipt.events?.some((e) => e.type === "company.task.retry" && e.subject === t.id)) continue;
            if (
              !businesses.some(
                (b) => b.autonomy && b.status === "active" && this.currentTask(this.get(b.id, now), t.id),
              )
            )
              continue;
            chief.retries[t.id] = (chief.retries[t.id] ?? 0) + 1;
            receipt.events ??= [];
            receipt.events.push({
              id: `ceo:retry:${pending.decision}:${t.id}`,
              type: "company.task.retry",
              subject: t.id,
              summary: "CEO 处理阻塞后继续",
              detail: "{}",
            });
          }
          chief.pendingRetries = (chief.pendingRetries ?? []).filter(
            (p) =>
              !receipt.events?.some((e) => e.type === "company.task.retry" && e.subject === p.task) &&
              tasks.some((t) => t.id === p.task && t.status === "blocked"),
          );
        }
        this.saveExecutive(chief);
      }
      for (const b of businesses.filter((b) => b.autonomy)) {
        const p = this.get(b.id, now),
          before = JSON.stringify(p);
        for (const plan of p.plans) {
          const approval = plan.publishApproval;
          if (!approval || approval.state !== "pending" || approval.key !== plan.publicationKey || plan.task) continue;
          for (const answer of answers) {
            if (answer.about !== approval.about || chief.answeredCards.includes(answer.card)) continue;
            const choice = answer.choice ?? ["发布", "退回修改", "暂缓"].indexOf(answer.text?.trim() ?? "");
            if (![0, 1, 2].includes(choice)) {
              chief.answeredCards.push(answer.card);
              approval.state = "deferred";
              approval.nextAt = now.toISOString();
              approval.answer = answer.text?.trim();
              break;
            }
            chief.answeredCards.push(answer.card);
            approval.card = answer.card;
            approval.answer = answer.text?.trim() || ["发布", "退回修改", "暂缓"][choice];
            if (choice === 0) approval.state = "approved";
            else if (choice === 2) {
              approval.state = "deferred";
              approval.nextAt = nextPublishDay(now);
              plan.result = "负责人暂缓发布，次日重新确认";
            } else {
              plan.deliveryDecision = "revise";
              plan.result = `负责人退回修改：${approval.answer}`;
              plan.revision = (plan.revision ?? 0) + 1;
              plan.status = "planned";
              plan.task = null;
              plan.dueAt = after(now, plan.dueDays);
              plan.deliveredAt = null;
              delete plan.publicationKey;
              delete plan.publishApproval;
              delete plan.publishWait;
            }
            break;
          }
        }
        for (const s of p.staff) {
          mergeFollowups(s);
          const t = tasks.find((t) => t.id === s.lastTask);
          if (!t || t.status !== "completed" || s.processed === `${t.id}:${t.assignment}`) continue;
          const report = t.reports.at(-1),
            decision = report?.inspection;
          if (!decision) continue;
          s.processed = `${t.id}:${t.assignment}`;
          s.lastChecked = now.toISOString();
          s.finding = report!.summary;
          if (s.daily && s.daily.checkTask === t.id && Date.parse(s.daily.reviewAt) <= now.getTime())
            s.daily.checkedAt = now.toISOString();
          if (s.followups) s.followups = s.followups.filter((f) => f.checkTask !== t.id);
          if (decision.state === "blocked" && !chief.enabled) s.fingerprint = null;
          for (const a of decision.actions) {
            const id = hash(`${b.id}:${s.role}:${a.key}`);
            // Stable employee keys deduplicate proposals across checks; a closed plan remains in history.
            if (p.plans.some((v) => v.id === id) || p.plans.filter((v) => v.status !== "closed").length >= 30) continue;
            p.plans.push({
              ...a,
              id,
              proposedBy: s.role,
              owner: workflows[a.kind][0],
              sourceTask: t.id,
              task: null,
              status: chief.enabled ? "proposed" : "planned",
              createdAt: now.toISOString(),
              dueAt: after(now, a.dueDays),
              followUpAt: null,
              deliveredAt: null,
              outcome: null,
              result: "待执行",
            });
          }
          for (const r of decision.reviews) {
            const a = p.plans.find(
              (a) =>
                (a.id === r.key || (a.key === r.key && a.proposedBy === s.role)) &&
                (a.proposedBy === s.role || (a.proposedBy === "ceo" && a.owner === s.role) || s.role === p.owner) &&
                a.status === "review",
            );
            if (!a) continue;
            a.outcome = r;
            a.status = r.outcome === "unknown" ? "observing" : "closed";
            a.followUpAt = r.outcome === "unknown" ? after(now, r.nextDays) : null;
            a.result = r.evidence;
          }
        }
        for (const a of p.plans) {
          const t = tasks.find((t) => t.id === a.task);
          // Old document-only observations are reclassified by the normal journaled tick.
          if (
            chief.enabled &&
            ["observing", "review"].includes(a.status) &&
            !a.deliveryDecision &&
            t?.kind.startsWith("internal-") &&
            t.status === "completed"
          ) {
            a.status = "delivered";
            a.followUpAt = null;
            a.outcome = null;
            a.result = "内部交付已完成，待 CEO 审核成果及下一步执行";
          }
          if (["working", "blocked", "publishing"].includes(a.status)) {
            if (t?.status === "superseded") {
              a.status = "closed";
              a.followUpAt = null;
              a.result = `已取代关闭：${t.reason}`;
            } else if (t?.status === "completed") {
              const published = t.kind === "publish-content" && t.reports.at(-1)?.publication?.key === a.publicationKey;
              a.status = chief.enabled && !published ? "delivered" : "observing";
              a.deliveredAt = now.toISOString();
              a.followUpAt = a.status === "observing" ? after(now, a.followUpDays) : null;
              a.result = t.reason;
            } else if (t?.status === "blocked" || t?.status === "rejected") {
              a.status = "blocked";
              a.result = t.reason;
            } else if (t?.status === "active") a.status = t.kind === "publish-content" ? "publishing" : "working";
          }
          if (a.status === "observing" && a.followUpAt && Date.parse(a.followUpAt) <= now.getTime())
            a.status = "review";
        }
        const busy = () =>
          p.activity.filter(
            (a) => !tasks.find((t) => t.id === a.task) || tasks.find((t) => t.id === a.task)?.status === "active",
          );
        const capacity = (fixedPublication = false) =>
          depth <= 1 &&
          b.status === "active" &&
          (!chief.enabled || !!chief.briefs[b.id]) &&
          (receipt.events?.length ?? 0) < 50 &&
          (busy().length < p.maxActive || (fixedPublication && !busy().some((a) => a.kind === "work")));
        const emit = (id: string, role: Role, kind: "check" | "work", request: ReturnType<typeof taskRequest>) => {
          receipt.events ??= [];
          receipt.events.push({
            id: `company:operations:${id}`,
            type: "company.task.create",
            subject: id,
            summary: request.title,
            detail: JSON.stringify(request),
          });
          p.activity.push({ task: id, role, kind, at: now.toISOString() });
        };
        // Plans take priority over further inspections, and all work is routed through the existing company workflow.
        const todayPriority = (a: Plan) =>
          this.dailyPlanning &&
          p.staff.some(
            (s) => s.enabled && s.daily?.date === day(now) && s.daily.mode === "work" && s.daily.plan === a.id,
          )
            ? 0
            : 1;
        for (const a of [...p.plans].sort(
          (a, b) =>
            todayPriority(a) - todayPriority(b) || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
        )) {
          const publishing = a.status === "publishing";
          // A fixed publisher has its own hub lane; model inspections must not prevent it reporting missing access.
          if (
            !capacity(publishing) ||
            (a.status !== "planned" && !(publishing && !a.task)) ||
            !p.staff.find((s) => s.role === a.owner)?.enabled ||
            (!publishing && busy().some((v) => v.role === a.owner))
          )
            continue;
          if (publishing && !this.admitPublication(p, a, b.name, receipt, now)) continue;
          const id = publishing
            ? "P-" + hash(a.publicationKey!)
            : "W-" + hash(`${b.id}:${a.id}${a.revision ? `:${a.revision}` : ""}`);
          emit(
            id,
            a.owner,
            "work",
            taskRequest({
              title: `${b.name} · ${a.title}`.slice(0, 120),
              kind: publishing ? "publish-content" : `internal-${a.kind}`,
              ...(publishing ? { publication: a.publicationKey } : {}),
              goal: publishing
                ? `项目资料：knowledge/operations/${b.id}.json。计划 ${a.id} 已经 CEO 审核。固定发布入口仅发布已冻结的内容；缺渠道或账号则报告具体阻塞。验收必须核对真实平台结果，不能把本地草稿当已发布。`
                : `项目资料：knowledge/operations/${b.id}.json。计划编号 ${a.id}。${a.goal}${a.revision ? ` 返工：${a.result}；读取上一交付任务 ${a.deliveryTask}，在本任务目录修改。` : ""} 仅交付本地成果，交 CEO 审核。`.slice(
                    0,
                    500,
                  ),
              acceptance: publishing
                ? ["平台返回真实链接、内容编号、渠道和时间", "验收核对平台回执，失败报告具体原因"]
                : a.acceptance,
            }),
          );
          a.task = id;
          a.status = publishing ? "publishing" : "working";
        }
        for (const s of p.staff) {
          if (this.config.inspections === false || !capacity() || !this.onDuty(s)) continue;
          const retained = s.followups
            ?.filter((f) => Date.parse(f.reviewAt) <= now.getTime())
            .sort((a, b) => a.reviewAt.localeCompare(b.reviewAt))[0];
          const daily = this.dailyPlanning && chief.enabled ? (retained ?? s.daily) : undefined;
          const dailyDue =
            !!daily &&
            Date.parse(daily.reviewAt) <= now.getTime() &&
            (!daily.checkedAt || daily.checkedAt < daily.reviewAt);
          if (this.dailyPlanning && chief.enabled && (!daily || (daily.date !== day(now) && !dailyDue))) continue;
          if (daily && !dailyDue) continue;
          const previous = tasks.find((t) => t.id === s.lastTask);
          if (s.lastTask && previous?.status !== "completed") continue;
          if (
            p.plans.some(
              (a) => a.owner === s.role && ["planned", "working", "publishing", "delivered"].includes(a.status),
            )
          )
            continue;
          if (busy().some((a) => a.role === s.role)) continue;
          const reviews = p.plans
            .filter(
              (a) =>
                a.status === "review" &&
                (a.proposedBy === s.role || (a.proposedBy === "ceo" && a.owner === s.role) || s.role === p.owner),
            )
            .map((a) => `${a.id}:${a.followUpAt}`);
          const fingerprint = hash(
            JSON.stringify({
              ceoGoal: chief.briefs[b.id],
              ...(daily ? { daily } : {}),
              knowledge: chief.knowledge.filter((k) => k.business === b.id),
              facts: [b.name, b.description, b.audience, b.objective, b.channels, b.url],
              metrics: b.metrics,
              evidenceRevision: sourceSnapshots(this.directory)[b.id]?.revision ?? null,
              signals: p.signals.filter((v) => v.role === "all" || v.role === s.role || s.role === p.owner),
              exceptions:
                s.role === p.owner
                  ? p.plans
                      .filter(
                        (a) =>
                          a.status === "blocked" ||
                          (["planned", "working", "publishing", "delivered"].includes(a.status) &&
                            Date.parse(a.dueAt) <= now.getTime()),
                      )
                      .map((a) => [a.id, a.status, a.result])
                  : [],
              duty: s.duty,
              checks: s.checks,
            }),
          );
          const changed = fingerprint !== s.fingerprint;
          const newReviews = reviews.some((key) => !(s.reviewKeys ?? []).includes(key));
          if (
            !dailyDue &&
            !changed &&
            !newReviews &&
            chief.enabled &&
            chief.issues.some(
              (i) =>
                i.business === b.id &&
                i.role === s.role &&
                (i.state === "open" || i.state === "owner") &&
                !(
                  chief.knowledge.some((k) => k.business === b.id && k.source === "owner" && k.at > i.at) ||
                  (sourceSnapshots(this.directory)[b.id]?.changedAt ?? "") > i.at
                ),
            )
          )
            continue;
          if (!dailyDue && !changed && !newReviews && Date.parse(s.nextAt) > now.getTime()) continue;
          if (!dailyDue && !changed && !reviews.length && s.cadence === "daily") {
            s.nextAt = after(now, 1);
            s.lastChecked = now.toISOString();
            s.finding = "无新增资料或到期跟进，未调用模型";
            continue;
          }
          const id =
            "C-" + hash(`${b.id}:${s.role}:${fingerprint}:${reviews.join(",")}:${s.lastTask ?? "first"}:${day(now)}`);
          if (p.activity.some((a) => a.task === id)) continue;
          emit(
            id,
            s.role,
            "check",
            taskRequest({
              title: `${b.name} · ${departments[s.role]}${daily ? "今日跟进" : "检查"}`.slice(0, 120),
              kind: `check-${s.role}`,
              goal: daily
                ? `读取 knowledge/operations/${b.id}.json。每日安排 ${daily.date}：${daily.focus}。岗位目标：${daily.goal}。完成标准：${daily.doneWhen}。核对真实结果并向CEO报告；需要制作或修改成果则提出具体action，不能以检查完成冒充交付。`.slice(
                    0,
                    500,
                  )
                : `读取 knowledge/operations/${b.id}.json，按自己的责任档案检查资料、计划和到期跟进，提交结构化检查结果。发现明确问题才提出内部行动；没有变化返回 idle，缺少数据记录未知。项目负责人检查跨部门优先级和阻塞。`,
              acceptance: [
                "依据真实资料，缺少数据不得虚构问题或增长",
                "复用历史计划编号，避免重复任务；区分交付与效果",
              ],
            }),
          );
          s.lastTask = id;
          if (daily) daily.checkTask = id;
          s.nextAt = after(now, s.cadence === "daily" ? 1 : 7);
          s.fingerprint = fingerprint;
          s.reviewKeys = reviews;
        }
        if (JSON.stringify(p) !== before) this.save(p, "check", now);
        this.profile(p, b, tasks);
      }
      if (chief.enabled) {
        if (chief.processed !== beforeProcessed && beforeCEO === chief.fingerprint)
          chief.fingerprint = this.ceoInputs(chief, businesses, tasks, now);
        if (depth <= 1) this.scheduleCEO(chief, businesses, tasks, receipt, now);
        this.saveExecutive(chief);
      }
      this.db.prepare("INSERT INTO batches VALUES (?,?)").run(batch, JSON.stringify(receipt));
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
