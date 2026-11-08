// Failure modes: history bloats the home payload, pagination skips or duplicates work after insertion,
// validators accept malformed cursors, caching loses approval details, or unchanged data still sends a body.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { initialize } from "../plugins/company/setup.ts";
import { Company } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";
import { startDashboard } from "../cli/company-dashboard.ts";

test("dashboard serves compact home, stable cursor pages and conditional reads behind the same access checks", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dashboard-loading-"));
  const dir = join(temp, "office");
  initialize(dir);
  mkdirSync(join(dir, "hub"));
  const config = JSON.parse(readFileSync(join(dir, "company.json"), "utf8"));
  const office = new Company(config);
  const add = (id: number) =>
    office.process({
      events: [
        {
          id,
          source: "company-inbox",
          type: "company.task.create",
          subject: `T${id}`,
          detail: JSON.stringify({ title: `任务 ${id}`, kind: "content", goal: "完整目标", acceptance: ["完整标准"] }),
        },
      ],
      answers: [],
    });
  for (let i = 1; i <= 123; i++) add(i);
  const businesses = new Businesses(dir);
  businesses.save({
    id: "sample",
    name: "示例",
    description: "示例",
    audience: "示例",
    objective: "示例",
    stage: "operating",
  });
  businesses.close();
  const ops = new Operations(dir);
  const chief = ops.leadership(true);
  ops.close();
  const db = new DatabaseSync(join(dir, "operations.db"));
  chief.decisions = Array.from({ length: 123 }, (_, i) => ({
    task: `T${i + 1}`,
    at: "2026-01-01T00:00:00Z",
    summary: `决定 ${i}`,
    decision: { report: "不应下载".repeat(1000) } as any,
  }));
  chief.issues = Array.from({ length: 73 }, (_, i) => ({
    id: `I${i}`,
    business: "sample",
    role: "growth",
    task: null,
    question: `问题 ${i}`,
    context: "资料",
    state: "open",
    answer: null,
    at: "2026-01-01T00:00:00Z",
  }));
  chief.knowledge = Array.from({ length: 53 }, (_, i) => ({
    id: `K${i}`,
    business: "sample",
    issue: `I${i}`,
    answer: `答案 ${i}`,
    evidence: "依据",
    source: "ceo",
    at: "2026-01-01T00:00:00Z",
  }));
  db.prepare("UPDATE leadership SET body=? WHERE id='company'").run(JSON.stringify(chief));
  db.close();
  const key = "a".repeat(32);
  const cards = [
    {
      id: 7,
      kind: "ask",
      title: "发布确认",
      text: `APP：示例\n标题：正文标题\n正文：完整正文\n图片数：1\n发布稿件：${key}`,
      options: ["确认", "退回"],
    },
  ];
  const allRuns = Array.from({ length: 123 }, (_, i) => ({
    id: 123 - i,
    agent: "company-ceo",
    state: "done",
    summary: `结果 ${123 - i}`,
    createdAt: "2026-01-01T00:00:00Z",
  }));
  const hub = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-owner");
    const before = Number(new URL(req.url!, "http://local").searchParams.get("before")) || Infinity;
    const remaining = allRuns.filter((r) => r.id < before);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        cards,
        channels: [],
        agents: [],
        spending: null,
        runs: remaining.slice(0, 60),
        nextBefore: remaining.length > 60 ? remaining[59].id : null,
      }),
    );
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  writeFileSync(
    join(dir, "hub/config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(hub.address() as any).port}`,
      owner: "test-owner",
      source: { key: "test-source" },
    }),
  );
  const dashboard = await startDashboard(dir, 0);
  const get = (path: string, headers = {}) => fetch(dashboard.url + path, { headers });
  const originalTasks = Company.prototype.tasks,
    originalExecutive = Operations.prototype.executive;
  try {
    let taskReads = 0,
      chiefReads = 0;
    Company.prototype.tasks = function () {
      taskReads++;
      return originalTasks.call(this);
    };
    Operations.prototype.executive = function () {
      chiefReads++;
      return originalExecutive.call(this);
    };
    const response = await get("/api/overview");
    const raw = await response.text();
    const overview = JSON.parse(raw);
    assert.equal(taskReads, 1);
    assert.equal(chiefReads, 1);
    assert.ok(gzipSync(raw, { level: 1 }).length <= 40000);
    assert.equal(overview.taskStats.total, 123);
    assert.equal(overview.tasks.length, 6);
    assert.equal(overview.leadership, undefined);
    assert.equal(overview.operations, undefined);
    assert.equal(overview.home.leadership.openIssues, 73);
    assert.deepEqual(overview.cards, cards);
    assert.doesNotMatch(raw, /不应下载|完整目标|test-owner|test-source/);
    const unchanged = await get("/api/overview", { "If-None-Match": `W/${response.headers.get("etag")}` });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
    cards[0].options.push("稍后");
    const changed = await get("/api/overview", { "If-None-Match": response.headers.get("etag")! });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), response.headers.get("etag"));
    for (const endpoint of ["tasks", "leadership", "operations", "runs", "tasks/T1"]) {
      const r = await get(`/api/${endpoint}`);
      assert.equal(r.status, 200, endpoint);
      assert.ok(r.headers.get("etag"));
      await r.text();
      const same = await get(`/api/${endpoint}`, { "If-None-Match": '"other", ' + r.headers.get("etag") });
      assert.equal(same.status, 304, endpoint);
      assert.equal(await same.text(), "");
      assert.equal((await get(`/api/${endpoint}`, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    }
    const first = await (await get("/api/tasks?limit=50")).json();
    assert.equal(first.tasks.length, 50);
    assert.equal(first.tasks[0].id, "T123");
    assert.equal(first.tasks[0].goal, undefined);
    assert.equal(first.tasks[0].reports, undefined);
    add(124);
    const ids = first.tasks.map((t: any) => t.id);
    let before = first.nextBefore;
    while (before !== null) {
      const page = await (await get(`/api/tasks?limit=50&before=${before}`)).json();
      ids.push(...page.tasks.map((t: any) => t.id));
      before = page.nextBefore;
    }
    assert.equal(ids.length, 123);
    assert.equal(new Set(ids).size, 123);
    const task = await (await get("/api/tasks/T1")).json();
    assert.equal(task.task.goal, "完整目标");
    assert.equal(task.history.length, 1);
    assert.equal(task.task.approval, undefined);
    assert.equal(task.history[0].task.approval, undefined);
    const runIds: number[] = [];
    before = null;
    do {
      const page = await (await get("/api/runs?limit=50" + (before ? `&before=${before}` : ""))).json();
      runIds.push(...page.runs.map((r: any) => r.id));
      before = page.nextBefore;
    } while (before !== null);
    assert.deepEqual(
      runIds,
      allRuns.map((r) => r.id),
    );
    const totals = { decisions: [], issues: [], knowledge: [] } as Record<string, any[]>;
    before = null;
    do {
      const page = await (await get("/api/leadership?limit=20" + (before ? `&before=${before}` : ""))).json();
      for (const name of Object.keys(totals)) totals[name].push(...page.leadership[name]);
      assert.ok(page.leadership.decisions.every((d: any) => !d.decision));
      before = page.nextBefore;
    } while (before !== null);
    assert.equal(new Set(totals.decisions.map((d) => d.task)).size, 123);
    assert.equal(new Set(totals.issues.map((d) => d.id)).size, 73);
    assert.equal(new Set(totals.knowledge.map((d) => d.id)).size, 53);
    for (const endpoint of ["tasks", "leadership", "runs", "operations"]) {
      for (const query of [
        "limit=0",
        "limit=51",
        "limit=1.5",
        "limit=-1",
        "limit=abc",
        "limit=1&limit=2",
        "before=",
        "before=-1",
        "before=1e3",
        "unknown=1",
      ]) {
        assert.equal((await get(`/api/${endpoint}?${query}`)).status, 400, `${endpoint}?${query}`);
      }
    }
    for (const cursor of ["999.0.0", "1.2", "1.2.3.4"])
      assert.equal((await get(`/api/leadership?before=${cursor}`)).status, 400);
    assert.equal((await get("/api/tasks/" + "A".repeat(41))).status, 400);
    assert.equal((await get("/api/tasks/not-found")).status, 404);
  } finally {
    Company.prototype.tasks = originalTasks;
    Operations.prototype.executive = originalExecutive;
    office.close();
    await dashboard.close();
    await new Promise<void>((r) => hub.close(() => r()));
    rmSync(temp, { recursive: true, force: true });
  }
});
