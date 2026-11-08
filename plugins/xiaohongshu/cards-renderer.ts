import {
  constants,
  chmodSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { renderCards, type CardSpec } from "./cards.ts";

export const CARD_SPOOL = "/var/lib/agent-company/company/workspace/.cards-renderer";
export const CARD_BROWSER = "/opt/agent-company/tools/chrome-headless-shell/chrome-headless-shell";
export function cardSpec(value: unknown): CardSpec {
  const s = value as CardSpec;
  if (
    !s ||
    typeof s !== "object" ||
    Object.keys(s).some((k) => !["title", "pages", "theme"].includes(k)) ||
    typeof s.title !== "string" ||
    s.title.length > 200 ||
    (s.pages !== undefined &&
      (!Array.isArray(s.pages) ||
        s.pages.length > 8 ||
        s.pages.some((p) => typeof p !== "string" || p.length > 2000))) ||
    (s.theme !== undefined && !["paper", "lemon", "sky", "blush"].includes(s.theme))
  )
    throw Error("配图格式不正确：只接受标题、最多8页文字和预设主题");
  renderCards(s);
  return s;
}
export function checkPNG(png: Buffer) {
  if (
    png.length < 1000 ||
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    png.readUInt32BE(16) !== 1080 ||
    png.readUInt32BE(20) !== 1440
  )
    throw Error("配图不是1080×1440 PNG");
  return png;
}
export function renderPNGs(spec: CardSpec, browser = CARD_BROWSER): Buffer[] {
  const pages = renderCards(cardSpec(spec));
  if (!existsSync(browser)) throw Error("文字配图渲染器未安装：" + browser);
  const work = mkdtempSync(join(tmpdir(), "xhs-cards-"));
  try {
    return pages.map((html, i) => {
      const page = join(work, `card-${i + 1}.html`),
        png = join(work, `card-${i + 1}.png`);
      writeFileSync(page, html);
      const r = spawnSync(
        browser,
        [
          "--headless",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--hide-scrollbars",
          "--force-device-scale-factor=1",
          "--window-size=1080,1440",
          `--user-data-dir=${join(work, "profile")}`,
          `--screenshot=${png}`,
          pathToFileURL(page).href,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      if (r.status !== 0 || !existsSync(png))
        throw Error("配图渲染失败：" + (r.stderr || r.error?.message || "未生成PNG").slice(-300));
      return checkPNG(readFileSync(png));
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
export async function requestCards(spec: CardSpec, spool: string, timeout = 550_000) {
  const id = randomUUID(),
    request = join(spool, id + ".json"),
    response = join(spool, id + ".result.json");
  const temp = request + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify(cardSpec(spec)), { mode: 0o660, flag: "wx" });
    // The service uses a distinct unprivileged user in the same group, even under a restrictive umask.
    chmodSync(temp, 0o660);
    renameSync(temp, request);
    const deadline = Date.now() + timeout;
    while (!existsSync(response)) {
      if (Date.now() > deadline) throw Error("文字配图服务超时，请在原任务报告阻塞");
      await delay(100);
    }
    const result = JSON.parse(
      readFileSync(response, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }),
    );
    if (result.error) throw Error(result.error);
    if (!Array.isArray(result.images) || result.images.length !== renderCards(spec).length)
      throw Error("配图服务返回张数不正确");
    return result.images.map((s: string) => checkPNG(Buffer.from(s, "base64"))) as Buffer[];
  } finally {
    for (const p of [temp, request, response]) rmSync(p, { force: true });
  }
}
export async function generateCards(value: unknown, outdir: string) {
  const spec = cardSpec(value);
  const spool = process.env.XHS_CARDS_SPOOL ?? CARD_SPOOL;
  // A direct browser remains useful outside the model sandbox; production uses the fixed service.
  const images =
    !process.env.XHS_CARDS_BROWSER && existsSync(spool)
      ? await requestCards(spec, spool)
      : renderPNGs(spec, process.env.XHS_CARDS_BROWSER ?? CARD_BROWSER);
  mkdirSync(outdir, { recursive: true });
  return images.map((png, i) => {
    const file = resolve(outdir, `card-${i + 1}.png`);
    writeFileSync(file, png);
    return file;
  });
}
