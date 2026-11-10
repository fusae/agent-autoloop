import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Card } from "../../host/channels.ts";

// The hub ends a model turn before the business coordinator applies its actions.
// Render completion from that coordinator's durable receipt, never the model's claim.
export function decisionCard(directory: string, card: Card): Card {
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
