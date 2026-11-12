import { checkPipelineDelivery } from "./pipeline.ts";
import { staffWorkType, taskProject, type StaffModels } from "./staff-model.ts";
import { checkJinzhaoDelivery } from "./jinzhao-writing.ts";
import { registeredProactive } from "./proactive.ts";
import { squareStatus } from "./rabbitrun-receipt.ts";
import { taskTopic, validateTopicSubmission } from "./topics.ts";
import { registeredWeeklyReport, registeredReview, retrospective, type Retrospective } from "./weekly.ts";
import { dailyReport, scheduledReport, validateReporting, validateDraftPlan, type DailyReport } from "./reporting.ts";
import { validateWorkday, type permissions } from "./workday.ts";
import { validatePublishPolicy } from "./publication-policy.ts";
import { ModelBudget, modelDay } from "./model-budget.ts";
import { publication, verifiedPublication, type Publication } from "./publication.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { executiveDecision, type ExecutiveDecision } from "./executive.ts";
import { inspection, type Inspection } from "./inspection.ts";

export const departments = {
  ceo: "CEO",
  product: "产品",
  engineering: "研发",
  qa: "验收",
  growth: "运营",
  support: "客服",
  finance: "财务",
} as const;
export type Role = keyof typeof departments;
export const workflows: Record<string, Role[]> = {
  ceo: ["ceo"],
  "publish-content": ["growth", "qa"],
  software: ["product", "engineering", "qa"],
  content: ["growth", "qa"],
  support: ["support", "qa"],
  finance: ["finance", "qa"],
};
for (const role of Object.keys(departments) as Role[]) workflows[`check-${role}`] = [role];
for (const role of Object.keys(departments)) {
  workflows[`workday-${role}`] = [role as Role];
  workflows[`staff-${role}`] = [role as Role];
}
for (const kind of ["software", "content", "support", "finance"]) workflows[`internal-${kind}`] = [...workflows[kind]];
export type CompanyConfig = {
  pipelineMode?: boolean;
  staffModels?: StaffModels;
  jinzhaoWriting?: boolean;
  name: string;
  database: string;
  maxAssignments: number;
  ceoMode?: boolean;
  contentReview?: "qa" | "ceo";
  dailyPlanning?: boolean;
  proactiveCEO?: boolean;
  ceoEfficiency?: boolean;
  activeRoles?: Role[];
  inspections?: boolean;
  ceoWake?: "legacy" | "events";
  dailyModelRuns?: Partial<Record<Role | "total" | "employee", number>>;
  delegation?: { source: string; confirmPublish?: string[] };
  topics?: { startAt: string };
  workday?: { enabled: boolean; after: string; startDate?: string; prepareDrafts?: boolean };
  reporting?: { enabled: boolean; weekly?: boolean };
  health?: { enabled: boolean };
  permissions?: typeof permissions;
  publishVerification?: "qa" | "program";
  publishDailyLimit?: number;
  publishApproval?: { confirmFirst: number; preview?: boolean };
  publishPolicies?: Record<string, { dailyLimit: number; alwaysConfirm: boolean }>;
};
export type Context = {
  events: { id: string | number; source: string; type: string; subject: string; detail: string; hops?: number }[];
  answers: { at?: string; card: number; choice: number | null; about: string; text?: string | null }[];
};
export type Report = {
  writingErrors?: string[];
  topic?: string;
  at?: string;
  dailyReport?: DailyReport;
  retrospective?: Retrospective;
  assignment: number;
  verdict: "pass" | "reject" | "blocked";
  summary: string;
  artifacts: string[];
  evidence: string[];
  inspection?: Inspection;
  executive?: ExecutiveDecision;
  publication?: Publication;
};
export type Task = {
  id: string;
  title: string;
  goal: string;
  kind: string;
  acceptance: string[];
  status: "active" | "blocked" | "awaiting_approval" | "completed" | "rejected" | "queued" | "superseded";
  stage: number;
  assignment: number;
  reports: (Report & { role: Role })[];
  approval: string | null;
  reason: string;
  supervised?: boolean;
  publication?: string;
};
export type Receipt = {
  events?: { id: string; type: string; subject: string; summary: string; detail: string }[];
  ask?: { key: string; title: string; text: string; options: string[]; about: string }[];
  notice?: { key: string; title: string; text: string }[];
};
class CompanyInputError extends Error {}
function words(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new CompanyInputError(`${label}需要 1–${max} 字`);
  return value;
}
function list(value: unknown, label: string, max = 120): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 5) throw new CompanyInputError(`${label}需要 1–5 项`);
  return value.map((v) => words(v, max, label));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompanyInputError("资料必须是 JSON 对象");
  return value as Record<string, unknown>;
}
export function taskRequest(value: unknown) {
  const data = object(value);
  const kind = words(data.kind, 20, "任务类型");
  if (!Object.hasOwn(workflows, kind)) throw new CompanyInputError("任务类型不正确");
  const request = {
    title: words(data.title, 120, "标题"),
    goal: words(data.goal, 500, "目标"),
    kind,
    acceptance: list(data.acceptance, "验收标准"),
    ...(kind === "publish-content"
      ? {
          publication: (() => {
            if (typeof data.publication !== "string" || !/^[a-f0-9]{32}$/.test(data.publication))
              throw new CompanyInputError("发布任务缺少已审核的内容记录");
            return data.publication;
          })(),
        }
      : {}),
  };
  if (JSON.stringify(request).length > 1600)
    throw new CompanyInputError("需求 JSON 超过 1600 字，请缩短描述并引用工作区资料");
  return request;
}
export function taskId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value))
    throw new CompanyInputError("任务编号只能含字母、数字、-、_，最多 40 字");
  return value;
}

