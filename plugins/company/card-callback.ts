import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const digest = (value: string) => createHash("sha256").update(value).digest();
const errorDetail = (error: unknown, secrets: unknown[] = []) => {
  const e = error as NodeJS.ErrnoException;
  let detail = `${e?.code ?? "UNKNOWN"} errno=${e?.errno ?? "unknown"}: ${e?.message ?? "未知错误"}`;
  for (const secret of secrets)
    if (typeof secret === "string" && secret) detail = detail.replaceAll(secret, "[已隐藏]");
  return detail.replace(/[\r\n]/g, " ");
};

export function cardCallbackServer(spool: string, privateDir: string, log: (message: string) => void = console.error) {
  mkdirSync(spool, { recursive: true, mode: 0o700 });
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(privateDir, "verification-token");
  const publish = (key: string) => {
    const pending = join(privateDir, key + ".pending");
    // systemd may mount these directories separately; rename only within the consumer directory.
    const temporary = join(spool, "http-" + key + ".tmp");
    writeFileSync(temporary, readFileSync(pending), { mode: 0o600, flush: true });
    renameSync(temporary, join(spool, "http-" + key + ".json"));
    renameSync(pending, join(privateDir, key + ".done"));
  };
  // Recover interrupted publication; the existing channel also deduplicates accepted event IDs.
  for (const file of readdirSync(privateDir)) {
    if (/^[a-f0-9]{64}\.pending$/.test(file)) publish(file.slice(0, -8));
  }
  return createServer({ requestTimeout: 3000, headersTimeout: 3000 }, (request, response) => {
    const started = performance.now();
    response.on("finish", () =>
      log(`飞书 HTTP 回调响应 status=${response.statusCode} duration_ms=${(performance.now() - started).toFixed(2)}`),
    );
    const reply = (status: number, body: object = {}) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/feishu/card-callback") {
      reply(404);
      request.resume();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("error", (error) => log(`飞书 HTTP 回调请求中断：${errorDetail(error)}`));
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        if (!response.writableEnded) reply(413);
        chunks.length = 0;
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      const raw = Buffer.concat(chunks);
      let body: any;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        reply(400);
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        reply(400);
        return;
      }
      if ("encrypt" in body) {
        log("飞书 HTTP 回调需要 Encrypt Key");
        reply(400);
        return;
      }
      let known: string | undefined;
      try {
        const verification = body.type === "url_verification";
        if (verification && typeof body.challenge !== "string") {
          reply(400);
          return;
        }
        const token = body.header?.token ?? body.token;
        known = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") : undefined;
        if (
          typeof token !== "string" ||
          !token ||
          (known === undefined ? !verification : !timingSafeEqual(digest(token), digest(known))) ||
          (body.token !== undefined && body.token !== token)
        ) {
          log("飞书 HTTP 回调 token 校验失败（401）");
          reply(401);
          return;
        }
        if (verification) {
          if (known === undefined) {
            writeFileSync(tokenFile, token, { mode: 0o600, flag: "wx", flush: true });
            log("飞书 HTTP 回调已保存首次校验 token");
          }
          reply(200, { challenge: body.challenge });
          return;
        }
        if (
          body.schema !== "2.0" ||
          body.header?.event_type !== "card.action.trigger" ||
          typeof body.header.event_id !== "string" ||
          !body.header.event_id ||
          !body.event ||
          typeof body.event !== "object" ||
          Array.isArray(body.event)
        ) {
          reply(400);
          return;
        }
        const key = digest(body.header.event_id).toString("hex");
        if (!existsSync(join(privateDir, key + ".done"))) {
          if (!existsSync(join(privateDir, key + ".pending"))) {
            writeFileSync(join(privateDir, key + ".tmp"), raw, { mode: 0o600, flush: true });
            renameSync(join(privateDir, key + ".tmp"), join(privateDir, key + ".pending"));
          }
          publish(key);
        }
        reply(200);
      } catch (error) {
        log(
          `飞书 HTTP 回调保存失败（500）：${errorDetail(error, [known, body.token, body.header?.token, body.event?.token])}`,
        );
        reply(500);
      }
    });
  });
}

if (import.meta.main) {
  const [spool, privateDir, port] = process.argv.slice(2);
  if (!spool || !privateDir || !/^\d+$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535)
    throw new Error("用法：card-callback.ts <回调目录> <私有目录> <端口>");
  const server = cardCallbackServer(spool, privateDir);
  server.listen(Number(port), "127.0.0.1", () => console.error(`飞书 HTTP 回调监听 127.0.0.1:${port}`));
  process.on("SIGTERM", () => server.close());
  process.on("SIGINT", () => server.close());
}
