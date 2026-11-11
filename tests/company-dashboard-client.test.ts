// Failure modes: opening home downloads history, cached approvals become actionable before reconnecting,
// 304 parses an empty body, hidden tabs poll, view revisits lose cache, or approval buttons and draft previews stop working.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const overview = () => ({
  name: "测试公司",
  maxAssignments: 6,
  connected: true,
  tasks: [],
  taskStats: { total: 123 },
  businesses: [],
  agents: [],
  runs: [],
  spending: null,
  home: { operations: [], leadership: { enabled: true }, publications: [], stock: {} },
  cards: [
    {
      id: 7,
      kind: "ask",
      title: "确认发布",
      text: "APP：测试\n标题：标题\n正文：完整正文\n图片数：1\n发布稿件：" + "a".repeat(32),
      options: ["确认", "退回"],
    },
  ],
});
async function browser(storage = true) {
  const nodes = new Map<string, any>();
  const events = new Map<string, Function>();
  const calls: { path: string; options: any }[] = [];
  const intervals: { fn: Function; ms: number }[] = [];
  const replies = new Map<string, any>();
  const waits = new Map<string, (value: any) => void>();
  const storageWrites: string[] = [];
  const cached = { value: { ...overview(), at: "2026-01-01T00:00:00Z" }, etag: '"home"' };
  const node = (key: string) => {
    if (!nodes.has(key))
      nodes.set(key, {
        id: key.slice(1),
        value: "",
        innerHTML: "",
        textContent: "",
        classList: { toggle() {} },
        addEventListener: (name: string, fn: Function) => events.set(key + ":" + name, fn),
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return nodes.get(key);
  };
  const document = {
    hidden: false,
    body: { dataset: {} },
    activeElement: null,
    querySelector: (q: string) => (q === "dialog[open]" ? null : node(q)),
    querySelectorAll: () => [],
    addEventListener: (name: string, fn: Function) => events.set("document:" + name, fn),
  };
  const location = { href: "https://company.example.test/", hash: "#home" };
  const clock = { now: Date.now() };
  class ClockDate extends Date {
    static now() {
      return clock.now;
    }
  }
  const fetch = async (url: URL, options: any) => {
    const path = url.pathname + url.search;
    calls.push({ path, options });
    if (waits.has(path)) return await new Promise((resolve) => waits.set(path, resolve));
    if (replies.has(path)) return replies.get(path)(options);
    if (path === "/api/session") return Response.json({ csrf: "test-session", remote: true });
    if (path === "/api/overview")
      return options.headers["If-None-Match"]
        ? new Response(null, { status: 304 })
        : Response.json(overview(), { headers: { ETag: '"home"' } });
    if (path === "/api/leadership")
      return Response.json({
        leadership: { enabled: true, briefs: {}, issues: [], decisions: [], knowledge: [] },
        nextBefore: null,
      });
    if (path === "/api/operations") return Response.json({ operations: [], tasks: [] });
    if (path === "/api/runs")
      return Response.json({ runs: [{ id: 1, state: "done", summary: "执行结果" }], nextBefore: null });
    if (path === "/api/tasks")
      return Response.json(
        { tasks: [{ id: "T2", title: "第二项", status: "active", kind: "content", stage: 0 }], nextBefore: 2 },
        { headers: { ETag: '"tasks"' } },
      );
    if (path === "/api/tasks?before=2")
      return Response.json({
        tasks: [{ id: "T1", title: "第一项", status: "completed", kind: "content", stage: 1 }],
        nextBefore: null,
      });
    if (path.startsWith("/api/publications/"))
      return Response.json({ title: "全文标题", content: "完整正文 <script>bad</script>", images: 1 });
    return Response.json({ ok: true });
  };
  const context = {
    document,
    location,
    window: { addEventListener: (name: string, fn: Function) => events.set("window:" + name, fn) },
    localStorage: {
      getItem() {
        if (!storage) throw Error("disabled");
        return JSON.stringify(cached);
      },
      setItem(_k: string, value: string) {
        if (!storage) throw Error("full");
        storageWrites.push(value);
      },
    },
    fetch,
    URL,
    Response,
    AbortSignal,
    Date: ClockDate,
    setInterval: (fn: Function, ms: number) => intervals.push({ fn, ms }),
    setTimeout: () => 1,
    clearTimeout() {},
    crypto: { randomUUID: () => "test" },
  };
  waits.set("/api/overview", () => {});
  const html = readFileSync(new URL("../plugins/company/dashboard/index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script defer src="\.\/([^\"]+)"/g)]
    .map((m) => readFileSync(new URL("../plugins/company/dashboard/" + m[1], import.meta.url), "utf8"))
    .join("\n");
  const app = runInNewContext(scripts + ";({data, api, enterView, loadDetail, refresh, openDraft})", context);
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
  };
  await flush();
  return {
    app,
    nodes,
    node,
    events,
    calls,
    intervals,
    replies,
    waits,
    location,
    document,
    clock,
    storageWrites,
    flush,
  };
}

test("cached home paints before the network, refreshes conditionally and pauses while hidden", async () => {
  const b = await browser();
  assert.match(b.node("#view-content").innerHTML, /确认发布/);
  assert.match(b.node("#view-content").innerHTML, /更新中/);
  assert.match(b.node("#view-content").innerHTML, /data-answer="7"[^>]*disabled/);
  assert.deepEqual(b.calls.map((r) => r.path).sort(), ["/api/overview", "/api/session"]);
  b.waits.get("/api/overview")!(new Response(null, { status: 304 }));
  b.waits.delete("/api/overview");
  await b.flush();
  assert.match(b.node("#view-content").innerHTML, /查看全文和配图/);
  assert.doesNotMatch(b.node("#view-content").innerHTML, /data-answer="7"[^>]*disabled/);
  assert.equal(b.storageWrites.length, 1);
  const count = b.calls.length;
  b.clock.now += 29999;
  b.intervals[0].fn();
  await b.flush();
  assert.equal(b.calls.length, count);
  b.clock.now += 1;
  b.intervals[0].fn();
  await b.flush();
  assert.equal(b.calls.length, count + 1);
  b.document.hidden = true;
  b.clock.now += 60000;
  b.intervals[0].fn();
  await b.flush();
  assert.equal(b.calls.length, count + 1);
  b.document.hidden = false;
  b.events.get("document:visibilitychange")!();
  await b.flush();
  assert.equal(b.calls.length, count + 2);
  assert.equal(b.calls.at(-1)!.options.headers["If-None-Match"], '"home"');
  await b.app.openDraft("a".repeat(32));
  assert.equal(b.node("#draft-dialog").open, true);
  assert.match(b.node("#draft-content").innerHTML, /完整正文 &lt;script&gt;/);
  assert.match(b.node("#draft-content").innerHTML, /\/image\/0/);
  const button: any = { disabled: false, dataset: { answer: "7", choice: "1" } };
  b.replies.set("/api/overview", () =>
    Response.json({ ...overview(), cards: [] }, { headers: { ETag: '"answered"' } }),
  );
  b.events.get("document:click")!({ target: { closest: () => button } });
  await b.flush();
  const answer = b.calls.find((r) => r.path === "/api/cards/7/answer");
  assert.equal(answer?.options.body, '{"choice":1}');
  assert.equal(answer?.options.headers["X-Company-CSRF"], "test-session");
  assert.equal(b.app.data().cards.length, 0);
});

test("detail views load on entry, paginate, paint cached rows during refresh and do not poll", async () => {
  const b = await browser(false);
  b.waits.get("/api/overview")!(Response.json(overview(), { headers: { ETag: '"home"' } }));
  b.waits.delete("/api/overview");
  await b.flush();
  assert.match(b.node("#view-content").innerHTML, /确认发布/);
  b.location.hash = "#tasks";
  await b.app.enterView();
  assert.match(b.node("#view-content").innerHTML, /第二项/);
  assert.match(b.node("#view-content").innerHTML, /加载更早/);
  await b.app.loadDetail("tasks", true);
  assert.equal(b.app.data().tasks.length, 2);
  b.location.hash = "#home";
  await b.app.enterView();
  const count = b.calls.length;
  b.waits.set("/api/tasks", () => {});
  b.location.hash = "#tasks";
  const entering = b.app.enterView();
  assert.match(b.node("#view-content").innerHTML, /第一项/);
  b.waits.get("/api/tasks")!(new Response(null, { status: 304 }));
  b.waits.delete("/api/tasks");
  await entering;
  assert.equal(b.app.data().tasks.length, 2);
  assert.equal(b.calls.length, count + 1);
  b.clock.now += 60000;
  b.intervals[0].fn();
  await b.flush();
  assert.equal(b.calls.length, count + 1);
});

test("each management view requests only its resource and approvals retain draft preview", async () => {
  const b = await browser();
  b.waits.get("/api/overview")!(new Response(null, { status: 304 }));
  b.waits.delete("/api/overview");
  await b.flush();
  for (const [view, endpoint, text] of [
    ["ceo", "leadership", "管理状态"],
    ["plans", "operations", "项目"],
    ["employees", "operations", "项目"],
    ["spending", "runs", "执行结果"],
  ]) {
    const count = b.calls.length;
    b.location.hash = "#" + view;
    await b.app.enterView();
    assert.deepEqual(
      b.calls.slice(count).map((r) => r.path),
      ["/api/" + endpoint],
    );
    assert.match(b.node("#view-content").innerHTML, new RegExp(text));
  }
  b.location.hash = "#approvals";
  await b.app.enterView();
  assert.match(b.node("#view-content").innerHTML, /查看全文和配图/);
  assert.match(b.node("#view-content").innerHTML, /data-choice="1"/);
});

test("home shows unresolved anomalies with escaped evidence and no approval controls", async () => {
  const b = await browser();
  const data = overview();
  Object.assign(data.home, {
    anomalies: [
      {
        id: "a",
        title: "<script>异常</script>",
        impact: "任务停止",
        evidence: "<img src=x onerror=alert(1)>",
        suggestion: "交CEO处理",
      },
    ],
  });
  b.waits.get("/api/overview")!(Response.json(data));
  b.waits.delete("/api/overview");
  await b.flush();
  const html = b.node("#view-content").innerHTML;
  assert.match(html, /未解决异常/);
  assert.match(html, /&lt;script&gt;异常/);
  assert.doesNotMatch(html, /<script>异常|<img src=x/);
  assert.match(html, /交CEO处理/);
});

test("employee notes and weekly report stay read-only and escape embedded markup", async () => {
  const b = await browser(false);
  const d = overview() as any;
  d.home.weeklyReport = { date: "2026-11-13", report: "周报<script>bad</script>" };
  b.waits.get("/api/overview")!(Response.json(d));
  b.waits.delete("/api/overview");
  await b.flush();
  assert.match(b.node("#view-content").innerHTML, /周报&lt;script&gt;bad&lt;\/script&gt;/);
  b.replies.set("/api/operations", () =>
    Response.json({
      ceoNotes: { text: "管理经验<script>bad</script>" },
      operations: [
        {
          business: "app",
          name: "应用",
          owner: "growth",
          status: "active",
          staff: [
            {
              role: "growth",
              duty: "运营",
              checks: [],
              enabled: true,
              notes: { text: "标题要具体<img src=x>", omitted: 2 },
            },
          ],
        },
      ],
      tasks: [],
    }),
  );
  b.location.hash = "#employees";
  await b.app.enterView();
  const html = b.node("#view-content").innerHTML;
  assert.match(html, /管理经验&lt;script&gt;/);
  assert.match(html, /标题要具体&lt;img src=x&gt;/);
  assert.match(html, /2 条原始事实待周五整理/);
  assert.doesNotMatch(html, /<textarea[^>]*notes|<script>bad/);
});

test("disabled departments and employees have no status or quota placeholders", async () => {
  const b = await browser();
  const d = { ...overview(), activeRoles: ["growth"] };
  b.waits.get("/api/overview")!(Response.json(d));
  b.waits.delete("/api/overview");
  await b.flush();
  b.location.hash = "#departments";
  await b.app.enterView();
  assert.match(b.node("#view-content").innerHTML, /data-department="growth"/);
  assert.doesNotMatch(
    b.node("#view-content").innerHTML,
    /data-department="(?:engineering|qa|finance|support|product)"|6 个部门/,
  );
  b.replies.set("/api/operations", () =>
    Response.json({
      operations: [
        {
          business: "app",
          name: "应用",
          owner: "growth",
          status: "active",
          staff: [
            { role: "growth", enabled: true, onDuty: true, checks: [] },
            { role: "qa", enabled: false, onDuty: false, checks: [], duty: "闲置验收占位" },
          ],
        },
      ],
      tasks: [],
    }),
  );
  b.location.hash = "#employees";
  await b.app.enterView();
  assert.doesNotMatch(b.node("#view-content").innerHTML, /闲置验收占位|data-employee="qa"/);
});
