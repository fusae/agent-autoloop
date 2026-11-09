import { createHash } from "node:crypto";
import type { Task } from "./company.ts";

// Reports are append-only deliveries; task id alone cannot distinguish a retry's new handoff.
export function reviewVersion(task: Task): string {
  return createHash("sha256")
    .update(JSON.stringify([task.id, task.assignment, task.reports]))
    .digest("hex");
}
