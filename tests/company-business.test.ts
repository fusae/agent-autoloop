// Failure modes: recurring work duplicates after replay/restart, stacks behind unfinished work,
// ignores pause, mixes business data, or invents results without measured metrics.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Businesses } from "../plugins/company/business.ts";

test("business cycles replay exactly, respect pause and outstanding work, and retain measured metrics", () => {
  const dir = mkdtempSync(join(tmpdir(), "business-"));
  let store = new Businesses(dir);
  const now = new Date("2026-11-04T02:00:00Z");
  const input = {
    name: "APP A",
    description: "提醒事项",
    audience: "容易忘事的人",
    objective: "提高首次创建提醒的人数",
    url: "https://example.com",
    stage: "operating",
  };
  try {
    const a = store.save({ ...input, id: "app-a" }, now);
    store.save({ ...input, name: "APP B", id: "app-b" }, now);
    assert.equal(a.status, "draft");
    assert.deepEqual(store.plan("tick-0", [], now), {});
    store.status("app-a", "active", now);
    const receipt = store.plan("tick-1", [], now);
    assert.equal(receipt.events?.length, 3);
    assert.ok(receipt.events?.every((e) => e.detail.includes("knowledge/businesses/app-a.json")));
    const ids = receipt.events!.map((e) => e.subject);
    assert.equal(new Set(ids).size, 3);
    store.close();
    store = new Businesses(dir);
    assert.deepEqual(store.plan("tick-1", [], now), receipt);
    assert.deepEqual(store.plan("tick-2", [], new Date("2026-11-05T02:00:00Z")), {});
    const tasks = ids.map((id) => ({ id, status: "completed" }));
    assert.equal(store.plan("tick-3", tasks, new Date("2026-11-05T02:00:00Z")).events?.length, 2);
    store.status("app-a", "paused", now);
    assert.deepEqual(store.plan("tick-4", tasks, new Date("2026-11-06T02:00:00Z")), {});
    const before = store.list()[0];
    assert.equal(before.metrics.length, 0);
    store.metric(
      "app-a",
      { date: "2026-11-04", newUsers: 12, activeUsers: null, revenue: 0, source: "后台人工核对", note: "小红书试验" },
      now,
    );
    store.metric(
      "app-a",
      { date: "2026-11-04", newUsers: 13, activeUsers: null, revenue: 0, source: "后台校正", note: "" },
      now,
    );
    const measured = store.list().find((x) => x.id === "app-a")!;
    assert.equal(measured.metrics.length, 1);
    assert.equal(measured.metrics[0].newUsers, 13);
    assert.equal(measured.metrics[0].activeUsers, null);
    assert.equal(store.list().find((x) => x.id === "app-b")!.metrics.length, 0);
    assert.throws(() => store.metric("app-a", { date: "2026-02-30", newUsers: 1, source: "后台" }, now));
    assert.throws(() => store.save({ ...input, id: "../escape" }, now));
    assert.throws(() => store.save({ ...input, id: "app-a", url: "javascript:alert(1)" }, now));
    const profile = JSON.parse(readFileSync(join(dir, "workspace/knowledge/businesses/app-a.json"), "utf8"));
    assert.equal(profile.business.name, "APP A");
    assert.equal(profile.metrics[0].newUsers, 13);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large portfolios stay within receipt event limits and pick up remaining businesses later", () => {
  const dir = mkdtempSync(join(tmpdir(), "business-cap-"));
  const store = new Businesses(dir);
  const now = new Date("2026-11-04T02:00:00Z");
  try {
    for (let i = 0; i < 34; i++) {
      const id = "app-" + String(i).padStart(2, "0");
      store.save(
        { id, name: "测试业务", description: "测试", audience: "测试", objective: "测试", stage: "operating" },
        now,
      );
      store.status(id, "active", now);
    }
    assert.equal(store.plan("batch-1", [], now).events?.length, 100);
    assert.equal(store.plan("batch-2", [], now).events?.length, 2);
    assert.deepEqual(store.plan("batch-3", [], now), {});
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
