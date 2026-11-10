import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readXhsStatus } from "./status.ts";
import { readXhs } from "./reader.ts";
try {
  if (process.argv.length !== 3) throw Error("只读入口不接受附加参数");
  const configFile = process.argv[2];
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 10000) throw Error("读取请求过大");
  }
  const request = JSON.parse(input);
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  console.log(
    JSON.stringify(
      request?.action === "status"
        ? await readXhsStatus(config, request)
        : await readXhs(config, join(dirname(configFile), "xiaohongshu-readonly"), request),
    ),
  );
} catch {
  console.log(JSON.stringify({ state: "unknown", reason: "只读请求无效或平台字段不完整" }));
}
