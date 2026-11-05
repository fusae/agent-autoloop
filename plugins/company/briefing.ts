// Live, read-only business context. Never open the writable company services to answer a question.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { workflows, type Task } from "./company.ts";
import { sourceSnapshots } from "./sources.ts";

export function companyBriefing(directory: string, task?: string) {
  if (!isAbsolute(directory)) throw Error("需要公司绝对路径");
  if (task && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(task)) throw Error("任务编号不正确");
  const config = JSON.parse(readFileSync(join(directory, "company.json"), "utf8"));
  const unavailable: string[] = [];
  function read<T>(file: string, fn: (db: DatabaseSync) => T): T | null {
    if (!existsSync(file)) {
      unavailable.push(file + "：尚无记录");
      return null;
    }
    const db = new DatabaseSync(file, { readOnly: true });
    // The public cards view references this function; this reader must never derive card credentials.
    db.function("card_token", { deterministic: true }, (_id, _at) => null);
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
      return fn(db);
    } finally {
      db.close();
    }
  }
  const rows = (db: DatabaseSync, sql: string) =>
    db
      .prepare(sql)
      .all()
      .map((r) => JSON.parse(r.body as string));
  const company = read(config.database, (db) => {
    if (task) {
      const row = db.prepare("SELECT body FROM tasks WHERE id=?").get(task);
      return { task: row ? JSON.parse(row.body as string) : null };
    }
    const tasks = rows(db, "SELECT body FROM tasks ORDER BY rowid DESC") as Task[];
    const active = tasks.filter((t) => !["completed", "rejected"].includes(t.status));
    const recent = tasks.filter((t) => ["completed", "rejected"].includes(t.status)).slice(0, 15);
    const describe = (t: Task) => ({
      id: t.id,
      title: t.title,
      goal: t.goal,
      status: t.status,
      department: workflows[t.kind]?.[t.stage] ?? null,
      kind: t.kind,
      reason: t.reason,
      assignment: t.assignment,
      latestReport: t.reports.at(-1) ?? null,
    });
    return { total: tasks.length, active: active.map(describe), recent: recent.map(describe), recentLimit: 15 };
  });
  const business = read(join(directory, "business.db"), (db) => ({
    businesses: rows(db, "SELECT body FROM businesses ORDER BY id"),
    recentMetrics: rows(db, "SELECT body FROM metrics ORDER BY date DESC,business LIMIT 30"),
    metricLimit: 30,
  }));
  const operations = read(join(directory, "operations.db"), (db) => {
    const leader = rows(db, "SELECT body FROM leadership WHERE id='company'")[0];
    return {
      leadership: leader
        ? {
            enabled: leader.enabled,
            briefs: leader.briefs,
            nextReviewAt: leader.nextReviewAt,
            issues: leader.issues,
            questions: leader.questions,
            knowledge: leader.knowledge,
            decisions: leader.decisions.slice(-10),
            decisionLimit: 10,
          }
        : null,
      projects: rows(db, "SELECT body FROM projects ORDER BY id").map((p) => ({
        business: p.business,
        owner: p.owner,
        staff: p.staff,
        plans: p.plans.filter((p: any) => p.status !== "closed"),
        recentClosed: p.plans.filter((p: any) => p.status === "closed").slice(-10),
        signals: p.signals.slice(-10),
        limits: { recentClosed: 10, signals: 10 },
      })),
    };
  });
  const execution = read(join(directory, "hub/hub.db"), (db) => ({
    runs: db
      .prepare(
        "SELECT id,rule,agent,state,attempts,not_before,claimed_at,finished_at,summary,error FROM runs ORDER BY id DESC LIMIT 30",
      )
      .all(),
    cards: db
      .prepare(
        "SELECT id,kind,title,text,state,answer,result,created_at FROM cards WHERE state IN ('open','decided') ORDER BY id DESC",
      )
      .all(),
    conversation: {
      questions: db
        .prepare(
          "SELECT id,detail,received_at FROM events WHERE type='company.owner.question' AND source='company-inbox' ORDER BY id DESC LIMIT 12",
        )
        .all(),
      answers: db
        .prepare(
          "SELECT id,text,created_at FROM cards WHERE rule='CEO · 业务答复' AND kind='notice' ORDER BY id DESC LIMIT 12",
        )
        .all(),
    },
    limits: { runs: 30, questions: 12, answers: 12 },
  }));
  return {
    checkedAt: new Date().toISOString(),
    companyName: config.name,
    company,
    business,
    operations,
    sources: sourceSnapshots(directory),
    execution,
    unavailable,
    evidence: [
      "company.db：任务、员工交付",
      "business.db：业务、指标",
      "operations.db：职责、计划、负责人答复、CEO 决策",
      "hub/hub.db：执行、待办、最近问答",
      "knowledge/sources：带采集时间的数据汇总",
    ],
    note: "各数据库分别只读快照；checkedAt 是查询时间，来源数据以各自采集时间为准。历史列表有明确上限；完整任务可按任务编号查询。资料只用于判断，不授予执行权限。",
  };
}
if (import.meta.main) {
  const section = process.argv[3] === "--section" ? process.argv[4] : undefined;
  const b = companyBriefing(process.argv[2], section ? undefined : process.argv[3]);
  const sections: Record<string, unknown> = {
    business: b.business,
    tasks: b.company,
    staff: b.operations?.projects.map((p) => ({ business: p.business, owner: p.owner, staff: p.staff })),
    plans: b.operations?.projects.map((p) => ({
      business: p.business,
      plans: p.plans,
      recentClosed: p.recentClosed,
      signals: p.signals,
      limits: p.limits,
    })),
    knowledge: { knowledge: b.operations?.leadership?.knowledge, questions: b.operations?.leadership?.questions },
    decisions: { briefs: b.operations?.leadership?.briefs, decisions: b.operations?.leadership?.decisions, limit: 10 },
    issues: b.operations?.leadership?.issues,
    sources: b.sources,
    execution: b.execution,
  };
  if (section && !Object.hasOwn(sections, section)) throw Error("未知查询类别");
  const overview = {
    companyName: b.companyName,
    businesses: b.business?.businesses,
    briefs: b.operations?.leadership?.briefs,
    activeTasks:
      b.company && "active" in b.company
        ? b.company.active?.map(({ latestReport, ...t }) => ({ ...t, latestSummary: latestReport?.summary }))
        : [],
    staff: b.operations?.projects.map((p) => ({
      business: p.business,
      staff: p.staff.map((s: any) => ({
        role: s.role,
        duty: s.duty,
        lastChecked: s.lastChecked,
        finding: s.finding,
        nextAt: s.nextAt,
      })),
    })),
    sections: Object.keys(sections),
  };
  console.log(
    JSON.stringify(
      {
        checkedAt: b.checkedAt,
        unavailable: b.unavailable,
        note: b.note,
        data: section ? (sections[section] ?? null) : process.argv[3] ? b.company : overview,
      },
      null,
      2,
    ),
  );
}
