// Failure modes: a web page exposes owner keys, another origin can approve a task, offline data looks live,
// an artifact path escapes the workspace, frozen drafts lose content or serve unsafe image types,
// or manual posts inflate staff totals or inject markup. The fake hub records only explicit browser actions.
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { Company } from "../plugins/company/company.ts";
import { initialize } from "../plugins/company/setup.ts";
import { startDashboard } from "../cli/company-dashboard.ts";

test("frozen publications expose full drafts and image bytes but reject invalid keys and unsafe MIME types", async () => {
  const temp = mkdtempSync(join(tmpdir(), "company-draft-"));
  const dir = join(temp, "office");
  initialize(dir);
  mkdirSync(join(dir, "hub"));
  mkdirSync(join(dir, "publications"));
  writeFileSync(
    join(dir, "hub/config.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", owner: "test", source: { key: "test" } }),
  );
  const key = "a".repeat(32);
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=",
    "base64",
  );
  const content = "第一段完整正文。\n\n第二段 <script>原样保留的资料</script>。";
  writeFileSync(
    join(dir, "publications", `${key}.json`),
    JSON.stringify({
      business: "test-app",
      artifacts: [
        {
          path: "tasks/draft/xiaohongshu.json",
          content: JSON.stringify({
            title: "冻结稿标题",
            content,
            images: ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "text/html", "image/gif"].map(
              (mime) => ({
                mime,
                base64: bytes.toString("base64"),
              }),
            ),
          }),
        },
      ],
    }),
  );
  const dashboard = await startDashboard(dir, 0);
  try {
    const endpoint = `${dashboard.url}/api/publications/${key}`;
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { key, business: "test-app", title: "冻结稿标题", content, images: 6 });
    for (const [index, mime] of ["image/png", "image/jpeg", "image/webp"].entries()) {
      const image = await fetch(`${endpoint}/image/${index}`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("content-type"), mime);
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    }
    for (const index of [3, 4, 5, 6]) assert.equal((await fetch(`${endpoint}/image/${index}`)).status, 404);
    for (const invalid of ["bad-key", "g".repeat(32), "a".repeat(31), "a".repeat(33), "b".repeat(32)]) {
      for (const suffix of ["", "/image/0"]) {
        assert.equal((await fetch(`${dashboard.url}/api/publications/${invalid}${suffix}`)).status, 404);
      }
    }
  } finally {
    await dashboard.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

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
    const business = await fetch(dashboard.url + "/api/businesses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "app-a",
        name: "APP A",
        description: "提醒工具",
        audience: "忙碌的人",
        objective: "提升首次使用",
        stage: "operating",
      }),
    });
    assert.equal(business.status, 200);
    assert.equal((await business.json()).status, "draft");
    const businessView = await (await fetch(dashboard.url + "/api/overview")).json();
    assert.equal(businessView.businesses[0].name, "APP A");
    assert.equal(businessView.businesses[0].metrics.length, 0);
    for (const [endpoint, data] of [
      ["autonomy", { enabled: true }],
      ["employee", { role: "growth", duty: "维护渠道和激活", cadence: "weekly", enabled: true }],
      ["signal", { title: "入口问题", detail: "用户找不到入口", source: "人工整理", role: "support" }],
      ["settings", { maxDailyTasks: 8, maxActive: 2 }],
    ] as const) {
      assert.equal(
        (
          await fetch(dashboard.url + "/api/businesses/app-a/" + endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(data),
          })
        ).status,
        200,
      );
    }
    const managed = {
      ...(await (await fetch(dashboard.url + "/api/overview")).json()),
      ...(await (await fetch(dashboard.url + "/api/operations")).json()),
    };
    assert.equal(managed.operations[0].staff.length, 6);
    assert.equal(managed.operations[0].maxDailyTasks, 8);
    assert.equal(managed.operations[0].signals[0].title, "入口问题");
    assert.equal(managed.businesses[0].autonomy, true);
    assert.equal(managed.businesses[0].status, "draft");
    assert.equal(
      (
        await fetch(dashboard.url + "/api/businesses/app-a/employee", {
          method: "POST",
          headers,
          body: JSON.stringify({ role: "root", enabled: true }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(dashboard.url + "/api/businesses/missing/signal", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "bad", detail: "bad", source: "bad" }),
        })
      ).status,
      400,
    );
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

