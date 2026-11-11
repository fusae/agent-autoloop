// Read-only export: never construct Company/Operations, whose constructors can write projections.
// Collection has no network; read-only clients reuse the sanitized business summary.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";

const roles: Record<string, string> = {
  ceo: "CEO",
  product: "产品",
  engineering: "研发",
  qa: "验收",
  growth: "运营",
  support: "客服",
  finance: "财务",
};
const labels: Record<string, string> = {
  active: "进行中",
  blocked: "受阻",
  awaiting_approval: "待审",
  completed: "完成",
  rejected: "退回",
  queued: "排队",
  superseded: "已取代",
  proposed: "待审",
  planned: "待执行",
  working: "写作中",
  observing: "效果观察",
  review: "待审核",
  closed: "已结束",
  delivered: "待发布",
  publishing: "发布中",
  claimed: "运行中",
  running: "运行中",
  done: "完成",
  failed: "失败",
  cancelled: "取消",
  pending: "待处理",
  published: "已发",
  screening: "待审",
  ready: "待审",
  approved: "通过",
  returned: "退回",
  withdrawn: "撤回",
  accept: "验收通过",
  publish: "同意发布",
  revise: "退回修改",
};
const state = (v: unknown) => labels[String(v)] ?? String(v ?? "未知");
const day = (d: Date) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
const beijing = (d: Date) => new Date(d.getTime() + 8 * 3600000).toISOString().replace("Z", "+08:00");
const text = (v: unknown) => (typeof v === "string" ? v : "");
const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: any): any[] => (Array.isArray(v) ? v : []);
const clip = (v: unknown, n = 400) => [...text(v)].slice(0, n).join("");
const secretField =
  /^(?:.*(?:token|password|passwd|secret|cookie|api[_-]?key|private[_-]?key)|open[_-]?id|chat[_-]?id|account[_-]?id|user[_-]?id|app[_-]?id|authorization)$/i;
const patterns: [string, RegExp][] = [
  ["Cookie", /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi],
  ["私钥", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  [
    "凭据",
    /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+\/-]+=*|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi,
  ],
  ["飞书标识", /\b(?:ou|oc|on|om|cli)_[A-Za-z0-9_-]+\b/g],
  [
    "敏感字段",
    /(?:["']?(?:[\w-]*(?:token|password|passwd|secret|cookie|api[_-]?key|private[_-]?key)|open[_-]?id|chat[_-]?id|account[_-]?id|user[_-]?id|authorization)["']?\s*[:=：]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；}\r\n]+)/gi,
  ],
  ["中文凭据", /(?:密钥|密码|口令|账号\s*(?:ID|标识)|账户\s*(?:ID|标识))\s*[:=：]\s*[^\s,;，；}\r\n]+/gi],
  ["IP", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ["账号", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|@[A-Za-z0-9_][A-Za-z0-9_.-]*/g],
];
function ipv6(value: string) {
  return value.match(/(?<![\w:])[A-Fa-f0-9]*:[A-Fa-f0-9:.:%-]+/g)?.filter((v) => isIP(v.split("%")[0]) === 6) ?? [];
}
export function scanSensitive(value: unknown, known: string[] = []): string[] {
  const found = new Set<string>();
  const visit = (v: any) => {
    if (typeof v === "string") {
      const prose = v.replace(/https?:\/\/[^\s<>"'）)，；。]+/g, (url: string) => {
        if (cleanLink(url) !== url) found.add("私密链接");
        return " ";
      });
      for (const [label, pattern] of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(prose)) found.add(label);
      }
      if (ipv6(v).length) found.add("IP");
      if (known.some((s) => s.length >= 3 && v.includes(s))) found.add("已知敏感值");
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (secretField.test(k)) found.add("敏感字段");
        visit(x);
      }
  };
  visit(value);
  return [...found].sort();
}
function cleanLink(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || isIP(u.hostname.replace(/^\[|\]$/g, "")))
      return "[链接已隐藏]";
    // Only content links survive. Profile URLs, internal hosts and arbitrary token-bearing paths are not exported.
    if (/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)) {
      const id = /\/(?:[^/]+\/status|i\/web\/status)\/(\d+)$/.exec(u.pathname)?.[1];
      return id ? `https://x.com/i/web/status/${id}` : "[链接已隐藏]";
    }
    if (!(
      (/^(?:www\.)?xiaohongshu\.com$/.test(u.hostname) &&
        /^\/(?:explore|discovery\/item)\/[a-f0-9]+$/i.test(u.pathname)) ||
      (/^(?:www\.)?binance\.com$/.test(u.hostname) && /^\/(?:[a-z-]+\/)?square\/post\/\d+$/i.test(u.pathname))
    ))
      return "[链接已隐藏]";
    return u.origin + u.pathname;
  } catch {
    return "[链接已隐藏]";
  }
}
export function redact(value: any, known: string[] = []): any {
  if (typeof value === "string") {
    let v = value;
    for (const secret of known.filter((s) => s.length >= 3).sort((a, b) => b.length - a.length))
      v = v.split(secret).join("[已隐藏]");
    return v
      .split(/(https?:\/\/[^\s<>"'）)，；。]+)/g)
      .map((part, index) => {
        if (index % 2) return cleanLink(part);
        for (const [, pattern] of patterns) part = part.replace(pattern, "[已隐藏]");
        for (const ip of ipv6(part)) part = part.split(ip).join("[已隐藏]");
        return part;
      })
      .join("");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, known));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !secretField.test(k))
        .map(([k, v]) => [k, redact(v, known)]),
    );
  return value;
}
function assertSafe(value: unknown, known: string[] = []) {
  const hits = scanSensitive(value, known);
  if (hits.length) throw Error(`脱敏扫描拒绝：${hits.join("、")}`);
}
function readJSON(path: string, fallback: any = {}) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}
function database<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    return fn(db);
  } finally {
    db.close();
  }
}
const bodies = (db: DatabaseSync, table: string): any[] =>
  db
    .prepare(`SELECT body FROM ${table} ORDER BY rowid`)
    .all()
    .map((r) => JSON.parse(String(r.body)));
