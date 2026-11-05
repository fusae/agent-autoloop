// Failure modes: replies from another sender or unrelated messages become decisions, restart loses routing,
// failed delivery drops a card, or retry sends the same report twice.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CompanyFeishu } from "../plugins/company/channel.ts";
import type { Card } from "../host/channels.ts";

// Ordinary owner questions must be durable, authenticated data, never implicit card approvals.
test("owner chat retries ingestion safely and survives restart without routing invalid card replies as chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-chat-")),
    events: any[] = [];
  const file = join(dir, "state.json");
  let fail = true;
  const onQuestion = async (event: any) => {
    if (fail) throw Error("offline");
    events.push(event);
  };
  const question = {
    message_id: "om_question1",
    msg_type: "text",
    sender: { id: "ou_owner", sender_type: "user" },
    content: "记住 APP 进展怎样？",
  };
  try {
    let bridge = new CompanyFeishu(file, "ou_owner", {} as any, async () => ({}), onQuestion);
    await assert.rejects(bridge.receive([question]), /offline/);
    fail = false;
    await bridge.receive([question]);
    bridge = new CompanyFeishu(file, "ou_owner", {} as any, async () => ({}), onQuestion);
    await bridge.receive([
      question,
      { ...question, message_id: "om_other", sender: { id: "ou_other", sender_type: "user" } },
      { ...question, message_id: "om_bad", content: "#999 批准" },
      { ...question, message_id: "om_bot", sender: { id: "ou_owner", sender_type: "app" } },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "company.owner.question");
    assert.equal(JSON.parse(events[0].detail).question, question.content);
    assert.doesNotMatch(events[0].summary, /记住/);
    assert.equal(events[0].subject, "owner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const card: Card = {
  id: 42,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "CEO · 待你决策",
  text: "业务数据在哪里？",
  options: ["资料已补充", "暂缓"],
  recommend: null,
  choice: null,
  answer: null,
  result: null,
  link: null,
};
test("only explicit decisions from the configured owner reach the hub, across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-")),
    calls: any[] = [],
    answers: any[] = [],
    delivered: any[] = [];
  const hub = {
    delivered: async (...args: any[]) => {
      delivered.push(args);
    },
    answer: async (...args: any[]) => {
      answers.push(args);
      return { changed: true };
    },
  };
  const lark = async (args: string[]) => {
    calls.push(args);
    return { ok: true, data: { message_id: "om_ceo42" } };
  };
  try {
    let bridge = new CompanyFeishu(join(dir, "state.json"), "ou_owner", hub as any, lark);
    await bridge.deliver(card);
    await bridge.deliver(card);
    assert.equal(calls.length, 1);
    bridge = new CompanyFeishu(join(dir, "state.json"), "ou_owner", hub as any, lark);
    await bridge.receive([
      { message_id: "om_bad", msg_type: "text", sender: { id: "ou_other", sender_type: "user" }, content: "C42 批准" },
      {
        message_id: "om_unrelated",
        msg_type: "text",
        sender: { id: "ou_owner", sender_type: "user" },
        content: "今天不错",
      },
    ]);
    assert.equal(answers.length, 0);
    const reply = {
      message_id: "om_reply",
      msg_type: "text",
      sender: { id: "ou_owner", sender_type: "user" },
      content: "C42 数据在本机报表，先做记住 APP",
    };
    await bridge.receive([reply]);
    await bridge.receive([reply]);
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0], [42, { text: "数据在本机报表，先做记住 APP", by: "ou_owner", ref: "om_ceo42" }]);
    assert.ok(calls[0].includes("--as") && calls[0].includes("bot"));
    await bridge.deliver({ ...card, version: 2, ref: "om_ceo42", state: "decided", answer: "已回复" });
    assert.equal(delivered.at(-1)[2], "om_ceo42");
    await bridge.receive([{ ...reply, message_id: "om_again", content: "C42 1" }]);
    assert.equal(answers.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Owner replies must retain their subject, not produce two opaque status messages or lose real results.
test("reply updates name the question, acknowledge once across restarts, and suppress bookkeeping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-updates-"));
  const file = join(dir, "state.json"),
    calls: string[][] = [],
    delivered: any[] = [];
  const hub = {
    delivered: async (...args: any[]) => {
      delivered.push(args);
    },
  } as any;
  const lark = async (args: string[]) => {
    calls.push(args);
    return { data: { message_id: `om_message${calls.length}` } };
  };
  const question = { ...card, text: "两个 APP 是否已经完成真机安装测试？\n\n已有安装包。" };
  const decided = { ...question, version: 2, state: "decided" as const, answer: "两个 APP 我都安装测试过了。" };
  try {
    let bridge = new CompanyFeishu(file, "ou_owner", hub, lark);
    await bridge.deliver(question);
    assert.match(calls[0][calls[0].indexOf("--text") + 1], /#42/);
    await bridge.deliver(decided);
    const ack = calls[1][calls[1].indexOf("--text") + 1];
    assert.match(ack, /两个 APP 是否已经完成真机安装测试/);
    assert.match(ack, /两个 APP 我都安装测试过了/);
    assert.doesNotMatch(ack, /CEO · C42|CEO 将处理并反馈员工/);
    bridge = new CompanyFeishu(file, "ou_owner", hub, lark);
    await bridge.deliver({ ...decided, version: 3, state: "done", result: "经营周期已检查。" });
    await bridge.deliver({ ...decided, version: 3, state: "done", result: "经营周期已检查。" });
    assert.equal(calls.length, 2);
    assert.deepEqual(delivered.at(-1), [42, 3, "om_message1"]);
    await bridge.deliver({ ...decided, version: 4, state: "done", result: "已安排研发核查锁屏提醒故障。" });
    const result = calls.at(-1)!;
    assert.match(result[result.indexOf("--text") + 1], /真机安装测试/);
    assert.match(result[result.indexOf("--text") + 1], /已安排研发核查锁屏提醒故障/);
    assert.equal(calls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skipped versions acknowledge replies once; legacy acknowledgements and empty closures stay quiet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-skipped-"));
  const file = join(dir, "state.json"),
    calls: string[][] = [],
    delivered: any[] = [];
  const hub = {
    delivered: async (...args: any[]) => {
      delivered.push(args);
    },
  } as any;
  const lark = async (args: string[]) => {
    calls.push(args);
    return { data: { message_id: "om_new" } };
  };
  try {
    // A pre-upgrade decided state already sent an acknowledgement.
    writeFileSync(
      file,
      JSON.stringify({
        cards: { 42: { version: 2, ref: "om_old", open: false, options: card.options } },
        seen: [],
        cursor: new Date().toISOString(),
      }),
    );
    let bridge = new CompanyFeishu(file, "ou_owner", hub, lark);
    await bridge.deliver({ ...card, version: 3, state: "done", answer: "已提供", result: "经营周期已检查。" });
    assert.equal(calls.length, 0);
    await bridge.deliver({ ...card, id: 43, version: 3, state: "done", choice: 1, result: "经营周期已检查。" });
    assert.equal(calls.length, 1);
    assert.match(calls[0][calls[0].indexOf("--text") + 1], /暂缓/);
    bridge = new CompanyFeishu(file, "ou_owner", hub, lark);
    await bridge.deliver({ ...card, id: 44, version: 2, kind: "notice", state: "closed", result: null });
    assert.equal(calls.length, 1);
    assert.deepEqual(delivered.at(-1), [44, 2, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human-readable reply numbers keep owner and original-message checks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-number-")),
    answers: any[] = [];
  const hub = {
    delivered: async () => {},
    answer: async (...args: any[]) => {
      answers.push(args);
    },
  } as any;
  try {
    const bridge = new CompanyFeishu(join(dir, "state.json"), "ou_owner", hub, async () => ({
      data: { message_id: "om_question" },
    }));
    await bridge.deliver(card);
    await bridge.receive([
      { message_id: "om_other", msg_type: "text", sender: { id: "ou_other", sender_type: "user" }, content: "#42 1" },
    ]);
    assert.equal(answers.length, 0);
    await bridge.receive([
      {
        message_id: "om_answer",
        msg_type: "text",
        sender: { id: "ou_owner", sender_type: "user" },
        content: "#42 暂时没有反馈",
      },
    ]);
    assert.deepEqual(answers, [[42, { text: "暂时没有反馈", by: "ou_owner", ref: "om_question" }]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A recovered worker only confirms execution resumed, not that a business deliverable exists.
test("generic runtime recovery closures stay silent across restarts while concrete results still deliver", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-recovery-"));
  const file = join(dir, "state.json"),
    calls: string[][] = [],
    delivered: any[] = [];
  const hub = {
    delivered: async (...args: any[]) => {
      delivered.push(args);
    },
  } as any;
  const lark = async (args: string[]) => {
    calls.push(args);
    return { data: { message_id: "om_warning" } };
  };
  const warning: Card = {
    ...card,
    kind: "notice",
    title: "公司部门-engineering",
    options: [],
    text: "连续 3 次自动处理没跑完（卡在：Reconnecting...），16:59 会自动再试。",
  };
  try {
    let bridge = new CompanyFeishu(file, "ou_owner", hub, lark);
    await bridge.deliver(warning);
    assert.equal(calls.length, 1, "an ongoing failure must remain visible");
    bridge = new CompanyFeishu(file, "ou_owner", hub, lark);
    await bridge.deliver({ ...warning, version: 2, state: "closed", result: "后来跑成了" });
    await bridge.deliver({ ...warning, version: 2, state: "closed", result: "后来跑成了" });
    assert.equal(calls.length, 1, "no content-free recovery message");
    assert.deepEqual(delivered.at(-1), [42, 2, "om_warning"]);
    await bridge.deliver({ ...warning, id: 43, version: 2, state: "closed", result: "结果回来了。" });
    assert.equal(calls.length, 1, "a skipped initial delivery must also stay silent");
    await bridge.deliver({
      ...warning,
      id: 44,
      version: 2,
      state: "closed",
      result: "英语阅读：短信登录修复已交付，隔离回归通过，待部署。",
    });
    assert.equal(calls.length, 2);
    assert.match(calls[1][calls[1].indexOf("--text") + 1], /短信登录修复已交付/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
