// Failure modes: replies from another sender or unrelated messages become decisions, restart loses routing,
// failed delivery drops a card, or retry sends the same report twice.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CompanyFeishu } from "../plugins/company/channel.ts";
import type { Card } from "../host/channels.ts";
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
