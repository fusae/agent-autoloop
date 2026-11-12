// Failure modes: an ambiguous write is repeated, absence consumes quota, old unknown locks a channel,
// a restart resets the readback bound, or migration dispatches an unapproved frozen draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitAndReadback, type Readback } from "../plugins/company/publication-readback.ts";
import { publicationUsage } from "../plugins/company/publication-policy.ts";
import { publicationAttempt, savePublicationAttempt } from "../plugins/company/publication.ts";
import { recoverPublications, importPublicationAttempts } from "../plugins/company/publication-recovery.ts";

test("lost response polls in the same run and never resubmits unknown", () => {
  let time = 0,
    writes = 0,
    reads = 0,
    intents = 0;
  const result = submitAndReadback({
    lookup: () => ({ state: ++reads === 1 ? "absent" : reads < 4 ? "unknown" : "published" }),
    publish: () => {
      writes++;
      throw Error("lost response");
    },
    beforeSubmit: () => {
      intents++;
    },
    lookupOnly: false,
    maxMs: 120_000,
    now: () => time,
    wait: (ms) => {
      time += ms;
    },
  });
  assert.equal(result.state, "published");
  assert.equal(writes, 1);
  assert.equal(intents, 1);
  assert.equal(time, 20_000);
  const unknown = submitAndReadback({
    lookup: () => ({ state: "unknown" }),
    publish: () => {
      throw Error("duplicate");
    },
    beforeSubmit: () => {
      throw Error("unexpected write");
    },
    lookupOnly: false,
    maxMs: 120_000,
  });
  assert.equal(unknown.state, "unknown");
});
test("confirmed absence retries once but readback-only never submits", () => {
  let writes = 0;
  const adapter = {
    lookup: (): Readback => ({ state: writes < 2 ? "absent" : "published" }),
    publish: (): Readback => {
      writes++;
      return { state: "unknown" };
    },
    beforeSubmit: () => {},
    lookupOnly: false,
    maxMs: 0,
  };
  assert.equal(submitAndReadback(adapter).state, "published");
  assert.equal(writes, 2);
  writes = 0;
  assert.equal(submitAndReadback({ ...adapter, lookupOnly: true }).state, "absent");
  assert.equal(writes, 0);
});
test("unknown readback is bounded to two minutes", () => {
  let clock = 0,
    writes = 0;
  const r = submitAndReadback({
    lookup: () => ({ state: writes ? "unknown" : "absent" }),
    publish: () => {
      writes++;
      return { state: "unknown" };
    },
    beforeSubmit: () => {},
    lookupOnly: false,
    maxMs: 120_000,
    now: () => clock,
    wait: (ms) => {
      clock += ms;
    },
  });
  assert.equal(clock, 120_000);
  assert.equal(writes, 1);
  assert.equal(r.state, "unknown");
});
test("quota counts today's unknown, releases confirmed absence and permits other drafts next day", () => {
  const dir = mkdtempSync(join(tmpdir(), "publication-usage-"));
  try {
    const key = "a".repeat(32),
      at = "2026-11-11T02:00:00Z",
      reservations = [{ key, channel: "test", at }];
    savePublicationAttempt(dir, { key, channel: "test", state: "unknown", at, checks: 0 });
    assert.equal(publicationUsage([], reservations, "test", new Date(at), dir).pending, 1);
    assert.equal(publicationUsage([], reservations, "test", new Date("2026-11-12T02:00:00Z"), dir).pending, 0);
    savePublicationAttempt(dir, { key, channel: "test", state: "absent", at, checks: 0 });
    assert.equal(publicationUsage([], reservations, "test", new Date(at), dir).pending, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("migration is idempotent; three read-only cycles survive restart and then require human checking", () => {
  const dir = mkdtempSync(join(tmpdir(), "publication-import-"));
  const key = "a".repeat(32),
    at = "2026-11-11T02:00:00Z";
  const tasks = [{ id: "post", kind: "publish-content", status: "blocked", publication: key, reports: [{ at }] }];
  let manual = 0,
    lookups = 0;
  const office: any = {
    tasks: () => tasks,
    publicationUnknown: () => {
      manual++;
    },
    reconcilePublication: () => {
      throw Error("not published");
    },
  };
  try {
    mkdirSync(join(dir, "publications"));
    writeFileSync(join(dir, "publications", key + ".json"), JSON.stringify({ key, business: "test" }));
    writeFileSync(join(dir, "publishing.json"), JSON.stringify({ projects: { test: { channel: "test" } } }));
    assert.equal(importPublicationAttempts(dir, office, new Date(at)), 1);
    assert.equal(importPublicationAttempts(dir, office, new Date(at)), 0);
    for (let n = 1; n <= 5; n++) {
      const now = new Date(Date.parse(at) + n * 300_000);
      const lookup = (_dir: string, _key: string, only?: boolean): never => {
        assert.equal(only, true);
        lookups++;
        throw Error("unknown");
      };
      recoverPublications(dir, office, {} as any, now, lookup);
      recoverPublications(dir, office, {} as any, now, lookup);
    }
    assert.equal(lookups, 3);
    assert.equal(manual, 1);
    assert.equal(publicationAttempt(dir, key)!.manual, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart reads a persisted result without another adapter call", () => {
  const dir = mkdtempSync(join(tmpdir(), "publication-restart-"));
  const key = "b".repeat(32);
  let completed = 0,
    reconciled = 0;
  try {
    mkdirSync(join(dir, "publications"));
    writeFileSync(join(dir, "publications", key + "-result.json"), "{}");
    const office: any = {
      tasks: () => [{ kind: "publish-content", status: "active", publication: key }],
      reconcilePublication: () => {
        completed++;
      },
    };
    const operations: any = {
      reconcilePublication: () => {
        reconciled++;
      },
    };
    recoverPublications(dir, office, operations, new Date(), () => {
      throw Error("no adapter needed");
    });
    assert.equal(completed, 1);
    assert.equal(reconciled, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slow pre-submit lookup uses the configured timeout and never becomes an ambiguous write", async () => {
  const { default: childProcess } = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const { mock } = await import("node:test");
  const { executePublication } = await import("../plugins/company/publication.ts");
  const dir = mkdtempSync(join(tmpdir(), "slow-lookup-")),
    key = "c".repeat(32);
  const actions: string[] = [];
  mkdirSync(join(dir, "publications"));
  writeFileSync(join(dir, "publications", key + ".json"), JSON.stringify({ key, business: "test", artifacts: [] }));
  writeFileSync(
    join(dir, "publishing.json"),
    JSON.stringify({
      projects: { test: { channel: "test", command: ["/fake/publish"], timeoutMs: 600000, readbackMs: 0 } },
    }),
  );
  const original = childProcess.spawnSync;
  const stub = mock.method(childProcess, "spawnSync", ((_command: unknown, _args: unknown, options: any) => {
    const request = JSON.parse(options.input);
    actions.push(request.action);
    // Login plus author-page reads take 40 seconds; the configured entry allows ten minutes.
    if (options.timeout < 40000) return { status: null, error: Error("ETIMEDOUT"), stdout: "" };
    return {
      status: 0,
      stdout: JSON.stringify({
        state: "published",
        key,
        channel: "test",
        remoteId: "1",
        url: "https://example.com/1",
        publishedAt: "2026-11-11T16:00:00Z",
      }),
    };
  }) as typeof original);
  syncBuiltinESMExports();
  try {
    assert.equal(executePublication(dir, key).remoteId, "1");
    assert.deepEqual(actions, ["lookup"]);
    assert.equal(publicationAttempt(dir, key), undefined);
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
