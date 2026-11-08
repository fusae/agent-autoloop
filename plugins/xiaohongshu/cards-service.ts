import {
  constants,
  renameSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { cardSpec, renderPNGs } from "./cards-renderer.ts";

// Files are the narrow transport: the employee sandbox blocks connect() and shutdown().
// The service gets only this directory, no company credentials, caller paths, HTML or commands.
export function serveCards(spool: string, render = renderPNGs) {
  for (const name of readdirSync(spool).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
    const request = join(spool, name),
      response = request.replace(/\.json$/, ".result.json");
    let fd: number | undefined;
    let result: { images: string[] } | { error: string };
    try {
      fd = openSync(request, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64_000) throw Error("配图请求须为64KB内的JSON文件");
      const spec = cardSpec(JSON.parse(readFileSync(fd, "utf8")));
      result = { images: render(spec).map((png) => png.toString("base64")) };
    } catch (e) {
      result = { error: e instanceof Error ? e.message : "配图失败" };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    try {
      // Exclusive creation prevents a supplied symlink from redirecting the service's write.
      const temp = response + ".tmp";
      writeFileSync(temp, JSON.stringify(result), { flag: "wx", mode: 0o660 });
      chmodSync(temp, 0o660);
      renameSync(temp, response);
    } catch (e) {
      console.error("配图响应写入失败", e instanceof Error ? e.message : "");
    }
    try {
      unlinkSync(request);
    } catch {
      /* The caller may have timed out. */
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const spool = process.argv[2] ?? "/work";
  while (true) {
    serveCards(spool, (spec) => renderPNGs(spec, process.env.XHS_CARDS_BROWSER));
    await delay(250);
  }
}
