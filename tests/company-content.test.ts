// Failure modes: deduplication drops unpublished drafts, indexes closed/published drafts,
// exposes files outside the workspace, or loses Unicode characters in content previews.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentSummary, draftSummaries } from "../plugins/company/content.ts";

test("draft inventory preserves active drafts, reads packages and rejects outside symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "content-index-"));
  try {
    mkdirSync(join(dir, "workspace/tasks/T"), { recursive: true });
    const content = "😀".repeat(101);
    writeFileSync(
      join(dir, "workspace/tasks/T/xiaohongshu.json"),
      JSON.stringify({ title: "通知栏单条记事", content }),
    );
    writeFileSync(join(dir, "private.json"), JSON.stringify({ title: "secret", content: "private" }));
    symlinkSync(join(dir, "private.json"), join(dir, "workspace/tasks/T/private.json"));
    const plans: any[] = [
      {
        id: "draft",
        task: "T",
        title: "计划名",
        kind: "content",
        owner: "growth",
        operation: "package",
        status: "delivered",
      },
      { id: "closed", task: "T", kind: "content", owner: "growth", status: "closed" },
      {
        id: "making",
        task: "M",
        title: "在制稿",
        kind: "content",
        owner: "growth",
        operation: "write",
        status: "working",
      },
      { id: "outside", task: "O", title: "需补正文", kind: "content", owner: "growth", status: "blocked" },
      { id: "data", task: "D", kind: "content", owner: "growth", operation: "data", status: "delivered" },
    ];
    const tasks: any[] = [
      { id: "T", reports: [{ role: "growth", artifacts: ["tasks/T/xiaohongshu.json"] }] },
      { id: "O", reports: [{ role: "growth", artifacts: ["tasks/T/private.json", "../private.json"] }] },
    ];
    const data = draftSummaries(dir, plans, tasks);
    assert.deepEqual(
      data.map((d) => d.plan),
      ["draft", "making", "outside"],
    );
    assert.equal(data[0].title, "通知栏单条记事");
    assert.equal(data[0].excerpt, "😀".repeat(100));
    assert.equal(data[1].title, "在制稿");
    assert.equal(data[2].excerpt, "");
    assert.ok(!JSON.stringify(data).includes("secret"));
    assert.equal(contentSummary(JSON.stringify({ title: "已发", content })).excerpt, "😀".repeat(100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