// An authenticated reverse proxy must not turn arbitrary forwarded origins into authority.
test("a configured HTTPS origin supports a protected proxy without weakening CSRF or local defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-proxy-"));
  initialize(dir + "/office");
  mkdirSync(join(dir, "office/hub"));
  writeFileSync(
    join(dir, "office/hub/config.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", owner: "test", source: { key: "test" } }),
  );
  const dashboard = await startDashboard(dir + "/office", 0, { publicOrigin: "https://company.example.com" });
  try {
    const html = await (await fetch(dashboard.url)).text();
    const navigation = await new Promise<number>((resolve, reject) => {
      get(dashboard.url, { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" } }, (r) => {
        r.resume();
        resolve(r.statusCode!);
      }).on("error", reject);
    });
    assert.equal(navigation, 200);
    assert.equal(
      (await fetch(dashboard.url + "/api/session", { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
      403,
    );
    assert.match(html, /href="\.\/style.css"/);
    const { csrf } = await (await fetch(dashboard.url + "/api/session")).json();
    for (const [origin, token, status] of [
      ["https://company.example.com", csrf, 200],
      ["https://evil.example.com", csrf, 403],
      ["https://company.example.com", "wrong", 403],
    ]) {
      const r = await fetch(dashboard.url + "/api/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, "X-Company-CSRF": token },
        body: JSON.stringify({
          id: "proxy-test",
          name: "测试",
          description: "提醒",
          audience: "测试",
          objective: "测试",
          stage: "operating",
        }),
      });
      assert.equal(r.status, status);
    }
    const wrongHost = await new Promise<number>((resolve, reject) => {
      get(dashboard.url + "/api/session", { headers: { Host: "evil.example.com" } }, (r) => {
        r.resume();
        resolve(r.statusCode!);
      }).on("error", reject);
    });
    assert.equal(wrongHost, 403);
  } finally {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("home distinguishes manual posts, escapes their fields and accepts old feedback", () => {
  const home = runInNewContext(
    readFileSync(new URL("../plugins/company/dashboard/home.js", import.meta.url), "utf8") +
      ";({homeSummary, homePosts, homeGoal})",
    {
      esc: (s: unknown) =>
        String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;"),
      planNames: {},
    },
  );
  const d: any = {
    at: "2026-11-08T03:00:00Z",
    home: {
      publications: [{}],
      feedback: {
        posts: [
          {
            publishedAt: "2026-11-07T02:00:00Z",
            samples: [{ title: "系统稿", likes: 2 }],
          },
        ],
      },
    },
  };
  assert.doesNotMatch(home.homePosts(d), /你自己发的/);
  assert.doesNotMatch(home.homeSummary(d, [], [], {}), /另有/);
  d.home.feedback.manual = [
    {
      title: '<img src=x onerror="bad()">',
      url: 'https://www.xiaohongshu.com/explore/test?x="y"',
      firstSeen: d.at,
      samples: [{ likes: 3 }, { likes: null }],
    },
  ];
  const html = home.homePosts(d);
  assert.match(html, /系统发布/);
  assert.match(html, /<h3 class="sub-head">你自己发的<\/h3><ul class="queue">/);
  assert.match(html, /首次看到 11\/8/);
  assert.match(html, /点赞 —/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.match(
    html,
    /href="https:\/\/www.xiaohongshu.com\/explore\/test\?x=&quot;y&quot;" target="_blank" rel="noopener noreferrer"/,
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(home.homeSummary(d, [], [], {}), /已发 1 篇帖子（另有你自己发的 1 篇）/);
  assert.match(home.homeGoal({ target: 4, published: 1, ready: 2 }), /已发 1，备稿 2，目标 4 篇/);
  d.home.publications = [];
  assert.match(home.homeSummary(d, [], [], {}), /已发 0 篇帖子（另有你自己发的 1 篇）/);
});