export class Company {
  private db: DatabaseSync;
  private config: CompanyConfig;
  constructor(config: CompanyConfig) {
    if (
      !isAbsolute(config.database) ||
      !Number.isSafeInteger(config.maxAssignments) ||
      config.maxAssignments < 1 ||
      config.maxAssignments > 30
    )
      throw new CompanyInputError("database 必须是绝对路径；maxAssignments 必须在 1–30 之间");
    if (
      config.activeRoles !== undefined &&
      (!Array.isArray(config.activeRoles) || config.activeRoles.some((r) => !Object.hasOwn(departments, r)))
    )
      throw new CompanyInputError("在岗岗位不正确");
    if (config.inspections !== undefined && typeof config.inspections !== "boolean")
      throw new CompanyInputError("巡检开关不正确");
    if (config.ceoWake !== undefined && !["legacy", "events"].includes(config.ceoWake))
      throw new CompanyInputError("CEO 唤醒方式不正确");
    if (
      config.dailyModelRuns !== undefined &&
      (!config.dailyModelRuns ||
        Array.isArray(config.dailyModelRuns) ||
        typeof config.dailyModelRuns !== "object" ||
        Object.entries(config.dailyModelRuns).some(
          ([key, n]) =>
            (!["total", "employee"].includes(key) && !Object.hasOwn(departments, key)) ||
            !Number.isSafeInteger(n) ||
            n < 0,
        ))
    )
      throw new CompanyInputError("每日模型次数需要非负整数及正确岗位");
    validatePublishPolicy(config);
    validateWorkday(config);
    validateReporting(config);
    if (config.ceoEfficiency !== undefined && typeof config.ceoEfficiency !== "boolean") throw Error("CEO合并开关无效");
    if (config.proactiveCEO !== undefined && typeof config.proactiveCEO !== "boolean")
      throw Error("主动经营开关不正确");
    if (config.proactiveCEO && (!config.delegation || !config.workday?.enabled || !config.reporting?.enabled))
      throw Error("主动经营需要CEO授权、自主上班及日报");
    if (config.health !== undefined && typeof config.health?.enabled !== "boolean") throw Error("程序巡检开关不正确");
    if (config.health?.enabled && !config.ceoMode) throw Error("程序巡检需要启用CEO");
    if (config.pipelineMode !== undefined && typeof config.pipelineMode !== "boolean") throw Error("流水线开关不正确");
    this.config = config;
    mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(config.database);
    chmodSync(config.database, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, task TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processed (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  task(id: string): Task | undefined {
    const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  tasks(): Task[] {
    return this.db
      .prepare("SELECT body FROM tasks ORDER BY id")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  taskPage(limit: number, before = Number.MAX_SAFE_INTEGER) {
    // Creation journal sequences stay fixed when a task changes or newer tasks arrive.
    const rows = this.db
      .prepare(
        `SELECT t.body, MIN(j.seq) AS created FROM tasks t JOIN journal j ON j.task=t.id
        GROUP BY t.id HAVING created < ? ORDER BY created DESC LIMIT ?`,
      )
      .all(before, limit + 1);
    return {
      tasks: rows.slice(0, limit).map((r) => JSON.parse(r.body as string) as Task),
      nextBefore: rows.length > limit ? Number(rows[limit - 1].created) : null,
    };
  }
  history(id: string) {
    return this.db.prepare("SELECT seq,kind,at,body FROM journal WHERE task=? ORDER BY seq").all(id);
  }
  private save(task: Task, kind: string) {
    const body = JSON.stringify(task);
    this.db
      .prepare("INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(task.id, body);
    this.db
      .prepare("INSERT INTO journal(task,kind,at,body) VALUES (?,?,?,?)")
      .run(task.id, kind, new Date().toISOString(), body);
  }
  reconcilePublication(key: string) {
    const proof = verifiedPublication(dirname(this.config.database), key);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.tasks().find((t) => t.kind === "publish-content" && t.publication === key);
      if (task && ["blocked", "active", "queued"].includes(task.status)) {
        task.status = "completed";
        task.approval = null;
        task.reason = proof.x ? squareStatus(proof) : `平台回读已确认发布：${proof.url}`;
        task.reports.push({
          at: proof.publishedAt,
          assignment: task.assignment,
          verdict: "pass",
          role: "growth",
          summary: task.reason,
          artifacts: [],
          evidence: [task.reason],
          publication: proof,
        });
        this.save(task, "publication-reconciled");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  publicationUnknown(key: string) {
    const task = this.tasks().find((t) => t.kind === "publish-content" && t.publication === key);
    if (!task || !["active", "blocked", "queued"].includes(task.status)) return;
    task.status = "blocked";
    task.reason = "发布结果未知：已完成3次只读复查，需人工核实；只锁本篇，不阻塞同渠道其他稿件";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.save(task, "publication-unknown");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private notice(receipt: Receipt, task: string, text: string) {
    receipt.notice ??= [];
    receipt.notice.push({ key: `company-${task}`, title: `公司任务：${task}`, text });
  }
  private dispatch(task: Task, receipt: Receipt, now: Date) {
    task.approval = null;
    if (
      this.config.pipelineMode &&
      (task.kind === "ceo" || task.kind.startsWith("check-") || task.kind.startsWith("workday-"))
    ) {
      task.status = "superseded";
      task.reason = "内容流水线已停用经营轮次";
      return;
    }
    const reportDate =
      this.config.reporting?.enabled && task.kind === "ceo"
        ? scheduledReport(dirname(this.config.database), task.id)
        : undefined;
    const proactive = task.kind === "ceo" ? registeredProactive(dirname(this.config.database), task.id) : undefined;
    if (proactive && proactive.date < modelDay(now)) {
      task.status = "blocked";
      task.reason = "主动经营已跨日，保留未完成记录，不补跑历史轮次";
      return;
    }
    if (reportDate && reportDate < modelDay(now)) {
      task.status = "blocked";
      task.reason = "汇报已跨日，保留原日期未完成记录，不占用今天的汇报或管理轮次";
      return;
    }
    if (task.assignment >= this.config.maxAssignments) {
      task.status = "blocked";
      task.reason = `已达到 ${this.config.maxAssignments} 次部门派工上限；请检查任务或调整本机公司配置。`;
      if (!task.supervised) this.notice(receipt, task.id, task.reason);
      return;
    }
    const role = workflows[task.kind][task.stage];
    const program = task.kind === "publish-content" && role === "qa" && this.config.publishVerification === "program";
    if (this.config.dailyModelRuns && !(task.kind === "publish-content" && (role === "growth" || program))) {
      const budget = new ModelBudget(dirname(this.config.database), this.config);
      try {
        if (!budget.available(role, now, task.id)) {
          budget.limited(now);
          task.status = "queued";
          return;
        }
      } finally {
        budget.close();
      }
    }
    task.assignment++;
    task.status = "active";
    // Only the current brief and latest handoff travel in the event; full artifacts stay in the workspace.
    const detail = JSON.stringify({
      task: task.id,
      title: task.title,
      goal: task.goal,
      acceptance: task.acceptance,
      assignment: task.assignment,
      role,
      inspection: task.kind.startsWith("check-"),
      workday: task.kind.startsWith("workday-"),
      internal: task.kind.startsWith("internal-"),
      supervised: !!task.supervised,
      publication: task.publication ?? null,
      repair: task.assignment > 1 ? task.reason.slice(0, 400) : null,
      previous:
        (task.kind === "publish-content" && role === "qa"
          ? task.reports.findLast((r) => r.role === "growth" && r.verdict === "pass")
          : task.reports.at(-1)) ?? null,
    });
    receipt.events ??= [];
    receipt.events.push({
      id: `company:${task.id}:${task.assignment}`,
      type: program
        ? "company.work.verify"
        : task.kind === "publish-content" && role === "growth"
          ? "company.work.publish"
          : staffWorkType(this.config, dirname(this.config.database), task.id, role),
      subject: task.id,
      summary: `${departments[role]}处理任务 ${task.id}`,
      detail,
    });
  }
  private event(event: Context["events"][number], receipt: Receipt, now: Date) {
    const id = taskId(event.subject);
    const data = object(JSON.parse(event.detail || "{}"));
    let task = this.task(id);
    if (event.source === "company-inbox" && event.type === "company.task.create") {
      if (task) throw new CompanyInputError("任务已存在；请使用新的编号或显式 retry");
      task = {
        ...taskRequest(data),
        id,
        status: "active",
        stage: 0,
        assignment: 0,
        supervised:
          !!this.config.ceoMode &&
          (String(data.kind).startsWith("check-") ||
            String(data.kind).startsWith("internal-") ||
            String(data.kind).startsWith("workday-") ||
            String(data.kind).startsWith("staff-") ||
            data.kind === "publish-content"),
        reports: [],
        approval: null,
        reason: "",
      };
      this.dispatch(task, receipt, now);
      this.save(task, "created");
      return;
    }
    if (!task) throw new CompanyInputError("任务不存在");
    if (event.source === "company-owner" && event.type === "company.task.supersede") {
      if (task.status === "superseded") return;
      if (!["blocked", "rejected", "queued"].includes(task.status))
        throw new CompanyInputError("只能取代关闭已暂停的任务");
      task.reason = words(data.reason, 400, "取代关闭原因");
      task.status = "superseded";
      task.approval = null;
      this.save(task, "superseded");
      return;
    }
    if (event.type === "company.model.deferred" && event.source === `company-${workflows[task.kind][task.stage]}`) {
      if (task.status !== "active" || task.assignment !== data.assignment) return;
      task.status = "queued";
      this.save(task, "model-deferred");
      return;
    }
    if (event.source === "company-inbox" && event.type === "company.task.resume") {
      if (task.status !== "queued") return;
      this.dispatch(task, receipt, now);
      this.save(task, "model-resumed");
      return;
    }
    if (event.source === "company-inbox" && event.type === "company.task.failed") {
      if (task.status !== "active" || data.assignment !== task.assignment) return;
      task.status = "blocked";
      task.reason = words(data.reason, 400, "运行失败原因");
      this.save(task, "worker-failed");
      return;
    }
    if (event.source === "company-inbox" && event.type === "company.task.retry") {
      if (task.status !== "blocked" && task.status !== "rejected")
        throw new CompanyInputError("只能重试已阻塞或被否决的任务");
      if (workflows[task.kind][task.stage] === "qa" && task.kind !== "publish-content")
        task.stage = Math.max(0, task.stage - 1);
      this.dispatch(task, receipt, now);
      this.save(task, "retried");
      return;
    }
    const role = workflows[task.kind][task.stage];
    const source =
      task.kind === "publish-content" && role === "qa" && this.config.publishVerification === "program"
        ? "company-verifier"
        : `company-${role}`;
    if (event.type !== "company.result" || event.source !== source) throw new CompanyInputError("来源不是当前负责部门");
    if (task.status !== "active" || data.assignment !== task.assignment)
      throw new CompanyInputError("结果已过期或任务已暂停");
    let report: Report;
    try {
      if (!["pass", "reject", "blocked"].includes(data.verdict as string))
        throw new CompanyInputError("结果必须是 pass、reject 或 blocked");
      report = {
        ...(this.config.reporting?.enabled ? { at: now.toISOString() } : {}),
        assignment: task.assignment,
        verdict: data.verdict as Report["verdict"],
        summary: words(data.summary, 400, "结果摘要"),
        artifacts:
          data.verdict === "pass" &&
          !task.kind.startsWith("check-") &&
          !task.kind.startsWith("workday-") &&
          task.kind !== "ceo"
            ? list(data.artifacts, "交付物", 150)
            : [],
        evidence: list(data.evidence, "核验依据", 150),
      };
      const topic =
        !this.config.pipelineMode && this.config.topics && task.kind !== "publish-content"
          ? taskTopic(dirname(this.config.database), task.id)
          : undefined;
      if (topic && data.verdict === "pass") {
        if (data.topic !== topic) throw new CompanyInputError("稿件交付必须关联原选题id（topic）");
        report.topic = topic;
      }
      const weekly = this.config.reporting?.weekly
        ? registeredReview(dirname(this.config.database), task.id)
        : undefined;
      const weeklyCEO =
        this.config.reporting?.weekly && task.kind === "ceo"
          ? registeredWeeklyReport(dirname(this.config.database), task.id)
          : undefined;
      if (weekly && data.verdict === "pass") {
        try {
          report.retrospective = retrospective(data.retrospective);
          if (weekly.role !== role || report.retrospective.through !== weekly.through)
            throw Error("复盘员工或笔记版本不符");
        } catch (error) {
          throw new CompanyInputError((error as Error).message);
        }
      }
      if (!this.config.pipelineMode && data.dailyReport !== undefined) {
        try {
          report.dailyReport = dailyReport(data.dailyReport);
        } catch (error) {
          throw new CompanyInputError((error as Error).message);
        }
      }
      if ((task.kind.startsWith("check-") || task.kind.startsWith("workday-")) && data.verdict === "pass") {
        try {
          report.inspection = inspection(data.inspection);
          if (report.inspection.topics?.length) {
            if (!this.config.topics) throw Error("选题流程尚未启用");
            validateTopicSubmission(dirname(this.config.database), task.id, report.inspection.topics, now);
          }
          if (this.config.workday?.prepareDrafts)
            validateDraftPlan(dirname(this.config.database), task.id, report.inspection, now, !!this.config.topics);
        } catch (error) {
          throw new CompanyInputError((error as Error).message);
        }
      }
      if (task.kind === "ceo" && data.verdict === "pass") {
        try {
          report.executive = executiveDecision(data.executive);
          if (
            registeredProactive(dirname(this.config.database), task.id) &&
            (!report.executive.report || report.executive.report.length > 500)
          )
            throw Error("主动经营必须提供executive.report经营结论（1–500字），没有新信息写无需动作");
          if (weeklyCEO) {
            report.retrospective = retrospective(data.retrospective);
            if (report.retrospective.through !== weeklyCEO.ceoThrough) throw Error("CEO笔记版本不符");
          }
          if (
            this.config.reporting?.enabled &&
            scheduledReport(dirname(this.config.database), task.id) &&
            !report.executive.report
          )
            throw Error("晚间汇报必须提供executive.report完整日报或周报");
        } catch (error) {
          throw new CompanyInputError((error as Error).message);
        }
      }
      if (task.kind === "publish-content" && data.verdict === "pass") {
        try {
          report.publication = publication(data.publication);
          if (
            JSON.stringify(report.publication) !==
            JSON.stringify(verifiedPublication(dirname(this.config.database), task.publication!))
          )
            throw Error("发布入口尚未确认这份平台结果");
          if (report.publication.key !== task.publication) throw Error("发布结果不属于本次审核");
          if (
            role === "qa" &&
            JSON.stringify(report.publication) !==
              JSON.stringify(task.reports.findLast((r) => r.role === "growth" && r.verdict === "pass")?.publication)
          )
            throw Error("验收结果与发布回执不一致");
        } catch (error) {
          throw new CompanyInputError((error as Error).message);
        }
      }
      if (
        JSON.stringify(report).length >
        (weekly || task.kind === "ceo" || report.inspection?.topics?.length ? 3500 : 1900)
      )
        throw new CompanyInputError("报告 JSON 超过 1900 字，请将详情留在交付文件");
    } catch (error) {
      if (!(error instanceof CompanyInputError)) throw error;
      task.status = "blocked";
      task.reason = `部门报告格式不合格：${error.message}`;
      this.save(task, "invalid-report");
      if (!task.supervised && !(this.config.ceoMode && task.kind === "ceo"))
        this.notice(receipt, id, `${task.reason}。请修正工作规范后显式 retry。`);
      return;
    }
    if (
      (this.config.jinzhaoWriting || this.config.pipelineMode) &&
      role === "growth" &&
      report.verdict === "pass" &&
      task.kind !== "publish-content"
    ) {
      const project = taskProject(dirname(this.config.database), task.id);
      const plan = project?.plans.find((p) => p.task === task.id);
      if (
        (project?.business === "jinzhao" || (this.config.pipelineMode && project?.business === "rabbitrun")) &&
        plan?.kind === "content" &&
        (!plan.operation || ["write", "image", "revise", "package"].includes(plan.operation))
      ) {
        const errors = this.config.pipelineMode
          ? checkPipelineDelivery(
              dirname(this.config.database),
              project!.business,
              report.artifacts,
              !!plan.pipelineDate,
            )
          : checkJinzhaoDelivery(dirname(this.config.database), report.artifacts);
        if (errors.length) {
          const returned =
            task.reports.filter((r) => r.writingErrors?.length).length >=
            (this.config.pipelineMode ? (plan.ownerRevisions ? 0 : 2) : 1);
          task.reason = `程序退稿：${errors.join("；")}`;
          task.reports.push({
            ...report,
            role,
            verdict: "reject",
            summary: task.reason.slice(0, 400),
            writingErrors: errors,
          });
          if (returned) task.status = "blocked";
          else this.dispatch(task, receipt, now);
          this.save(task, "writing-returned");
          return;
        }
      }
    }
    task.reports.push({ ...report, role });
    task.reason = report.summary;
    if (report.verdict !== "pass") {
      task.status = "blocked";
      if (!task.supervised)
        this.notice(
          receipt,
          id,
          `${departments[role]}未通过：${report.summary}。处理后可显式 retry；不会自动循环返工。`,
        );
    } else if (
      task.stage < workflows[task.kind].length - 1 &&
      task.kind !== "publish-content" &&
      !(this.config.pipelineMode && task.kind === "internal-content") &&
      !(this.config.ceoMode && this.config.contentReview === "ceo" && task.kind === "internal-content")
    ) {
      task.stage++;
      this.dispatch(task, receipt, now);
    } else if (
      task.kind === "ceo" ||
      task.kind === "publish-content" ||
      (task.kind.startsWith("check-") && (task.supervised || report.inspection?.state !== "blocked")) ||
      task.kind.startsWith("internal-") ||
      task.kind.startsWith("workday-") ||
      task.kind.startsWith("staff-")
    ) {
      task.status = "completed";
      task.approval = null;
    } else {
      task.status = "awaiting_approval";
      task.approval = `company:${id}:${task.assignment}:${randomUUID()}`;
      receipt.ask ??= [];
      receipt.ask.push({
        key: `company-${id}-${task.assignment}`,
        title: `${task.kind.startsWith("check-") ? "待处理" : "验收"}「${task.title}」`,
        text: task.kind.startsWith("check-")
          ? `${report.summary}\n依据：${report.evidence.join("；")}\n处理后员工继续检查；不授权发布、付款或对外联系。`
          : `验收部门报告：${report.summary}\n依据：${report.evidence.join("；")}\n交付物：${report.artifacts.join("；")}\n批准仅表示接受本次交付，不会自动发布、付款或发送消息。`,
        options: task.kind.startsWith("check-") ? ["已处理", "退回检查"] : ["接受交付", "退回修改"],
        about: task.approval,
      });
    }
    this.save(task, `reported:${role}`);
  }
  process(context: Context, now = new Date()): Receipt {
    if (!Array.isArray(context.events) || !Array.isArray(context.answers))
      throw new CompanyInputError("缺少中台事件或回答上下文");
    const batch = createHash("sha256")
      .update(JSON.stringify([context.events.map((e) => e.id), context.answers.map((a) => a.card)]))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cached = this.db.prepare("SELECT body FROM receipts WHERE id=?").get(batch);
      if (cached) {
        this.db.exec("COMMIT");
        return JSON.parse(cached.body as string);
      }
      const receipt: Receipt = {};
      for (const event of context.events) {
        const key = `event:${event.id}`;
        if (this.db.prepare("SELECT id FROM processed WHERE id=?").get(key)) continue;
        this.db.exec("SAVEPOINT event_input");
        try {
          this.event(event, receipt, now);
          this.db.exec("RELEASE event_input");
        } catch (error) {
          this.db.exec("ROLLBACK TO event_input; RELEASE event_input");
          if (!(error instanceof CompanyInputError) && !(error instanceof SyntaxError)) throw error;
          this.notice(
            receipt,
            /^[\w-]{1,40}$/.test(event.subject) ? event.subject : "invalid",
            (error as Error).message.slice(0, 500),
          );
        }
        this.db.prepare("INSERT INTO processed VALUES (?)").run(key);
      }
      for (const answer of context.answers) {
        const key = `answer:${answer.card}`;
        if (this.db.prepare("SELECT id FROM processed WHERE id=?").get(key)) continue;
        const task = this.tasks().find((t) => t.status === "awaiting_approval" && t.approval === answer.about);
        if (task) {
          task.status = answer.choice === 0 ? "completed" : "rejected";
          task.approval = null;
          this.save(task, task.status);
          this.notice(
            receipt,
            task.id,
            answer.choice === 0
              ? task.kind.startsWith("check-")
                ? "已记录，员工将在下次检查接续。"
                : "已接受交付并归档。"
              : "已退回；修改意见可写入工作区，显式 retry 后继续。",
          );
        }
        this.db.prepare("INSERT INTO processed VALUES (?)").run(key);
      }
      // Rule lanes isolate tasks; collapse malformed repeated inputs into one bounded notice.
      if ((receipt.notice?.length ?? 0) > 1)
        receipt.notice = [
          {
            key: `company-${batch.slice(0, 12)}`,
            title: "公司任务处理结果",
            text: receipt
              .notice!.map((n) => `${n.title}：${n.text}`)
              .join("\n")
              .slice(0, 3900),
          },
        ];
      this.db.prepare("INSERT INTO receipts VALUES (?,?)").run(batch, JSON.stringify(receipt));
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
