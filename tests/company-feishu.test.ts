// Failure modes: replies from another sender or unrelated messages become decisions, restart loses routing,
// failed delivery drops a card, retry sends the same report twice, or CLI upgrades silently break polling/callbacks.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import companyChannel, { CompanyFeishu } from "../plugins/company/channel.ts";
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

// Native buttons must bind owner, message and card version; delivery retries cannot re-send or re-decide.
test("interactive decision cards bind clicks and update the original message after a choice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-buttons-"));
  const calls: string[][] = [],
    answers: any[] = [];
  const hub = {
    delivered: async () => {},
    answer: async (...args: any[]) => {
      answers.push(args);
    },
  } as any;
  const lark = async (args: string[]) => {
    calls.push(args);
    return { data: { message_id: "om_card42" } };
  };
  try {
    let bridge = new CompanyFeishu(join(dir, "state.json"), "ou_owner", hub, lark, undefined, true);
    await bridge.deliver({ ...card, options: ["先推广记住", "先推广阅读", "暂缓"] });
    const sent = calls[0];
    assert.ok(sent.includes("interactive"));
    const content = JSON.parse(sent[sent.indexOf("--content") + 1]);
    const buttons = content.body.elements
      .find((e: any) => e.name === "owner_reply")
      .elements.filter((e: any) => e.name?.startsWith("choice_"));
    assert.equal(buttons.length, 3);
    assert.match(buttons[1].text.content, /先推广阅读/);
    const event = {
      header: { event_id: "click-42", event_type: "card.action.trigger" },
      event: {
        operator: { open_id: "ou_owner" },
        context: { open_message_id: "om_card42" },
        action: { value: buttons[1].behaviors[0].value },
      },
    };
    for (const bad of [
      { ...event, event: { ...event.event, operator: { open_id: "ou_other" } } },
      { ...event, event: { ...event.event, context: { open_message_id: "om_wrong" } } },
      { ...event, event: { ...event.event, action: { value: { ...event.event.action.value, version: 999 } } } },
      { ...event, event: { ...event.event, action: { value: { ...event.event.action.value, choice: 8 } } } },
    ])
      assert.equal(await bridge.receiveAction(bad), false);
    assert.equal(answers.length, 0);
    assert.equal(await bridge.receiveAction(event), true);
    assert.deepEqual(answers[0], [42, { choice: 1, by: "ou_owner", ref: "om_card42" }]);
    bridge = new CompanyFeishu(join(dir, "state.json"), "ou_owner", hub, lark, undefined, true);
    assert.equal(await bridge.receiveAction(event), false);
    await bridge.deliver({
      ...card,
      options: ["先推广记住", "先推广阅读", "暂缓"],
      version: 2,
      state: "decided",
      choice: 1,
    });
    assert.equal(calls[1][0], "api");
    assert.equal(calls[1][1], "PATCH");
    const updated = JSON.parse(JSON.parse(calls[1][calls[1].indexOf("--data") + 1]).content);
    assert.equal(updated.body.elements.filter((e: any) => e.tag === "button").length, 0);
    assert.match(JSON.stringify(updated), /先推广阅读/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Upgrading an unanswered text message must preserve the kernel's immutable answer reference.
test("legacy questions gain buttons without changing their answer binding and transient failures can retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-upgrade-"));
  const file = join(dir, "state.json"),
    calls: string[][] = [],
    answers: any[] = [];
  let offline = true;
  const hub = {
    delivered: async () => {},
    answer: async (...args: any[]) => {
      if (offline) throw Error("offline");
      answers.push(args);
    },
  } as any;
  const lark = async (args: string[]) => {
    calls.push(args);
    return { data: { message_id: calls.length === 1 ? "om_old" : "om_new" } };
  };
  try {
    await new CompanyFeishu(file, "ou_owner", hub, lark).deliver(card);
    const bridge = new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true);
    await bridge.deliver({ ...card, ref: "om_old" });
    await bridge.deliver({ ...card, ref: "om_old" });
    assert.equal(calls.length, 2);
    const event = {
      header: { event_id: "upgraded", event_type: "card.action.trigger" },
      event: {
        operator: { open_id: "ou_owner" },
        context: { open_message_id: "om_new" },
        action: { value: { card: 42, version: 1, choice: 0 } },
      },
    };
    await assert.rejects(bridge.receiveAction(event), /offline/);
    offline = false;
    assert.equal(await bridge.receiveAction(event), true);
    assert.deepEqual(answers, [[42, { choice: 0, by: "ou_owner", ref: "om_old" }]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HTTP mode must drain the same spool without spawning a listener; legacy mode must stop its owned listener.
for (const listener of [true, false])
  test(`channel drains durable callback files with CLI listener ${listener}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "company-feishu-listener-"));
    const file = join(dir, "state.json"),
      spool = file + ".callbacks",
      script = join(dir, "lark");
    const abort = new AbortController(),
      answers: any[] = [];
    const timeout = setTimeout(() => abort.abort(), 5000);
    const hub = {
      delivered: async () => {},
      failed: async () => {},
      answer: async (...args: any[]) => {
        answers.push(args);
      },
      nextCard: async () => {
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) resolve();
          else abort.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { card: null };
      },
    } as any;
    try {
      await new CompanyFeishu(
        file,
        "ou_owner",
        hub,
        async () => ({ data: { message_id: "om_native" } }),
        undefined,
        true,
      ).deliver(card);
      mkdirSync(spool);
      writeFileSync(
        join(spool, "pending.json"),
        JSON.stringify({
          header: { event_id: "persisted", event_type: "card.action.trigger" },
          event: {
            operator: { open_id: "ou_owner" },
            context: { open_message_id: "om_native" },
            action: { value: { card: 42, version: 1, choice: 0 } },
          },
        }),
      );
      writeFileSync(
        script,
        `#!${process.execPath}
const fs=require('node:fs'); const a=process.argv.slice(2);
if(a[0]==='event') {
  if(a[1]!=='consume'||a.includes('--quiet')||a.includes('--force')||!a.includes('card.action.trigger')||a[a.indexOf('--output-dir')+1]!=='.') process.exit(2);
  process.stdin.resume(); process.stdin.on('end',()=>process.exit(3));
  console.error('[event] ready event_key=card.action.trigger');
  fs.writeFileSync(${JSON.stringify(join(dir, "pid"))},String(process.pid));
  process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(join(dir, "stopped"))},'yes');process.exit(0);});
  setInterval(()=>{},1000);
} else console.log(JSON.stringify({data:{items:[{message_id:'om_native',chat_id:'oc_owner'}],messages:[],has_more:false}}));
`,
        { mode: 0o700 },
      );
      const running = companyChannel({
        hub,
        signal: abort.signal,
        log: () => {},
        options: {
          lark: script,
          stateFile: file,
          user: "ou_owner",
          cards: true,
          cardCallbacks: true,
          cardCallbackListener: listener,
        },
      });
      while (
        !abort.signal.aborted &&
        ((listener && !existsSync(join(dir, "pid"))) || !answers.length || existsSync(join(spool, "pending.json")))
      )
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(answers.length, 1);
      assert.equal(existsSync(join(spool, "pending.json")), false);
      if (listener)
        assert.match(readFileSync(join(spool, "connection.log"), "utf8"), /ready event_key=card.action.trigger/);
      else {
        assert.equal(existsSync(join(dir, "pid")), false);
        assert.equal(existsSync(join(spool, "connection.log")), false);
      }
      abort.abort();
      await running;
      if (listener) assert.equal(readFileSync(join(dir, "stopped"), "utf8"), "yes");
      else assert.equal(existsSync(join(dir, "pid")), false);
    } finally {
      abort.abort();
      clearTimeout(timeout);
      rmSync(dir, { recursive: true, force: true });
    }
  });

// Free-form decisions must submit text, never reinterpret a typed number as a button choice.
test("decision cards accept validated owner form text and clear the form after submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-form-"));
  const calls: string[][] = [],
    answers: any[] = [];
  let offline = true;
  const hub = {
    delivered: async () => {},
    answer: async (...args: any[]) => {
      if (offline) throw Error("offline");
      answers.push(args);
    },
  } as any;
  const lark = async (args: string[]) => {
    calls.push(args);
    return { data: { message_id: "om_form42" } };
  };
  try {
    const file = join(dir, "state.json");
    let bridge = new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true);
    await bridge.deliver(card);
    const rendered = JSON.parse(calls[0][calls[0].indexOf("--content") + 1]);
    const form = rendered.body.elements.find((e: any) => e.tag === "form");
    assert.ok(form, "missing free-text form");
    const input = form.elements.find((e: any) => e.tag === "input"),
      button = form.elements.find((e: any) => e.name === "submit_reply");
    assert.equal(input.input_type, "multiline_text");
    assert.equal(input.required, false);
    assert.equal(button.form_action_type, "submit");
    const event = {
      header: { event_id: "text-42", event_type: "card.action.trigger" },
      event: {
        operator: { open_id: "ou_owner" },
        context: { open_message_id: "om_form42" },
        action: {
          tag: "button",
          name: button.name,
          value: button.behaviors[0].value,
          form_value: { [input.name]: "  2\n先做记住推广  " },
        },
      },
    };
    for (const bad of [
      { ...event, event: { ...event.event, operator: { open_id: "ou_other" } } },
      { ...event, event: { ...event.event, context: { open_message_id: "om_wrong" } } },
      {
        ...event,
        event: {
          ...event.event,
          action: { ...event.event.action, value: { ...event.event.action.value, version: 99 } },
        },
      },
      ...["", "   ", "x".repeat(1001), 42, {}].map((text) => ({
        ...event,
        event: { ...event.event, action: { ...event.event.action, form_value: { [input.name]: text } } },
      })),
      {
        ...event,
        event: { ...event.event, action: { ...event.event.action, value: { ...event.event.action.value, choice: 0 } } },
      },
    ])
      assert.equal(await bridge.receiveAction(bad), false);
    await assert.rejects(bridge.receiveAction(event), /offline/);
    offline = false;
    assert.equal(await bridge.receiveAction(event), true);
    assert.deepEqual(answers, [[42, { text: "2\n先做记住推广", by: "ou_owner", ref: "om_form42" }]]);
    bridge = new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true);
    assert.equal(await bridge.receiveAction(event), false);
    await bridge.deliver({ ...card, version: 2, state: "decided", answer: "2\n先做记住推广" });
    const updated = JSON.parse(JSON.parse(calls[1][calls[1].indexOf("--data") + 1]).content);
    assert.equal(
      updated.body.elements.some((e: any) => e.tag === "form"),
      false,
    );
    assert.match(JSON.stringify(updated), /先做记住推广/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Existing unanswered native cards must gain the input in place, without changing kernel versions or resending.
test("existing native cards gain the free-text form once on restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-form-upgrade-"));
  const file = join(dir, "state.json"),
    calls: string[][] = [];
  const hub = { delivered: async () => {} } as any;
  const lark = async (args: string[]) => {
    calls.push(args);
    return { data: { message_id: "om_existing" } };
  };
  try {
    await new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true).deliver(card);
    const old = JSON.parse(readFileSync(file, "utf8"));
    delete old.cards[42].layout;
    writeFileSync(file, JSON.stringify(old));
    const bridge = new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true);
    await bridge.deliver(card);
    await bridge.deliver(card);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1], "PATCH");
    assert.match(calls[1][2], /om_existing$/);
    const saved = JSON.parse(readFileSync(file, "utf8")).cards[42];
    assert.equal(saved.version, 1);
    assert.equal(saved.ref, "om_existing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Acknowledging an owner's deferral must not claim the business work was completed.
test("deferred cards show paused status and put background in a collapsed panel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-readable-"));
  const calls: string[][] = [];
  const hub = { delivered: async () => {} } as any;
  const lark = async (args: string[]) => {
    calls.push(args);
    return { data: { message_id: "om_readable" } };
  };
  try {
    const bridge = new CompanyFeishu(join(dir, "state.json"), "ou_owner", hub, lark, undefined, true);
    await bridge.deliver({ ...card, text: "提醒是否按时到达？\n\n内部核验记录" });
    const open = JSON.parse(calls[0][calls[0].indexOf("--content") + 1]);
    assert.equal(open.body.elements[0].text.content, "提醒是否按时到达？");
    const panel = open.body.elements.find((e: any) => e.tag === "collapsible_panel");
    assert.equal(panel.expanded, false);
    assert.match(JSON.stringify(panel), /内部核验记录/);
    await bridge.deliver({ ...card, version: 3, state: "done", choice: 1, result: "经营周期已检查。" });
    const done = JSON.parse(JSON.parse(calls[1][calls[1].indexOf("--data") + 1]).content);
    assert.match(done.header.title.content, /已暂缓/);
    assert.doesNotMatch(JSON.stringify(done), /待你决策|已处理|经营周期已检查/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Quoted replies must carry the actual referenced content, including closed cards, without approving them again.
test("quoted owner replies include the closed card and retry context lookup before marking seen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-quote-")),
    file = join(dir, "state.json"),
    events: any[] = [];
  const message = {
    message_id: "om_reply",
    msg_type: "text",
    sender: { id: "ou_owner", sender_type: "user" },
    content: "这两项都可以",
    reply_to: "om_card42",
  };
  let offline = true,
    answers = 0,
    lookups = 0;
  const hub = {
    delivered: async () => {},
    answer: async () => {
      answers++;
    },
  } as any;
  const lark = async (args: string[]) => {
    if (args.includes("+messages-mget")) {
      lookups++;
      if (offline) throw Error("offline");
      return {
        data: {
          messages: [
            {
              message_id: "om_card42",
              msg_type: "interactive",
              content: "记住 APP：记事保存、提醒到达",
              sender: { sender_type: "app" },
            },
          ],
        },
      };
    }
    return { data: { message_id: "om_card42" } };
  };
  try {
    let bridge = new CompanyFeishu(file, "ou_owner", hub, lark, async (e) => events.push(e), true);
    await bridge.deliver(card);
    await bridge.deliver({ ...card, version: 3, state: "done", choice: 1 });
    await bridge.receive([{ ...message, sender: { id: "ou_other", sender_type: "user" } }]);
    assert.equal(lookups, 0);
    await assert.rejects(bridge.receive([message]), /offline/);
    assert.equal(events.length, 0);
    offline = false;
    await bridge.receive([message]);
    bridge = new CompanyFeishu(file, "ou_owner", hub, lark, async (e) => events.push(e), true);
    await bridge.receive([message]);
    assert.equal(events.length, 1);
    assert.equal(answers, 0);
    const detail = JSON.parse(events[0].detail);
    assert.equal(detail.question, message.content);
    assert.equal(detail.quoted.message, "om_card42");
    assert.equal(detail.quoted.card, 42);
    assert.match(detail.quoted.text, /记事保存、提醒到达/);
    assert.equal(events[0].summary, "负责人向 CEO 提问");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The CLI hides parent_id behind thread_id; retrieve the immediate parent, not an unrelated thread root.
test("thread replies resolve the exact parent and bound quoted text without dropping the owner message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-thread-")),
    events: any[] = [],
    calls: string[][] = [];
  const lark = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api")
      return { data: { items: [{ message_id: "om_reply", parent_id: "om_parent", root_id: "om_root" }] } };
    return {
      data: {
        messages: [
          {
            message_id: "om_parent",
            msg_type: "text",
            content: "原始说明".repeat(2000),
            sender: { sender_type: "app" },
          },
        ],
      },
    };
  };
  try {
    const bridge = new CompanyFeishu(join(dir, "state.json"), "ou_owner", {} as any, lark, async (e) => events.push(e));
    await bridge.receive([
      {
        message_id: "om_reply",
        msg_type: "text",
        sender: { id: "ou_owner", sender_type: "user" },
        content: "确认上述结果",
        thread_id: "omt_thread",
      },
    ]);
    assert.equal(calls[0][0], "api");
    assert.ok(calls[0][2].endsWith("/om_reply"));
    assert.ok(calls[1].includes("om_parent"));
    assert.equal(events.length, 1);
    const detail = JSON.parse(events[0].detail);
    assert.equal(detail.quoted.message, "om_parent");
    assert.equal(detail.question, "确认上述结果");
    assert.equal(detail.quoted.truncated, true);
    assert.ok(events[0].detail.length <= 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withdrawn quoted messages are explicitly unavailable rather than guessed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-deleted-")),
    events: any[] = [];
  try {
    const bridge = new CompanyFeishu(
      join(dir, "state.json"),
      "ou_owner",
      {} as any,
      async () => ({ data: { messages: [{ message_id: "om_gone", deleted: true, content: "不要传这个旧内容" }] } }),
      async (e) => events.push(e),
    );
    await bridge.receive([
      {
        message_id: "om_reply",
        msg_type: "text",
        sender: { id: "ou_owner", sender_type: "user" },
        content: "这个如何",
        reply_to: "om_gone",
      },
    ]);
    const detail = JSON.parse(events[0].detail);
    assert.ok(detail.quoted.unavailable);
    assert.equal(detail.quoted.text, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CLI 1.0.99 rejects bot --user-id history; resolving an existing sent message must not resend or lose the cursor.
test("bot polling resolves and persists the owner chat, retries history without skipping messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-chat-id-"));
  const file = join(dir, "state.json");
  const calls: string[][] = [],
    events: any[] = [];
  const cursor = "2026-11-07T05:54:09.929Z";
  let fail = true;
  writeFileSync(
    file,
    JSON.stringify({ cards: { 53: { ref: "om_owner", version: 1, open: true, options: [] } }, seen: [], cursor }),
  );
  const lark = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api") return { data: { items: [{ message_id: "om_owner", chat_id: "oc_owner" }] } };
    assert.equal(args[args.indexOf("--chat-id") + 1], "oc_owner");
    assert.equal(args.includes("--user-id"), false);
    assert.equal(args[args.indexOf("--order") + 1], "asc");
    assert.equal(args[args.indexOf("--start") + 1], "2026-11-07T05:52:09.929Z");
    if (fail) throw Error("read unavailable");
    return {
      data: {
        messages: [
          {
            message_id: "om_question",
            msg_type: "text",
            sender: { id: "ou_owner", sender_type: "user" },
            content: "进展怎样？",
          },
        ],
        has_more: false,
      },
    };
  };
  try {
    let bridge = new CompanyFeishu(file, "ou_owner", {} as any, lark, async (e) => events.push(e));
    await assert.rejects(bridge.poll(), /read unavailable/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).cursor, cursor);
    fail = false;
    bridge = new CompanyFeishu(file, "ou_owner", {} as any, lark, async (e) => events.push(e));
    await bridge.poll();
    assert.equal(calls.filter((a) => a[0] === "api").length, 1);
    assert.equal(
      calls.some((a) => a.includes("+messages-send")),
      false,
    );
    assert.equal(events.length, 1);
    assert.notEqual(JSON.parse(readFileSync(file, "utf8")).cursor, cursor);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Flattened consume callbacks must retain the original authentication, version, form, and deduplication checks.
test("CLI consume callbacks authenticate owner, message and version and preserve form answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-consume-"));
  const answers: any[] = [];
  const hub = { delivered: async () => {}, answer: async (...a: any[]) => answers.push(a) } as any;
  try {
    const bridge = new CompanyFeishu(
      join(dir, "state.json"),
      "ou_owner",
      hub,
      async () => ({ data: { message_id: "om_card" } }),
      undefined,
      true,
    );
    await bridge.deliver(card);
    const value = { card: 42, version: 1, choice: 0 };
    const raw = {
      type: "card.action.trigger",
      event_id: "e1",
      operator_id: "ou_owner",
      message_id: "om_card",
      action_tag: "button",
      action_value: JSON.stringify(value),
    };
    for (const bad of [
      { ...raw, operator_id: "ou_other" },
      { ...raw, message_id: "om_other" },
      { ...raw, action_value: JSON.stringify({ ...value, version: 2 }) },
      { ...raw, action_value: "malformed" },
    ])
      assert.equal(await bridge.receiveAction(bad), false);
    assert.equal(await bridge.receiveAction(raw), true);
    assert.equal(await bridge.receiveAction(raw), false);
    await bridge.deliver({ ...card, id: 43 });
    assert.equal(
      await bridge.receiveAction({
        ...raw,
        event_id: "e2",
        action_name: "submit_reply",
        action_value: JSON.stringify({ card: 43, version: 1, action: "reply" }),
        form_value: JSON.stringify({ reply: "先核查资料" }),
      }),
      true,
    );
    assert.deepEqual(answers, [
      [42, { choice: 0, by: "ou_owner", ref: "om_card" }],
      [43, { text: "先核查资料", by: "ou_owner", ref: "om_card" }],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Operational failures must reveal the CLI cause, without exposing tokens or sending diagnostic messages.
test("poll diagnostics retain CLI validation errors and redact credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-feishu-error-"));
  const abort = new AbortController(),
    logs: string[] = [];
  const timeout = setTimeout(() => abort.abort(), 3000);
  const file = join(dir, "state.json"),
    script = join(dir, "lark");
  writeFileSync(file, JSON.stringify({ cards: {}, seen: [], cursor: new Date().toISOString(), chatId: "oc_owner" }));
  writeFileSync(
    script,
    `#!${process.execPath}
