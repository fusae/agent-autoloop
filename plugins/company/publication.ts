import { submitAndReadback, type Readback } from "./publication-readback.ts";
import { squareLink, type OwnerConfirmation } from "./rabbitrun-receipt.ts";
import { checkJinzhaoDelivery } from "./jinzhao-writing.ts";
import { rabbitChannel, rabbitDraft, xReceipt, type XReceipt } from "./rabbitrun.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Task } from "./company.ts";

export type Publication = {
  key: string;
  channel: string;
  remoteId: string;
  url: string;
  publishedAt: string;
  x?: XReceipt;
  confirmation?: OwnerConfirmation;
  deleted?: { at: string; reason: string };
};
export class PublicationPending extends Error {}
export class PublicationAbsent extends Error {}
export type PublicationAttempt = {
  key: string;
  channel: string;
  state: "unknown" | "absent";
  at: string;
  checks: number;
  lastCycle?: number;
  manual?: boolean;
  reason?: string;
};
export function publicationAttempt(directory: string, key: string): PublicationAttempt | undefined {
  const path = file(directory, key, "-readback");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
export function savePublicationAttempt(directory: string, attempt: PublicationAttempt) {
  save(file(directory, attempt.key, "-readback"), attempt);
}
type Request = {
  key: string;
  business: string;
  plan: string;
  task: string;
  artifacts: { path: string; sha256: string; content: string }[];
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function file(directory: string, key: string, suffix = "") {
  if (!/^[a-f0-9]{32}$/.test(key)) throw Error("发布记录编号不正确");
  return join(directory, "publications", key + suffix + ".json");
}
function save(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(path + ".tmp", path);
}
export function freezePublication(
  directory: string,
  business: string,
  plan: string,
  task: Task,
  selected?: string[],
): string {
  const workspace = realpathSync(join(directory, "workspace"));
  const registered = task.reports.at(-1)?.artifacts ?? [];
  const paths = selected ?? registered;
  if (paths.some((path) => !registered.includes(path))) throw Error("只能发布本次已验收交付中的正文文件");
  if (!paths.length) throw Error("成果缺少可审核的交付文件");
  const configPath = join(directory, "company.json");
  if (business === "jinzhao" && existsSync(configPath) && JSON.parse(readFileSync(configPath, "utf8")).jinzhaoWriting) {
    const errors = checkJinzhaoDelivery(directory, paths);
    if (errors.length) throw Error(`今朝程序检查未通过：${errors.join("；")}`);
  }
  let size = 0;
  const artifacts = paths.map((path) => {
    const resolved = realpathSync(isAbsolute(path) ? path : join(workspace, path));
    const rel = relative(workspace, resolved);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw Error("发布文件必须位于公司工作区");
    const stat = statSync(resolved);
    size += stat.size;
    if (!stat.isFile() || size > 1_000_000) throw Error("发布内容须为总计不超过1MB的文本文件");
    const content = readFileSync(resolved, "utf8");
    if (content.includes("\u0000")) throw Error("当前发布入口只接受文本内容");
    return { path: rel, content, sha256: digest(content) };
  });
  const key = digest(
    JSON.stringify([business, plan, task.id, task.assignment, artifacts.map((a) => [a.path, a.sha256])]),
  ).slice(0, 32);
  if (business === "rabbitrun") rabbitDraft({ key, business, channel: rabbitChannel, action: "lookup", artifacts });
  if (!existsSync(file(directory, key)))
    save(file(directory, key), { key, business, plan, task: task.id, artifacts } satisfies Request);
  return key;
}
export function publication(value: unknown): Publication {
  const p = value as Publication;
  if (!p || !/^[a-f0-9]{32}$/.test(p.key)) throw Error("发布结果缺少审核记录");
  if (
    p.deleted &&
    (!Number.isFinite(Date.parse(p.deleted.at)) || typeof p.deleted.reason !== "string" || !p.deleted.reason.trim())
  )
    throw Error("删除记录需要时间与原因");
  const c = p.confirmation;
  if (
    c &&
    (c.source !== "chairman" ||
      p.channel !== rabbitChannel ||
      !p.x ||
      !Number.isSafeInteger(c.card) ||
      c.card < 1 ||
      !Number.isSafeInteger(c.event) ||
      c.event < 1 ||
      !Number.isFinite(Date.parse(c.at)) ||
      c.at !== p.publishedAt)
  )
    throw Error("董事长确认回执无效");
  const missingLink = !!c && p.remoteId === "" && p.url === "";
  for (const name of (missingLink
    ? ["channel", "publishedAt"]
    : ["channel", "remoteId", "url", "publishedAt"]) as (keyof Pick<
    Publication,
    "channel" | "remoteId" | "url" | "publishedAt"
  >)[])
    if (typeof p[name] !== "string" || !p[name].trim() || p[name].length > 200)
      throw Error("发布结果缺少渠道、链接、平台编号或时间");
  const url = missingLink ? null : new URL(p.url);
  if (
    (url && (url.protocol !== "https:" || url.username || url.password)) ||
    !Number.isFinite(Date.parse(p.publishedAt))
  )
    throw Error("发布链接或时间无效");
  if (c && !missingLink && squareLink(p.url).remoteId !== p.remoteId) throw Error("币安回执链接不匹配");
  return {
    key: p.key,
    channel: p.channel,
    remoteId: p.remoteId,
    url: p.url,
    publishedAt: p.publishedAt,
    ...(p.deleted ? { deleted: { at: p.deleted.at, reason: p.deleted.reason } } : {}),
    ...(p.x ? { x: xReceipt(p.x) } : {}),
    ...(c ? { confirmation: { source: c.source, card: c.card, event: c.event, at: c.at } } : {}),
  };
}
export function verifiedPublication(directory: string, key: string): Publication {
  return publication(JSON.parse(readFileSync(file(directory, key, "-result"), "utf8")));
}
export function executePublication(directory: string, key: string, lookupOnly = false): Publication {
  const request: Request = JSON.parse(readFileSync(file(directory, key), "utf8"));
  if (request.key !== key) throw Error("发布审核记录不匹配");
  if (existsSync(file(directory, key, "-result")))
    return publication(JSON.parse(readFileSync(file(directory, key, "-result"), "utf8")));
  const configFile = join(directory, "publishing.json");
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const target = config.projects?.[request.business];
  if (!target) throw Error("内容已审核，尚未接入该项目的发布渠道和账号；需要确定发布平台并完成账号接入");
  if (
    typeof target.channel !== "string" ||
    !target.channel.trim() ||
    !Array.isArray(target.command) ||
    !target.command.length ||
    !target.command.every((v: unknown) => typeof v === "string") ||
    (!isAbsolute(target.command[0]) && target.command[0] !== "sudo")
  )
    throw Error("发布入口配置不完整，需要修复渠道及固定执行程序");
  const timeout = target.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000)
    throw Error("发布入口超时必须为1000–600000毫秒");
  const call = (action: "lookup" | "publish", remainingMs?: number): any => {
    // Commands come only from private operator configuration, never from CEO text or draft files.
    const result = spawnSync(
      target.command[0] === "sudo" ? "/usr/bin/sudo" : target.command[0],
      target.command.slice(1),
      {
        input: JSON.stringify({ ...request, channel: target.channel, action }),
        encoding: "utf8",
        timeout: action === "lookup" ? Math.min(timeout, remainingMs ?? timeout) : timeout,
        maxBuffer: 100_000,
        cwd: directory,
        shell: false,
      },
    );
    if (result.error || result.status !== 0)
      throw new PublicationPending("发布入口调用失败，尚未确认平台结果；保留原发布编号核对，不能重复发布");
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new PublicationPending("发布入口未返回可核验结果，不能视为发布成功");
    }
  };
  const previous = publicationAttempt(directory, key);
  const maxMs =
    target.readbackMs ?? (request.artifacts.some((a) => /(^|\/)xiaohongshu\.json$/.test(a.path)) ? 120_000 : 0);
  if (!Number.isInteger(maxMs) || maxMs < 0 || maxMs > 120_000) throw Error("回读时间必须为0–120000毫秒");
  let submitted = false;
  const result = submitAndReadback({
    lookup: (remainingMs) => call("lookup", maxMs === 0 ? undefined : remainingMs) as Readback,
    publish: () => call("publish") as Readback,
    lookupOnly,
    maxMs,
    beforeSubmit: () => {
      submitted = true;
      savePublicationAttempt(directory, {
        key,
        channel: target.channel,
        state: "unknown",
        at: new Date().toISOString(),
        checks: 0,
      });
    },
  });
  if (result.state !== "published") {
    const reason =
      typeof result.reason === "string" && result.reason.trim()
        ? result.reason.slice(0, 400)
        : "平台尚未确认发布成功，保留本篇编号继续只读核对";
    savePublicationAttempt(directory, {
      ...(previous ?? {}),
      key,
      channel: target.channel,
      state: result.state === "absent" ? "absent" : "unknown",
      at: submitted ? publicationAttempt(directory, key)!.at : (previous?.at ?? new Date().toISOString()),
      checks: previous?.checks ?? 0,
      reason,
    });
    if (result.state === "blocked" || /扫码|登录已失效|账号.*不一致/.test(reason)) throw Error(reason);
    if (result.state === "absent") throw new PublicationAbsent("平台确认未发布，可安全重试原稿");
    throw new PublicationPending(reason);
  }
  const proof = publication(result);
  if (proof.key !== key || proof.channel !== target.channel) throw Error("平台发布结果与本次审核或配置渠道不匹配");
  save(file(directory, key, "-result"), proof);
  return proof;
}
