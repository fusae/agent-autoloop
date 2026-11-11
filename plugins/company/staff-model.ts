import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Project } from "./operations.ts";
import type { CompanyConfig, Role } from "./company.ts";

export type StaffModels = Record<string, Partial<Record<Role, { engine: "codex" | "claude"; model: string }>>>;

// Resolve identity from the coordinator's ledger, never the employee's prose or event payload.
export function taskProject(directory: string, task: string): Project | undefined {
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const row of db.prepare("SELECT body FROM projects").all()) {
      const p = JSON.parse(String(row.body)) as Project;
      if (p.plans.some((a) => a.task === task) || p.activity.some((a) => a.task === task)) return p;
    }
  } finally {
    db.close();
  }
}

export function staffWorkType(config: CompanyConfig, directory: string, task: string, role: Role) {
  const business = config.staffModels && taskProject(directory, task)?.business;
  return `company.work.${role}${business && config.staffModels?.[business]?.[role] ? `.${business}` : ""}`;
}

export function staffAgentRole(agent: string): Role | undefined {
  return /^company-(?:staff-[a-z0-9][a-z0-9_-]*-)?(ceo|product|engineering|qa|growth|support|finance)$/.exec(
    agent,
  )?.[1] as Role | undefined;
}
