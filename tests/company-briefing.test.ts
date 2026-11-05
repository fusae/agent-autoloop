// Failure modes: CEO answers from stale snapshots, forgets owner decisions, leaks credentials,
// or a read query creates/modifies business data; rule upgrades omit chat or duplicate it.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { companyBriefing } from "../plugins/company/briefing.ts";
import { initialize, ensureBusinessRules } from "../plugins/company/setup.ts";

test("CEO reads current decisions and task responsibility without creating missing stores or exposing config", () => {
  const dir = mkdtempSync(join(tmpdir(), "ceo-briefing-"));
  try {
    writeFileSync(
      join(dir, "company.json"),
      JSON.stringify({ name: "公司", database: join(dir, "company.db"), secret: "PRIVATE" }),
    );
    const before = readdirSync(dir);
    assert.ok(companyBriefing(dir).unavailable.length);
    assert.deepEqual(readdirSync(dir), before);
    const db = new DatabaseSync(join(dir, "operations.db"));
    db.exec("CREATE TABLE leadership(id TEXT,body TEXT); CREATE TABLE projects(id TEXT,body TEXT)");
    const state = {
      enabled: true,
      briefs: { app: "维护现有业务" },
      knowledge: [{ source: "owner", answer: "0 收入 0 支出", at: "2026-11-05" }],
      questions: [],
      issues: [],
      decisions: [],
    };
    db.prepare("INSERT INTO leadership VALUES ('company',?)").run(JSON.stringify(state));
    mkdirSync(join(dir, "workspace/knowledge"), { recursive: true });
    writeFileSync(join(dir, "workspace/knowledge/ceo.json"), JSON.stringify({ knowledge: "旧数据：未提供收入" }));
    let brief = companyBriefing(dir);
    assert.match(JSON.stringify(brief), /0 收入 0 支出/);
    assert.doesNotMatch(JSON.stringify(brief), /PRIVATE|未提供收入/);
    state.knowledge.push({ source: "owner", answer: "两个 APP 都安装测试过", at: "2026-11-05" });
    db.prepare("UPDATE leadership SET body=?").run(JSON.stringify(state));
    brief = companyBriefing(dir);
    assert.match(JSON.stringify(brief), /两个 APP 都安装测试过/);
    const queried = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../plugins/company/briefing.ts"), dir, "--section", "knowledge"],
      { encoding: "utf8" },
    );
    assert.equal(queried.status, 0, queried.stderr);
    assert.match(queried.stdout, /两个 APP 都安装测试过/);
    assert.doesNotMatch(queried.stdout, /PRIVATE|未提供收入/);
    assert.deepEqual(JSON.parse(db.prepare("SELECT body FROM leadership").get()!.body as string), state);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new and upgraded rules keep chat read-only and refresh CEO knowledge without duplicating channels", () => {
  const parent = mkdtempSync(join(tmpdir(), "ceo-rules-")),
    dir = join(parent, "company");
  try {
    const rules = initialize(dir);
    const chat = rules.rules.find((r) => r.name === "CEO · 业务答复")!;
    assert.ok(chat);
    assert.equal(chat.to, "company-ceo");
    assert.equal("emits" in chat, false);
    assert.match(chat.prompt, /briefing.ts/);
    assert.match(rules.rules.find((r) => r.name === "公司部门-ceo")!.prompt, /briefing.ts/);
    mkdirSync(join(dir, "hub"));
    rules.rules = rules.rules.filter((r) => r.name !== chat.name);
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(rules));
    writeFileSync(
      join(dir, "hub/config.json"),
      JSON.stringify({ channels: { "company-feishu": { use: "company", key: "secret", lark: "/custom/lark" } } }),
    );
    ensureBusinessRules(dir);
    const first = readFileSync(join(dir, "hub/rules.json"), "utf8");
    ensureBusinessRules(dir);
    assert.equal(readFileSync(join(dir, "hub/rules.json"), "utf8"), first);
    assert.equal(JSON.parse(first).rules.filter((r: any) => r.name === chat.name).length, 1);
    const channel = JSON.parse(readFileSync(join(dir, "hub/config.json"), "utf8")).channels["company-feishu"];
    assert.equal(channel.lark, "/custom/lark");
    assert.equal(channel.key, "secret");
    assert.equal(channel.inboxFile, join(dir, "hub/config.json"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
