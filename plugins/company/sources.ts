// Source configuration is local trusted configuration, never a model receipt or business text.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
type Part = { data: unknown; checkedAt: string | null; error: string | null };
export type SourceSnapshot = {
  business: string;
  status: "ready" | "partial" | "unavailable";
  attemptedAt: string;
  nextAt: string;
  revision: string;
  changedAt: string;
  release: Part;
  database: Part;
  repositories: Part;
};
type SourceConfig = {
  releaseUrl?: string;
  localDatabase?: { helper: string };
  repositories?: { path: string; files: string[] }[];
  ssh?: { host: string; databases: { name: string; path: string; queries: Record<string, string> }[] };
};
export type SourceExecutor = (kind: "release" | "sqlite", config: any) => Promise<unknown>;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const script = `import sys,json,sqlite3
cfg=json.load(sys.stdin)
out={}
for spec in cfg['databases']:
 db=sqlite3.connect('file:'+spec['path']+'?mode=ro',uri=True,timeout=5)
 db.execute('PRAGMA query_only=ON')
 out[spec['name']]={}
 for name,sql in spec['queries'].items():
  if not sql.lstrip().upper().startswith('SELECT ') or ';' in sql: raise ValueError('SELECT only')
  cur=db.execute(sql)
  rows=cur.fetchmany(26)
  out[spec['name']][name]={'columns':[d[0] for d in cur.description],'rows':rows[:25],'truncated':len(rows)>25}
 db.close()
print(json.dumps(out,ensure_ascii=False))`;
const execute: SourceExecutor = async (kind, config) => {
  if (kind === "release") {
    const url = new URL(config);
    if (url.protocol !== "https:" || url.username || url.password) throw Error("HTTPS URL required");
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!r.ok) throw Error("release unavailable");
    const raw = await r.text();
    if (raw.length > 32000) throw Error("release too large");
    const value = JSON.parse(raw);
    return Object.fromEntries(
      ["version", "versionCode", "channel", "download", "downloadUrl", "sha256", "architecture", "notes"]
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, value[k]]),
    );
  }
  if (config.helper) {
    if (!isAbsolute(config.helper)) throw Error("数据读取程序必须使用绝对路径");
    return new Promise((resolve, reject) => {
      execFile(config.helper, [], { timeout: 25000, maxBuffer: 256000, encoding: "utf8" }, (error, out) => {
        if (error) return reject(Error("本机只读数据连接失败"));
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(Error("数据格式错误"));
        }
      });
    });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(config.host)) throw Error("Invalid SSH host");
  for (const db of config.databases)
    if (
      !isAbsolute(db.path) ||
      /[?\n#]/.test(db.path) ||
      Object.values(db.queries).some((q) => typeof q !== "string" || !/^SELECT\s/i.test(q) || q.includes(";"))
    )
      throw Error("Invalid read-only query");
  return new Promise((resolve, reject) => {
    const command = "sudo -n python3 -c '" + script.replaceAll("'", "'\\''") + "'";
    const child = execFile(
      "ssh",
      ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", config.host, command],
      { timeout: 25000, maxBuffer: 256000, encoding: "utf8" },
      (err, out) => {
        if (err) {
          reject(Error("只读数据连接失败"));
          return;
        }
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(Error("数据格式错误"));
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(config));
  });
};
export function sourceSnapshots(directory: string): Record<string, SourceSnapshot> {
  const cfg = join(directory, "sources.json");
  if (!existsSync(cfg)) return {};
  const projects = JSON.parse(readFileSync(cfg, "utf8")).projects ?? {},
    out: Record<string, SourceSnapshot> = {};
  for (const id of Object.keys(projects)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    const file = join(directory, "workspace/knowledge/sources", id + ".json");
    if (existsSync(file)) out[id] = JSON.parse(readFileSync(file, "utf8"));
  }
  return out;
}
export async function collectSources(
  directory: string,
  now = new Date(),
  run: SourceExecutor = execute,
): Promise<Record<string, SourceSnapshot>> {
  const cfg = join(directory, "sources.json");
  if (!existsSync(cfg)) return {};
  const projects: Record<string, SourceConfig> = JSON.parse(readFileSync(cfg, "utf8")).projects ?? {},
    out = sourceSnapshots(directory);
  const folder = join(directory, "workspace/knowledge/sources");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const [id, spec] of Object.entries(projects)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw Error("无效数据源项目编号");
    const old = out[id];
    if (old && Date.parse(old.nextAt) > now.getTime()) continue;
    const part = async (key: "release" | "database" | "repositories", get: () => Promise<unknown>): Promise<Part> => {
      try {
        return { data: await get(), checkedAt: now.toISOString(), error: null };
      } catch {
        return {
          data: old?.[key]?.data ?? null,
          checkedAt: old?.[key]?.checkedAt ?? null,
          error: "本轮读取失败，历史数据仅供参考",
        };
      }
    };
    const release = await part("release", () =>
      spec.releaseUrl ? run("release", spec.releaseUrl) : Promise.resolve(null),
    );
    const database = await part("database", () =>
      spec.localDatabase || spec.ssh ? run("sqlite", spec.localDatabase ?? spec.ssh) : Promise.resolve(null),
    );
    const repositories = await part("repositories", async () =>
      (spec.repositories ?? []).map((repo) => {
        const root = realpathSync(repo.path);
        return {
          path: root,
          files: repo.files.map((file) => {
            const full = realpathSync(resolve(root, file));
            if (!full.startsWith(root + sep) || /(^|\/)\.env|\.pem$|credentials|secrets/i.test(file))
              throw Error("文件不在资料范围内");
            const text = readFileSync(full, "utf8");
            if (text.length > 64000) throw Error("资料过长");
            return { file, text };
          }),
        };
      }),
    );
    const parts = [release, database, repositories],
      errors = parts.filter((p) => p.error).length;
    const revision = hash(parts.map((p) => ({ data: p.data, error: p.error })));
    const snapshot: SourceSnapshot = {
      business: id,
      status: errors === 3 ? "unavailable" : errors ? "partial" : "ready",
      attemptedAt: now.toISOString(),
      nextAt: new Date(now.getTime() + 3600000).toISOString(),
      revision,
      changedAt: old?.revision === revision ? old.changedAt : now.toISOString(),
      release,
      database,
      repositories,
    };
    const file = join(folder, id + ".json");
    writeFileSync(file + ".tmp", JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    renameSync(file + ".tmp", file);
    out[id] = snapshot;
  }
  return out;
}
