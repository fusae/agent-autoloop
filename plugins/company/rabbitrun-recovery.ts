import { recoverPublications } from "./publication-recovery.ts";
import { executePublication } from "./publication.ts";
import type { Company } from "./company.ts";
import type { Operations } from "./operations.ts";
// Retain the old import for installed clients; all channels use the same recovery implementation.
export function recoverRabbitPublications(
  directory: string,
  office: Company,
  operations: Operations,
  lookup = executePublication,
) {
  return recoverPublications(directory, office, operations, new Date(), lookup);
}
