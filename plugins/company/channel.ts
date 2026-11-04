// This company channel uses the installed CLI's supported shortcuts, not a second WebSocket listener.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HubError } from "../../protocol/client.ts";
import type { Card, ChannelContext } from "../../host/channels.ts";
type Message = {
  message_id: string;
  msg_type: string;
  sender?: { id?: string; sender_type?: string };
  content?: string;
  deleted?: boolean;
};
type Saved = { version: number; ref: string; open: boolean; options: string[] };
type State = { cards: Record<string, Saved>; seen: string[]; cursor: string };
export class CompanyFeishu {
  private file: string;
  private owner: string;
  private state: State;
  private hub: ChannelContext["hub"];
  private lark: (args: string[]) => Promise<any>;
  constructor(file: string, owner: string, hub: ChannelContext["hub"], lark: (args: string[]) => Promise<any>) {
    if (!isAbsolute(file) || !/^ou_[A-Za-z0-9]+$/.test(owner)) throw new Error("需要飞书本人 open_id 和绝对状态路径");
    this.file = file;
    this.owner = owner;
    this.hub = hub;
    this.lark = lark;
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
    if (!saved || saved.version < card.version) {
      let text: string;
      if (card.state === "open")
        text = `${card.title}\n\n${card.text}${card.kind === "ask" ? `\n\n请回复：C${card.id} 你的回答\n也可回复：${card.options.map((o, i) => `C${card.id} ${i + 1}（${o}）`).join("；")}` : ""}`;
      else
        text = `CEO · C${card.id}\n${card.state === "decided" ? "已收到你的答复，CEO 将处理并反馈员工。" : card.result || "此事项已处理。"}`;
      // Persist the original message reference: owner authentication remains bound to that question.
      const key =
        "company-" + createHash("sha256").update(`${this.file}:${card.id}:${card.version}`).digest("hex").slice(0, 32);
      const sent = await this.lark([
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--user-id",
        this.owner,
        "--text",
        text,
        "--idempotency-key",
        key,
      ]);
      const ref = saved?.ref ?? card.ref ?? sent.data?.message_id;
      if (typeof ref !== "string" || !ref.startsWith("om_")) throw new Error("飞书未返回有效消息编号");
      saved = { ref, version: card.version, open: card.kind === "ask" && card.state === "open", options: card.options };
      this.state.cards[card.id] = saved;
      this.save();
    }
    await this.hub.delivered(card.id, card.version, saved.ref);
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
      const match = /^\s*#?C(\d+)\s+([\s\S]+)$/i.exec(m.content ?? "");
      if (!match) continue;
      const card = Number(match[1]),
        saved = this.state.cards[card],
        text = match[2].trim();
      if (!saved?.open || !text || text.length > 4000) continue;
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
          if (result.ok === false || result.error) throw new Error(JSON.stringify(result.error).slice(0, 300));
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });
  const bridge = new CompanyFeishu(String(options.stateFile ?? ""), String(options.user ?? ""), hub, lark);
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
  await Promise.all([deliver(), poll()]);
}
