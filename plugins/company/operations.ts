import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { departments, taskId, taskRequest, workflows, type Role, type Task, type Receipt } from "./company.ts";
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
  status: "planned" | "working" | "blocked" | "observing" | "review" | "closed";
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
const duties: Record<Role, [string, string[]]> = {
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
const roles = Object.keys(departments) as Role[];
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
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY,project TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);`);
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
    if (!roles.includes(role as Role)) throw new Error("员工不存在");
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
    if (role !== "all" && !roles.includes(role as Role)) throw new Error("员工不存在");
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
        name: b.name,
        enabled: !!b.autonomy,
        status: b.status,
        todayTasks: p.activity.filter((a) => day(new Date(a.at)) === day(now)).length,
        staff: p.staff.map((s) => {
          const work = p.plans.find((a) => a.owner === s.role && ["working", "blocked"].includes(a.status));
          const t = tasks.find((t) => t.id === (work?.task ?? s.lastTask));
          const currentTask = t ? (({ approval: _approval, ...safe }) => safe)(t) : null;
          return { ...s, currentTask };
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
          staff: p.staff,
          plans: p.plans,
          signals: p.signals,
          recent,
          limits: { maxDailyTasks: p.maxDailyTasks, maxActive: p.maxActive },
          sources: {
            metrics: b.metrics.length ? "人工录入" : "未接入",
            feedback: "人工录入",
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
  plan(batch: string, businesses: Portfolio, tasks: Task[], now = new Date()): Receipt {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cached = this.db.prepare("SELECT body FROM batches WHERE id=?").get(batch);
      if (cached) {
        this.db.exec("COMMIT");
        return JSON.parse(cached.body as string);
      }
      const receipt: Receipt = {};
      for (const b of businesses.filter((b) => b.autonomy)) {
        const p = this.get(b.id, now),
          before = JSON.stringify(p);
        for (const s of p.staff) {
          const t = tasks.find((t) => t.id === s.lastTask);
          if (!t || t.status !== "completed" || s.processed === t.id) continue;
          const report = t.reports.at(-1),
            decision = report?.inspection;
          if (!decision) continue;
          s.processed = t.id;
          s.lastChecked = now.toISOString();
          s.finding = report!.summary;
          if (decision.state === "blocked") s.fingerprint = null;
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
              status: "planned",
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
                (a.proposedBy === s.role || s.role === p.owner) &&
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
          b.status === "active" &&
          (receipt.events?.length ?? 0) < 50 &&
          busy().length < p.maxActive &&
          p.activity.filter((a) => day(new Date(a.at)) === day(now)).length < p.maxDailyTasks;
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
          if (p.plans.some((a) => a.owner === s.role && ["planned", "working", "blocked"].includes(a.status))) continue;
          if (busy().some((a) => a.role === s.role)) continue;
          const reviews = p.plans
            .filter((a) => a.status === "review" && (a.proposedBy === s.role || s.role === p.owner))
            .map((a) => `${a.id}:${a.followUpAt}`);
          const fingerprint = hash(
            JSON.stringify({
              facts: [b.name, b.description, b.audience, b.objective, b.channels, b.url],
              metrics: b.metrics,
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
      this.db.prepare("INSERT INTO batches VALUES (?,?)").run(batch, JSON.stringify(receipt));
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
