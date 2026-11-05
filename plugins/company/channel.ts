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
type Saved = { version: number; ref: string | null; open: boolean; options: string[]; acknowledged?: boolean };
type State = { cards: Record<string, Saved>; seen: string[]; cursor: string };
const bookkeeping = new Set(["经营周期已检查", "公司任务状态已更新", "此事项已处理", "已处理"]);
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
      // Old closed states have already sent their acknowledgement; do not replay them on upgrade.
      const acknowledged = saved?.acknowledged ?? (!!saved && saved.version > 1 && !saved.open);
      let text: string | null;
      if (card.state === "open")
        text = `${card.title}\n\n${card.text}${card.kind === "ask" ? `\n\n请回复：#${card.id} 你的回答\n也可回复：${card.options.map((o, i) => `#${card.id} ${i + 1}（${o}）`).join("；")}` : ""}`;
      else text = updateText(card, acknowledged);
      // Persist the original message reference: owner authentication remains bound to that question.
      let ref = saved?.ref ?? card.ref;
      if (text) {
        const version = card.state !== "open" && text.startsWith("答复已记录\n") ? "answer" : card.version;
        const key =
          "company-" + createHash("sha256").update(`${this.file}:${card.id}:${version}`).digest("hex").slice(0, 32);
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
        if (typeof sent.data?.message_id !== "string" || !sent.data.message_id.startsWith("om_"))
          throw new Error("飞书未返回有效消息编号");
        ref ??= sent.data.message_id;
      }
      saved = {
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
      if (!match) continue;
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
