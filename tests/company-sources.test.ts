// Stale or inaccessible sources must not look fresh; unchanged observations must not wake models.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSources } from "../plugins/company/sources.ts";
test("configured sources persist evidence, isolate failures and deduplicate unchanged data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-sources-"));
  let calls = 0,
    broken = false;
  const config = {
    projects: {
      app: {
        releaseUrl: "https://example.com/release",
        repositories: [],
        ssh: {
          host: "example",
          databases: [{ name: "counts", path: "/data/app.db", queries: { users: "SELECT COUNT(*) FROM users" } }],
        },
      },
    },
  };
  writeFileSync(join(dir, "sources.json"), JSON.stringify(config));
  const execute = async (kind: string, args: any) => {
    calls++;
    if (broken && kind === "sqlite") throw Error("offline");
    return kind === "release"
      ? { version: "1.2", versionCode: 3, download: "https://example.com/app.apk" }
      : { counts: { users: { columns: ["n"], rows: [[2]] } } };
  };
  try {
    const a = await collectSources(dir, new Date("2026-11-05T01:00:00Z"), execute);
    assert.equal(a.app.status, "ready");
    const n = calls;
    await collectSources(dir, new Date("2026-11-05T01:05:00Z"), execute);
    assert.equal(calls, n);
    const b = await collectSources(dir, new Date("2026-11-05T02:01:00Z"), execute);
    assert.equal(a.app.revision, b.app.revision);
    broken = true;
    const c = await collectSources(dir, new Date("2026-11-05T03:02:00Z"), execute);
    assert.equal(c.app.status, "partial");
    assert.equal(c.app.database.checkedAt, b.app.database.checkedAt);
    assert.ok(c.app.database.error);
    assert.equal(c.app.release.error, null);
    assert.notEqual(c.app.revision, b.app.revision);
    const disk = JSON.parse(readFileSync(join(dir, "workspace/knowledge/sources/app.json"), "utf8"));
    assert.equal(disk.status, "partial");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Server deployments use a fixed local aggregate reader, not an SSH key with broad production access.
test("trusted local database helpers provide aggregates without copying production databases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-local-source-"));
  try {
    const helper = join(dir, "reader");
    writeFileSync(helper, '#!/bin/sh\nprintf \'{"usage":{"rows":[[2]]}}\\n\'\n', { mode: 0o700 });
    writeFileSync(join(dir, "sources.json"), JSON.stringify({ projects: { app: { localDatabase: { helper } } } }));
    const result = await collectSources(dir);
    assert.deepEqual(result.app.database.data, { usage: { rows: [[2]] } });
    assert.equal(result.app.database.error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
