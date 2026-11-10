import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Leadership } from "./executive.ts";
import type { Hub } from "../../protocol/client.ts";

// Semantic matching belongs to the CEO. Evidence and card identity are checked here,
// against authenticated hub events rather than text invented in a model receipt.
export function ownerReplyEvidence(directory: string, event: number | string, after: string) {
  const db = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT id,source,type,detail,received_at FROM events WHERE ${typeof event === "number" ? "id" : "key"}=? AND source='company-inbox'`,
      )
      .get(event);
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
      event: Number(row.id),
      card: Number.isSafeInteger(detail.quoted?.card) ? Number(detail.quoted.card) : undefined,
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

export function ownerCardMessage(directory: string, card: number) {
  const file = join(directory, "hub/hub.db");
  if (!existsSync(file)) return `card:${card}`;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE name='deliveries'").get();
    const row = table
      ? db.prepare("SELECT ref FROM deliveries WHERE card_id=? AND ref IS NOT NULL LIMIT 1").get(card)
      : undefined;
    return String(row?.ref ?? `card:${card}`);
  } finally {
    db.close();
  }
}

export function ownerAnswerEvidence(directory: string, card: number, after: string) {
  const db = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  db.function("card_token", { deterministic: true }, (_id, _at) => null);
  try {
    const row = db.prepare("SELECT * FROM cards WHERE id=?").get(card);
    if (!row || !row.answer_event || !row.decided_at || Date.parse(String(row.decided_at)) < Date.parse(after))
      throw Error("拍板必须引用实际收到回答的卡片");
    const options = JSON.parse(String(row.options));
    const selected = row.choice === null ? "" : options[Number(row.choice)];
    const text = [selected, row.answer].filter(Boolean).join("；");
    if (!text.trim()) throw Error("卡片没有董事长决定");
    const delivery = db.prepare("SELECT ref FROM deliveries WHERE card_id=? AND ref IS NOT NULL LIMIT 1").get(card);
    return {
      card,
      event: Number(row.answer_event),
      at: String(row.decided_at),
      text,
      message: String(delivery?.ref ?? `card:${card}`),
      context: `${row.text}\n${row.about}`,
      topicBatch: undefined,
      topicChoice: undefined,
    };
  } finally {
    db.close();
  }
}

// Supplementary opinions are knowledge only: a chat message never confirms publication or X completion.
export function ownerCardFeedback(directory: string, event: number | string) {
  if (!existsSync(join(directory, "publications"))) return undefined;
  const evidence = ownerReplyEvidence(directory, event, "1970-01-01T00:00:00Z");
  const db = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  db.function("card_token", { deterministic: true }, (_id, _at) => null);
  try {
    const matches = new Map<string, { business: string; plan: string; title: string; card: number }>();
    for (const row of db
      .prepare("SELECT id,text,created_at FROM cards WHERE created_at<=? ORDER BY id")
      .all(evidence.at)) {
      const key = /\n发布稿件：([a-f0-9]{32})$/.exec(String(row.text))?.[1];
      if (!key) continue;
      const file = join(directory, "publications", key + ".json");
      if (!existsSync(file)) continue;
      const request = JSON.parse(readFileSync(file, "utf8"));
      const artifact = request.artifacts.find((a: any) => /(?:^|\/)(?:xiaohongshu|rabbitrun)\.json$/.test(a.path));
      const title = artifact ? JSON.parse(artifact.content).title : undefined;
      if (typeof title !== "string" || !title.trim()) continue;
      if (evidence.card !== undefined ? evidence.card !== Number(row.id) : !evidence.text.includes(title)) continue;
      matches.set(`${request.business}:${request.plan}`, {
        business: request.business,
        plan: request.plan,
        title,
        card: Number(row.id),
      });
    }
    return matches.size === 1 ? { ...evidence, ...[...matches.values()][0] } : undefined;
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