const projected = (db: DatabaseSync, collection: string): any[] =>
  db
    .prepare("SELECT data FROM projections WHERE collection=? ORDER BY key")
    .all(collection)
    .map((r) => JSON.parse(String(r.data)));
function sensitiveValues(value: any): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) =>
    secretField.test(k) || /^(?:answerers|account|author|owner|key)$/i.test(k)
      ? (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === "string")
      : sensitiveValues(v),
  );
}
function draft(content: string, known: string[]) {
  try {
    const d = JSON.parse(content);
    return { title: text(d.title), excerpt: clip(redact(text(d.content), known), 200) };
  } catch {
    return { title: content.split("\n")[0].replace(/^#+\s*/, ""), excerpt: clip(redact(content, known), 200) };
  }
}
function artifact(directory: string, paths: string[], known: string[]) {
  const workspace = realpathSync(join(directory, "workspace"));
  const candidates = paths.slice().reverse();
  candidates.sort(
    (a, b) => Number(/(?:xiaohongshu|rabbitrun)\.json$/.test(b)) - Number(/(?:xiaohongshu|rabbitrun)\.json$/.test(a)),
  );
  for (const path of candidates) {
    if (!/\.(?:md|txt|json)$/i.test(path)) continue;
    const file = isAbsolute(path) ? path : join(workspace, path);
    if (!existsSync(file)) continue;
    const real = realpathSync(file),
      rel = relative(workspace, real);
    if (!rel || rel.startsWith(".." + sep) || isAbsolute(rel) || rel === "..") throw Error("稿件路径越界");
    if (statSync(real).size > 1000000) continue;
    return draft(readFileSync(real, "utf8"), known);
  }
  return { title: "", excerpt: "尚无可读稿件" };
}
export type Snapshot = {
  generatedAt: string;
  date: string;
  staff: any[];
  businesses: any[];
  drafts: any[];
  publications: any;
  downloads: any[];
  chairman: any[];
  maintenance: any[];
  anomalies: any[];
  dailyReport: any;
  ceoRounds: any[];
  health: any;
};
export function collectSnapshot(directory: string, now = new Date(), services: Record<string, string> = {}): Snapshot {
  const config = readJSON(join(directory, "company.json"));
  const tasks = database(join(directory, "company.db"), (db) => bodies(db, "tasks"));
  const { projects, chief, maintenance } = database(join(directory, "operations.db"), (db) => ({
    projects: bodies(db, "projects"),
    chief: bodies(db, "leadership")[0] ?? {},
    maintenance: db.prepare("SELECT 1 FROM sqlite_master WHERE name='maintenance'").get()
      ? bodies(db, "maintenance")
      : [],
  }));
  const businesses = database(join(directory, "business.db"), (db) => bodies(db, "businesses"));
  const hub = database(join(directory, "hub/hub.db"), (db) => ({
    runs: projected(db, "runs"),
    events: projected(db, "events"),
    links: projected(db, "run_events"),
    cards: projected(db, "cards"),
    rules:
      JSON.parse(
        String(
          db.prepare("SELECT data FROM projections WHERE collection='config' AND key='rules'").get()?.data ?? "{}",
        ),
      ).value ?? {},
  }));
  const feedback = readJSON(join(directory, "workspace/knowledge/feedback.json"));
  const known = [
    ...sensitiveValues(hub.rules),
    ...sensitiveValues(readJSON(join(directory, "feedback.json"))),
    ...sensitiveValues(feedback),
    ...sensitiveValues(readJSON(join(directory, "publishing.json"))),
    ...sensitiveValues(readJSON(join(directory, "hub/config.json"))),
  ];
  for (const path of ["secrets.env", "hub/secrets.env"]) {
    const file = join(directory, path);
    if (existsSync(file))
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const value = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line)?.[1];
        if (value) known.push(value.replace(/^['"]|['"]$/g, ""));
      }
  }
  const date = day(now),
    start = new Date(date + "T00:00:00+08:00").toISOString(),
    end = new Date(Date.parse(start) + 86400000).toISOString();
  const safeClip = (value: unknown, size = 400) => clip(redact(text(value), known), size);
  const weekStart = new Date(date + "T00:00:00Z");
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const week = weekStart.toISOString().slice(0, 10);
  const counts: Record<string, Record<string, number>> = { started: {}, "employee-started": {} };
  const usageKnown = existsSync(join(directory, "model-runs.db"));
  if (usageKnown)
    database(join(directory, "model-runs.db"), (db) => {
      for (const r of db
        .prepare(
          "SELECT role,kind,COUNT(*) n FROM journal j WHERE kind IN ('started','employee-started') AND at>=? AND at<? AND NOT EXISTS (SELECT 1 FROM journal x WHERE x.id=(CASE WHEN j.kind='employee-started' THEN substr(j.id,1,length(j.id)-9) ELSE j.id END)||':refunded') GROUP BY kind,role",
        )
        .all(start, end))
        counts[String(r.kind)][String(r.role)] = Number(r.n);
    });
  const task = (id: string) => tasks.find((t) => t.id === id);
  const businessName = (id: string) => businesses.find((b) => b.id === id)?.name ?? id;
  const runTask = (run: any) =>
    hub.links
      .filter((l) => l.run_id === run.id)
      .map((l) => hub.events.find((e) => e.id === l.event_id))
      .map((e) => task(e?.subject))
      .find(Boolean);
  const running = hub.runs.filter((r) => ["running", "claimed"].includes(r.state));
  const publications: any[] = [],
    frozen = new Map<string, any>();
  const pubdir = join(directory, "publications");
  for (const file of existsSync(pubdir) ? readdirSync(pubdir).sort() : []) {
    if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
    const p = readJSON(join(pubdir, file));
    const a =
      list(p.artifacts).find((a) => /(?:xiaohongshu|rabbitrun)\.json$/.test(a.path)) ??
      list(p.artifacts).find((a) => /\.(?:md|txt)$/.test(a.path));
    frozen.set(p.key, { ...p, draft: a ? draft(a.content, known) : { title: "", excerpt: "无正文" } });
    const proof = readJSON(join(pubdir, file.replace(".json", "-result.json")), null);
    if (proof && !proof.deleted) {
      const handle = /^https:\/\/(?:x|twitter)\.com\/([^/]+)\/status\//.exec(proof.x?.url ?? "")?.[1];
      if (handle) known.push(handle);
      publications.push({ ...proof, business: p.business, title: frozen.get(p.key).draft.title });
    }
  }
  const ceoRuns = hub.runs
    .filter((r) => r.agent === "company-ceo")
    .sort((a, b) => b.id - a.id)
    .slice(0, 10);
  const staff: any[] = [
    {
      name: "CEO",
      business: "全公司",
      role: "ceo",
      duty: chief.enabled ? "在岗" : "停用",
      model: hub.rules.agents?.["company-ceo"]?.model ?? "未知",
      todayRounds: usageKnown ? (counts.started.ceo ?? 0) : null,
      dailyLimit: config.dailyModelRuns?.ceo ?? null,
      current:
        running
          .filter((r) => r.agent === "company-ceo")
          .map((r) => runTask(r)?.title ?? "经营轮次")
          .join("；") || "无运行中轮次",
      next: chief.nextReviewAt ? `下次复查 ${chief.nextReviewAt}` : "按既有事件与经营日程执行",
    },
  ];
  for (const p of projects)
    for (const s of list(p.staff).filter(
      (s) => s.enabled && (!config.activeRoles || config.activeRoles.includes(s.role)),
    )) {
      const current = running.filter(
        (r) =>
          (r.agent === `company-${s.role}` || r.agent === `company-staff-${p.business}-${s.role}`) &&
          list(p.activity).some((a) => a.task === runTask(r)?.id),
      );
      staff.push({
        name: s.name ?? `${businessName(p.business)}·${roles[s.role] ?? s.role}`,
        business: businessName(p.business),
        role: s.role,
        duty:
          s.enabled && !s.pausedByCEO && (!config.activeRoles || config.activeRoles.includes(s.role)) ? "在岗" : "停用",
        model:
          config.staffModels?.[p.business]?.[s.role]?.model ?? hub.rules.agents?.[`company-${s.role}`]?.model ?? "未知",
        todayRounds: usageKnown ? (counts["employee-started"][`${p.business}:${s.role}`] ?? 0) : null,
        dailyLimit: config.dailyModelRuns?.employee ?? null,
        roleTodayRounds: usageKnown ? (counts.started[s.role] ?? 0) : null,
        roleDailyLimit: config.dailyModelRuns?.[s.role] ?? null,
        workState: current.length ? "运行中" : "无运行中轮次；以下为已有安排或最近记录",
        current:
          current
            .map((r) => runTask(r)?.title)
            .filter(Boolean)
            .join("；") ||
          s.daily?.focus ||
          s.finding ||
          "无运行中轮次",
        next: s.daily?.doneWhen || s.followups?.[0]?.focus || (s.nextAt ? `下次检查 ${s.nextAt}` : "等待安排"),
        nextAt: s.daily?.reviewAt ?? s.nextAt ?? null,
      });
    }
  const drafts = projects.flatMap((p) =>
    list(p.plans)
      .filter(
        (a) =>
          a.kind === "content" &&
          !["closed", "observing"].includes(a.status) &&
          !publications.some((r) => r.key === a.publicationKey),
      )
      .map((a) => {
        const t = task(a.deliveryTask ?? a.task),
          content =
            frozen.get(a.publicationKey)?.draft ??
            artifact(
              directory,
              list(t?.reports).flatMap((r) => list(r.artifacts)),
              known,
            );
        const review = list(chief.decisions)
          .slice()
          .reverse()
          .flatMap((d) => list(d.decision?.deliveries))
          .find((d) => d.plan === a.id);
        return {
          business: businessName(p.business),
          title: content.title || a.title,
          status: state(a.status),
          review: review ? `${state(review.verdict)}：${safeClip(review.reason)}` : "尚无CEO审核结论",
          excerpt: content.excerpt,
        };
      }),
  );
  const metrics = (p: any) => {
    const post = list(feedback.posts).find((x) => x.key === p.key),
      sample = list(post?.samples).at(-1),
      manual = list(feedback.ownerMetrics)
        .filter((m) => m.publication === p.key)
        .at(-1);
    return {
      reads: number(manual?.reads ?? list(post?.reads).at(-1)?.reads),
      likes: number(manual?.likes ?? sample?.likes),
      collects: number(manual?.collects ?? sample?.collects),
      comments: number(manual?.comments ?? sample?.comments),
      checkedAt: manual?.at ?? sample?.at ?? null,
    };
  };
  const pubRows = publications
    .flatMap((p) => [
      {
        business: businessName(p.business),
        platform: p.x ? "币安广场" : "小红书",
        title: p.title,
        at: p.publishedAt,
        link: p.url || "链接待补",
        data: metrics(p),
      },
      ...(p.x?.state === "published"
        ? [
            {
              business: businessName(p.business),
              platform: "X",
              title: p.title,
              at: p.x.at,
              link: p.x.url ?? "链接待补",
              data: { reads: null, likes: null, collects: null, comments: null, checkedAt: null },
            },
          ]
        : []),
    ])
    .sort((a, b) => b.at.localeCompare(a.at));
  const recent = (at: string) => Date.parse(at) >= Date.parse(start) - 6 * 86400000 && Date.parse(at) <= now.getTime();
  const downloads = ["jinzhao", "jizhu"].map((id) => {
    const source = readJSON(join(directory, "workspace/knowledge/sources", id + ".json"));
    const d = source.database?.data?.downloads;
    return {
      business: businessName(id),
      checkedAt: source.database?.checkedAt ?? null,
      today: d?.current?.day === date ? number(d.current.count) : null,
      todayPartial: true,
      daily: list(d?.daily?.rows)
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[0] >= day(new Date(Date.parse(start) - 6 * 86400000)))
        .map((r) => ({ date: r[0], count: number(r[1]) })),
      note: d?.note ?? "尚无下载统计；未知不计为零",
    };
  });
  const latest = list(chief.eveningReports)
    .filter((r) => list(task(r.task)?.reports).some((x) => x.executive?.report || x.summary))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const dailyTask = latest ? task(latest.task) : null;
  const dailyCard = hub.cards.filter((c) => /^CEO · 日报/.test(c.title)).sort((a, b) => b.id - a.id)[0];
  const observation = list(feedback.days).at(-1);
  const snapshot: Snapshot = {
    generatedAt: beijing(now),
    date,
    staff,
    businesses: businesses.map((b) => {
      const p = projects.find((p) => p.business === b.id);
      return {
        name: b.name,
        status: state(b.status),
        objective: b.objective,
        week,
        goals: list(p?.staff)
          .filter((s) => s.weeklyGoal?.week === week)
          .map((s) => ({
            employee: s.name ?? roles[s.role],
            direction: s.weeklyGoal.direction,
            metrics: list(s.weeklyGoal.metrics).map((m) => ({ name: m.name, target: number(m.target), unit: m.unit })),
          })),
        progress: {
          publishedThisWeek: publications.filter((x) => x.business === b.id && day(new Date(x.publishedAt)) >= week)
            .length,
          plans: list(p?.plans)
            .filter((a) => !["closed"].includes(a.status))
            .map((a) => ({ title: a.title, status: state(a.status), result: safeClip(a.result) })),
        },
        topics: list(p?.topics).map((t) => {
          const a = list(p?.plans).find((a) => a.id === t.plan);
          return {
            title: t.title,
            week: t.week,
            status: publications.some((r) => r.key === a?.publicationKey)
              ? "已发"
              : t.state === "approved" && t.plan
                ? "写作中"
                : ["screening", "ready", "pending"].includes(t.state)
                  ? "待审"
                  : state(t.state),
          };
        }),
      };
    }),
    drafts,
    publications: {
      window: "北京时间今天及此前6天",
      today: pubRows.filter((p) => day(new Date(p.at)) === date),
      recent7Days: pubRows.filter((p) => recent(p.at)),
    },
    downloads,
    chairman: [
      ...publications
        .filter((p) => p.x && p.x.state !== "published")
        .map((p) => ({ category: "X待发", title: p.title, detail: state(p.x.state), at: p.x.at })),
      ...list(chief.questions)
        .filter((q) => q.recipient === "chairman" && q.state !== "answered")
        .map((q) => ({
          category: /支出|花钱|付费|预算/.test(q.question + q.context) ? "花钱决策" : "本人验证",
          title: q.question,
          detail: q.context,
          at: q.at,
        })),
      ...hub.cards
        .filter((c) => c.state === "open" && /本人验证|支出决策/.test(c.title))
        .map((c) => ({ category: c.title, title: c.title, detail: c.text, at: c.created_at })),
    ],
    maintenance: maintenance.filter((m) => !m.resolvedAt).map((m) => ({ title: m.title, detail: m.text, at: m.at })),
    anomalies: [
      ...list(chief.health?.incidents)
        .filter((i) => !i.resolvedAt)
        .map((i) => ({
          title: i.title,
          impact: i.impact,
          evidence: safeClip(i.evidence),
          suggestion: i.suggestion,
          firstAt: i.firstAt,
        })),
      ...list(chief.issues)
        .filter((i) => i.state !== "answered")
        .map((i) => ({ title: i.question, impact: i.context, firstAt: i.at })),
    ],
    dailyReport:
      dailyCard && (!latest || day(new Date(dailyCard.created_at)) >= latest.date)
        ? { date: day(new Date(dailyCard.created_at)), text: dailyCard.text }
        : latest
          ? { date: latest.date, text: dailyTask.reports.at(-1).executive?.report ?? dailyTask.reports.at(-1).summary }
          : { date: null, text: "尚无日报" },
    ceoRounds: ceoRuns.map((r) => ({
      at: r.finished_at ?? r.claimed_at ?? r.created_at,
      purpose: runTask(r)?.title ?? r.rule,
      status: state(r.state),
      conclusion: safeClip(r.summary || r.error || "尚未提交结论", 600),
    })),
    health: {
      services,
      heartbeat: readJSON(join(directory, "health-heartbeat.json")).at ?? null,
      healthCheckedAt: chief.health?.checkedAt ?? null,
      xiaohongshu: {
        state:
          observation?.observation?.state === "ready"
            ? "最近观测已登录"
            : observation?.observation?.state === "blocked"
              ? "登录或平台验证受阻"
              : "登录态未知",
        checkedAt: observation?.at ?? null,
        note: "仅引用最近只读观测，不启动浏览器或登录验证",
      },
      publishing: projects.map((p) => {
        const last = publications
          .filter((r) => r.business === p.business)
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
        return {
          business: businessName(p.business),
          lastSuccess: last?.publishedAt ?? null,
          pending: list(p.plans)
            .filter((a) => a.status === "publishing" || a.publishWait)
            .map((a) => ({ title: a.title, status: state(a.status), reason: a.publishWait?.reason ?? "待回执" })),
        };
      }),
      quota: {
        today: usageKnown ? Object.values(counts.started).reduce((a, b) => a + b, 0) : null,
        dailyLimit: config.dailyModelRuns?.total ?? null,
      },
    },
  };
  const safe = JSON.parse(JSON.stringify(redact(snapshot, known))) as Snapshot;
  assertSafe(safe, known);
  return safe;
}
export function serviceStates(): Record<string, string> {
  return Object.fromEntries(
    [
      "agent-company",
      "agent-company-web",
      "agent-company-cards",
      "agent-company-card-callback",
      "agent-company-watchdog.timer",
    ].map((name) => {
      const unit = name.includes(".") ? name : name + ".service";
      const r = spawnSync("systemctl", ["show", unit, "--property=ActiveState", "--value"], {
        encoding: "utf8",
        timeout: 5000,
      });
      return [name, r.status === 0 ? r.stdout.trim() : "未知"];
    }),
  );
}
