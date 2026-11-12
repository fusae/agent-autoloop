import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompanyConfig, Receipt } from "./company.ts";
import type { Leadership } from "./executive.ts";

export type Maintenance = {
  key: string;
  title: string;
  text: string;
  at: string;
  resolvedAt?: string;
  result?: string;
};
export function delegated(directory: string) {
  const path = join(directory, "company.json");
  return existsSync(path) && !!JSON.parse(readFileSync(path, "utf8")).delegation;
}
export function chairmanTitle(category?: string) {
  return category === "spend" ? "CEO · 支出决策" : category === "identity" ? "CEO · 本人验证" : "待维护者处理";
}
export function chairmanNotice(title: string) {
  return [
    "发布确认",
    "今朝选题",
    "CEO · 支出决策",
    "CEO · 本人验证",
    "CEO · 日报",
    "CEO · 日报+周报",
    "CEO · 周报",
    "CEO · 工作汇报",
  ].includes(title);
}
export function maintenanceList(db: DatabaseSync): Maintenance[] {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='maintenance'").get()) return [];
  return db
    .prepare("SELECT body FROM maintenance ORDER BY rowid")
    .all()
    .map((r) => JSON.parse(String(r.body)));
}
export function recordMaintenance(db: DatabaseSync, entry: Maintenance) {
  db.exec("CREATE TABLE IF NOT EXISTS maintenance(key TEXT PRIMARY KEY, body TEXT NOT NULL)");
  if (db.prepare("SELECT key FROM maintenance WHERE key=?").get(entry.key)) return;
  const body = JSON.stringify(entry);
  db.prepare("INSERT INTO maintenance VALUES (?,?)").run(entry.key, body);
  db.prepare("INSERT INTO journal(project,kind,at,body) VALUES (?,?,?,?)").run(
    "company",
    "maintenance",
    entry.at,
    body,
  );
}
export function reconcileMaintenance(db: DatabaseSync, c: Leadership, now: Date) {
  for (const q of c.questions.filter((q) => q.recipient !== "chairman")) {
    if (q.state !== "answered") {
      q.recipient = "maintainer";
      recordMaintenance(db, {
        key: `ceo-${q.id}`,
        title: "待维护者处理",
        text: `${q.question}\n${q.context}`,
        at: q.at,
      });
    }
  }
  for (const entry of maintenanceList(db).filter((m) => !m.resolvedAt)) {
    const q = c.questions.find((q) => entry.key === `ceo-${q.id}`);
    if (q?.state === "answered") finishMaintenance(db, entry.key, q.answer ?? "原问题已解决", now);
  }
}
export function finishMaintenance(db: DatabaseSync, key: string, result: string, now: Date) {
  if (!result.trim() || result.length > 1000) throw Error("维护处理结果需要1–1000字");
  const entry = maintenanceList(db).find((m) => m.key === key);
  if (!entry) throw Error("待维护事项不存在");
  if (entry.resolvedAt) return;
  const body = JSON.stringify({ ...entry, resolvedAt: now.toISOString(), result });
  db.prepare("UPDATE maintenance SET body=? WHERE key=?").run(body, key);
  db.prepare("INSERT INTO journal(project,kind,at,body) VALUES (?,?,?,?)").run(
    "company",
    "maintenance-resolved",
    now.toISOString(),
    body,
  );
}
export function routeDelegatedReceipt(db: DatabaseSync, config: Partial<CompanyConfig>, receipt: Receipt, now: Date) {
  if (!config.delegation) return;
  for (const kind of ["ask", "notice"] as const) {
    receipt[kind] = (receipt[kind] as any[] | undefined)?.filter((entry) => {
      if (chairmanNotice(entry.title)) return true;
      if (kind === "ask" || /待维护者处理|异常|失败|故障|未完成|停滞/.test(entry.title))
        recordMaintenance(db, { ...entry, at: now.toISOString() });
      return false;
    }) as any;
  }
}
export function delegatedReport(db: DatabaseSync, c: Leadership, date: string) {
  const decisions = c.decisions.filter(
    (d) => !!d.authority && new Date(Date.parse(d.at) + 8 * 3600_000).toISOString().slice(0, 10) === date,
  );
  const titles = new Map<string, string>();
  const batches = new Map<string, string[]>();
  for (const row of db.prepare("SELECT body FROM projects").all()) {
    const p = JSON.parse(String(row.body));
    for (const t of p.topics ?? []) titles.set(t.id, t.title);
    for (const b of p.topicBatches ?? []) batches.set(b.id, b.topics);
    for (const p1 of p.plans ?? []) titles.set(p1.id, p1.title);
  }
  const lines = decisions.flatMap(({ decision: d }) => [
    ...(d.topicReviews ?? []).map(
      (t) =>
        `选题${t.approve ? "通过" : "退回"}《${titles.get(t.topic) ?? t.topic}》：${t.score ?? "未知"}/10，${t.reason}`,
    ),
    ...(d.topicDecisions ?? []).flatMap((b) =>
      b.choices.map(
        (v) =>
          `选题${v.approve ? "通过" : "退回"}《${titles.get(batches.get(b.batch)?.[v.index] ?? "") ?? "存量选题"}》：${v.opinion}`,
      ),
    ),
    ...(d.deliveries ?? []).map(
      (p) =>
        `${p.verdict === "publish" ? "发布决定" : p.verdict === "revise" ? "退回重写" : "验收"}《${titles.get(p.plan) ?? p.plan}》：${p.reason}`,
    ),
  ]);
  const queue = maintenanceList(db).filter((m) => !m.resolvedAt);
  const summary = (lines: string[], empty: string) => {
    const text = lines.map((s) => `- ${s}`).join("\n");
    return text.length > 850 ? text.slice(0, 800) + `\n共${lines.length}项，完整记录见后台。` : text || empty;
  };
  return `\n\n今天替董事长做的决定\n${summary(lines, "今天没有新增决定")}\n\n待维护者处理\n${summary(
    queue.map((m) => `${m.title}：${m.text}`),
    "暂无",
  )}`;
}

// Suppressed hub failures still need a durable place for the maintainer to find them.
export function retainSuppressedCard(
  directory: string,
  card: { id: number; kind: string; title: string; text: string },
) {
  if (card.kind !== "ask" && !/异常|失败|故障|未完成|停滞/.test(card.title)) return;
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    recordMaintenance(db, { key: `card:${card.id}`, title: card.title, text: card.text, at: new Date().toISOString() });
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export function pipelineSuppresses(directory: string, card: { title: string; text: string; kind: string }) {
  const file = join(directory, "company.json");
  if (!existsSync(file) || !JSON.parse(readFileSync(file, "utf8")).pipelineMode) return false;
  if (
    card.title === "今朝选题" ||
    card.title === "CEO · 日报" ||
    card.title === "待维护者处理" ||
    /^X 待发，请手动发布\n发布稿件：[a-f0-9]{32}$/.test(card.text)
  )
    return false;
  if (card.title === "发布确认") {
    const key = /\n发布稿件：([a-f0-9]{32})$/.exec(card.text)?.[1];
    if (key) {
      const frozen = join(directory, "publications", key + ".json");
      if (existsSync(frozen) && JSON.parse(readFileSync(frozen, "utf8")).business === "jinzhao") return false;
    }
  }
  return true;
}
