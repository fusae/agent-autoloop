// Failure modes: chairman replies hit screening, empty-comment buttons lose intent, invented evidence approves topics,
// failed actions close cards as success, and retry exhaustion sends technical errors directly to the chairman.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TopicWorkflow } from "../plugins/company/topic-workflow.ts";
import { executiveDecision } from "../plugins/company/executive.ts";
import { parseTopicReply } from "../plugins/company/topics.ts";
import { initNotes, notebook } from "../plugins/company/notes.ts";
import { decisionCard } from "../plugins/company/decision-cards.ts";
import { interactiveCard, CompanyFeishu } from "../plugins/company/channel.ts";
import agent from "../plugins/company/agent.ts";
import { permissions } from "../plugins/company/workday.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";

const now = new Date("2026-11-10T01:00:00Z");
const base = { briefs: [], directives: [], approvals: [], answers: [], escalations: [] };
async function fixture(fn: (f: any) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "topic-decisions-"));
  mkdirSync(join(dir, "hub"));
  writeFileSync(
    join(dir, "company.json"),
    JSON.stringify({
      name: "test",
      database: join(dir, "company.db"),
      maxAssignments: 6,
      ceoMode: true,
      permissions,
      dailyPlanning: true,
      inspections: false,
      workday: { enabled: true, after: "09:00" },
      topics: { startAt: now.toISOString() },
    }),
  );
  const ops = new Operations(dir),
    businesses = new Businesses(dir);
  businesses.save(
    { id: "app", name: "示例业务", description: "说明", audience: "用户", objective: "推广", stage: "operating" },
    now,
  );
  businesses.autonomy("app", true, now);
  businesses.status("app", "active", now);
  ops.leadership(true, now);
  ops.configure("app", "growth", { enabled: true }, now);
  const db = new DatabaseSync(join(dir, "operations.db"));
  initNotes(db);
  const batch = "a".repeat(24);
  const p = JSON.parse(String(db.prepare("SELECT body FROM projects WHERE id='app'").get()!.body));
  p.topics = Array.from({ length: 7 }, (_, index) => ({
    id: String(index + 1).repeat(24),
    title: `示例选题${index + 1}`,
    state: "pending",
    batch,
    role: "growth",
    week: "2026-11-09",
  }));
  p.topicBatches = [{ id: batch, topics: p.topics.map((t: any) => t.id), at: now.toISOString() }];
  db.prepare("UPDATE projects SET body=? WHERE id='app'").run(JSON.stringify(p));
  const h = new DatabaseSync(join(dir, "hub/hub.db"));
  h.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY, source TEXT, type TEXT, detail TEXT, received_at TEXT);
    CREATE TABLE cards(id INTEGER PRIMARY KEY, text TEXT, about TEXT, options TEXT, choice INTEGER, answer TEXT, answer_event INTEGER, decided_at TEXT);
    CREATE TABLE deliveries(card_id INTEGER,ref TEXT);`);
  const insert = (id: number, text: string, extra = {}, source = "company-inbox") =>
    h
      .prepare("INSERT INTO events VALUES (?,?,?,?,?)")
      .run(
        id,
        source,
        "company.owner.question",
        JSON.stringify({ question: text, message: `message-${id}`, quoted: { text: `选题批次：${batch}` }, ...extra }),
        now.toISOString(),
      );
  const workflow = new TopicWorkflow(db, dir);
  const apply = (v: any) => {
    const d = executiveDecision({ ...base, ...v });
    workflow.validate(d);
    workflow.apply(d, now);
  };
  try {
    await fn({ dir, db, h, ops, businesses, batch, insert, apply, workflow, project: () => workflow.projects()[0] });
  } finally {
    h.close();
    db.close();
    ops.close();
    businesses.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("natural language recognizes satisfaction and multiple numbered decisions without deciding the rest", () => {
  for (const text of ["只有第4个满意", "只有第 4 个我是满意的", "只有第4题满意。"])
    assert.deepEqual(
      parseTopicReply(text, 7).map((v) => [v.index, v.approve]),
      [[3, true]],
    );
  for (const text of ["1、3通过", "①、③通过"])
    assert.deepEqual(
      parseTopicReply(text, 7).map((v) => [v.index, v.approve]),
      [
        [0, true],
        [2, true],
      ],
    );
  assert.deepEqual(parseTopicReply("只有第8个满意", 7), []);
});

test("text decision followed by empty-comment CEO button records actual results, message IDs and notes", () =>
  fixture((f) => {
    f.insert(1, "只有第4个我是满意的");
    f.apply({
      topicDecisions: [
        { business: "app", batch: f.batch, event: 1, choices: [{ index: 3, approve: true, opinion: "只满意第4题" }] },
      ],
    });
    f.h
      .prepare("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?)")
      .run(
        12,
        `其余6个怎么处理？选题批次：${f.batch}`,
        "",
        JSON.stringify(["全部撤下，另报新题", "保留"]),
        0,
        null,
        2,
        now.toISOString(),
      );
    f.h.prepare("INSERT INTO deliveries VALUES (?,?)").run(12, "message-button");
    f.apply({
      topicDecisions: [
        {
          business: "app",
          batch: f.batch,
          card: 12,
          choices: [0, 1, 2, 4, 5, 6].map((index) => ({ index, approve: false, opinion: "其余撤下另报新题" })),
        },
      ],
    });
    assert.deepEqual(
      f.project().topics.map((t: any) => t.state),
      ["rejected", "rejected", "rejected", "approved", "rejected", "rejected", "rejected"],
    );
    assert.equal(f.project().topics[3].decisionSource.message, "message-1");
    assert.equal(f.project().topics[0].decisionSource.message, "message-button");
    assert.equal(f.project().topicBatches[0].closed, true);
    for (const name of ["ceo", "app:growth"]) assert.match(notebook(f.db, name).text, /只满意第4题/);
    const before = JSON.stringify(f.project());
    f.apply({
      topicDecisions: [
        { business: "app", batch: f.batch, event: 1, choices: [{ index: 3, approve: true, opinion: "只满意第4题" }] },
      ],
    });
    assert.equal(JSON.stringify(f.project()), before);
  }));

test("individual topic button uses the same recorded chairman action", () =>
  fixture((f) => {
    f.insert(1, `选题批次：${f.batch}\n2通过`, {
      topicBatch: f.batch,
      topicChoice: { index: 1, approve: true, opinion: "讲具体步骤" },
    });
    f.workflow.tick(
      [],
      [
        {
          id: 1,
          source: "company-inbox",
          type: "company.owner.question",
          subject: "owner",
          detail: JSON.stringify({ question: `选题批次：${f.batch}\n2通过`, topicBatch: f.batch }),
        },
      ],
      {},
      now,
    );
    assert.equal(f.project().topics[1].state, "approved");
    assert.equal(f.project().topics[1].decisionSource.message, "message-1");
    assert.match(notebook(f.db, "ceo").text, /讲具体步骤/);
  }));

test("remaining topics require a prior approval; unauthenticated, contradictory and cross-batch evidence fails", () =>
  fixture((f) => {
    f.insert(1, "其余撤下");
    f.insert(2, "1、3通过");
    f.insert(3, "全部通过", {}, "company-growth");
    f.insert(4, "第2题不通过");
    const d = (event: number, choices: any[], batch = f.batch) => ({
      topicDecisions: [{ business: "app", batch, event, choices }],
    });
    const choice = (index: number, approve = true) => ({ index, approve, opinion: "原话" });
    assert.throws(() => f.apply(d(1, [choice(0, false)])), /缺少已拍板依据/);
    assert.throws(() => f.apply(d(3, [choice(0)])), /本人消息/);
    assert.throws(() => f.apply(d(4, [choice(1)])), /否定/);
    assert.throws(() => f.apply(d(2, [choice(1)])), /不一致/);
    assert.throws(() => f.apply(d(2, [choice(0)], "b".repeat(24))), /批次不存在/);
    f.apply(d(2, [choice(0), choice(2)]));
    f.apply(
      d(
        1,
        [1, 3, 4, 5, 6].map((i) => choice(i, false)),
      ),
    );
    assert.equal(f.project().topics.filter((t: any) => t.state === "approved").length, 2);
  }));

test("preflight rejects screening a pending topic; bounded correction drops false success and reports internally", () =>
  fixture((f) => {
    const bad = {
      ...base,
      topicReviews: [{ business: "app", topic: "1".repeat(24), approve: false, reason: "撤下", rank: 1 }],
    };
    const read = (d: any, repairs = 0) =>
      agent.read(
        [
          JSON.stringify({
            companyModel: "claude",
            companyValidation: { directory: f.dir, repairs, run: 10, cards: [12], open: [13] },
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "test-session",
            result: `六题已退回\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events: [{ id: "d", type: "company.ceo.decision", subject: "owner", detail: JSON.stringify({ summary: "执行决定", executive: d }) }], resolve: [{ card: 13, reason: "已执行" }] })}\n\`\`\``,
          }),
        ].join("\n"),
        0,
        "",
      );
    assert.match(read(bad).receiptProblem!, /topicDecisions/);
    assert.match(read(bad, 1).receiptProblem!, /初筛/);
    const exhausted = read(bad, 2);
    assert.equal(exhausted.receiptProblem, undefined);
    assert.doesNotMatch(exhausted.text!, /六题已退回|"notice"|"resolve"/);
    const event = JSON.parse(/```agent-autoloop\n([\s\S]*?)\n```/.exec(exhausted.text!)![1]).events[0];
    const r = f.ops.plan("failure", f.businesses.list(), [], now, [], 9, [{ ...event, id: 10, source: "company-ceo" }]);
    assert.equal(r.notice, undefined);
    assert.match(f.ops.executive().issues.at(-1).question, /未执行成功/);
    f.insert(1, "1通过");
    const good = read({
      ...base,
      topicDecisions: [
        { business: "app", batch: f.batch, event: 1, choices: [{ index: 0, approve: true, opinion: "通过" }] },
      ],
    });
    assert.equal(good.receiptProblem, undefined);
    assert.match(good.text!, /^处理中/);
    assert.doesNotMatch(good.text!, /"resolve"/);
    assert.equal(f.project().topics[0].state, "pending", "preflight never executes the decision");
  }));

