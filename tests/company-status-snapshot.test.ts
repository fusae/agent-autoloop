// Prevent credential/identity leakage, source mutations, missing business evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectSnapshot, redact, scanSensitive } from "../cli/company-status-snapshot.ts";

const now = new Date("2026-11-10T12:00:00Z");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  const json = (file: string, data: unknown) => writeFileSync(join(dir, file), JSON.stringify(data));
  for (const name of ["hub", "publications", "workspace/knowledge/sources"])
    mkdirSync(join(dir, name), { recursive: true });
  const db = (file: string, tables: Record<string, any[]>) => {
    const database = new DatabaseSync(join(dir, file));
    for (const [table, rows] of Object.entries(tables)) {
      database.exec(`CREATE TABLE ${table}(body TEXT)`);
      for (const row of rows) database.prepare(`INSERT INTO ${table} VALUES (?)`).run(JSON.stringify(row));
    }
    database.close();
  };
  json("company.json", { activeRoles: ["growth"], dailyModelRuns: { employee: 5, ceo: 10, total: 30 } });
  json("feedback.json", { accountId: "personal_account_123" });
  json("health-heartbeat.json", { at: now.toISOString() });
  const fullReport = "完整日报\n" + "今天完成了工作。".repeat(150);
  db("company.db", {
    tasks: [
      { id: "daily", title: "晚间日报", reports: [{ summary: "摘要", executive: { report: fullReport } }] },
      { id: "draft-task", title: "稿件任务", reports: [{ artifacts: ["draft.json"] }] },
    ],
  });
  db("business.db", {
    businesses: [
      { id: "jinzhao", name: "今朝", status: "active", objective: "验证获客" },
      { id: "jizhu", name: "记住", status: "active" },
    ],
  });
  const key = "a".repeat(32),
    draftKey = "b".repeat(32);
  const project = {
    business: "jinzhao",
    activity: [],
    staff: [
      {
        name: "小林",
        role: "growth",
        enabled: true,
        daily: { focus: "准备稿件", doneWhen: "交CEO审核" },
        weeklyGoal: { week: "2026-11-09", direction: "写好内容", metrics: [{ name: "发布", target: 3, unit: "篇" }] },
      },
    ],
    plans: [
      {
        id: "draft-plan",
        kind: "content",
        task: "draft-task",
        title: "完整稿件标题",
        status: "working",
        publicationKey: draftKey,
      },
      { id: "published-plan", kind: "content", status: "observing", publicationKey: key },
    ],
    topics: [
      { title: "待审选题", state: "pending" },
      { title: "通过选题", state: "approved" },
      { title: "写作选题", state: "approved", plan: "draft-plan" },
      { title: "已发选题", state: "approved", plan: "published-plan" },
    ],
  };
  db("operations.db", {
    projects: [project],
    leadership: [
      {
        enabled: true,
        eveningReports: [{ date: "2026-11-10", task: "daily" }],
        decisions: [{ decision: { deliveries: [{ plan: "draft-plan", verdict: "revise", reason: "补事实依据" }] } }],
        questions: [{ recipient: "chairman", state: "open", question: "本人验证", context: "需要本人操作" }],
        health: { incidents: [{ title: "待修复", evidence: "连接失败", resolvedAt: null }] },
      },
    ],
    maintenance: [
      { title: "修复入口", text: "机器 192.0.2.2，ou_fakeid，account_id=personal_account_123", at: now.toISOString() },
    ],
  });
  json("workspace/draft.json", { title: "完整稿件标题", content: "文".repeat(220) });
  json(`publications/${key}.json`, {
    key,
    business: "jinzhao",
    artifacts: [{ path: "rabbitrun.json", content: JSON.stringify({ title: "已发全文标题", content: "公开正文" }) }],
  });
  json(`publications/${key}-result.json`, {
    key,
    channel: "内部账号",
    publishedAt: "2026-11-09T18:00:00Z",
    url: "https://www.binance.com/zh-CN/square/post/12345",
    x: { state: "pending", at: now.toISOString() },
  });
  json("workspace/knowledge/feedback.json", {
    days: [{ at: now.toISOString(), observation: { state: "ready", account: "personal_account_123" } }],
    posts: [{ key, samples: [{ likes: 12, collects: 3, comments: 2, at: now.toISOString() }] }],
  });
  json("workspace/knowledge/sources/jinzhao.json", {
    database: {
      checkedAt: now.toISOString(),
      data: {
        downloads: { current: { day: "2026-11-10", count: 4 }, daily: { rows: [["2026-11-09", 8]] }, note: "下载点击" },
      },
    },
  });
  const hub = new DatabaseSync(join(dir, "hub/hub.db"));
  hub.exec("CREATE TABLE projections(collection TEXT,key TEXT,data TEXT)");
  const put = (c: string, k: string, v: any) =>
    hub.prepare("INSERT INTO projections VALUES (?,?,?)").run(c, k, JSON.stringify(v));
  put("config", "1", { value: { agents: { "company-ceo": { model: "obsolete-model" } } } });
  put("config", "rules", {
    value: {
      agents: { "company-ceo": { model: "opus" }, "company-growth": { model: "test-model" } },
      channels: { test: { answerers: ["ou_fakeid"] } },
    },
  });
  for (let i = 1; i <= 12; i++)
    put("runs", String(i), {
      id: i,
      agent: "company-ceo",
      state: "done",
      rule: "CEO经营",
      summary: `完成第${i}轮`,
      finished_at: now.toISOString(),
    });
  put("run_events", "12", { run_id: 12, event_id: 1 });
  put("events", "1", { id: 1, subject: "daily" });
  hub.close();
  const budget = new DatabaseSync(join(dir, "model-runs.db"));
  budget.exec("CREATE TABLE journal(id TEXT,kind TEXT,at TEXT,role TEXT)");
  for (const row of [
    ["model:1:1:1", "started", "growth"],
    ["model:1:1:1:employee", "employee-started", "jinzhao:growth"],
    ["model:2:1:1", "started", "growth"],
    ["model:2:1:1:employee", "employee-started", "jinzhao:growth"],
    ["model:2:1:1:refunded", "refunded", "growth"],
  ])
    budget.prepare("INSERT INTO journal VALUES (?,?,?,?)").run(row[0], row[1], now.toISOString(), row[2]);
  budget.close();
  return { dir, fullReport, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("redacts credentials, personal identifiers, IPs and signed/profile links; scanner fails closed", () => {
  const cases = [
    "ghp_" + "z".repeat(36),
    "sk-proj-" + "a".repeat(50),
    "Bearer abcDEF123",
    "eyJabc.def.ghi",
    "ou_abc123",
    "oc_chat123",
    "192.0.2.7",
    "2001:db8::1",
    "::1",
    "api_key=secretvalue",
    "密码：private123",
    "Cookie: session=abc",
    "@private_account",
    "user@example.org",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----",
    "https://www.xiaohongshu.com/user/profile/abcd",
    "https://www.xiaohongshu.com/explore/abcd?xsec_token=private",
  ];
  for (const value of cases) {
    assert.ok(scanSensitive(value).length, value.slice(0, 20));
    assert.deepEqual(scanSensitive(redact(value)), []);
    assert.notEqual(redact(value), value);
  }
  assert.equal(redact("https://x.com/private_user/status/123"), "https://x.com/i/web/status/123");
  const published = "https://www.binance.com/zh-CN/square/post/12345678901234567890";
  assert.equal(redact(published), published);
  assert.deepEqual(scanSensitive(published), []);
  assert.equal(redact("用户 personal_account_123", ["personal_account_123"]), "用户 [已隐藏]");
  assert.deepEqual(redact({ apiKey: "anything", title: "公开标题" }), { title: "公开标题" });
  assert.ok(scanSensitive({ chat_id: "anything" }).length);
});

test("exports real business evidence, full daily report and only 200 draft characters without source writes", () => {
  const f = fixture();
  try {
    const files = ["company.db", "operations.db", "business.db", "model-runs.db", "hub/hub.db"];
    const before = files.map((file) => readFileSync(join(f.dir, file)));
    const s = collectSnapshot(f.dir, now, { company: "active" });
    files.forEach((file, i) => assert.deepEqual(readFileSync(join(f.dir, file)), before[i]));
    assert.equal(s.generatedAt, "2026-11-10T20:00:00.000+08:00");
    assert.equal(s.staff.find((s) => s.name === "小林").todayRounds, 1);
    assert.equal(s.staff[0].model, "opus");
    assert.deepEqual(
      s.businesses[0].topics.map((t: any) => t.status),
      ["待审", "通过", "写作中", "已发"],
    );
    assert.equal(s.drafts[0].title, "完整稿件标题");
    assert.equal([...s.drafts[0].excerpt].length, 200);
    assert.match(s.drafts[0].review, /补事实依据/);
    assert.equal(s.publications.today.length, 1);
    assert.equal(s.publications.today[0].data.likes, 12);
    assert.equal(s.downloads[0].today, 4);
    assert.equal(s.downloads[1].today, null);
    assert.equal(s.dailyReport.text, f.fullReport);
    assert.equal(s.ceoRounds.length, 10);
    assert.equal(s.ceoRounds[0].purpose, "晚间日报");
    assert.equal(s.chairman[0].category, "X待发");
    assert.deepEqual(scanSensitive(s), []);
    assert.ok(!JSON.stringify(s).includes("personal_account_123"));
  } finally {
    f.cleanup();
  }
});

test("artifact symlinks cannot export data outside the workspace", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(join(f.dir, "company.db"));
    db.prepare("UPDATE tasks SET body=? WHERE json_extract(body,'$.id')='draft-task'").run(
      JSON.stringify({ id: "draft-task", reports: [{ artifacts: ["../company.json"] }] }),
    );
    db.close();
    assert.throws(() => collectSnapshot(f.dir, now), /稿件路径越界/);
  } finally {
    f.cleanup();
  }
});

