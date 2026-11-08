import { readFileSync, statSync } from "node:fs";
import { approvedRabbitRequest, rabbitQueue } from "../plugins/company/rabbitrun-bridge.ts";
import { squarePublication, squarePublish } from "../plugins/binance-square/publisher.ts";

const directory = "/var/lib/agent-company/company";
const stateDirectory = "/var/lib/agent-company-publisher/rabbitrun";
try {
  if (process.getuid?.() !== 0 || process.argv.length !== 3 || !["publish", "x"].includes(process.argv[2]))
    throw Error("固定发布入口无效");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1_100_000) throw Error("请求过长");
  }
  const value = JSON.parse(input);
  let result;
  if (process.argv[2] === "x") result = rabbitQueue(directory, stateDirectory, value);
  else {
    if (!["lookup", "publish"].includes(value.action)) throw Error("动作无效");
    const request = approvedRabbitRequest(directory, value.key, value.action);
    result = await squarePublication(stateDirectory, request, async (draft) => {
      const file = "/etc/agent-company/binance-square.env",
        stat = statSync(file);
      if (stat.uid !== 0 || (stat.mode & 0o777) !== 0o600 || !stat.isFile()) throw Error("密钥文件权限无效");
      const key = readFileSync(file, "utf8").trim();
      if (!key || /[\r\n]/.test(key)) throw Error("密钥格式无效");
      return squarePublish(key, draft);
    });
  }
  process.stdout.write(JSON.stringify(result));
} catch {
  // Stdin, credentials, network errors and server response bodies must never enter output or logs.
  process.stdout.write(
    JSON.stringify({
      state: "blocked",
      reason: "发布入口拒绝或未完成操作；请核对批准、权限和已有发布记录，不可盲目重发",
    }),
  );
  process.exitCode = 1;
}
