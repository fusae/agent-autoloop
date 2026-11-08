// Failure modes: unverified callbacks reach the channel, retries recreate consumed files, partial JSON is
// consumed after a crash, cross-mount handoff fails, or errors hide diagnostics or expose credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cardCallbackServer } from "../plugins/company/card-callback.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "company-callback-"));
  const spool = join(root, "callbacks"),
    privateDir = join(root, "private"),
    logs: string[] = [];
  let server = cardCallbackServer(spool, privateDir, (message) => logs.push(message));
  const start = async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  };
  const stop = () =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await start();
  return {
    spool,
    privateDir,
    tokenFile: join(privateDir, "verification-token"),
    logs,
    async request(body?: unknown, method = "POST", path = "/feishu/card-callback") {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    async restart() {
      await stop();
      server = cardCallbackServer(spool, privateDir, (message) => logs.push(message));
      await start();
    },
    async close() {
      await stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const verify = { type: "url_verification", challenge: "原值\nchallenge", token: "private-test-token" };
const callback = {
  schema: "2.0",
  header: { event_type: "card.action.trigger", event_id: "../../event/1", token: verify.token },
  event: {
    operator: { open_id: "ou_owner" },
    context: { open_message_id: "om_original" },
    action: { value: { card: 42, version: 1, choice: 0 } },
    token: "separate-card-update-token",
  },
};

test("first verification pins a private token; rejected callbacks never enter the spool", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(callback)).status, 401);
    assert.equal(existsSync(f.tokenFile), false);
    const result = await f.request(verify);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { challenge: verify.challenge });
    assert.equal(readFileSync(f.tokenFile, "utf8"), verify.token);
    assert.equal(statSync(f.tokenFile).mode & 0o777, 0o600);
    await f.restart();
    assert.equal((await f.request({ ...verify, token: "wrong-token" })).status, 401);
    assert.equal((await f.request({ ...callback, header: { ...callback.header, token: "wrong-token" } })).status, 401);
    assert.equal((await f.request({ ...callback, header: { ...callback.header, token: undefined } })).status, 401);
    assert.equal((await f.request({ ...callback, token: "wrong-token" })).status, 401);
    assert.deepEqual(readdirSync(f.spool), []);
    assert.ok(f.logs.some((line) => line.includes("401")));
    assert.ok(f.logs.every((line) => !line.includes(verify.token) && !line.includes("wrong-token")));
    unlinkSync(f.tokenFile);
    assert.equal((await f.request(callback)).status, 401);
    assert.equal((await f.request({ ...verify, token: "fresh-test-token" })).status, 200);
    assert.equal(readFileSync(f.tokenFile, "utf8"), "fresh-test-token");
  } finally {
    await f.close();
  }
});

test("raw callbacks publish atomically and deduplicate after consumption and restart; pending publication recovers", async () => {
  const f = await fixture();
  try {
    await f.request(verify);
    const raw = JSON.stringify(callback, null, 2);
    const results = await Promise.all(Array.from({ length: 6 }, () => f.request(raw)));
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), {});
    }
    const files = readdirSync(f.spool);
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(f.spool, files[0]), "utf8"), raw);
    assert.equal(statSync(join(f.spool, files[0])).mode & 0o777, 0o600);
    const done = readdirSync(f.privateDir).find((file) => file.endsWith(".done"))!;
    assert.notEqual(statSync(join(f.spool, files[0])).ino, statSync(join(f.privateDir, done)).ino);
    unlinkSync(join(f.spool, files[0]));
    await f.restart();
    assert.equal((await f.request(raw)).status, 200);
    assert.deepEqual(readdirSync(f.spool), []);
    const next = { ...callback, header: { ...callback.header, event_id: "interrupted" } };
    const key = createHash("sha256").update(next.header.event_id).digest("hex");
    writeFileSync(join(f.privateDir, key + ".pending"), JSON.stringify(next), { mode: 0o600 });
    writeFileSync(join(f.spool, "http-" + key + ".tmp"), '{"partial":');
    await f.restart();
    assert.deepEqual(JSON.parse(readFileSync(join(f.spool, "http-" + key + ".json"), "utf8")), next);
    assert.equal(existsSync(join(f.privateDir, key + ".done")), true);
    assert.equal(existsSync(join(f.spool, "http-" + key + ".tmp")), false);
    // A crash after publication but before marking done may leave both files.
    writeFileSync(join(f.privateDir, key + ".pending"), JSON.stringify(next), { mode: 0o600 });
    await f.restart();
    assert.deepEqual(JSON.parse(readFileSync(join(f.spool, "http-" + key + ".json"), "utf8")), next);
  } finally {
    await f.close();
  }
});

test("handoff failure logs errno and duration, preserves pending, and recovers without another callback", async () => {
  const f = await fixture();
  try {
    await f.request(verify);
    rmSync(f.spool, { recursive: true });
    writeFileSync(f.spool, "blocked");
    assert.equal((await f.request(callback)).status, 500);
    assert.ok(f.logs.some((line) => /ENOTDIR errno=-?\d+/.test(line)));
    assert.ok(f.logs.some((line) => /status=500 duration_ms=\d+\.\d+/.test(line)));
    assert.ok(f.logs.every((line) => !line.includes(verify.token) && !line.includes(callback.event.token)));
    assert.equal(readdirSync(f.privateDir).filter((file) => file.endsWith(".pending")).length, 1);
    unlinkSync(f.spool);
    mkdirSync(f.spool);
    await f.restart();
    const files = readdirSync(f.spool);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(f.spool, files[0]), "utf8")), callback);
    assert.equal((await f.request(callback)).status, 200);
    assert.deepEqual(readdirSync(f.spool), files);
  } finally {
    await f.close();
  }
});

test("HTTP boundary rejects encryption, malformed data, wrong methods and over 64 KiB without enrolling a token", async () => {
  const f = await fixture();
  try {
    for (const body of ["{", "null", "[]", { ...verify, challenge: undefined }, { encrypt: "encrypted-test-data" }])
      assert.equal((await f.request(body)).status, 400);
    assert.equal((await f.request(verify, "GET")).status, 404);
    assert.equal((await f.request(verify, "PUT")).status, 404);
    assert.equal((await f.request(verify, "POST", "/elsewhere")).status, 404);
    assert.equal(existsSync(f.tokenFile), false);
    const raw = JSON.stringify(verify);
    assert.equal((await f.request(raw + " ".repeat(65537 - Buffer.byteLength(raw)))).status, 413);
    assert.equal(existsSync(f.tokenFile), false);
    assert.equal((await f.request(raw + " ".repeat(65536 - Buffer.byteLength(raw)))).status, 200);
    assert.ok(f.logs.some((line) => line.includes("需要 Encrypt Key")));
    assert.ok(f.logs.every((line) => !line.includes("encrypted-test-data")));
    assert.equal((await f.request({ ...callback, schema: "1.0" })).status, 400);
    assert.equal((await f.request({ ...callback, header: { ...callback.header, event_id: "" } })).status, 400);
    assert.equal((await f.request({ ...callback, header: { ...callback.header, event_type: "other" } })).status, 400);
    assert.deepEqual(readdirSync(f.spool), []);
  } finally {
    await f.close();
  }
});
