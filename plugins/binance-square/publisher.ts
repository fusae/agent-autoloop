import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  rabbitChannel,
  rabbitDraft,
  rabbitText,
  type RabbitRequest,
  type RabbitDraft,
  type XReceipt,
} from "../company/rabbitrun.ts";

const base = "https://www.binance.com/bapi/composite/";
export function squareRequest(key: string, endpoint: string, body: unknown) {
  if (!["content/add", "image/presignedUrl", "image/imageStatus"].includes(endpoint)) throw Error("接口不在发布范围");
  return {
    url: `${base}${endpoint === "content/add" ? "v1" : "v2"}/public/pgc/openApi/${endpoint}`,
    options: {
      method: "POST",
      headers: { "X-Square-OpenAPI-Key": key, "Content-Type": "application/json", clienttype: "binanceSkill" },
      body: JSON.stringify(body),
      redirect: "error" as const,
      signal: AbortSignal.timeout(60000),
    },
  };
}
export function squareResult(value: any) {
  const id = value?.data?.id;
  // Numeric IDs beyond JS precision cannot safely identify the published post.
  if (
    value?.code !== "000000" ||
    !(typeof id === "string" || Number.isSafeInteger(id)) ||
    !/^\d{1,30}$/.test(String(id))
  )
    throw Error("币安未返回可核验的帖子编号；请人工核对，不可重发");
  const url = `https://www.binance.com/square/post/${id}`;
  if (value.data.shareLink) {
    const link = new URL(value.data.shareLink);
    if (
      link.protocol !== "https:" ||
      link.hostname !== "www.binance.com" ||
      link.username ||
      link.password ||
      !new RegExp(`^/(?:[a-z]{2}(?:-[A-Z]{2})?/)?square/post/${id}$`).test(link.pathname)
    )
      throw Error("币安回执链接不匹配");
  }
  return { remoteId: String(id), url };
}
export function squareBody(draft: RabbitDraft, images: string[]) {
  if (images.length !== draft.images.length) throw Error("配图没有全部上传，禁止发布不完整稿件");
  return { contentType: 1, bodyTextOnly: rabbitText(draft), ...(images.length ? { imageList: images } : {}) };
}
export function durableSave(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600, flush: true, flag: "wx" });
  renameSync(path + ".tmp", path);
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function squarePublish(key: string, draft: RabbitDraft, network = fetch, wait = delay) {
  const api = async (endpoint: string, body: unknown) => {
    const request = squareRequest(key, endpoint, body);
    const response = await network(request.url, request.options);
    // Never log upstream bodies, URLs from upload grants, headers or exception messages.
    if (!response.ok) throw Error("币安接口未确认操作");
    const value = (await response.json()) as any;
    if (value.code !== "000000") throw Error("币安接口拒绝操作");
    return value;
  };
  const urls: string[] = [];
  for (const [i, image] of draft.images.entries()) {
    const ext = image.mime === "image/png" ? "png" : image.mime === "image/jpeg" ? "jpg" : "webp";
    const grant = (await api("image/presignedUrl", { imageName: `image-${i}.${ext}` })).data;
    const upload = new URL(grant.presignedUrl);
    if (
      upload.protocol !== "https:" ||
      upload.username ||
      upload.password ||
      !/(^|\.)(amazonaws\.com|bnbstatic\.com|binance\.com)$/.test(upload.hostname) ||
      typeof grant.fileTicket !== "string" ||
      !grant.fileTicket
    )
      throw Error("图片上传地址无效");
    const result = await network(upload, {
      method: "PUT",
      headers: { "Content-Type": image.mime },
      body: Buffer.from(image.base64, "base64"),
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (!result.ok) throw Error("图片上传未完成");
    let ready = false;
    for (let n = 0; n < 10; n++) {
      const status = (await api("image/imageStatus", { fileTicket: grant.fileTicket })).data;
      if (status.status === 1) {
        const url = new URL(status.imageUrl);
        if (url.protocol !== "https:" || url.username || url.password) throw Error("图片结果无效");
        urls.push(url.href);
        ready = true;
        break;
      }
      if (status.status === 2) throw Error("图片处理失败");
      if (n < 9) await wait(3000);
    }
    if (!ready) throw Error("图片处理尚未完成");
  }
  return squareResult(await api("content/add", squareBody(draft, urls)));
}
const day = (date: Date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export async function squarePublication(
  directory: string,
  request: RabbitRequest,
  publish: (draft: RabbitDraft) => Promise<{ remoteId: string; url: string }>,
  now = new Date(),
) {
  const draft = rabbitDraft(request);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "publisher.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw Error("发布处理中；异常中断须核对后处理，不能重复发帖");
  }
  try {
    const path = join(directory, request.key + ".json");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([request.business, request.channel, draft]))
      .digest("hex");
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    if (saved && saved.fingerprint !== fingerprint) throw Error("已确认的稿件发生变化");
    if (saved?.proof) return { state: "published", ...saved.proof };
    if (saved) return { state: "unknown", reason: "币安发布结果待人工核对；未取得回执，不可重发" };
    if (request.action === "lookup") return { state: "absent" };
    const previous = readdirSync(directory)
      .filter((f) => /^[a-f0-9]{32}\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(directory, f), "utf8")));
    if (previous.some((p) => !p.proof || day(new Date(p.proof.publishedAt)) === day(now)))
      throw Error("今日已发布或仍有结果待核对；每天最多一篇");
    // Write intent before any network request. A lost HTTP response must never enable a second POST.
    const state = { fingerprint, startedAt: now.toISOString() };
    durableSave(path, state);
    let result;
    try {
      result = await publish(draft);
    } catch {
      return { state: "unknown", reason: "币安发布失败或结果未知，请人工核对；不会自动重发" };
    }
    const proof = {
      key: request.key,
      channel: rabbitChannel,
      ...result,
      publishedAt: now.toISOString(),
      x: { state: "pending", attempts: 0, at: now.toISOString() } satisfies XReceipt,
    };
    durableSave(path, { ...state, proof });
    return { state: "published", ...proof };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
