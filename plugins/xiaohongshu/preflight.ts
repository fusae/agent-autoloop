import { xhsApi } from "./publisher.ts";

export async function xhsPreflight(
  config: { endpoint: string; token: string; accountId: string; enabled: boolean },
  call = xhsApi(config),
) {
  if (config.enabled !== true || !config.accountId) throw Error("小红书尚未启用或绑定账号");
  const status = await call("/api/v1/login/status");
  if (status.is_logged_in !== true) throw Error("小红书未登录");
  let accountId = status.user_id;
  if (!accountId) {
    const response = await call("/api/v1/user/me");
    accountId = (response.data ?? response).userBasicInfo?.userId;
  }
  if (accountId !== config.accountId) throw Error("小红书登录账号与绑定账号不一致，禁止发布");
  const creator = await call("/api/v1/login/creator-status");
  if (creator.is_logged_in === false) throw Error("创作者中心未登录，请本人查看登录页面");
  if (creator.is_logged_in !== true || creator.can_publish !== true) throw Error("创作者发布页状态未知");
  return { loggedIn: true, canPublish: true };
}
