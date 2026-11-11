import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { rabbitDraft, type RabbitRequest } from "./rabbitrun.ts";

export type OwnerConfirmation = { source: "chairman"; card: number; event: number; at: string };
export type SquareReceipt = { remoteId: string; url: string; confirmation?: OwnerConfirmation };

export function squareLink(value: string) {
  const u = new URL(value);
  const id =
    u.hostname === "www.binance.com"
      ? /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?square\/post\/(\d{1,30})\/?$/.exec(u.pathname)?.[1]
      : u.hostname === "app.binance.com"
        ? /^\/uni-qr\/cpos\/(\d{1,30})\/?$/.exec(u.pathname)?.[1]
        : undefined;
  if (u.protocol !== "https:" || u.port || u.username || u.password || !id) throw Error("需要币安广场帖子链接");
  return { remoteId: id, url: `https://www.binance.com/square/post/${id}` };
}

export const squareStatus = (proof: SquareReceipt) =>
  proof.confirmation ? `董事长确认已发${proof.url ? `：${proof.url}` : "，链接待补"}` : `币安广场已发布：${proof.url}`;

const normalize = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

// Only authenticated answers to the publication exception for this frozen draft count.
// General chat, publish approval and a CEO's own assertion are not publication evidence.
export function rabbitConfirmation(
  directory: string,
  request: RabbitRequest,
  startedAt: string,
): SquareReceipt | undefined {
  const draft = rabbitDraft(request);
  const db = new DatabaseSync(join(directory, "operations.db"), { readOnly: true });
  const hub = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM leadership WHERE id='company'").get();
    if (!row) return;
    const chief = JSON.parse(String(row.body));
    for (const r of hub.prepare("SELECT data FROM projections WHERE collection='cards' ORDER BY rowid").all()) {
      const c = JSON.parse(String(r.data));
      if (
        c.kind !== "ask" ||
        c.agent !== "company-business" ||
        c.grp !== "company-business" ||
        !c.by ||
        !Number.isSafeInteger(c.answer_event) ||
        !["decided", "done", "closed"].includes(c.state) ||
        !(Date.parse(c.decided_at) >= Date.parse(startedAt)) ||
        !(Date.parse(c.created_at) >= Date.parse(startedAt))
      )
        continue;
      const q = chief.questions.find((q: any) => `ceo:${q.id}` === c.about);
      if (
        !q ||
        !q.issues.some((id: string) => chief.issues.some((i: any) => i.id === id && i.business === "rabbitrun"))
      )
        continue;
      const context = normalize(c.text);
      if (
        !context.includes(`《${normalize(draft.title)}》`) ||
        !/币安/.test(context) ||
        !/发布(?:结果未知|异常|失败|受阻)|(?:未|没)拿到.*回执/.test(context)
      )
        continue;
      const options = typeof c.options === "string" ? JSON.parse(c.options) : c.options;
      const answer = [c.choice === null ? "" : options[c.choice], c.answer].filter(Boolean).join("；").trim();
      const links = answer.match(/https:\/\/[^\s；，。]+/g) ?? [];
      const words = answer.replace(/https:\/\/[^\s；，。]+/g, "").replace(/[\s；，。！!：:]/g, "");
      if (!/^(?:(?:币安(?:广场)?|我)?(?:确认)?已(?:发出|发布|发)(?:了)?)+$/.test(words) || links.length > 1) continue;
      let link = { remoteId: "", url: "" };
      if (links.length) {
        try {
          link = squareLink(links[0]!);
        } catch {
          continue;
        }
      }
      return { ...link, confirmation: { source: "chairman", card: c.id, event: c.answer_event, at: c.decided_at } };
    }
  } finally {
    db.close();
    hub.close();
  }
}
