import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Refuse to patch a different upstream revision or overwrite another maintainer's changes.
const directory = resolve(process.argv[2]);
for (const [file, expected] of [
  ["routes.go", "5e86f99cba9b8ecf16af50bcfb055dd4ed6b9247b6f58e0e1e557eaa678303d6"],
  ["xiaohongshu/creator_session.go", "be939563596483cb2a13ce6387c5592aa81d0df425ba79971034d05a14b18750"],
]) {
  if (
    createHash("sha256")
      .update(readFileSync(join(directory, file)))
      .digest("hex") !== expected
  )
    throw Error(`上游文件版本不符，停止覆盖：${file}`);
}
const source = join(import.meta.dirname, "upstream");
for (const file of ["creator_session.go", "creator-page.js", "creator_session_test.go"])
  copyFileSync(join(source, file), join(directory, "xiaohongshu", file));
for (const file of ["creator_status.go", "creator_status_test.go"])
  copyFileSync(join(source, file), join(directory, file));
const routes = join(directory, "routes.go");
writeFileSync(
  routes,
  readFileSync(routes, "utf8").replace(
    'api.GET("/login/status", appServer.checkLoginStatusHandler)',
    'api.GET("/login/status", appServer.checkLoginStatusHandler)\n\t\tapi.GET("/login/creator-status", appServer.creatorStatusHandler)',
  ),
);
console.log("创作者登录检查补丁已应用");
