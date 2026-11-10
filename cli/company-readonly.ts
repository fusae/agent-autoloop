// The privileged entry accepts only fixed commands; errors never include raw subprocess output.
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { collectSnapshot, redact, serviceStates, type Snapshot } from "./company-status-snapshot.ts";

export const services = [
  "agent-company",
  "agent-company-web",
  "agent-company-cards",
  "agent-company-card-callback",
  "agent-company-watchdog",
  "agent-company-watchdog.timer",
];
export function sanitize(value: any): any {
  if (typeof value === "string") {
    try {
      if (!/^\s*[\[{]/.test(value)) return redact(value);
      return sanitize(JSON.parse(value));
    } catch {
      return redact(value);
    }
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return redact(
      Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !/^(?:owner|key|account|author|answerers)$/i.test(k))
          .map(([k, v]) => [k, sanitize(v)]),
      ),
    );
  return value;
}
function run(command: string, args: string[], timeout = 15000, input?: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  if (result.status !== 0 || result.error) throw Error("查询失败或被拒绝：只读限制、服务不可用或超时");
  return result.stdout;
}
export function summary(s: Snapshot) {
  const short = (v: unknown, max = 70) => {
    const text = String(v ?? "未知").replace(/\s+/g, " ");
    return text.length > max ? text.slice(0, max) + "…" : text;
  };
  const rows = (items: any[], render: (item: any) => string, max = 6) =>
    items.length
      ? items.slice(0, max).map(render).join("；") +
        (items.length > max ? `；另${items.length - max}项（共${items.length}项）` : "")
      : "暂无";
  const limit = (v: unknown) => v ?? "未设置";
  const publication = (p: any) => `${short(p.business, 12)}/${p.platform} ${short(p.title, 30)} ${p.link}`;
  const h = s.health;
  return [
    `公司现状 ${s.generatedAt}（列表为摘要，省略项标明数量）`,
    `服务与心跳：${Object.entries(h.services)
      .map(([k, v]) => `${k}=${v}`)
      .join("；")}；心跳 ${h.heartbeat ?? "未知"}`,
    `今日轮次/额度：全公司 ${h.quota.today ?? "未知"}/${limit(h.quota.dailyLimit)}；${rows(s.staff, (p) => `${short(p.name, 20)} ${p.todayRounds ?? "未知"}/${limit(p.dailyLimit)}`, 20)}`,
    `本周目标与进度：${rows(s.businesses, (b) => `${short(b.name, 15)} 已发${b.progress.publishedThisWeek}；${rows(b.goals, (g: any) => `${short(g.employee, 10)}：${short(g.direction, 45)} ${rows(g.metrics, (m: any) => `${m.name} ${m.target ?? "未知"}${m.unit ?? ""}`, 2)}`, 2)}`, 6)}`,
    `在途稿件：${rows(s.drafts, (d) => `${short(d.business, 12)} ${short(d.title, 35)} [${d.status}]`)}`,
    `选题池：${rows(s.businesses, (b) => `${short(b.name, 12)}：${rows(b.topics, (t: any) => `${short(t.title, 25)}[${t.status}]`, 3)}`)}`,
    `今日发布：${rows(s.publications.today, publication)}`,
    `近7天发布：${rows(s.publications.recent7Days, publication)}`,
    `待董事长：${rows(s.chairman, (p) => short(p.title), 3)}`,
    `待维护者：${rows(s.maintenance, (p) => short(p.title), 3)}`,
    `未解决异常：${rows(s.anomalies, (p) => `${short(p.title)}：${short(p.impact, 50)}`, 3)}`,
    `小红书：${h.xiaohongshu.state}（观测 ${h.xiaohongshu.checkedAt ?? "未知"}；实时请用company_xhs）；发布通道：${rows(h.publishing, (p) => `${short(p.business, 12)} 最近成功${p.lastSuccess ?? "暂无"}，待处理${p.pending.length}`)}`,
    `最近日报 ${s.dailyReport.date ?? ""}：${short(s.dailyReport.text, 300)}`,
  ].join("\n");
}
export function readonlyQuery(root: string, command: string, args: string[]) {
  let value: unknown;
  if (command === "status" && !args.length) value = summary(collectSnapshot(root, new Date(), serviceStates()));
  else if (["sql", "read", "ls"].includes(command))
    value = JSON.parse(
      run("/usr/bin/python3", [
        join(import.meta.dirname, "../plugins/company/readonly-data.py"),
        root,
        command,
        ...args,
      ]),
    );
  else if (command === "logs" && args.length >= 1 && args.length <= 3 && services.includes(args[0])) {
    const minutes = args[1] ?? "60";
    if (!/^\d+$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > 10080 || (args[2]?.length ?? 0) > 200)
      throw Error("拒绝查询：日志参数不正确");
    const unit = args[0].endsWith(".timer") ? args[0] : args[0] + ".service";
    const output = run("/usr/bin/journalctl", [
      "--no-pager",
      "--quiet",
      "--output=short-iso",
      "--unit",
      unit,
      "--since",
      `${minutes} minutes ago`,
      "--lines=500",
    ]);
    value = output
      .split("\n")
      .filter((line) => !args[2] || line.includes(args[2]))
      .slice(-500)
      .join("\n");
  } else if (command === "xhs" && !args.length)
    value = run(
      "/usr/bin/sudo",
      ["-n", "-u", "company-reader", "/usr/local/libexec/company-xhs-read"],
      25000,
      JSON.stringify({ action: "status" }),
    );
  else throw Error("拒绝查询：没有此只读命令或参数不正确");
  const safe = sanitize(value);
  const output = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  if (Buffer.byteLength(output) > 200 * 1024) throw Error("拒绝查询：结果超过200KB，请缩小范围");
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    console.log(readonlyQuery("/var/lib/agent-company/company", process.argv[2], process.argv.slice(3)));
  } catch {
    console.error("查询被拒绝或失败：仅限白名单只读命令、SELECT/WITH、允许的相对路径及输出范围");
    process.exitCode = 1;
  }
}
