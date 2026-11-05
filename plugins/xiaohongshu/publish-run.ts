import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { xhsPublication } from "./publisher.ts";
const configFile = process.argv[2];
try {
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1_100_000) throw Error("小红书稿件超过大小限制");
  }
  console.log(
    JSON.stringify(
      await xhsPublication(config, join(dirname(configFile), "xiaohongshu-publications"), JSON.parse(input)),
    ),
  );
} catch (error) {
  console.log(JSON.stringify({ state: "unknown", reason: error instanceof Error ? error.message : "小红书发布失败" }));
}
