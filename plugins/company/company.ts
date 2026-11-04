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
  software: ["product", "engineering", "qa"],
  content: ["growth", "qa"],
  support: ["support", "qa"],
  finance: ["finance", "qa"],
};
for (const role of Object.keys(departments) as Role[]) workflows[`check-${role}`] = [role];
for (const kind of ["software", "content", "support", "finance"]) workflows[`internal-${kind}`] = [...workflows[kind]];
export type CompanyConfig = { name: string; database: string; maxAssignments: number; ceoMode?: boolean };
export type Context = {
  events: { id: number; source: string; type: string; subject: string; detail: string; hops?: number }[];
  answers: { card: number; choice: number | null; about: string; text?: string | null }[];
};
export type Report = {
  assignment: number;
  verdict: "pass" | "reject" | "blocked";
  summary: string;
  artifacts: string[];
  evidence: string[];
  inspection?: Inspection;
  executive?: ExecutiveDecision;
};
export type Task = {
  id: string;
  title: string;
  goal: string;
  kind: string;
  acceptance: string[];
  status: "active" | "blocked" | "awaiting_approval" | "completed" | "rejected";
  stage: number;
  assignment: number;
  reports: (Report & { role: Role })[];
  approval: string | null;
  reason: string;
  supervised?: boolean;
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
  private notice(receipt: Receipt, task: string, text: string) {
    receipt.notice ??= [];
    receipt.notice.push({ key: `company-${task}`, title: `公司任务：${task}`, text });
  }
  private dispatch(task: Task, receipt: Receipt) {
    task.approval = null;
    if (task.assignment >= this.config.maxAssignments) {
      task.status = "blocked";
      task.reason = `已达到 ${this.config.maxAssignments} 次部门派工上限；请检查任务或调整本机公司配置。`;
      if (!task.supervised) this.notice(receipt, task.id, task.reason);
      return;
    }
    task.assignment++;
    task.status = "active";
    const role = workflows[task.kind][task.stage];
    // Only the current brief and latest handoff travel in the event; full artifacts stay in the workspace.
    const detail = JSON.stringify({
      task: task.id,
      title: task.title,
      goal: task.goal,
      acceptance: task.acceptance,
      assignment: task.assignment,
      role,
      inspection: task.kind.startsWith("check-"),
      internal: task.kind.startsWith("internal-"),
      supervised: !!task.supervised,
      repair: task.assignment > 1 ? task.reason.slice(0, 400) : null,
      previous: task.reports.at(-1) ?? null,
    });
    receipt.events ??= [];
    receipt.events.push({
      id: `company:${task.id}:${task.assignment}`,
      type: `company.work.${role}`,
      subject: task.id,
      summary: `${departments[role]}处理任务 ${task.id}`,
      detail,
    });
  }
  private event(event: Context["events"][number], receipt: Receipt) {
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
          (String(data.kind).startsWith("check-") || String(data.kind).startsWith("internal-")),
        reports: [],
        approval: null,
        reason: "",
      };
      this.dispatch(task, receipt);
      this.save(task, "created");
      return;
    }
    if (!task) throw new CompanyInputError("任务不存在");
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
      if (workflows[task.kind][task.stage] === "qa") task.stage = Math.max(0, task.stage - 1);
      this.dispatch(task, receipt);
      this.save(task, "retried");
      return;
    }
    const role = workflows[task.kind][task.stage];
    if (event.type !== "company.result" || event.source !== `company-${role}`)
      throw new CompanyInputError("来源不是当前负责部门");
    if (task.status !== "active" || data.assignment !== task.assignment)
      throw new CompanyInputError("结果已过期或任务已暂停");
    let report: Report;
    try {
      if (!["pass", "reject", "blocked"].includes(data.verdict as string))
        throw new CompanyInputError("结果必须是 pass、reject 或 blocked");
      report = {
        assignment: task.assignment,
        verdict: data.verdict as Report["verdict"],
        summary: words(data.summary, 400, "结果摘要"),
        artifacts:
          data.verdict === "pass" && !task.kind.startsWith("check-") && task.kind !== "ceo"
            ? list(data.artifacts, "交付物", 150)
            : [],
        evidence: list(data.evidence, "核验依据", 150),
      };
      if (task.kind.startsWith("check-") && data.verdict === "pass") {
        try {
          report.inspection = inspection(data.inspection);
        } catch (error) {
          throw new CompanyInputError((error as Error).message);
        }
      }
      if (task.kind === "ceo" && data.verdict === "pass") {
        try {
          report.executive = executiveDecision(data.executive);
        } catch (error) {
          throw new CompanyInputError((error as Error).message);
        }
      }
      if (JSON.stringify(report).length > (task.kind === "ceo" ? 3500 : 1900))
        throw new CompanyInputError("报告 JSON 超过 1900 字，请将详情留在交付文件");
    } catch (error) {
      if (!(error instanceof CompanyInputError)) throw error;
      task.status = "blocked";
      task.reason = `部门报告格式不合格：${error.message}`;
      this.save(task, "invalid-report");
      if (!task.supervised) this.notice(receipt, id, `${task.reason}。请修正工作规范后显式 retry。`);
      return;
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
    } else if (task.stage < workflows[task.kind].length - 1) {
      task.stage++;
      this.dispatch(task, receipt);
    } else if (
      task.kind === "ceo" ||
      (task.kind.startsWith("check-") && (task.supervised || report.inspection?.state !== "blocked")) ||
      task.kind.startsWith("internal-")
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
  process(context: Context): Receipt {
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
          this.event(event, receipt);
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
