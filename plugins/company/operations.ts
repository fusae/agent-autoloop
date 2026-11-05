import { sourceSnapshots } from "./sources.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { departments, taskId, taskRequest, workflows, type Role, type Task, type Receipt } from "./company.ts";
import { executiveDecision, type Leadership, type ExecutiveDecision, type Issue } from "./executive.ts";
import type { Context } from "./company.ts";
import type { Business, Metric } from "./business.ts";
import type { ActionProposal, Inspection } from "./inspection.ts";

type Portfolio = (Business & { metrics: Metric[] })[];
export type Employee = {
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
  status: "proposed" | "planned" | "working" | "blocked" | "observing" | "review" | "closed";
  createdAt: string;
  dueAt: string;
  followUpAt: string | null;
  deliveredAt: string | null;
  outcome: Inspection["reviews"][number] | null;
  result: string;
};
type Signal = { id: string; title: string; detail: string; source: string; role: Role | "all"; at: string };
type Project = {
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
  constructor(directory: string) {
    this.directory = directory;
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
                ["active", "blocked", "awaiting_approval"].includes(t.status) &&
                workflows[t.kind]?.[t.stage] === s.role,
            );
          const work =
            p.plans.find((a) => assigned && a.task === assigned.id) ??
            p.plans.find(
              (a) => a.owner === s.role && ["planned", "working", "blocked", "proposed", "review"].includes(a.status),
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
            workStatus =
              work.status === "working"
                ? "等待交接"
                : work.status === "proposed"
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
          return { ...s, currentTask, workStatus, nextAction };
        }),
        alerts: p.plans
          .filter(
            (a) =>
              a.status === "blocked" ||
              (["planned", "working"].includes(a.status) && Date.parse(a.dueAt) < now.getTime()),
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
            publishing: "未接入",
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
        if (!t) continue;
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
      if (answer.choice === 1 && !answer.text) {
        q.state = "deferred";
        q.answer = "暂缓";
        continue;
      }
      q.state = "answered";
      q.answer = (answer.text?.trim() || "负责人确认已处理，请核对更新后的资料").slice(0, 4000);
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
    if (d.escalations.some((a) => a.issues.some((id) => c.issues.find((i) => i.id === id)?.state === "answered")))
      return "上报引用了已答复的问题，不能作为新的待决事项。请先使用已有答案；确有新缺口时提供 business 项目编号和 issues:[]，不要借用历史问题编号。";
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
    c.nextReviewAt = new Date(now.getTime() + 30 * 60000).toISOString();
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
    for (const a of d.approvals) {
      const p = this.get(a.business, now),
        plan = p.plans.find((p) => p.id === a.plan)!;
      if (plan.status !== "proposed") continue;
      plan.status = a.approve ? "planned" : "closed";
      plan.result = a.reason;
      this.save(p, "ceo-approval", now);
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
        options: ["资料已补充", "暂缓"],
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
        const error = this.applyDecision(c, businesses, tasks, d, decisionId, summary, receipt, now);
        if (error) text = `安排未执行：${error}`;
        else {
          const names = (id: string) => businesses.find((b) => b.id === id)!.name;
          const changes = [
            ...d.briefs.map((v) => `目标：${names(v.business)} · ${v.objective}`),
            ...d.directives.map((v) => {
              const p = this.get(v.business, now).plans.find(
                (p) => p.id === hash(`${v.business}:ceo:${v.action.key}`),
              )!;
              return `工作：${names(v.business)} · ${p.title}，${departments[p.owner]}负责${p.status === "closed" ? "（已有计划已结束）" : "，按现有任务流程执行和验收"}`;
            }),
            ...d.approvals.map((v) => {
              const p = this.get(v.business, now).plans.find((p) => p.id === v.plan)!;
              const states = {
                proposed: "待审核",
                planned: "待执行",
                working: "执行中",
                blocked: "受阻",
                observing: "跟进效果",
                review: "待复盘",
                closed: "已结束",
              };
              return `计划：${p.title}，${states[p.status]}；${p.result}`;
            }),
            ...d.answers.map((v) => `员工问题：${c.issues.find((i) => i.id === v.issue)!.question}；${v.answer}`),
          ];
          text = changes.length ? changes.join("\n") : summary;
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
        .flatMap((b) => this.get(b.id, now).activity.map((a) => a.task)),
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
        receipt.notice ??= [];
        receipt.notice.push({
          key: `repair-exhausted-${t.id}`,
          title: "运行异常",
          text: `${t.title} 连续修复两次仍未通过：${t.reason}。其他工作继续；补充资料或下个经营日再恢复管理。`,
        });
        if (t.id === c.lastTask) {
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
  private scheduleCEO(c: Leadership, businesses: Portfolio, tasks: Task[], receipt: Receipt, now: Date) {
    const active = businesses.filter((b) => b.autonomy && b.status === "active");
    if (!active.length) return;
    const latest = tasks.find((t) => t.id === c.lastTask);
    if (c.lastTask && latest?.status !== "completed") return;
    const fingerprint = this.ceoInputs(c, businesses, tasks, now);
    const agenda =
      c.issues.some((i) => i.state === "open") ||
      active.some((b) => this.get(b.id, now).plans.some((p) => p.status === "proposed" || p.status === "review"));
    const unchanged = fingerprint === c.fingerprint;
    if (unchanged) {
      if (!(agenda && c.nextReviewAt && Date.parse(c.nextReviewAt) <= now.getTime())) return;
      if ((c.unchangedReviews ?? 0) >= 2) {
        if (c.stalled?.fingerprint !== fingerprint) {
          const pending = [
            ...c.issues.filter((i) => i.state === "open").map((i) => i.question),
            ...active.flatMap((b) =>
              this.get(b.id, now)
                .plans.filter((p) => p.status === "proposed" || p.status === "review")
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
            for (const p of this.get(b.id, now).plans.filter((p) => p.status === "proposed" || p.status === "review")) {
              const id = hash(`stalled-plan:${p.id}:${p.status}`);
              if (!c.issues.some((i) => i.context.startsWith(`计划 ${p.id}：`) && i.state !== "answered"))
                c.issues.push({
                  id: hash(`${id}:${fingerprint}`),
                  business: b.id,
                  role: "ceo",
                  task: null,
                  question: `${b.name} · ${p.title}：${p.status === "proposed" ? "CEO 未决定是否执行" : "CEO 未处理效果复盘"}`,
                  context: `计划 ${p.id}：${p.result}`,
                  state: "open",
                  answer: null,
                  at: now.toISOString(),
                });
            }
          }
          const issues = c.issues.filter((i) => i.state === "open").slice(0, 8);
          if (issues.length) {
            const question = issues
              .map((i) => `${active.find((b) => b.id === i.business)?.name ?? i.business}：${i.question.slice(0, 180)}`)
              .join("；");
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
                    question: `CEO 未能解决以下事项，请决定处理方式或补充所缺信息：${question}`.slice(0, 800),
                    context: "CEO 已连续复查两次，仍未给出处理结果。回复后由 CEO 继续处理原任务，其他工作继续。",
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
      goal: "读取 knowledge/ceo.json 及项目资料。先查已知事实，给员工明确目标；审核提案，解答员工问题，处理受阻工作。只有确实无法判断的事项才汇总提问负责人，并引用问题编号。用结构化决策反馈，不直接操作配置或外部系统。",
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
    c.nextReviewAt = new Date(now.getTime() + 30 * 60000).toISOString();
    c.lastTask = id;
    c.fingerprint = fingerprint;
    c.runs.push({ task: id, at: now.toISOString() });
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
                (b) => b.autonomy && b.status === "active" && this.get(b.id, now).activity.some((a) => a.task === t.id),
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
        for (const s of p.staff) {
          const t = tasks.find((t) => t.id === s.lastTask);
          if (!t || t.status !== "completed" || s.processed === `${t.id}:${t.assignment}`) continue;
          const report = t.reports.at(-1),
            decision = report?.inspection;
          if (!decision) continue;
          s.processed = `${t.id}:${t.assignment}`;
          s.lastChecked = now.toISOString();
          s.finding = report!.summary;
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
          if (a.status === "working" || a.status === "blocked") {
            if (t?.status === "completed") {
              a.status = "observing";
              a.deliveredAt = now.toISOString();
              a.followUpAt = after(now, a.followUpDays);
              a.result = t.reason;
            } else if (t?.status === "blocked" || t?.status === "rejected") {
              a.status = "blocked";
              a.result = t.reason;
            } else if (t?.status === "active") a.status = "working";
          }
          if (a.status === "observing" && a.followUpAt && Date.parse(a.followUpAt) <= now.getTime())
            a.status = "review";
        }
        const busy = () =>
          p.activity.filter(
            (a) => !tasks.find((t) => t.id === a.task) || tasks.find((t) => t.id === a.task)?.status === "active",
          );
        const capacity = () =>
          depth <= 1 &&
          b.status === "active" &&
          (!chief.enabled || !!chief.briefs[b.id]) &&
          (receipt.events?.length ?? 0) < 50 &&
          busy().length < p.maxActive;
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
        for (const a of [...p.plans].sort(
          (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
        )) {
          if (
            !capacity() ||
            a.status !== "planned" ||
            !p.staff.find((s) => s.role === a.owner)?.enabled ||
            busy().some((v) => v.role === a.owner)
          )
            continue;
          const id = "W-" + hash(`${b.id}:${a.id}`);
          emit(
            id,
            a.owner,
            "work",
            taskRequest({
              title: `${b.name} · ${a.title}`.slice(0, 120),
              kind: `internal-${a.kind}`,
              goal: `项目资料：knowledge/operations/${b.id}.json。计划编号 ${a.id}。${a.goal} 仅交付本地草稿、分析或隔离代码；不发布、不付款、不联系用户、不修改线上服务。`,
              acceptance: a.acceptance,
            }),
          );
          a.task = id;
          a.status = "working";
        }
        for (const s of p.staff) {
          if (!capacity() || !s.enabled) continue;
          const previous = tasks.find((t) => t.id === s.lastTask);
          if (s.lastTask && previous?.status !== "completed") continue;
          if (p.plans.some((a) => a.owner === s.role && ["planned", "working"].includes(a.status))) continue;
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
                          (["planned", "working"].includes(a.status) && Date.parse(a.dueAt) <= now.getTime()),
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
          if (!changed && !newReviews && Date.parse(s.nextAt) > now.getTime()) continue;
          if (!changed && !reviews.length && s.cadence === "daily") {
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
              title: `${b.name} · ${departments[s.role]}检查`.slice(0, 120),
              kind: `check-${s.role}`,
              goal: `读取 knowledge/operations/${b.id}.json，按自己的责任档案检查资料、计划和到期跟进，提交结构化检查结果。发现明确问题才提出内部行动；没有变化返回 idle，缺少数据记录未知。项目负责人检查跨部门优先级和阻塞。`,
              acceptance: [
                "依据真实资料，缺少数据不得虚构问题或增长",
                "复用历史计划编号，避免重复任务；区分交付与效果",
              ],
            }),
          );
          s.lastTask = id;
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
