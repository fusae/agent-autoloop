import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompanyConfig, Role } from "./company.ts";

export const modelDay = (now: Date) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
export class ModelBudget {
  private db: DatabaseSync;
  private config: CompanyConfig;
  private directory: string;
  constructor(directory: string, config: CompanyConfig) {
    this.config = config;
    this.directory = directory;
    const file = join(directory, "model-runs.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL, role TEXT);
      CREATE INDEX IF NOT EXISTS journal_at ON journal(at);`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM journal WHERE id='baseline'").get()) {
        // Import actual claims, not queued jobs; heartbeat replays keep the original issued sequence.
        const hubFile = join(directory, "hub/hub.db");
        if (existsSync(hubFile)) {
          const hub = new DatabaseSync(hubFile, { readOnly: true });
          try {
            let agents: Record<string, { use?: string; command?: string[] }> = {};
            const versions = new Map<number, typeof agents>();
            for (const row of hub.prepare("SELECT fact FROM facts ORDER BY seq").iterate()) {
              const fact = JSON.parse(row.fact as string);
              for (const c of fact.changes ?? []) {
                const r = c.row;
                if (c.table === "config" && c.key === "rules" && r?.value?.agents) {
                  agents = r.value.agents;
                  versions.set(r.version, agents);
                }
                if (c.table !== "runs" || r?.state !== "claimed" || r.issued !== fact.seq) continue;
                const agent = (versions.get(r.rules_version) ?? agents)[r.agent];
                if (agent?.use === "company" && agent.command?.[1] === "model") continue;
                const role = String(r.agent).replace(/^company-/, "");
                if (!["ceo", "product", "engineering", "qa", "growth", "support", "finance"].includes(role)) continue;
                this.record(`legacy:${c.key}:${r.attempts + 1}:1`, "started", new Date(fact.at), role);
              }
            }
          } finally {
            hub.close();
          }
        }
        // Worker repairs share one hub claim. Retained stdout files prove each extra process launch.
        const runs = join(directory, "hub/worker/runs");
        if (existsSync(runs))
          for (const name of readdirSync(runs)) {
            const entryFile = join(runs, name, "entry.json");
            if (!existsSync(entryFile)) continue;
            const entry = JSON.parse(readFileSync(entryFile, "utf8"));
            if (entry.job?.agent?.use === "company" && entry.job.agent.command?.[1] === "model") continue;
            const role = String(entry.job?.agent?.id).replace(/^company-/, "");
            if (!["ceo", "product", "engineering", "qa", "growth", "support", "finance"].includes(role)) continue;
            for (let turn = 2; turn <= entry.turn; turn++) {
              const log = join(runs, name, `stdout-${turn}.log`);
              if (existsSync(log))
                this.record(
                  `legacy:${entry.run}:${entry.attempt}:${turn}`,
                  "started",
                  new Date(statSync(log).mtimeMs),
                  role,
                );
            }
          }
        this.record("baseline", "baseline", new Date());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }
  private record(id: string, kind: string, now: Date, role?: string) {
    this.db.prepare("INSERT OR IGNORE INTO journal VALUES (?,?,?,?)").run(id, kind, now.toISOString(), role ?? null);
  }
  snapshot(now = new Date()) {
    const date = modelDay(now),
      start = new Date(date + "T00:00:00+08:00").toISOString();
    const end = new Date(Date.parse(start) + 86400_000).toISOString();
    const rows = this.db
      .prepare("SELECT role,COUNT(*) AS n FROM journal WHERE kind='started' AND at>=? AND at<? GROUP BY role")
      .all(start, end);
    const roles: Partial<Record<Role, number>> = {};
    for (const row of rows) roles[row.role as Role] = Number(row.n);
    const employees: Record<string, number> = {};
    for (const row of this.db
      .prepare("SELECT role,COUNT(*) AS n FROM journal WHERE kind='employee-started' AND at>=? AND at<? GROUP BY role")
      .all(start, end))
      employees[String(row.role)] = Number(row.n);
    return {
      employees,
      date,
      total: Object.values(roles).reduce((a, b) => a + b, 0),
      roles,
      limits: this.config.dailyModelRuns ?? {},
      limited: !!this.db.prepare("SELECT 1 FROM journal WHERE id=?").get(`limited:${date}`),
    };
  }
  private employee(role: Role, task?: string): string | undefined {
    if (!task || role === "ceo" || !existsSync(join(this.directory, "operations.db"))) return undefined;
    const db = new DatabaseSync(join(this.directory, "operations.db"), { readOnly: true });
    try {
      for (const row of db.prepare("SELECT id,body FROM projects").all()) {
        const project = JSON.parse(row.body as string);
        if (project.activity.some((a: any) => a.task === task)) return `${row.id}:${role}`;
      }
    } finally {
      db.close();
    }
    return undefined;
  }
  available(role: Role, now = new Date(), task?: string) {
    const s = this.snapshot(now),
      limits = this.config.dailyModelRuns;
    if (!limits) return true;
    if (s.total >= (limits.total ?? Infinity) || (s.roles[role] ?? 0) >= (limits[role] ?? Infinity)) return false;
    if (role !== "ceo" && limits.employee !== undefined) {
      const employee = this.employee(role, task);
      if (!employee) return false;
      return (s.employees[employee] ?? 0) < limits.employee;
    }
    return true;
  }
  limited(now = new Date()) {
    this.record(`limited:${modelDay(now)}`, "limited", now);
  }
  start(role: Role, key: string, owner = false, now = new Date(), task?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const allowed = owner || this.available(role, now, task);
      if (allowed) {
        this.record(key, "started", now, role);
        const employee = this.employee(role, task);
        if (employee) this.record(key + ":employee", "employee-started", now, employee);
      }
      if (!allowed || !this.available(role, now, task)) this.limited(now);
      this.db.exec("COMMIT");
      return allowed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
