import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Leadership } from "./executive.ts";
import type { Hub } from "../../protocol/client.ts";

// Semantic matching belongs to the CEO. Evidence and card identity are checked here,
// against authenticated hub events rather than text invented in a model receipt.
export function ownerReplyEvidence(directory: string, event: number, after: string) {
  const db = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT source,type,detail,received_at FROM events WHERE id=?").get(event);
    if (
      !row ||
      row.source !== "company-inbox" ||
      row.type !== "company.owner.question" ||
      !(Date.parse(String(row.received_at)) >= Date.parse(after))
    )
      throw Error("负责人答复必须引用提问后实际收到的本人消息");
    const detail = JSON.parse(String(row.detail));
    if (
      typeof detail.question !== "string" ||
      !detail.question.trim() ||
      detail.question.length > 4000 ||
      detail.truncated ||
      typeof detail.message !== "string" ||
      !detail.message.trim()
    )
      throw Error("负责人原话不完整，不能据此关闭问题");
    return {
      text: detail.question,
      message: detail.message,
      context: typeof detail.quoted?.text === "string" ? detail.quoted.text.slice(0, 2200) : undefined,
    };
  } finally {
    db.close();
  }
}

export async function syncOwnerReplyCards(directory: string, leadership: Leadership, hub: Pick<Hub, "answer">) {
  const replies = leadership.questions.filter((q) => q.state === "answered" && q.answerEvent);
  if (!replies.length) return;
  const db = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  db.function("card_token", { deterministic: true }, (_id, _at) => null);
  try {
    for (const q of replies) {
      const evidence = ownerReplyEvidence(directory, q.answerEvent!, q.at);
      if (q.answer !== evidence.text) throw Error("负责人答复与原消息不一致");
      const cards = db.prepare("SELECT id FROM cards WHERE kind='ask' AND state='open' AND about=?").all(`ceo:${q.id}`);
      for (const card of cards) await hub.answer(Number(card.id), { text: evidence.text });
    }
  } finally {
    db.close();
  }
}
