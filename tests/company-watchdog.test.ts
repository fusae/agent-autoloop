// Failure modes: engine outage disables its own monitor; heartbeat stalls are missed; retries spam or leak credentials;
// a lost send response generates another message ID, or an unacknowledged send is recorded as delivered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWatchdog, type WatchdogState } from "../plugins/company/watchdog.ts";
const now = new Date("2026-11-09T03:00:00Z");
const good = () => ({
  services: ["引擎", "后台", "回调"].map((label) => ({ name: label, label, ok: true })),
  heartbeat: now.toISOString(),
});
test("independent service failures and stale heartbeats notify once, with a 24-hour cooldown and worsening exception", async () => {
  const state: WatchdogState = { startedAt: now.toISOString() },
    sent: string[] = [];
  const send = async (_key: string, text: string) => {
      sent.push(text);
    },
    save = () => {};
  assert.equal((await checkWatchdog(state, good(), now, save, send)).healthy, true);
  const check = good();
  check.services[0].ok = false;
  await checkWatchdog(state, check, now, save, send);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /发生：[\s\S]*影响：[\s\S]*已尝试：[\s\S]*需要董事长：/);
  await checkWatchdog(state, check, new Date(+now + 60000), save, send);
  assert.equal(sent.length, 1);
  check.services[1].ok = false;
  await checkWatchdog(state, check, new Date(+now + 120000), save, send);
  assert.equal(sent.length, 2);
  check.heartbeat = new Date(+now + 86400_000).toISOString();
  await checkWatchdog(state, check, new Date(+now + 86400_000 + 120000), save, send);
  assert.equal(sent.length, 3);
});
test("missing heartbeat has a startup grace; stale heartbeat alerts even when every HTTP service is healthy", async () => {
  const state = { startedAt: now.toISOString() },
    check = { services: good().services },
    messages: string[] = [];
  const send = async (_key: string, text: string) => {
    messages.push(text);
  };
  await checkWatchdog(state, check, new Date(+now + 15 * 60000), () => {}, send);
  assert.equal(messages.length, 0);
  await checkWatchdog(state, check, new Date(+now + 15 * 60000 + 1), () => {}, send);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /心跳超过15分钟/);
});
test("a different failed service still alerts within 24 hours; recurrence of the same failure does not", async () => {
  const state: WatchdogState = { startedAt: now.toISOString() };
  const check = good();
  let sent = 0;
  const run = () =>
    checkWatchdog(
      state,
      check,
      now,
      () => {},
      async () => {
        sent++;
      },
    );
  check.services[0].ok = false;
  await run();
  check.services[0].ok = true;
  await run();
  check.services[1].ok = false;
  await run();
  assert.equal(sent, 2);
  check.services[1].ok = true;
  check.services[0].ok = false;
  await run();
  assert.equal(sent, 2);
});
test("failed send preserves a durable idempotency key and does not falsely mark notification success", async () => {
  const state: WatchdogState = { startedAt: now.toISOString() },
    check = good(),
    saved: WatchdogState[] = [],
    keys: string[] = [];
  check.services[2].ok = false;
  const save = (s: WatchdogState) => saved.push(structuredClone(s));
  await assert.rejects(
    checkWatchdog(state, check, now, save, async (key) => {
      keys.push(key);
      throw Error("transport lost");
    }),
  );
  assert.equal(state.sentAt, undefined);
  assert.ok(saved[0].pending);
  const restarted = structuredClone(saved[0]);
  await checkWatchdog(restarted, check, new Date(+now + 300000), save, async (key) => {
    keys.push(key);
  });
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.ok(restarted.sentAt);
  assert.equal(restarted.pending, undefined);
});

test("standalone watchdog probes local services and uses only a fake CLI, independent of engine delivery", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runWatchdog } = await import("../plugins/company/watchdog.ts");
  const dir = mkdtempSync(join(tmpdir(), "watchdog-local-")),
    bin = join(dir, "bin"),
    previousPath = process.env.PATH;
  mkdirSync(bin);
  mkdirSync(join(dir, "hub"));
  let failed = false;
  const requests: { path: string; auth?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, auth: req.headers.authorization });
    res.writeHead(req.url === "/callback" ? 404 : failed ? 503 : 200);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const messages = join(dir, "fake-messages.jsonl");
  try {
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const lark = join(bin, "lark-fake");
    writeFileSync(
      lark,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(messages)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({data:{message_id:'om_fake'}}));\n`,
      { mode: 0o700 },
    );
    process.env.PATH = bin + ":" + previousPath;
    writeFileSync(
      join(dir, "hub/config.json"),
      JSON.stringify({ url, owner: "test-owner-only", channels: { "company-feishu": { user: "ou_fake", lark } } }),
    );
    writeFileSync(
      join(dir, "watchdog.json"),
      JSON.stringify({ callbackUrl: url + "/callback", dashboardUrl: url + "/dashboard" }),
    );
    writeFileSync(join(dir, "health-heartbeat.json"), JSON.stringify({ at: new Date().toISOString() }));
    assert.equal((await runWatchdog(dir)).healthy, true);
    assert.equal(existsSync(messages), false);
    failed = true;
    assert.equal((await runWatchdog(dir)).sent, true);
    assert.equal((await runWatchdog(dir)).sent, false);
    const sent = readFileSync(messages, "utf8").trim().split("\n");
    assert.equal(sent.length, 1);
    assert.ok(requests.some((r) => r.path === "/v1/state" && r.auth === "Bearer test-owner-only"));
    assert.ok(requests.filter((r) => r.path !== "/v1/state").every((r) => !r.auth));
    assert.doesNotMatch(sent[0], /test-owner-only/);
    writeFileSync(join(dir, "watchdog.json"), JSON.stringify({ callbackUrl: "https://outside.example.test" }));
    await assert.rejects(runWatchdog(dir), /只能探测本机/);
  } finally {
    process.env.PATH = previousPath;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
