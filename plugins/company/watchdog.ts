import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { promisify } from "node:util";

export type WatchdogState = {
  startedAt: string;
  sentAt?: string;
  sentScore?: number;
  notified?: Record<string, string>;
  pending?: { key: string; text: string; score: number; at: string; problems: string[] };
};
export type WatchdogCheck = { services: { name: string; label: string; ok: boolean }[]; heartbeat?: string };
export async function checkWatchdog(
  state: WatchdogState,
  check: WatchdogCheck,
  now: Date,
  save: (state: WatchdogState) => void,
  send: (key: string, text: string) => Promise<void>,
) {
  const problems = check.services.filter((s) => !s.ok).map((s) => s.label);
  const keys = check.services.filter((s) => !s.ok).map((s) => s.name);
  const heartbeat = check.heartbeat ? Date.parse(check.heartbeat) : Date.parse(state.startedAt);
  const stale = !Number.isFinite(heartbeat) || now.getTime() - heartbeat > 15 * 60000;
  if (stale) {
    problems.push("经营程序心跳超过15分钟未更新");
    keys.push("heartbeat");
  }
  keys.sort();
  if (!problems.length) {
    delete state.pending;
    save(state);
    return { healthy: true, sent: false };
  }
  const score = check.services.filter((s) => !s.ok).length * 2 + Number(stale);
  if (
    keys.every((key) => state.notified?.[key] && now.getTime() - Date.parse(state.notified[key]) < 86400_000) &&
    score <= (state.sentScore ?? 0)
  ) {
    delete state.pending;
    save(state);
    return { healthy: false, sent: false };
  }
  const text = `发生：${problems.join("、")}。\n影响：调度、后台或审批回调可能中断。\n已尝试：独立看门狗已检查服务响应和程序心跳，未调用引擎或模型处理。\n需要董事长：请检查服务器并恢复异常服务。`;
  if (
    !state.pending ||
    state.pending.score !== score ||
    JSON.stringify(state.pending.problems) !== JSON.stringify(keys)
  )
    state.pending = {
      key: createHash("sha256")
        .update(`${state.startedAt}:${state.sentAt ?? "first"}:${score}:${keys.join(",")}`)
        .digest("hex")
        .slice(0, 32),
      text,
      score,
      at: now.toISOString(),
      problems: keys,
    };
  save(state);
  await send(state.pending.key, state.pending.text);
  state.sentAt = now.toISOString();
  state.sentScore = score;
  state.notified ??= {};
  for (const key of keys) state.notified[key] = now.toISOString();
  delete state.pending;
  save(state);
  return { healthy: false, sent: true };
}
const runFile = promisify(execFile);
export async function runWatchdog(directory: string) {
  if (!isAbsolute(directory)) throw Error("看门狗需要私有公司目录绝对路径");
  const file = join(directory, "watchdog-state.json"),
    now = new Date();
  const state: WatchdogState = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { startedAt: now.toISOString() };
  const config = JSON.parse(readFileSync(join(directory, "watchdog.json"), "utf8"));
  const hub = JSON.parse(readFileSync(join(directory, "hub/config.json"), "utf8"));
  const channel = hub.channels?.["company-feishu"];
  if (!/^ou_[A-Za-z0-9]+$/.test(channel?.user)) throw Error("看门狗缺少已配置董事长收件人");
  const probes = [
    { name: "agent-company", label: "任务引擎", url: new URL("/v1/state", hub.url).href, status: 200, owner: true },
    {
      name: "agent-company-web",
      label: "后台",
      url: config.dashboardUrl ?? "http://127.0.0.1:3361/api/session",
      status: 200,
      owner: false,
    },
    { name: "agent-company-card-callback", label: "飞书回调", url: config.callbackUrl, status: 404, owner: false },
  ];
  for (const p of probes) {
    const url = new URL(p.url);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw Error("看门狗只能探测本机HTTP服务");
  }
  const services = await Promise.all(
    probes.map(async (p) => {
      let ok = false;
      try {
        await runFile("systemctl", ["is-active", "--quiet", p.name], { timeout: 5000 });
        const response = await fetch(p.url, {
          signal: AbortSignal.timeout(3000),
          redirect: "error",
          headers: p.owner ? { authorization: `Bearer ${hub.owner}` } : {},
        });
        ok = response.status === p.status;
        await response.body?.cancel();
      } catch {
        /* Only service labels leave this process; never expose HTTP or CLI credentials. */
      }
      return { name: p.name, label: p.label, ok };
    }),
  );
  let heartbeat: string | undefined;
  try {
    heartbeat = JSON.parse(readFileSync(join(directory, "health-heartbeat.json"), "utf8")).at;
  } catch {
    /* Initial startup has a 15-minute grace period. */
  }
  const save = (s: WatchdogState) => {
    writeFileSync(file + ".tmp", JSON.stringify(s), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  };
  return checkWatchdog(state, { services, heartbeat }, now, save, async (key, text) => {
    let result: any;
    try {
      const { stdout } = await runFile(
        channel.lark ?? "lark-cli",
        ["im", "+messages-send", "--as", "bot", "--user-id", channel.user, "--text", text, "--idempotency-key", key],
        { timeout: 15000, maxBuffer: 256000 },
      );
      result = JSON.parse(stdout);
    } catch {
      throw Error("看门狗告警发送失败，保留相同消息编号待下次重试");
    }
    if (
      result.ok === false ||
      result.error ||
      (result.code !== undefined && result.code !== 0) ||
      !/^om_/.test(result.data?.message_id ?? "")
    )
      throw Error("看门狗告警未取得有效发送回执");
  });
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runWatchdog(process.argv[2])));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
