// Failure modes: a quoted/explicitly titled opinion disappears after a button closes the card,
// unrelated or forged text attaches to another manuscript, or supplementary feedback confirms publication.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ownerCardFeedback } from "../plugins/company/owner-replies.ts";
import { Operations } from "../plugins/company/operations.ts";

test("closed publication and X cards retain authenticated quoted or titled feedback in CEO and employee notes", () => {
  const dir = mkdtempSync(join(tmpdir(), "card-feedback-"));
  mkdirSync(join(dir, "hub"));
  mkdirSync(join(dir, "publications"));
  const h = new DatabaseSync(join(dir, "hub/hub.db"));
  const o = new Operations(dir);
  o.leadership(true);
  const db = new DatabaseSync(join(dir, "operations.db"));
  const key = "a".repeat(32),
    at = "2026-11-09T05:33:00Z";
  try {
    h.exec(
      "CREATE TABLE events(id INTEGER PRIMARY KEY,key TEXT,source TEXT,type TEXT,detail TEXT,received_at TEXT); CREATE TABLE card_rows(id INTEGER PRIMARY KEY,text TEXT,created_at TEXT,state TEXT); CREATE VIEW cards AS SELECT *,card_token(id,created_at) AS token FROM card_rows",
    );
    h.function("card_token", { deterministic: true }, (_id, _at) => null);
    for (const id of [1, 2])
      h.prepare("INSERT INTO card_rows VALUES (?,?,?,'done')").run(id, `发布稿件：${key}`.replace(/^/, "卡片\n"), at);
    writeFileSync(
      join(dir, "publications", key + ".json"),
      JSON.stringify({
        key,
        business: "app",
        plan: "plan",
        artifacts: [{ path: "rabbitrun.json", content: JSON.stringify({ title: "测试稿件" }) }],
      }),
    );
    const p = (o as any).get("app");
    p.plans.push({ id: "plan", owner: "growth", title: "测试计划", status: "blocked", result: "缺少意见" } as any);
    db.prepare("INSERT INTO projects VALUES (?,?)").run("app", JSON.stringify(p));
    const add = (id: number, question: string, quoted?: object, source = "company-inbox") => {
      const detail = JSON.stringify({ question, message: `om_reply${id}`, quoted });
      h.prepare("INSERT INTO events VALUES (?,?,?,?,?,?)").run(
        id,
        `owner-question:${id}`,
        source,
        "company.owner.question",
        detail,
        at,
      );
      return { id: `owner-question:${id}`, source, type: "company.owner.question", subject: "owner", detail };
    };
    const events = [
      add(1, "选题不好", { card: 1 }),
      add(2, "《测试稿件》请换角度"),
      add(3, "X卡片的文字有误", { card: 2 }),
    ];
    for (const e of events) assert.equal(ownerCardFeedback(dir, e.id)?.plan, "plan");
    assert.equal(ownerCardFeedback(dir, add(4, "无关留言").id), undefined);
    assert.equal(ownerCardFeedback(dir, add(5, "测试稿件", { card: 999 }).id), undefined);
    assert.throws(() => ownerCardFeedback(dir, add(6, "测试稿件", undefined, "company-growth").id), /本人消息/);
    o.plan("feedback", [], [], new Date(at), [], 4, events);
    o.plan("replayed", [], [], new Date(at), [], 4, events);
    assert.equal(o.executive().knowledge.length, 3);
    assert.match(o.notes("ceo").text, /选题不好/);
    assert.match(o.notes("app:growth").text, /请换角度/);
    assert.equal((o as any).get("app").plans[0].status, "blocked");
    assert.equal(h.prepare("SELECT count(*) n FROM cards WHERE state='done'").get()!.n, 2);
  } finally {
    db.close();
    o.close();
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
