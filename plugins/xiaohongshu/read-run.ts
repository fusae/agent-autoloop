import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readXhs } from "./reader.ts";
try {
  if (process.argv.length !== 3) throw Error("只读入口不接受附加参数");
  const configFile = process.argv[2];
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 10000) throw Error("读取请求过大");
  }
  console.log(
    JSON.stringify(
      await readXhs(
        JSON.parse(readFileSync(configFile, "utf8")),
        join(dirname(configFile), "xiaohongshu-readonly"),
        JSON.parse(input),
      ),
    ),
  );
} catch {
  console.log(JSON.stringify({ state: "unknown", reason: "只读请求无效或平台字段不完整" }));
}
