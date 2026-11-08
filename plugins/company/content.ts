import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Task } from "./company.ts";
import type { Plan } from "./operations.ts";
import { publicationResults } from "./publication-policy.ts";
import { production } from "./workday.ts";

export function contentSummary(text: string) {
  const draft = JSON.parse(text);
  if (typeof draft.title !== "string" || typeof draft.content !== "string") throw Error("缺少图文正文");
  return { title: draft.title, excerpt: Array.from(draft.content).slice(0, 100).join("") };
}
export function frozenSummary(artifacts: { path: string; content: string }[] = []): {
  title?: string;
  excerpt?: string;
} {
  const file = artifacts.find((a) => /(^|\/)xiaohongshu\.json$/.test(a.path));
  if (!file) return {};
  return contentSummary(file.content);
}
export function draftSummaries(directory: string, plans: Plan[], tasks: Task[]) {
  const published = new Set(publicationResults(directory).map((p) => p.key));
  return plans
    .filter(
      (p) =>
        p.kind === "content" &&
        p.owner === "growth" &&
        (!p.operation || production(p.operation)) &&
        ["proposed", "planned", "working", "blocked", "delivered", "publishing"].includes(p.status) &&
        !published.has(p.publicationKey ?? ""),
    )
    .map((p) => {
      const task = tasks.find((t) => t.id === p.task);
      const files = task?.reports.findLast((r) => r.role === "growth")?.artifacts ?? [];
      const base = { plan: p.id, task: p.task, status: p.status, title: p.title, excerpt: "", files };
      // Read only registered artifacts inside the workspace, never follow an employee symlink outside it.
      for (const file of [...files].sort(
        (a, b) => Number(b.endsWith("xiaohongshu.json")) - Number(a.endsWith("xiaohongshu.json")),
      )) {
        if (!file.endsWith(".json")) continue;
        try {
          const workspace = realpathSync(join(directory, "workspace"));
          const path = realpathSync(isAbsolute(file) ? file : join(workspace, file));
          const rel = relative(workspace, path);
          if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) continue;
          return { ...base, ...contentSummary(readFileSync(path, "utf8")) };
        } catch {
          // In-progress or old drafts may not yet have a complete package; keep their plan visible.
        }
      }
      return { ...base, note: "尚无可读的完整图文JSON，请读取任务原稿；不得视为空稿或新角度。" };
    });
}
