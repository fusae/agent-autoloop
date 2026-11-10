// Prevent remote command injection, SQL writes, file escapes, credential leakage and unbounded query results.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { argumentsFor, quote, tools } from "../cli/company-mcp.ts";
import { readonlyQuery, sanitize } from "../cli/company-readonly.ts";

test("single SELECT/WITH only, immutable database, bounded rows and denied SQLite side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "company-ro-"));
  try {
    const db = new DatabaseSync(join(root, "operations.db"));
    db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('normal')");
    db.close();
    const before = readFileSync(join(root, "operations.db"));
    const query = (sql: string) => JSON.parse(readonlyQuery(root, "sql", ["operations", sql]));
    assert.deepEqual(query("SELECT * FROM sample").rows, [{ value: "normal" }]);
    assert.equal(query("SELECT ';DELETE' AS text;").rows[0].text, ";DELETE");
    const bounded = query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<250) SELECT x FROM n");
    assert.equal(bounded.rows.length, 200);
    assert.equal(bounded.truncated, true);
    for (const sql of [
      "DELETE FROM sample",
      "WITH x AS (SELECT 1) DELETE FROM sample",
      "SELECT 1; DELETE FROM sample",
      "PRAGMA writable_schema=ON",
      "ATTACH '/tmp/other' AS other",
      "SELECT load_extension('bad')",
      "SELECT * FROM pragma_table_info('sample')",
      "SELECT randomblob(999999999)",
    ])
      assert.throws(() => query(sql), /拒绝/);
    assert.throws(() => readonlyQuery(root, "sql", ["../other", "SELECT 1"]));
    assert.deepEqual(readFileSync(join(root, "operations.db")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file paths reject traversal, symlinks, sensitive names, oversized data and sanitize nested JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "company-ro-"));
  try {
    mkdirSync(join(root, "workspace"));
    writeFileSync(
      join(root, "workspace", "notes.txt"),
      "正文\nCookie: a=firstsecret; b=secondsecret\nopen_id=ou_fixture\nchat_id=oc_fixture\napi_key=privatevalue\n192.0.2.1\n2001:db8::1",
    );
    writeFileSync(join(root, ".env"), "PRIVATE=yes");
    writeFileSync(join(root, "large.txt"), "a".repeat(200 * 1024 + 1));
    symlinkSync("/etc", join(root, "escape"));
    symlinkSync(join(root, ".env"), join(root, "indirect.txt"));
    for (const path of [
      "../outside",
      "/etc/passwd",
      "escape/passwd",
      "indirect.txt",
      ".env",
      "key.json",
      "cookie.json",
      "credentials",
      "feishu/config.json",
      "large.txt",
    ])
      assert.throws(() => readonlyQuery(root, "read", [path]), /拒绝/);
    const out = readonlyQuery(root, "read", ["workspace/notes.txt"]);
    assert.match(out, /正文/);
    for (const secret of [
      "firstsecret",
      "secondsecret",
      "ou_fixture",
      "oc_fixture",
      "privatevalue",
      "192.0.2.1",
      "2001:db8::1",
    ])
      assert.ok(!out.includes(secret));
    assert.ok(!readonlyQuery(root, "ls", ["."]).includes('".env"'));
    assert.deepEqual(sanitize({ body: JSON.stringify({ token: "shortsecret", title: "标题" }) }), {
      body: { title: "标题" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential fields remain hidden even with short values, while SQL text types survive", () => {
  assert.deepEqual(sanitize({ owner: "short", worker: { key: "small" }, account: "personal", title: "123" }), {
    worker: {},
    title: "123",
  });
});

test("MCP exposes exactly six reads and shell quotes hostile arguments as inert data", () => {
  assert.equal(tools.length, 6);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
  assert.deepEqual(argumentsFor("company_logs", { service: "agent-company", keyword: "hello" }), [
    "logs",
    "agent-company",
    "60",
    "hello",
  ]);
  for (const [name, args] of [
    ["company_write", {}],
    ["company_status", { cmd: "rm" }],
    ["company_sql", { database: "bad", query: "SELECT 1" }],
    ["company_logs", { service: "sshd" }],
    ["company_logs", { service: "agent-company", minutes: -1 }],
  ])
    assert.throws(() => argumentsFor(name as string, args));
  const hostile = "'; $(echo BAD); `echo BAD`\n--help";
  const result = spawnSync("/bin/sh", ["-c", "printf %s " + quote(hostile)], { encoding: "utf8" });
  assert.equal(result.stdout, hostile);
  assert.throws(() => readonlyQuery("/missing", "write", []));
  assert.throws(() => readonlyQuery("/missing", "logs", ["sshd"]));
});

test("stdio handshake lists reads and rejects unknown tools without invoking SSH", () => {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "company_delete", arguments: {} } },
  ];
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "cli/company-mcp.ts"], {
    encoding: "utf8",
    input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[1].result.tools.length, 6);
  assert.equal(responses[2].result.isError, true);
});

test("XHS status uses one GET, exposes no identities and never starts login or publication", async () => {
  const { readXhsStatus } = await import("../plugins/xiaohongshu/status.ts");
  const config = { endpoint: "http://127.0.0.1:18060", token: "fixture", enabled: true };
  let calls = 0;
  const fake = (async (url: any, init: any) => {
    calls++;
    assert.equal(new URL(url).pathname, "/api/v1/login/status");
    assert.equal(init.method, "GET");
    return new Response(JSON.stringify({ success: true, data: { is_logged_in: true, user_id: "must-not-leak" } }));
  }) as typeof fetch;
  const result = await readXhsStatus(config, { action: "status" }, fake, () => "active");
  assert.equal(calls, 1);
  assert.equal(result.login, "已登录");
  assert.ok(!JSON.stringify(result).includes("must-not-leak"));
  await assert.rejects(readXhsStatus(config, { action: "status", publish: true }, fake));
  assert.equal(calls, 1);
});

test("forced SSH command rejects shell, sudo escape, forwarding probes and malformed quoting", () => {
  for (const command of [
    "",
    "id",
    "sudo -n id",
    "sudo -n /usr/local/libexec/company-ro",
    "sudo -n /usr/local/libexec/company-ro status ; id extra extra",
    "sudo -n /usr/local/libexec/company-ro 'unterminated",
  ]) {
    const r = spawnSync("/usr/bin/python3", ["plugins/company/readonly-ssh.py"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /拒绝/);
  }
});
