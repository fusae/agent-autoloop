// Failure modes: routine escalations still ping the chairman, spending or identity requests disappear,
// duplicate backlog records, fabricated topic authority, or reports omit the decisions and maintenance queue.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CompanyFeishu } from "../plugins/company/channel.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";
import { delegatedReport } from "../plugins/company/delegation.ts";
import { executiveDecision } from "../plugins/company/executive.ts";
import { TopicWorkflow } from "../plugins/company/topic-workflow.ts";
const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
const now = new Date("2026-11-10T08:00:00Z");
test("CEO routes ordinary blockers to a durable backlog while spending and identity alone produce decision cards", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegation-"));
  writeFileSync(join(dir, "company.json"), JSON.stringify({ ceoMode: true, delegation: { source: "测试授权" } }));
  const o = new Operations(dir),
    b = new Businesses(dir);
  try {
    b.save(
      { id: "app", name: "应用", description: "应用", audience: "用户", objective: "推广", stage: "operating" },
      now,
    );
    b.autonomy("app", true, now);
    b.status("app", "active", now);
    o.leadership(true, now);
    const run = (category: string, key = category) =>
      o.plan(key, b.list(), [], now, [], 2, [
        {
          id: key,
          source: "company-ceo",
          type: "company.ceo.decision",
          subject: "owner",
          detail: JSON.stringify({
            summary: "处理阻塞",
            executive: decision({
              escalations: [{ business: "app", key, issues: [], category, question: key, context: "已检查，需处理" }],
            }),
          }),
        },
      ]);
    const ordinary = run("maintenance");
    assert.equal(ordinary.ask?.length ?? 0, 0);
    assert.equal(ordinary.notice?.length ?? 0, 0);
    assert.equal(o.maintenance().length, 1);
    run("maintenance");
    assert.equal(o.maintenance().length, 1);
    assert.equal(run("spend").ask?.[0].title, "CEO · 支出决策");
    assert.equal(run("identity").ask?.[0].title, "CEO · 本人验证");
    const db = new DatabaseSync(join(dir, "operations.db"), { readOnly: true });
    try {
      const report = delegatedReport(db, o.executive(), "2026-11-10");
      assert.match(report, /今天替董事长做的决定/);
      assert.match(report, /待维护者处理/);
      assert.match(report, /maintenance/);
    } finally {
      db.close();
    }
  } finally {
    o.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("declaring source CEO in an event cannot confer delegation permission", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE projects(id TEXT,body TEXT)");
  db.prepare("INSERT INTO projects VALUES (?,?)").run(
    "app",
    JSON.stringify({ business: "app", topics: [], topicBatches: [{ id: "batch", topics: [] }] }),
  );
  const d = executiveDecision(
    decision({
      topicDecisions: [
        { business: "app", batch: "batch", source: "ceo", choices: [{ index: 0, approve: true, opinion: "想通过" }] },
      ],
    }),
  );
  try {
    assert.throws(() => new TopicWorkflow(db, "/unused").validate(d), /未授权/);
  } finally {
    db.close();
  }
});
test("channel suppresses unsolicited cards and replays but retains real daily reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delegation-channel-"));
  writeFileSync(join(dir, "company.json"), JSON.stringify({ ceoMode: true, delegation: { source: "测试授权" } }));
  const o = new Operations(dir),
    calls: any[] = [];
  const card: any = {
    id: 12,
    version: 1,
    ref: null,
    kind: "ask",
    state: "open",
    title: "CEO · 待你决策",
    text: "普通问题",
    options: ["处理", "暂缓"],
    recommend: null,
    choice: null,
    answer: null,
    result: null,
    link: null,
  };
  const bridge = new CompanyFeishu(
    join(dir, "feishu-state.json"),
    "ou_owner",
    { delivered: async () => {} } as any,
    async (args) => {
      calls.push(args);
      return { data: { message_id: "om_report" } };
    },
  );
  try {
    await bridge.deliver(card);
    const ref = "company-silent-12";
    await bridge.deliver({ ...card, ref, version: 2, state: "done", result: "处理完成" });
    assert.equal(calls.length, 0);
    assert.equal(o.maintenance().length, 1);
    await bridge.deliver({ ...card, id: 13, kind: "notice", title: "CEO · 日报", state: "open" });
    assert.equal(calls.length, 1);
  } finally {
    o.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trusted rule refresh removes routine ask-first constraints without granting model execution permissions", async () => {
  const { initialize, ensureBusinessRules } = await import("../plugins/company/setup.ts");
  const { readFileSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "delegation-rules-"));
  try {
    rmSync(dir, { recursive: true });
    initialize(dir);
    mkdirSync(join(dir, "hub"));
    writeFileSync(join(dir, "hub/rules.json"), readFileSync(join(dir, "rules.company.json")));
    const path = join(dir, "company.json"),
      config = JSON.parse(readFileSync(path, "utf8"));
    config.ceoMode = true;
    config.delegation = { source: "测试授权" };
    writeFileSync(path, JSON.stringify(config));
    ensureBusinessRules(dir);
    const before = readFileSync(join(dir, "hub/rules.json"), "utf8");
    const rules = JSON.parse(before);
    assert.deepEqual(rules.askFirst, ["新增支出", "需要董事长本人身份验证的登录"]);
    assert.match(rules.rules.find((r: any) => r.to === "company-ceo").prompt, /CEO授权规范/);
    ensureBusinessRules(dir);
    assert.equal(readFileSync(join(dir, "hub/rules.json"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
