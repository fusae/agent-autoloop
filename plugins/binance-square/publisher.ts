import { squareLink, type SquareReceipt } from "../company/rabbitrun-receipt.ts";
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
export function squareResult(value: any): SquareReceipt {
  if (value?.code !== "000000") throw Error("币安接口拒绝操作");
  const id = value?.data?.id;
  const link = value?.data?.shareLink ? squareLink(value.data.shareLink) : undefined;
  if (id === undefined || id === null || id === "") {
    if (link) return link;
    throw Error("币安未返回可核验的帖子编号；请只读核对，不可重发");
  }
  if (!(typeof id === "string" || Number.isSafeInteger(id)) || !/^\d{1,30}$/.test(String(id)))
    throw Error("币安帖子编号无效；请只读核对，不可重发");
  if (link && link.remoteId !== String(id)) throw Error("币安回执链接不匹配");
  return { remoteId: String(id), url: `https://www.binance.com/square/post/${id}` };
}
export type SquareDiagnostic = {
  endpoint: string;
  outcome: "http" | "timeout" | "network" | "json" | "api" | "receipt";
  status?: number;
  code?: string;
  idType?: string;
  linkType?: string;
};
export class SquareNotSubmitted extends Error {}
class SquareFailure extends Error {
  diagnostic: SquareDiagnostic;
  constructor(diagnostic: SquareDiagnostic) {
    super(
      `币安接口未确认：${diagnostic.endpoint} ${diagnostic.outcome}${diagnostic.status ? ` HTTP ${diagnostic.status}` : ""}${diagnostic.code ? ` code ${diagnostic.code}` : ""}；请只读核对，不可重发`,
    );
    this.diagnostic = diagnostic;
  }
}
// The reviver retains the original JSON integer, including IDs beyond Number precision.
export function squareJSON(raw: string) {
  return JSON.parse(raw, (name: string, value: unknown, context?: { source?: string }) =>
    name === "id" && typeof value === "number" ? (context?.source ?? value) : value,
  );
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
  let submitted = false;
  try {
    const api = async (endpoint: string, body: unknown) => {
      const request = squareRequest(key, endpoint, body);
      let response;
      try {
        if (endpoint === "content/add") submitted = true;
        response = await network(request.url, request.options);
      } catch (error) {
        throw new SquareFailure({
          endpoint,
          outcome: (error as Error)?.name === "TimeoutError" ? "timeout" : "network",
        });
      }
      if (!response.ok) throw new SquareFailure({ endpoint, outcome: "http", status: response.status });
      let value;
      try {
        value = squareJSON(await response.text());
      } catch {
        throw new SquareFailure({ endpoint, outcome: "json", status: response.status });
      }
      const diagnostic: SquareDiagnostic = {
        endpoint,
        outcome: "api",
        status: response.status,
        ...(typeof value?.code === "string" && /^\d{1,8}$/.test(value.code) ? { code: value.code } : {}),
        idType: typeof value?.data?.id,
        linkType: typeof value?.data?.shareLink,
      };
      if (value?.code !== "000000") {
        // These documented rejections occur before creating content; a 504 or unknown code does not prove absence.
        if (
          [
            "220003",
            "220004",
            "220009",
            "220014",
            "20002",
            "20022",
            "20013",
            "20020",
            "220011",
            "30008",
            "2000001",
            "2000002",
          ].includes(value?.code)
        )
          throw new SquareNotSubmitted("币安明确拒绝提交，确认未发布");
        throw new SquareFailure(diagnostic);
      }
      if (endpoint === "content/add") {
        try {
          squareResult(value);
        } catch {
          throw new SquareFailure({ ...diagnostic, outcome: "receipt" });
        }
      }
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
  } catch (error) {
    if (!submitted) throw new SquareNotSubmitted("币安发布前准备未完成，确认未发布");
    throw error;
  }
}
const day = (date: Date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export async function squarePublication(
  directory: string,
  request: RabbitRequest,
  publish: (draft: RabbitDraft) => Promise<SquareReceipt>,
  now = new Date(),
  reconcile?: (startedAt: string) => Promise<SquareReceipt | undefined>,
) {
  const draft = rabbitDraft(request);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, request.key + ".lock");
  try {
    if (request.action === "publish") mkdirSync(lock, { mode: 0o700 });
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
    const record = (state: any, result: SquareReceipt) => {
      const at = result.confirmation?.at ?? state.startedAt;
      const proof = {
        key: request.key,
        channel: rabbitChannel,
        ...result,
        publishedAt: at,
        x: { state: "pending", attempts: 0, at } satisfies XReceipt,
      };
      durableSave(path, { ...state, proof });
      return { state: "published", ...proof };
    };
    if (saved && !saved.absent) {
      const result = await reconcile?.(saved.startedAt);
      if (result) return record(saved, result);
      return { state: "unknown", reason: saved.reason ?? "币安发布结果待只读核对；未取得回执，不可重发" };
    }
    if (request.action === "lookup") return { state: "absent" };
    const previous = readdirSync(directory)
      .filter((f) => /^[a-f0-9]{32}\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(directory, f), "utf8")));
    if (previous.some((p) => !p.absent && day(new Date(p.proof?.publishedAt ?? p.startedAt)) === day(now)))
      throw Error("今日已发与未知合计达到一篇");
    // Write intent before any network request. A lost HTTP response must never enable a second POST.
    const state = { fingerprint, startedAt: now.toISOString() };
    durableSave(path, state);
    let result;
    try {
      result = await publish(draft);
    } catch (error) {
      const reason =
        error instanceof SquareFailure ? error.message : "币安发布失败或结果未知，请只读核对；不会自动重发";
      const absent = error instanceof SquareNotSubmitted;
      durableSave(path, {
        ...state,
        absent,
        reason,
        ...(error instanceof SquareFailure ? { diagnostic: error.diagnostic } : {}),
      });
      return { state: absent ? "absent" : "unknown", reason };
    }
    return record(state, result);
  } finally {
    if (request.action === "publish") rmSync(lock, { recursive: true, force: true });
  }
}
