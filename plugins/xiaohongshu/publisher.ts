import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";

type Config = { endpoint: string; token: string; accountId: string; enabled: boolean };
type Request = {
  action: string;
  key: string;
  business: string;
  channel: string;
  artifacts: { path: string; content: string; sha256: string }[];
};
type Draft = { title: string; content: string; images: { mime: string; base64: string }[] };
type Call = (path: string, body?: unknown) => Promise<any>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalize = (s: string) => s.replace(/\r\n/g, "\n").trim();
export function parseXhsDraft(request: Request): Draft {
  if (!/^[a-f0-9]{32}$/.test(request.key) || !["publish", "lookup"].includes(request.action))
    throw Error("小红书发布请求无效");
  const files = request.artifacts.filter((a) => a.path.endsWith("/xiaohongshu.json") || a.path === "xiaohongshu.json");
  if (files.length !== 1) throw Error("小红书需要已审核的 xiaohongshu.json 图文稿，含标题、正文和图片");
  const file = files[0];
  if (hash(file.content) !== file.sha256 || Buffer.byteLength(file.content) > 1_000_000)
    throw Error("小红书稿件与审核内容不一致或超过1MB");
  const draft = JSON.parse(file.content) as Draft;
  if (typeof draft.title !== "string" || !draft.title.trim() || [...draft.title].length > 20)
    throw Error("小红书标题须为1–20字");
  if (typeof draft.content !== "string" || !draft.content.trim() || [...draft.content].length > 1000)
    throw Error("小红书正文须为1–1000字");
  if (!Array.isArray(draft.images) || draft.images.length < 1 || draft.images.length > 9)
    throw Error("小红书需要1–9张审核图片");
  for (const image of draft.images) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.mime) || typeof image.base64 !== "string")
      throw Error("小红书图片格式无效");
    const b = Buffer.from(image.base64, "base64");
    const valid =
      image.mime === "image/png"
        ? b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : image.mime === "image/jpeg"
          ? b[0] === 255 && b[1] === 216 && b[2] === 255
          : b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
    if (!valid || b.toString("base64") !== image.base64) throw Error("小红书图片内容无效");
  }
  return draft;
}
function save(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(path + ".tmp", path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function xhsApi(config: Pick<Config, "endpoint" | "token">): Call {
  const url = new URL(config.endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/")
    throw Error("小红书接口必须使用服务器本机地址");
  return async (path, body) => {
    const response = await fetch(new URL(path, url), {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
      redirect: "error",
    });
    const result = (await response.json()) as any;
    if (!response.ok || result.success !== true) throw Error("小红书接口未完成操作，请检查登录或平台提示");
    return result.data;
  };
}
export async function xhsPublication(
  config: Config,
  directory: string,
  request: Request,
  call: Call = xhsApi(config),
): Promise<any> {
  const draft = parseXhsDraft(request);
  if (config.enabled !== true) throw Error("小红书发布尚未启用，需先完成账号核验");
  if (!config.accountId) throw Error("小红书尚未绑定账号，请扫码后确认账号");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "publisher.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw Error("小红书正在处理另一项发布；若进程异常退出，需核对平台后清理锁");
  }
  try {
    const status = await call("/api/v1/login/status");
    if (status.is_logged_in !== true) throw Error("小红书登录已失效，请重新扫码登录");
    const response = await call("/api/v1/user/me");
    // The v2.7.2 /user/me handler wraps the profile in data inside the API envelope.
    const profile = response.data ?? response;
    // Older profile responses omit the account ID. Never infer ownership from a nickname.
    const accountId = status.user_id || profile.userBasicInfo?.userId;
    if (accountId !== config.accountId) throw Error("小红书登录账号与绑定账号不一致，禁止发布");
    if (!Array.isArray(profile.feeds)) throw Error("小红书未返回可核验的本人笔记列表");
    const stateFile = join(directory, request.key + ".json");
    const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
    const fingerprint = hash(JSON.stringify([request.business, request.channel, config.accountId, draft]));
    if (saved && saved.fingerprint !== fingerprint) throw Error("同一发布编号的账号或审核稿发生变化");
    const matches = profile.feeds.filter(
      (f: any) => normalize(f.noteCard?.displayTitle || "") === normalize(draft.title),
    );
    const unknown = { state: "unknown", reason: "小红书尚未返回唯一、可核验的发布结果，保留原任务，不能重复发布" };
    if (matches.length) {
      if (!saved || matches.length !== 1) return unknown;
      const f = matches[0];
      if (!/^[a-f0-9]{24}$/.test(f.id) || !f.xsecToken) return unknown;
      const detail = await call("/api/v1/feeds/detail", {
        feed_id: f.id,
        xsec_token: f.xsecToken,
        load_all_comments: false,
      });
      const n = detail?.data?.note;
      if (
        !n ||
        n.noteId !== f.id ||
        n.user?.userId !== config.accountId ||
        normalize(n.title) !== normalize(draft.title) ||
        normalize(n.desc) !== normalize(draft.content) ||
        !Array.isArray(n.imageList) ||
        n.imageList.length !== draft.images.length ||
        !Number.isFinite(n.time) ||
        n.time < saved.startedAt - 60_000 ||
        n.time > Date.now() + 60_000
      )
        return unknown;
      return {
        state: "published",
        key: request.key,
        channel: request.channel,
        remoteId: f.id,
        url: `https://www.xiaohongshu.com/explore/${f.id}`,
        publishedAt: new Date(n.time).toISOString(),
      };
    }
    // A missing note after a write may still be under moderation. It never authorizes another write.
    if (saved) return unknown;
    if (request.action === "lookup") return { state: "absent" };
    const images = draft.images.map((image, i) => {
      const path = join(
        directory,
        `${request.key}-${i}.${image.mime === "image/png" ? "png" : image.mime === "image/jpeg" ? "jpg" : "webp"}`,
      );
      writeFileSync(path, Buffer.from(image.base64, "base64"), { mode: 0o600 });
      return path;
    });
    // Persist before the network write; even a lost response must not permit duplicate publication.
    save(stateFile, { fingerprint, startedAt: Date.now() });
    await call("/api/v1/publish", {
      title: draft.title,
      content: draft.content,
      images,
      visibility: "公开可见",
      is_original: false,
    });
    return unknown;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