test("card rendering uses coordinator results, never a technical failure plus answer-recorded label", () =>
  fixture((f) => {
    const card: any = {
      id: 12,
      version: 2,
      state: "done",
      kind: "ask",
      title: "其余怎么处理",
      text: "问题",
      options: [],
      choice: null,
      answer: null,
      result: "处理中，CEO 正在执行董事长决定",
    };
    assert.match(JSON.stringify(interactiveCard(card)), /处理中/);
    f.db
      .prepare("INSERT INTO batches VALUES (?,?)")
      .run("ceo-chat-failure", JSON.stringify({ failed: true, text: "内部参数错误", completionCards: [12] }));
    assert.match(decisionCard(f.dir, card).result!, /未成功/);
    f.db
      .prepare("INSERT INTO batches VALUES (?,?)")
      .run("ceo-chat-success", JSON.stringify({ failed: false, text: "第4题通过，其余退回", completionCards: [12] }));
    assert.equal(decisionCard(f.dir, card).result, "第4题通过，其余退回");
    assert.doesNotMatch(
      JSON.stringify(
        interactiveCard({
          ...card,
          kind: "notice",
          title: "CEO · 工作安排",
          text: "安排未执行：参数错误",
          state: "open",
        }),
      ),
      /答复已记录/,
    );
  }));

