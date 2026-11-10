import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executePublication } from "./publication.ts";
import { rabbitConfirmation } from "./rabbitrun-receipt.ts";
import { rabbitChannel } from "./rabbitrun.ts";
import type { Company } from "./company.ts";
import type { Operations } from "./operations.ts";

// Lookup only: this recovery path must never dispatch a publisher or a model turn.
export function recoverRabbitPublications(
  directory: string,
  office: Company,
  operations: Operations,
  lookup = executePublication,
) {
  for (const task of office
    .tasks()
    .filter((t) => t.kind === "publish-content" && t.status === "blocked" && t.publication)) {
    const key = task.publication!;
    const request = JSON.parse(readFileSync(join(directory, "publications", key + ".json"), "utf8"));
    if (request.business !== "rabbitrun") continue;
    if (
      !rabbitConfirmation(directory, { ...request, channel: rabbitChannel, action: "lookup" }, "1970-01-01T00:00:00Z")
    )
      continue;
    try {
      lookup(directory, key, true);
    } catch {
      continue;
    }
    office.reconcilePublication(key);
    operations.reconcilePublication(key);
  }
  // Finish a partially committed reconciliation after a crash between the two journals.
  for (const task of office
    .tasks()
    .filter((t) => t.kind === "publish-content" && t.status === "completed" && t.reports.at(-1)?.publication?.x)) {
    operations.reconcilePublication(task.publication!);
  }
}
