import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Leadership } from "./executive.ts";
import type { Project } from "./operations.ts";

export const noteLimit = 4000;
export function initNotes(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS notebooks(agent TEXT PRIMARY KEY,body TEXT NOT NULL,through INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS note_facts(seq INTEGER PRIMARY KEY,agent TEXT NOT NULL,key TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(agent,key));`);
}
export function appendNote(db: DatabaseSync, agent: string, key: string, text: string, at: string) {
  db.prepare("INSERT OR IGNORE INTO note_facts(agent,key,text,at) VALUES (?,?,?,?)").run(agent, key, text, at);
}
export function notebook(db: DatabaseSync, agent: string) {
  const saved = db.prepare("SELECT body,through FROM notebooks WHERE agent=?").get(agent);
  const facts = db
    .prepare("SELECT seq,text,at FROM note_facts WHERE agent=? AND seq>? ORDER BY seq")
    .all(agent, Number(saved?.through ?? 0));
  let text = String(saved?.body ?? "");
  let omitted = 0;
  for (const f of facts.slice().reverse()) {
    const line = `\n- ${String(f.at).slice(0, 10)} ${f.text}`;
    if (text.length + line.length <= noteLimit) text += line;
    else omitted++;
  }
  return { text: text.trim(), through: Number(facts.at(-1)?.seq ?? saved?.through ?? 0), omitted };
}
export function compactNote(db: DatabaseSync, agent: string, text: string, through: number) {
  const current = notebook(db, agent);
  const old = db.prepare("SELECT through FROM notebooks WHERE agent=?").get(agent);
  if (
    !text.trim() ||
    text.length > noteLimit ||
    !Number.isSafeInteger(through) ||
    through < Number(old?.through ?? 0) ||
    through > current.through
  )
    throw Error("笔记需为1–4000字，且只整理已提供的事实版本");
  db.prepare(
    "INSERT INTO notebooks VALUES (?,?,?) ON CONFLICT(agent) DO UPDATE SET body=excluded.body,through=excluded.through",
  ).run(agent, text.trim(), through);
}
export function readNotebook(directory: string, agent: string) {
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return { text: "", through: 0, omitted: 0 };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='notebooks'").get())
      return { text: "", through: 0, omitted: 0 };
    return notebook(db, agent);
  } finally {
    db.close();
  }
}
export function seedNotes(db: DatabaseSync, chief: Leadership, projects: Project[]) {
  for (const k of chief.knowledge) {
    const text = `${k.source === "owner" ? "董事长事实/决定" : "CEO意见"}：${k.answer}（依据：${k.evidence}）`;
    appendNote(db, "ceo", `knowledge:${k.id}`, text, k.at);
    for (const s of projects.find((p) => p.business === k.business)?.staff ?? [])
      if (s.enabled) appendNote(db, `${k.business}:${s.role}`, `knowledge:${k.id}`, text, k.at);
  }
  for (const d of chief.decisions)
    for (const review of d.decision.deliveries ?? []) {
      if (review.verdict !== "revise") continue;
      const p = projects.find((p) => p.business === review.business)?.plans.find((p) => p.id === review.plan);
      const text = `CEO退回《${p?.title ?? review.task}》：${review.reason}`;
      for (const agent of ["ceo", `${review.business}:${p?.owner ?? "growth"}`])
        appendNote(db, agent, `review:${d.task}:${review.plan}`, text, d.at);
    }
}

export function taskNotebooks(directory: string, role: string, task?: string) {
  if (role === "ceo") return { ceo: readNotebook(directory, "ceo") };
  const file = join(directory, "operations.db");
  if (!task || !existsSync(file)) return {};
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const chief = db.prepare("SELECT body FROM leadership WHERE id='company'").get();
    const cycles = chief ? ((JSON.parse(String(chief.body)) as Leadership).weeklyCycles ?? []) : [];
    const agents = db
      .prepare("SELECT body FROM projects")
      .all()
      .map((r) => JSON.parse(String(r.body)) as Project)
      .filter(
        (p) =>
          p.activity.some((a) => a.task === task && a.role === role) ||
          p.staff.some((s) => s.role === role && s.workday?.task === task) ||
          cycles.some((c) => c.staff.some((s) => s.task === task && s.business === p.business && s.role === role)),
      )
      .map((p) => `${p.business}:${role}`);
    for (const cycle of cycles)
      for (const s of cycle.staff) if (s.task === task && s.role === role) agents.push(`${s.business}:${role}`);
    return Object.fromEntries([...new Set(agents)].map((agent) => [agent, readNotebook(directory, agent)]));
  } finally {
    db.close();
  }
}

export function attachWorkNotes(directory: string, role: string, task: string | undefined, contextFile: string) {
  const context = JSON.parse(readFileSync(contextFile, "utf8"));
  context.workNotes = taskNotebooks(directory, role, task);
  writeFileSync(contextFile, JSON.stringify(context), { mode: 0o600 });
}
