// Failure modes: a web page exposes owner keys, another origin can approve a task, offline data looks live,
// or an artifact path escapes the workspace. The fake hub records only explicit browser actions.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Company } from "../plugins/company/company.ts";
import { initialize } from "../plugins/company/setup.ts";
import { startDashboard } from "../cli/company-dashboard.ts";

test("dashboard protects mutations, keeps keys server-side, handles offline state and confines artifact reads", async () => {
  const temp = mkdtempSync(join(tmpdir(), "company-dashboard-"));
  const dir = join(temp, "office");
  initialize(dir);
  mkdirSync(join(dir, "hub"));
  const requests: { url: string; body: any }[] = [];
  const hub = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    assert.equal(req.headers.authorization, req.url === "/v1/events" ? "Bearer source-secret" : "Bearer owner-secret");
    requests.push({ url: req.url!, body });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/state"
          ? {
              cards: [{ id: 7, kind: "ask", title: "验收", options: ["接受", "退回"], link: "secret-link" }],
              spending: { today: { rounds: 0, cost: 0, missingCost: 0 } },
              agents: [],
              runs: [],
            }
          : { routed: ["公司调度"], ok: true },
      ),
    );
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  const port = (hub.address() as { port: number }).port;
  writeFileSync(
    join(dir, "hub/config.json"),
    JSON.stringify({ url: `http://127.0.0.1:${port}`, owner: "owner-secret", source: { key: "source-secret" } }),
  );
  const office = new Company({ name: "Test", database: join(dir, "company.db"), maxAssignments: 6 });
  office.process({
    events: [
      {
        id: 1,
        source: "company-inbox",
        type: "company.task.create",
        subject: "T1",
        detail: JSON.stringify({ title: "测试", kind: "content", goal: "测试交付", acceptance: ["有证据"] }),
      },
    ],
    answers: [],
  });
  mkdirSync(join(dir, "workspace/tasks/T1"), { recursive: true });
  writeFileSync(join(dir, "workspace/tasks/T1/draft.md"), "测试正文 <script>bad()</script>");
  office.process({
    events: [
      {
        id: 2,
        source: "company-growth",
        type: "company.result",
        subject: "T1",
        detail: JSON.stringify({
          assignment: 1,
          verdict: "pass",
          summary: "草稿",
          artifacts: ["tasks/T1/draft.md", "tasks/T1/escape.txt"],
          evidence: ["已核对"],
        }),
      },
    ],
    answers: [],
  });
  writeFileSync(join(temp, "secret.txt"), "never expose");
  symlinkSync(join(temp, "secret.txt"), join(dir, "workspace/tasks/T1/escape.txt"));
  office.close();
  const dashboard = await startDashboard(dir, 0);
  try {
    const root = await fetch(dashboard.url);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const overview = await (await fetch(dashboard.url + "/api/overview")).text();
    assert.match(overview, /测试/);
    assert.doesNotMatch(overview, /owner-secret|source-secret|secret-link|company:T1/);
    const denied = await fetch(dashboard.url + "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    const { csrf } = await (await fetch(dashboard.url + "/api/session")).json();
    const headers = { "Content-Type": "application/json", Origin: dashboard.url, "X-Company-CSRF": csrf };
    const task = { id: "T2", title: "新需求", kind: "software", goal: "制作工具", acceptance: ["可运行"] };
    assert.equal(
      (await fetch(dashboard.url + "/api/tasks", { method: "POST", headers, body: JSON.stringify(task) })).status,
      200,
    );
    assert.equal(requests.at(-1)?.body.subject, "T2");
    const generated = await fetch(dashboard.url + "/api/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...task, id: undefined }),
    });
    assert.equal(generated.status, 200);
    assert.match(requests.at(-1)?.body.subject, /^TASK-[a-f0-9]{32}$/);
    assert.equal(
      (await fetch(dashboard.url + "/api/cards/7/answer", { method: "POST", headers, body: '{"choice":0}' })).status,
      200,
    );
    assert.equal(requests.at(-1)?.url, "/v1/cards/7/answer");
    assert.equal((await fetch(dashboard.url + "/api/tasks/T1/artifact?path=tasks%2FT1%2Fdraft.md")).status, 200);
    assert.equal((await fetch(dashboard.url + "/api/tasks/T1/artifact?path=tasks%2FT1%2Fescape.txt")).status, 403);
    assert.equal((await fetch(dashboard.url + "/api/tasks/T1/artifact?path=../../secret.txt")).status, 403);
    await new Promise<void>((r) => hub.close(() => r()));
    const offline = await (await fetch(dashboard.url + "/api/overview")).json();
    assert.equal(offline.connected, false);
    assert.equal(offline.tasks.length, 1);
    assert.equal(
      (await fetch(dashboard.url + "/api/tasks", { method: "POST", headers, body: JSON.stringify(task) })).status,
      503,
    );
  } finally {
    await dashboard.close();
    hub.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
