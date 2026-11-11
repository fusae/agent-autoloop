import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Role } from "./company.ts";
import { localDay, weekOf } from "./workday.ts";
import { noteLimit } from "./notes.ts";

export type Retrospective = { review: string; notes: string; through: number };
export type WeeklyCycle = {
  week: string;
  date: string;
  staff: { business: string; role: Role; task: string; through: number; result?: Retrospective }[];
  report?: string;
  ceoThrough?: number;
  prepared?: boolean;
};
export function retrospective(value: any): Retrospective {
  if (
    !value ||
    typeof value.review !== "string" ||
    !value.review.trim() ||
    value.review.length > 1800 ||
    typeof value.notes !== "string" ||
    !value.notes.trim() ||
    value.notes.length > noteLimit ||
    !Number.isSafeInteger(value.through) ||
    value.through < 0
  )
    throw Error("复盘需含1800字内review、4000字内notes和资料中的through版本");
  return { review: value.review.trim(), notes: value.notes.trim(), through: value.through };
}
export function friday(now: Date, startDate?: string) {
  const date = localDay(now);
  return (
    new Date(date).getUTCDay() === 5 && (!startDate || date >= startDate) && now < new Date(`${date}T22:00:00+08:00`)
  );
}
export function registeredReview(directory: string, task: string) {
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM leadership WHERE id='company'").get();
    const cycles: WeeklyCycle[] = row ? (JSON.parse(String(row.body)).weeklyCycles ?? []) : [];
    for (const cycle of cycles) {
      const employee = cycle.staff.find((s) => s.task === task);
      if (employee) return { ...employee, week: cycle.week };
    }
  } finally {
    db.close();
  }
}
export function previousWeek(now: Date) {
  return weekOf(new Date(now.getTime() - 7 * 86400_000));
}

export function registeredWeeklyReport(directory: string, task: string) {
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM leadership WHERE id='company'").get();
    const chief = row ? JSON.parse(String(row.body)) : {};
    const report = chief.eveningReports?.find((r: any) => r.task === task);
    return (chief.weeklyCycles as WeeklyCycle[] | undefined)?.find((c) => c.date === report?.date);
  } finally {
    db.close();
  }
}
