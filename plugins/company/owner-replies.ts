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
      topicBatch: typeof detail.topicBatch === "string" ? detail.topicBatch : undefined,
      topicChoice: detail.topicChoice as import("./topics.ts").TopicChoice | undefined,
      at: String(row.received_at),
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

export async function syncTopicCards(directory: string, hub: Pick<Hub, "resolve">) {
  const db = new DatabaseSync(join(directory, "operations.db"), { readOnly: true });
  const h = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  h.function("card_token", { deterministic: true }, (_id, _at) => null);
  try {
    for (const row of db.prepare("SELECT body FROM projects").all()) {
      const p = JSON.parse(String(row.body)) as import("./operations.ts").Project;
      for (const b of p.topicBatches?.filter((b) => b.closed) ?? []) {
        for (const card of h.prepare("SELECT id FROM cards WHERE state='open' AND about=?").all(`topics:${b.id}`)) {
          await hub.resolve(Number(card.id), "该批选题已逐条记录董事长决定");
        }
      }
    }
  } finally {
    db.close();
    h.close();
  }
}
