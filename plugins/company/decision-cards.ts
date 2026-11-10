import { manualXKey } from "./rabbitrun.ts";
import { publicationResults } from "./publication-policy.ts";
import { squareStatus } from "./rabbitrun-receipt.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Card } from "../../host/channels.ts";

// The hub ends a model turn before the business coordinator applies its actions.
// Render completion from that coordinator's durable receipt, never the model's claim.
export function decisionCard(directory: string, card: Card): Card {
  const results = publicationResults(directory);
  const manual = results.find((p) => p.key === manualXKey(card));
  // /tell creates a closed FYI at version 1, not a user-dismissed notice.
  if (manual?.x && card.state === "closed" && card.version === 1 && card.result === null)
    return {
      ...card,
      state: manual.x.state === "published" ? "closed" : "open",
      result: manual.x.state === "published" ? "X 已发" : null,
    };
  const proof = results.find((p) => p.confirmation?.card === card.id);
  if (proof)
    return {
      ...card,
      state: "done",
      result: `${squareStatus(proof)}；发布阻塞已解除；${proof.x?.state === "published" ? "X 已发" : "X 待发，请使用本篇手动发布卡片"}`,
    };
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return card;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='batches'").get()) return card;
    const row = db
      .prepare(
        `SELECT body FROM batches WHERE id LIKE 'ceo-chat-%'
      AND EXISTS (SELECT 1 FROM json_each(batches.body, '$.completionCards') WHERE value=?)
      ORDER BY rowid DESC LIMIT 1`,
      )
      .get(card.id);
    if (!row) return card;
    const result = JSON.parse(String(row.body));
    return { ...card, state: "done", result: result.failed ? "未成功，CEO 正在重试；处理结果尚未确认。" : result.text };
  } finally {
    db.close();
  }
}

export async function syncDecisionCards(
  directory: string,
  hub: Pick<import("../../protocol/client.ts").Hub, "resolve">,
) {
  const db = new DatabaseSync(join(directory, "operations.db"), { readOnly: true });
  const h = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  h.function("card_token", { deterministic: true }, (_id, _at) => null);
  try {
    for (const row of db
      .prepare("SELECT body FROM batches WHERE id LIKE 'ceo-chat-%' AND json_extract(body,'$.failed')=0")
      .all()) {
      const result = JSON.parse(String(row.body));
      for (const id of result.completionCards ?? []) {
        if (h.prepare("SELECT id FROM cards WHERE id=? AND state='open'").get(id))
          await hub.resolve(id, result.text.slice(0, 4000));
      }
    }
  } finally {
    db.close();
    h.close();
  }
}

export function publicationDecisionCards(directory: string): Card[] {
  const results = publicationResults(directory);
  if (!results.length) return [];
  const ids = results.flatMap((p) => (p.confirmation ? [p.confirmation.card] : []));
  const h = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  try {
    return h
      .prepare("SELECT data FROM projections WHERE collection='cards'")
      .all()
      .flatMap((r) => {
        const card = JSON.parse(String(r.data));
        if (!ids.includes(card.id) && !results.some((p) => p.x && p.key === manualXKey(card))) return [];
        return [
          {
            ...card,
            options: typeof card.options === "string" ? JSON.parse(card.options) : card.options,
            ref: null,
            link: null,
          },
        ];
      });
  } finally {
    h.close();
  }
}