console.error(JSON.stringify({error:{message:'invalid_argument: --user-id requires user identity; token=private-token secret=private-secret https://example.test/?key=private-key'}})); process.exit(2);
`,
    { mode: 0o700 },
  );
  try {
    await companyChannel({
      options: { lark: script, stateFile: file, user: "ou_owner" },
      signal: abort.signal,
      log: (line) => {
        logs.push(line);
        abort.abort();
      },
      hub: {
        nextCard: async () => {
          await new Promise<void>((resolve) => {
            if (abort.signal.aborted) resolve();
            else abort.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { card: null };
        },
      } as any,
    });
    assert.match(logs.join("\n"), /invalid_argument.*--user-id requires user identity/);
    assert.doesNotMatch(logs.join("\n"), /private-token|private-secret|private-key/);
  } finally {
    abort.abort();
    clearTimeout(timeout);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Production callback shape omitted form_value because the choice was outside the form.
test("publication choices submit the same form and preserve opinions in raw and flattened callbacks", async () => {
  for (const flattened of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "card-opinion-"));
    const calls: string[][] = [],
      answers: any[] = [];
    try {
      const bridge = new CompanyFeishu(
        join(dir, "state.json"),
        "ou_owner",
        {
          delivered: async () => {},
          answer: async (...args: any[]) => {
            answers.push(args);
          },
        } as any,
        async (args) => {
          calls.push(args);
          return { data: { message_id: "om_card" } };
        },
        undefined,
        true,
      );
      await bridge.deliver({ ...card, title: "发布确认", options: ["发布", "退回修改", "暂缓"] });
      const rendered = JSON.parse(calls[0][calls[0].indexOf("--content") + 1]);
      assert.ok(!rendered.body.elements.some((e: any) => e.name === "choice_1"));
      const form = rendered.body.elements.find((e: any) => e.name === "owner_reply");
      const button = form.elements.find((e: any) => e.name === "choice_1");
      assert.equal(button.form_action_type, "submit");
      assert.ok(form.elements.some((e: any) => e.name === "reply"));
      const action = {
        tag: "button",
        name: button.name,
        value: button.behaviors[0].value,
        form_value: { reply: "  选题不好  " },
      };
      const raw = {
        schema: "2.0",
        header: { event_id: "opinion", event_type: "card.action.trigger" },
        event: { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_card" }, action },
      };
      assert.equal(
        await bridge.receiveAction({
          ...raw,
          event: { ...raw.event, action: { ...action, form_value: { reply: {} } } },
        }),
        false,
      );
      assert.equal(
        await bridge.receiveAction(
          flattened
            ? {
                type: "card.action.trigger",
                event_id: "opinion",
                operator_id: "ou_owner",
                message_id: "om_card",
                action_value: JSON.stringify(action.value),
                action_tag: action.tag,
                action_name: action.name,
                form_value: JSON.stringify(action.form_value),
              }
            : raw,
        ),
        true,
      );
      assert.deepEqual(answers, [[42, { choice: 1, text: "选题不好", by: "ou_owner", ref: "om_card" }]]);
      assert.equal(await bridge.receiveAction(raw), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