test("the original message is patched after execution, including after a channel restart", () =>
  fixture(async (f) => {
    const calls: string[][] = [];
    const lark = async (args: string[]) => {
      calls.push(args);
      if (args.includes("+chat-messages-list")) return { data: { messages: [] } };
      return { data: { message_id: "om_original", chat_id: "oc_chat" } };
    };
    const file = join(f.dir, "feishu-state.json");
    const hub: any = { delivered: async () => {} };
    let channel = new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true);
    const card: any = {
      id: 12,
      version: 1,
      kind: "ask",
      state: "open",
      title: "其余选题",
      text: "撤下还是保留？",
      options: ["撤下", "保留"],
      choice: null,
      result: null,
      answer: null,
    };
    await channel.deliver(card);
    await channel.deliver({ ...card, version: 3, state: "done", choice: 0, result: "处理中，CEO 正在执行董事长决定" });
    f.db
      .prepare("INSERT INTO batches VALUES (?,?)")
      .run("ceo-chat-done", JSON.stringify({ failed: false, text: "其余题已退回", completionCards: [12] }));
    channel = new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true);
    await channel.poll();
    const patches = calls.filter((a) => a[1] === "PATCH");
    assert.equal(calls.filter((a) => a.includes("+messages-send")).length, 1);
    assert.equal(patches.length, 2);
    assert.match(patches[1].join(" "), /其余题已退回/);
    assert.ok(patches.every((a) => a.includes("/open-apis/im/v1/messages/om_original")));
    await channel.poll();
    assert.equal(calls.filter((a) => a[1] === "PATCH").length, 2);
  }));
