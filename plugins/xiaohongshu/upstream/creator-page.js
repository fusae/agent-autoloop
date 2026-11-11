() => {
  const visible = (e) => {
    const style = getComputedStyle(e);
    return style.visibility !== "hidden" && style.display !== "none" && e.getClientRects().length > 0;
  };
  const any = (selector) => [...document.querySelectorAll(selector)].some(visible);
  const text = document.body?.innerText ?? "";
  if (location.protocol !== "https:" || location.hostname !== "creator.xiaohongshu.com") return "unknown";
  if (/安全验证|拖动滑块|请完成验证|访问异常|身份验证/.test(text) || any('[class*="captcha"], iframe[src*="captcha"]'))
    return "verification";
  if (
    /\/(?:login|auth)(?:\/|$)/.test(location.pathname) ||
    /扫码登录|手机号登录|验证码登录|账号登录|请先登录|登录后发布/.test(text) ||
    any('[class*="qrcode"], [class*="qr-code"], [class*="qrCode"]')
  )
    return "login";
  if (
    location.pathname === "/publish/publish" &&
    any("div.upload-content") &&
    [...document.querySelectorAll("div.creator-tab")].some((e) => visible(e) && e.innerText.trim() === "上传图文") &&
    document.querySelector('input[type="file"]')
  )
    return "ready";
  return "unknown";
};
