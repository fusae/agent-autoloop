// Failure modes: replies from another sender or unrelated messages become decisions, restart loses routing,
// failed delivery drops a card, or retry sends the same report twice.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
