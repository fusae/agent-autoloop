// The company channel owns one CLI callback connection; ordinary chat still uses history polling.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HubError, hubClient } from "../../protocol/client.ts";
import type { Card, ChannelContext } from "../../host/channels.ts";
type Message = {
  message_id: string;
  msg_type: string;
  sender?: { id?: string; sender_type?: string };
  content?: string;
  deleted?: boolean;
  reply_to?: string;
  thread_id?: string;
};
type Saved = {
  version: number;
  ref: string | null;
  open: boolean;
  options: string[];
  acknowledged?: boolean;
  interactive?: boolean;
  cardRef?: string;
  layout?: number;
};
type State = { cards: Record<string, Saved>; seen: string[]; cursor: string };
// Execution recovery is bookkeeping, not evidence of a business result.
const bookkeeping = new Set([
  "经营周期已检查",
  "公司任务状态已更新",
  "此事项已处理",
  "已处理",
  "后来跑成了",
  "结果回来了",
]);
function excerpt(text: string, max: number) {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > max ? plain.slice(0, max) + "…" : plain;
}
function updateText(card: Card, acknowledged: boolean) {
  const subject = excerpt(card.text.split(/\n\s*\n/)[0] || card.title, 180);
  const answer = card.answer?.trim() || (card.choice !== null ? card.options[card.choice] : "");
  const result = card.result?.trim();
  const meaningful = result && !bookkeeping.has(result.replace(/[。.!！]+$/, ""));
  if (card.state !== "decided" && meaningful) return `处理结果\n事项：${subject}\n\n${result}`;
  if (card.kind === "ask" && answer && !acknowledged)
    return `答复已记录\n事项：${subject}\n你的答复：${excerpt(answer, 240)}`;
  return null;
}
export function interactiveCard(card: Card) {
  const answer = card.answer || (card.choice !== null ? card.options[card.choice] : "");
  const deferred = card.state !== "open" && answer?.trim() === "暂缓";
  const paragraphs = card.kind === "ask" ? card.text.split(/\n\s*\n/) : [card.text];
  const elements: any[] = [{ tag: "div", text: { tag: "plain_text", content: paragraphs[0] } }];
  if (paragraphs.length > 1)
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: { title: { tag: "plain_text", content: "背景" } },
      elements: [{ tag: "div", text: { tag: "plain_text", content: paragraphs.slice(1).join("\n\n") } }],
    });
  if (card.kind === "ask" && card.state === "open") {
    elements.push(
      ...card.options.map((label, choice) => ({
        tag: "button",
        text: { tag: "plain_text", content: `${choice + 1}. ${label}` },
        type: choice === card.recommend ? "primary" : "default",
        width: "fill",
        behaviors: [{ type: "callback", value: { card: card.id, version: card.version, choice } }],
      })),
    );
    elements.push({
      tag: "form",
      name: "owner_reply",
      elements: [
        {
          tag: "input",
          name: "reply",
          label: { tag: "plain_text", content: "补充意见" },
          placeholder: { tag: "plain_text", content: "输入你的决定或补充说明" },
          input_type: "multiline_text",
          rows: 3,
          width: "fill",
          max_length: 1000,
          required: true,
        },
        {
          tag: "button",
          name: "submit_reply",
          text: { tag: "plain_text", content: "提交" },
          type: "primary",
          form_action_type: "submit",
          behaviors: [{ type: "callback", value: { card: card.id, version: card.version, action: "reply" } }],
        },
      ],
    });
  } else {
    if (answer) elements.push({ tag: "div", text: { tag: "plain_text", content: `你的决定：${answer}` } });
    const result = card.result?.trim();
    if (result && !bookkeeping.has(result.replace(/[。.!！]+$/, "")))
      elements.push({ tag: "div", text: { tag: "plain_text", content: `处理结果：${result}` } });
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: deferred ? "已暂缓，事项尚未解决" : card.state === "decided" ? "已提交 CEO" : "答复已记录",
      },
    });
  }
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content:
          card.kind === "ask" && card.state !== "open" ? (deferred ? "CEO · 已暂缓" : "CEO · 答复已记录") : card.title,
      },
      template: deferred ? "grey" : card.state === "open" ? "blue" : "green",
    },
    body: { elements },
  };
}
export class CompanyFeishu {
  private cards: boolean;
  private file: string;
  private owner: string;
  private state: State;
  private hub: ChannelContext["hub"];
  private lark: (args: string[]) => Promise<any>;
  private onQuestion?: (event: {
    id: string;
    type: string;
    subject: string;
    summary: string;
    detail: string;
  }) => Promise<unknown>;
  constructor(
    file: string,
    owner: string,
    hub: ChannelContext["hub"],
    lark: (args: string[]) => Promise<any>,
    onQuestion?: CompanyFeishu["onQuestion"],
    cards = false,
  ) {
    if (!isAbsolute(file) || !/^ou_[A-Za-z0-9]+$/.test(owner)) throw new Error("需要飞书本人 open_id 和绝对状态路径");
    this.cards = cards;
    this.file = file;
    this.owner = owner;
    this.hub = hub;
    this.lark = lark;
    this.onQuestion = onQuestion;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.state = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { cards: {}, seen: [], cursor: new Date(Date.now() - 60_000).toISOString() };
  }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  async deliver(card: Card) {
    let saved = this.state.cards[card.id];
    const promote =
      this.cards && (!saved?.interactive || saved.layout !== 3) && card.kind === "ask" && card.state === "open";
    if (!saved || saved.version < card.version || promote) {
      // Old closed states have already sent their acknowledgement; do not replay them on upgrade.
      const acknowledged = saved?.acknowledged ?? (!!saved && saved.version > 1 && !saved.open);
      let text: string | null;
      if (card.state === "open")
        text = `${card.title}\n\n${card.text}${card.kind === "ask" ? `\n\n请回复：#${card.id} 你的回答\n也可回复：${card.options.map((o, i) => `#${card.id} ${i + 1}（${o}）`).join("；")}` : ""}`;
      else text = updateText(card, acknowledged);
      // Persist the original message reference: owner authentication remains bound to that question.
      let ref = saved?.ref ?? card.ref;
      let cardRef = saved?.cardRef;
      const native = this.cards && (card.state === "open" || saved?.interactive);
      if (native && saved?.interactive && cardRef) {
        await this.lark([
          "api",
          "PATCH",
          `/open-apis/im/v1/messages/${cardRef}`,
          "--as",
          "bot",
          "--data",
          JSON.stringify({ content: JSON.stringify(interactiveCard(card)) }),
        ]);
      } else if (text) {
        const version = card.state !== "open" && text.startsWith("答复已记录\n") ? "answer" : card.version;
        const key =
          "company-" +
          createHash("sha256")
            .update(`${this.file}:${card.id}:${version}${native ? ":interactive" : ""}`)
            .digest("hex")
            .slice(0, 32);
        const sent = await this.lark([
          "im",
          "+messages-send",
          "--as",
          "bot",
          "--user-id",
          this.owner,
          ...(native
            ? ["--msg-type", "interactive", "--content", JSON.stringify(interactiveCard(card))]
            : ["--text", text]),
          "--idempotency-key",
          key,
        ]);
        if (typeof sent.data?.message_id !== "string" || !sent.data.message_id.startsWith("om_"))
          throw new Error("飞书未返回有效消息编号");
        ref ??= sent.data.message_id;
        if (native) cardRef = sent.data.message_id;
      }
      saved = {
        interactive: native || saved?.interactive,
        layout: native ? 3 : saved?.layout,
        cardRef,
        ref,
        version: card.version,
        open: card.kind === "ask" && card.state === "open",
        options: card.options,
        acknowledged: acknowledged || (card.kind === "ask" && card.state !== "open" && !!text),
      };
      this.state.cards[card.id] = saved;
      this.save();
    }
    await this.hub.delivered(card.id, card.version, saved.ref);
  }
  async receiveAction(raw: any) {
    const event = raw?.event,
      value = event?.action?.value,
      id = raw?.header?.event_id;
    if (
      !this.cards ||
      raw?.header?.event_type !== "card.action.trigger" ||
      typeof id !== "string" ||
      this.state.seen.includes(id) ||
      event?.operator?.open_id !== this.owner ||
      !Number.isSafeInteger(value?.card) ||
      !Number.isSafeInteger(value?.version)
    )
      return false;
    const saved = this.state.cards[value.card];
    if (
      !saved?.open ||
      !saved.interactive ||
      !saved.ref ||
      !saved.cardRef ||
      event.context?.open_message_id !== saved.cardRef ||
      saved.version !== value.version
    )
      return false;
    let answer: { text: string } | { choice: number };
    if (value.action === "reply") {
      const text = event.action.form_value?.reply;
      if (
        value.choice !== undefined ||
        event.action.tag !== "button" ||
        event.action.name !== "submit_reply" ||
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 1000
      )
        return false;
      answer = { text: text.trim() };
    } else {
      if (
        value.action !== undefined ||
        !Number.isSafeInteger(value.choice) ||
        value.choice < 0 ||
        value.choice >= saved.options.length
      )
        return false;
      answer = { choice: value.choice };
    }
    try {
      await this.hub.answer(value.card, { ...answer, by: this.owner, ref: saved.ref });
    } catch (error) {
      if (!(error instanceof HubError) || error.status !== 409) throw error;
    }
    saved.open = false;
    this.state.seen.push(id);
    this.state.seen = this.state.seen.slice(-2000);
    this.save();
    return true;
  }
  private async quotedContext(m: Message) {
    let parent = m.reply_to;
    if (!parent && m.thread_id) {
      // The CLI's compact formatter omits parent_id whenever thread_id exists.
      if (!/^om_[A-Za-z0-9]+$/.test(m.message_id)) return { unavailable: "引用消息编号无效" };
      const raw = await this.lark(["api", "GET", `/open-apis/im/v1/messages/${m.message_id}`, "--as", "bot"]);
      if (!Array.isArray(raw.data?.items)) throw Error("飞书未返回引用消息信息");
      const original = raw.data.items.find((v: any) => v.message_id === m.message_id);
      parent = original?.parent_id || original?.root_id;
      if (!parent) return { unavailable: "无法确认话题中被引用的消息" };
    }
    if (!parent) return undefined;
    if (!/^om_[A-Za-z0-9]+$/.test(parent) || parent === m.message_id) return { unavailable: "引用消息编号无效" };
    const response = await this.lark([
      "im",
      "+messages-mget",
      "--as",
      "bot",
      "--message-ids",
      parent,
      "--format",
      "json",
    ]);
    if (!Array.isArray(response.data?.messages)) throw Error("飞书未返回引用消息内容");
    const quoted = response.data.messages.find((v: Message) => v.message_id === parent);
    if (!quoted || quoted.deleted) return { message: parent, unavailable: "原消息已撤回或不可读取" };
    const matched = Object.entries(this.state.cards).find(([, s]) => s.cardRef === parent || s.ref === parent);
    const text = typeof quoted.content === "string" ? quoted.content : "";
    return {
      message: parent,
      ...(matched ? { card: Number(matched[0]) } : {}),
      type: quoted.msg_type,
      text: text.slice(0, 2200),
      truncated: text.length > 2200,
    };
  }
  async receive(messages: Message[]) {
    for (const m of messages) {
      if (
        this.state.seen.includes(m.message_id) ||
        m.deleted ||
        m.sender?.id !== this.owner ||
        m.sender?.sender_type !== "user" ||
        m.msg_type !== "text"
      )
        continue;
      const match = /^\s*(?:#C?|C)(\d+)\s+([\s\S]+)$/i.exec(m.content ?? "");
      if (!match) {
        const question = m.content?.trim();
        // Numbered replies never fall through to conversation, including incomplete/invalid replies.
        if (!this.onQuestion || !question || question.length > 4000 || /^(?:#C?|C)\d+\b/i.test(question)) continue;
        const payload = { question, message: m.message_id, quoted: await this.quotedContext(m), truncated: false };
        let detail = JSON.stringify(payload);
        // Keep the owner's words ahead of quoted background within the hub's detail limit.
        while (detail.length > 4000) {
          if (payload.quoted && "text" in payload.quoted && payload.quoted.text) {
            payload.quoted.text = payload.quoted.text.slice(
              0,
              Math.max(0, payload.quoted.text.length - (detail.length - 3900)),
            );
            payload.quoted.truncated = true;
          } else {
            payload.question = payload.question.slice(0, Math.max(0, payload.question.length - (detail.length - 3900)));
            payload.truncated = true;
          }
          detail = JSON.stringify(payload);
        }
        await this.onQuestion({
          id: "owner-question:" + createHash("sha256").update(m.message_id).digest("hex"),
          type: "company.owner.question",
          subject: "owner",
          summary: "负责人向 CEO 提问",
          detail,
        });
        this.state.seen.push(m.message_id);
        this.state.seen = this.state.seen.slice(-2000);
        this.save();
        continue;
      }
      const card = Number(match[1]),
        saved = this.state.cards[card],
        text = match[2].trim();
      if (!saved?.open || !saved.ref || !text || text.length > 4000) continue;
      const choice = /^[1-5]$/.test(text) ? Number(text) - 1 : null;
      if (choice !== null && choice >= saved.options.length) continue;
      try {
        await this.hub.answer(card, { ...(choice === null ? { text } : { choice }), by: this.owner, ref: saved.ref });
      } catch (error) {
        if (!(error instanceof HubError) || error.status !== 409) throw error;
      }
      this.state.seen.push(m.message_id);
      this.state.seen = this.state.seen.slice(-2000);
      saved.open = false;
      this.save();
    }
  }
  async poll() {
    const end = new Date().toISOString(),
      start = new Date(Date.parse(this.state.cursor) - 120_000).toISOString();
    let page: string | undefined;
    do {
      const args = [
        "im",
        "+chat-messages-list",
        "--as",
        "bot",
        "--user-id",
        this.owner,
        "--format",
        "json",
        "--sort",
        "asc",
        "--page-size",
        "50",
        "--start",
        start,
        "--end",
        end,
      ];
      if (page) args.push("--page-token", page);
      const response = await this.lark(args),
        data = response.data;
      if (!Array.isArray(data?.messages)) throw new Error("飞书未返回消息列表");
      await this.receive(data.messages);
      if (data.has_more && !data.page_token) throw new Error("飞书分页未返回游标");
      page = data.has_more ? data.page_token : undefined;
    } while (page);
    this.state.cursor = end;
    this.save();
  }
}
export default async function companyChannel({ hub, options, signal, log }: ChannelContext) {
  const program = typeof options.lark === "string" ? options.lark : "lark-cli";
  const lark = (args: string[]) =>
    new Promise<any>((resolve, reject) => {
      execFile(program, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000, signal }, (error, out) => {
        if (error) {
          reject(new Error("飞书 CLI 请求失败，请检查授权与网络"));
          return;
        }
        try {
          const result = JSON.parse(out);
          if (result.ok === false || result.error || (typeof result.code === "number" && result.code !== 0))
            throw new Error(JSON.stringify(result.error).slice(0, 300));
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });
  let onQuestion: CompanyFeishu["onQuestion"];
  let openCards: (() => Promise<Card[]>) | undefined;
  if (typeof options.inboxFile === "string") {
    if (!isAbsolute(options.inboxFile)) throw Error("需要公司收件配置绝对路径");
    const config = JSON.parse(readFileSync(options.inboxFile, "utf8"));
    if (config.source?.name !== "company-inbox" || typeof config.source.key !== "string")
      throw Error("公司收件来源未配置");
    onQuestion = hubClient(config.url, config.source.key).event;
    if (options.cards === true && typeof config.owner === "string")
      openCards = async () =>
        (await hubClient(config.url, config.owner).state()).cards.filter(
          (c: Card) => c.kind === "ask" && c.state === "open",
        );
  }
  const bridge = new CompanyFeishu(
    String(options.stateFile ?? ""),
    String(options.user ?? ""),
    hub,
    lark,
    onQuestion,
    options.cards === true,
  );
  if (openCards) for (const card of await openCards()) await bridge.deliver(card);
  const pause = () => delay(30_000, undefined, { signal }).catch(() => {});
  const deliver = async () => {
    while (!signal.aborted) {
      try {
        const { card } = await hub.nextCard(30);
        if (card)
          try {
            await bridge.deliver(card);
          } catch (e) {
            await hub.failed(card.id, card.version, String(e));
          }
      } catch (e) {
        if (!signal.aborted) {
          log(String(e));
          await pause();
        }
      }
    }
  };
  const poll = async () => {
    while (!signal.aborted) {
      try {
        await bridge.poll();
      } catch (e) {
        if (!signal.aborted) log(`CEO 飞书回复读取失败：${e}`);
      }
      await pause();
    }
  };
  const callbacks = async () => {
    if (options.cardCallbacks !== true) return;
    const spool = String(options.stateFile) + ".callbacks";
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    const listen = async () => {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const child = spawn(
            program,
            ["event", "+subscribe", "--event-types", "card.action.trigger", "--output-dir", ".", "--quiet"],
            { signal, cwd: spool, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
          );
          // npm's CLI shim spawns the Go binary; terminate the owned process group on shutdown.
          const stopListener = () => {
            if (child.pid && process.platform !== "win32")
              try {
                process.kill(-child.pid, "SIGTERM");
              } catch {}
          };
          signal.addEventListener("abort", stopListener, { once: true });
          if (signal.aborted) stopListener();
          let diagnostic = "";
          const capture = (chunk: Buffer) => {
            diagnostic = (diagnostic + chunk.toString()).slice(-8192);
          };
          child.stdout?.on("data", capture);
          child.stderr?.on("data", capture);
          child.on("error", (error) => {
            diagnostic = error.message;
          });
          child.on("close", () => {
            signal.removeEventListener("abort", stopListener);
            if (!signal.aborted) writeFileSync(join(spool, "connection.log"), diagnostic, { mode: 0o600 });
            resolve();
          });
        });
        if (!signal.aborted) {
          log("飞书卡片连接中断，正在重连");
          await pause();
        }
      }
    };
    const consume = async () => {
      while (!signal.aborted) {
        for (const file of readdirSync(spool).filter((f) => f.endsWith(".json"))) {
          try {
            await bridge.receiveAction(JSON.parse(readFileSync(join(spool, file), "utf8")));
            unlinkSync(join(spool, file));
          } catch {
            log("飞书卡片操作暂未提交，将重试");
          }
        }
        await delay(1000, undefined, { signal }).catch(() => {});
      }
    };
    await Promise.all([listen(), consume()]);
  };
  await Promise.all([deliver(), poll(), callbacks()]);
}
