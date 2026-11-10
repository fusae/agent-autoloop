// Status uses GET only and never enters the reader's cache/lock or publishing code.
import { spawnSync } from "node:child_process";
export async function readXhsStatus(
  config: { endpoint: string; token: string; enabled?: boolean },
  request: any,
  fetcher: typeof fetch = fetch,
  service = () =>
    spawnSync(
      "/usr/bin/systemctl",
      ["show", "agent-company-xiaohongshu.service", "--property=ActiveState", "--value"],
      { encoding: "utf8", timeout: 2000 },
    ).stdout?.trim() || "unknown",
) {
  if (!request || request.action !== "status" || Object.keys(request).length !== 1) throw Error("只读状态参数无效");
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/"
  )
    throw Error("状态接口必须在本机");
  const result = {
    service: service(),
    login: "unknown",
    publishing: config.enabled === true ? "已配置" : "未启用",
    checkedAt: new Date().toISOString(),
  };
  try {
    const response = await fetcher(new URL("/api/v1/login/status", endpoint), {
      method: "GET",
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(18000),
      redirect: "error",
    });
    const body = (await response.json()) as any;
    if (response.ok && body.success === true && typeof body.data?.is_logged_in === "boolean")
      result.login = body.data.is_logged_in ? "已登录" : "未登录";
  } catch {
    /* A failed status probe is unknown, never a request to log in. */
  }
  return result;
}
