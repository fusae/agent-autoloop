// Local stdio transport only: queries cross SSH directly, without a model or company event.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { sanitize, services } from "./company-readonly.ts";

const string = { type: "string", minLength: 1 };
export const tools = [
  ["company_status", "公司现状、轮次额度、目标进度、稿件选题、发布与待办", {}, []],
  [
    "company_sql",
    "只读单条 SELECT/WITH，最多200行",
    { database: { ...string, enum: ["operations", "hub", "model-runs", "company", "business"] }, query: string },
    ["database", "query"],
  ],
  ["company_read", "读取公司目录内非敏感文件，最多200KB", { path: string }, ["path"]],
  ["company_ls", "列出公司目录内允许的文件", { path: string }, ["path"]],
  [
    "company_logs",
    "读取白名单服务日志，最多500行，关键词按字面匹配",
    {
      service: { ...string, enum: services },
      minutes: { type: "integer", minimum: 1, maximum: 10080 },
      keyword: string,
    },
    ["service"],
  ],
  ["company_xhs", "只读查询小红书服务及登录状态，不登录、不发布", {}, []],
].map(([name, description, properties, required]) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
export function argumentsFor(name: string, args: any): string[] {
  const tool = tools.find((t) => t.name === name);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) throw Error("工具或参数不正确");
  const schema = tool.inputSchema as any;
  if (
    !schema.required.every((key: string) => Object.hasOwn(args, key)) ||
    !Object.entries(args).every(([key, value]) => {
      const s = schema.properties[key];
      if (!s) return false;
      if (s.type === "integer")
        return Number.isSafeInteger(value) && Number(value) >= s.minimum && Number(value) <= s.maximum;
      return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 20000 &&
        !value.includes("\0") &&
        (!s.enum || s.enum.includes(value))
      );
    })
  )
    throw Error("工具或参数不正确");
  switch (name) {
    case "company_sql":
      return ["sql", args.database, args.query];
    case "company_read":
      return ["read", args.path];
    case "company_ls":
      return ["ls", args.path];
    case "company_logs":
      return ["logs", args.service, String(args.minutes ?? 60), ...(args.keyword ? [args.keyword] : [])];
    case "company_xhs":
      return ["xhs"];
    default:
      return ["status"];
  }
}
export const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export function callTool(name: string, args: unknown) {
  const command = ["sudo", "-n", "/usr/local/libexec/company-ro", ...argumentsFor(name, args)].map(quote).join(" ");
  const host = process.env.COMPANY_SSH_HOST,
    user = process.env.COMPANY_SSH_USER,
    key = process.env.COMPANY_SSH_KEY;
  if (
    !host ||
    !user ||
    !key ||
    !/^[a-zA-Z0-9._-]+$/.test(host) ||
    host.startsWith("-") ||
    !/^[a-zA-Z0-9_-]+$/.test(user) ||
    user.startsWith("-") ||
    !key.startsWith("/")
  )
    throw Error("缺少本机只读 SSH 配置");
  const result = spawnSync(
    "/usr/bin/ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-l",
      user,
      "-i",
      key,
      host,
      command,
    ],
    { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", maxBuffer: 512 * 1024 },
  );
  if (result.status !== 0 || result.error) throw Error("查询被拒绝或失败：检查参数、只读权限及连接；最长60秒");
  return sanitize(result.stdout);
}
export async function mcp() {
  const reply = (id: unknown, body: object) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  let ready = false;
  for await (const line of createInterface({ input: process.stdin })) {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      reply(null, { error: { code: -32700, message: "不是JSON" } });
      continue;
    }
    if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      reply(null, { error: { code: -32600, message: "请求格式不正确" } });
      continue;
    }
    const { id, method, params } = request;
    if (id === undefined) continue;
    if (method === "initialize") {
      if (typeof params?.protocolVersion !== "string") {
        reply(id, { error: { code: -32602, message: "缺少协议版本" } });
        continue;
      }
      ready = true;
      reply(id, {
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "company", version: "1.0.0" },
        },
      });
    } else if (method === "ping") reply(id, { result: {} });
    else if (!ready) reply(id, { error: { code: -32600, message: "请先初始化" } });
    else if (method === "tools/list") reply(id, { result: { tools } });
    else if (method === "tools/call") {
      try {
        const value = callTool(params?.name, params?.arguments ?? {});
        reply(id, {
          result: { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] },
        });
      } catch {
        reply(id, {
          result: {
            isError: true,
            content: [{ type: "text", text: "查询被拒绝或失败：工具参数、只读限制、连接或超时" }],
          },
        });
      }
    } else reply(id, { error: { code: -32601, message: "没有此方法" } });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await mcp();