test("redacts known secrets before truncating an excerpt across a credential", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "hub/config.json"), JSON.stringify({ owner: "shortPrivateValue123" }));
    writeFileSync(
      join(f.dir, "workspace/draft.json"),
      JSON.stringify({ title: "稿件", content: "文".repeat(190) + "shortPrivateValue123" }),
    );
    const s = collectSnapshot(f.dir, now);
    assert.ok(!s.drafts[0].excerpt.includes("shortPrivate"));
    assert.match(s.drafts[0].excerpt, /已隐藏/);
  } finally {
    f.cleanup();
  }
});

test("status shows enabled roles only and resolves a business-specific model", () => {
  const f = fixture();
  try {
    const file = join(f.dir, "company.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.staffModels = { jinzhao: { growth: { engine: "claude", model: "sonnet" } } };
    writeFileSync(file, JSON.stringify(config));
    const db = new DatabaseSync(join(f.dir, "operations.db"));
    for (const row of db.prepare("SELECT rowid,body FROM projects").all()) {
      const p = JSON.parse(String(row.body));
      p.staff.push({ role: "engineering", enabled: true }, { role: "finance", enabled: false });
      db.prepare("UPDATE projects SET body=? WHERE rowid=?").run(JSON.stringify(p), row.rowid);
    }
    db.close();
    const staff = collectSnapshot(f.dir, now).staff;
    assert.ok(staff.every((s) => ["ceo", "growth"].includes(s.role)));
    assert.equal(staff.find((s) => s.role === "growth" && s.business === "今朝")?.model, "sonnet");
  } finally {
    f.cleanup();
  }
});
