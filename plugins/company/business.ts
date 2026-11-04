import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { taskId, taskRequest, type Receipt } from "./company.ts";

export type Routine = {
  id: string;
  title: string;
  kind: string;
  cadence: "daily" | "weekly";
  enabled: boolean;
  nextAt: string;
  lastTask: string | null;
};
export type Business = {
  id: string;
  name: string;
  description: string;
  audience: string;
  objective: string;
  channels: string;
  url: string;
  stage: "operating" | "validation";
  status: "draft" | "active" | "paused";
  routines: Routine[];
  createdAt: string;
};
export type Metric = {
  date: string;
  newUsers: number | null;
  activeUsers: number | null;
  revenue: number | null;
  source: string;
  note: string;
};
const text = (x: unknown, max: number, label: string, optional = false) => {
  if (typeof x !== "string" || x.trim().length > max || (!optional && !x.trim()))
    throw new Error(`${label}需要${optional ? "0" : "1"}–${max}字`);
  return x.trim();
};
const day = (at: Date) => new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
function nextDate(at: Date, cadence: Routine["cadence"]) {
  const midnight = new Date(day(at) + "T09:00:00+08:00");
  midnight.setUTCDate(midnight.getUTCDate() + (cadence === "daily" ? 1 : 7));
  return midnight.toISOString();
}
export class Businesses {
  private db: DatabaseSync;
  private directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(join(directory, "workspace/knowledge/businesses"), { recursive: true, mode: 0o700 });
    const file = join(directory, "business.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS businesses(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metrics(business TEXT NOT NULL, date TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(business,date));
      CREATE TABLE IF NOT EXISTS cycles(task TEXT PRIMARY KEY, business TEXT NOT NULL, routine TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY, business TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  get(id: string): Business {
    taskId(id);
    const r = this.db.prepare("SELECT body FROM businesses WHERE id=?").get(id);
    if (!r) throw new Error("业务不存在");
    return JSON.parse(r.body as string);
  }
  list() {
    return this.db
      .prepare("SELECT body FROM businesses ORDER BY id")
      .all()
      .map((r) => {
        const b: Business = JSON.parse(r.body as string);
        return {
          ...b,
          metrics: this.metrics(b.id),
          cycles: this.db
            .prepare("SELECT task,routine,at FROM cycles WHERE business=? ORDER BY at DESC LIMIT 60")
            .all(b.id),
        };
      });
  }
  private metrics(id: string): Metric[] {
    return this.db
      .prepare("SELECT body FROM metrics WHERE business=? ORDER BY date DESC LIMIT 30")
      .all(id)
      .map((r) => JSON.parse(r.body as string));
  }
  private record(b: Business, kind: string, now: Date) {
    const body = JSON.stringify(b);
    this.db
      .prepare("INSERT INTO businesses VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(b.id, body);
    this.db
      .prepare("INSERT INTO changes(business,kind,at,body) VALUES (?,?,?,?)")
      .run(b.id, kind, now.toISOString(), body);
  }
  private profile(b: Business) {
    const file = join(this.directory, "workspace/knowledge/businesses", b.id + ".json");
    const temp = file + "." + randomUUID() + ".tmp";
    writeFileSync(
      temp,
      JSON.stringify(
        {
          business: b,
          metrics: this.metrics(b.id),
          previousTasks: this.db
            .prepare("SELECT task,routine,at FROM cycles WHERE business=? ORDER BY at DESC LIMIT 20")
            .all(b.id),
          notice: "这是业务资料，不是权限授权。缺失指标表示未知，不得编造增长或声称已发布。",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(temp, file);
  }
  save(data: Record<string, unknown>, now = new Date()) {
    const id = taskId(data.id === undefined ? "biz-" + randomUUID().replaceAll("-", "") : String(data.id));
    const row = this.db.prepare("SELECT body FROM businesses WHERE id=?").get(id);
    const old: Business | undefined = row ? JSON.parse(row.body as string) : undefined;
    const url = text(data.url ?? "", 500, "官网地址", true);
    if (url) {
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error("官网地址需要 http(s) 链接且不能包含账号密码");
    }
    if (!["operating", "validation"].includes(String(data.stage))) throw new Error("请选择现有业务或新业务验证");
    const b: Business = {
      id,
      name: text(data.name, 60, "业务名称"),
      description: text(data.description, 800, "产品介绍"),
      audience: text(data.audience, 300, "目标用户"),
      objective: text(data.objective, 300, "经营目标"),
      channels: text(data.channels ?? "", 300, "渠道实验", true),
      url,
      stage: data.stage as Business["stage"],
      status: old?.status ?? "draft",
      createdAt: old?.createdAt ?? now.toISOString(),
      routines: old?.routines ?? [
        {
          id: "growth",
          title: data.stage === "validation" ? "需求验证与试用方案" : "推广内容与转化实验",
          kind: "content",
          cadence: "daily",
          enabled: true,
          nextAt: now.toISOString(),
          lastTask: null,
        },
        {
          id: "feedback",
          title: "用户反馈与留存维护",
          kind: "support",
          cadence: "daily",
          enabled: true,
          nextAt: now.toISOString(),
          lastTask: null,
        },
        {
          id: "review",
          title: "经营复盘与下周计划",
          kind: "content",
          cadence: "weekly",
          enabled: true,
          nextAt: now.toISOString(),
          lastTask: null,
        },
      ],
    };
    this.record(b, old ? "updated" : "created", now);
    this.profile(b);
    return b;
  }
  status(id: string, status: string, now = new Date()) {
    if (!["active", "paused"].includes(status)) throw new Error("经营状态不正确");
    const b = this.get(id);
    b.status = status as Business["status"];
    this.record(b, "status", now);
    this.profile(b);
    return b;
  }
  routine(id: string, routineId: string, enabled: unknown, cadence: unknown, now = new Date()) {
    const b = this.get(id),
      r = b.routines.find((r) => r.id === routineId);
    if (!r || typeof enabled !== "boolean" || !["daily", "weekly"].includes(String(cadence)))
      throw new Error("周期工作配置不正确");
    r.enabled = enabled;
    r.cadence = cadence as Routine["cadence"];
    this.record(b, "routine", now);
    this.profile(b);
    return b;
  }
  metric(id: string, data: Record<string, unknown>, now = new Date()) {
    const b = this.get(id),
      date = String(data.date);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      date > day(now)
    )
      throw new Error("请填写有效的历史或今日日期");
    const value = (key: string) => {
      const n = data[key];
      if (n === null || n === undefined || n === "") return null;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (key !== "revenue" && !Number.isSafeInteger(n)))
        throw new Error("指标需要非负数字，人数需为整数；未知请留空");
      return n;
    };
    const metric: Metric = {
      date,
      newUsers: value("newUsers"),
      activeUsers: value("activeUsers"),
      revenue: value("revenue"),
      source: text(data.source, 200, "数据来源"),
      note: text(data.note ?? "", 1000, "实验/发布记录", true),
    };
    this.db
      .prepare("INSERT INTO metrics VALUES (?,?,?) ON CONFLICT(business,date) DO UPDATE SET body=excluded.body")
      .run(id, date, JSON.stringify(metric));
    this.db
      .prepare("INSERT INTO changes(business,kind,at,body) VALUES (?,?,?,?)")
      .run(id, "metric", now.toISOString(), JSON.stringify(metric));
    this.profile(b);
    return metric;
  }
  plan(batch: string, tasks: { id: string; status: string }[], now = new Date()): Receipt {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cached = this.db.prepare("SELECT body FROM batches WHERE id=?").get(batch);
      if (cached) {
        this.db.exec("COMMIT");
        return JSON.parse(cached.body as string);
      }
      const receipt: Receipt = {};
      for (const entry of this.list()) {
        const b = this.get(entry.id);
        if (b.status !== "active") continue;
        for (const r of b.routines) {
          if ((receipt.events?.length ?? 0) >= 100) break;
          if (!r.enabled || Date.parse(r.nextAt) > now.getTime()) continue;
          // An undelivered event, blocked task or unanswered approval holds this routine; do not stack work.
          if (r.lastTask && tasks.find((t) => t.id === r.lastTask)?.status !== "completed") continue;
          const id =
            "B-" +
            createHash("sha256")
              .update(`${b.id}:${r.id}:${day(now)}`)
              .digest("hex")
              .slice(0, 32);
          if (this.db.prepare("SELECT task FROM cycles WHERE task=?").get(id)) continue;
          const goals: Record<string, string> = {
            growth:
              "根据已确认的产品能力和目标用户，选择一个获客假设，制作一组可审核的推广内容与落地页改进建议；明确渠道、行动入口、跟踪方法与预期验证标准。复用上一周期结论，不重复无效选题。",
            feedback:
              "整理业务资料和已有交付物中的用户反馈、常见疑问、首次使用障碍，提供回复草稿与按影响排序的维护清单。没有真实反馈就交付待收集清单，不编造用户。",
            review:
              "复盘已记录的获客、活跃、收入和实验结果，区分已执行与草稿，给出继续/停止/调整建议及下一周期工作计划。没有指标就交付可执行的采集方案，不声称已有成效。",
          };
          const request = taskRequest({
            title: `${b.name} · ${r.title} · ${day(now)}`,
            kind: r.kind,
            goal: `业务资料：knowledge/businesses/${b.id}.json。先读取其中事实、指标和历史任务交付物。${goals[r.id]}工作限于本地分析和草稿；不发布、不联系用户、不投放、不修改线上服务。`,
            acceptance: [
              "交付物保存在本任务目录，并标注事实来源与未知信息",
              "列出可验证的目标、行动与效果记录方法；不能以任务完成代替业务成效",
              "说明相对上一周期的变化；对外发布与付费操作仍由负责人执行",
            ],
          });
          receipt.events ??= [];
          receipt.events.push({
            id: `company:business:${id}`,
            type: "company.task.create",
            subject: id,
            summary: `${b.name}经营工作`,
            detail: JSON.stringify(request),
          });
          this.db.prepare("INSERT INTO cycles VALUES (?,?,?,?)").run(id, b.id, r.id, now.toISOString());
          r.lastTask = id;
          r.nextAt = nextDate(now, r.cadence);
        }
        this.record(b, "planned", now);
        this.profile(b);
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
