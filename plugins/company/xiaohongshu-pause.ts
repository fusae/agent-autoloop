import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const xiaohongshuPauseReason = "暂停中（养号）";
export function xiaohongshuPaused(directory: string, business = "jinzhao") {
  if (!["jinzhao", "jizhu"].includes(business)) return false;
  const file = join(directory, "company.json");
  return existsSync(file) && JSON.parse(readFileSync(file, "utf8")).xiaohongshuPaused === true;
}
