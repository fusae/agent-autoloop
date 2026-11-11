// Failure modes: legacy cookies override the real page, unknown pages ask for QR login,
// or a read-only preflight accepts a wrong account or invokes publishing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { xhsPreflight } from "../plugins/xiaohongshu/preflight.ts";

const probe = readFileSync(new URL("../plugins/xiaohongshu/upstream/creator-page.js", import.meta.url), "utf8")
  .trim()
  .replace(/;$/, "");
function page(options: {
  path?: string;
  host?: string;
  text?: string;
  ready?: boolean;
  hidden?: boolean;
  qr?: boolean;
}) {
  const element = { innerText: "上传图文", getClientRects: () => (options.hidden ? [] : [{}]) };
  return runInNewContext(`(${probe})()`, {
    location: {
      protocol: "https:",
      hostname: options.host ?? "creator.xiaohongshu.com",
      pathname: options.path ?? "/publish/publish",
    },
    document: {
      get cookie() {
        throw Error("must not inspect cookies");
      },
      body: { innerText: options.text ?? "" },
      querySelectorAll: (s: string) =>
        (options.ready && ["div.upload-content", "div.creator-tab"].includes(s)) || (options.qr && s.includes("qrcode"))
          ? [element]
          : [],
      querySelector: () => (options.ready ? element : null),
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  });
}
test("actual publisher works without a legacy cookie; redirects, QR and verification never pass", () => {
  assert.equal(page({ ready: true }), "ready");
  assert.equal(page({ ready: true, path: "/login" }), "login");
  assert.equal(page({ ready: true, qr: true }), "login");
  assert.equal(page({ ready: true, text: "请先登录" }), "login");
  assert.equal(page({ ready: true, text: "安全验证" }), "verification");
  for (const options of [
    {},
    { ready: true, hidden: true },
    { ready: true, host: "example.com" },
    { ready: true, path: "/new/home" },
  ])
    assert.equal(page(options), "unknown");
});

test("preflight only reads status and enforces activation, pinned account and creator readiness", async () => {
  const config = { endpoint: "http://127.0.0.1:18060", token: "test", accountId: "owner", enabled: true };
  let owner = "owner",
    login = true,
    creator: any = { is_logged_in: true, can_publish: true };
  const paths: string[] = [];
  const call = async (path: string, body?: unknown) => {
    assert.equal(body, undefined);
    paths.push(path);
    if (path === "/api/v1/login/status") return { is_logged_in: login, user_id: owner };
    if (path === "/api/v1/user/me") return { data: { userBasicInfo: { userId: "owner" } } };
    assert.equal(path, "/api/v1/login/creator-status");
    return creator;
  };
  assert.deepEqual(await xhsPreflight(config, call), { loggedIn: true, canPublish: true });
  assert.deepEqual(paths, ["/api/v1/login/status", "/api/v1/login/creator-status"]);
  owner = "other";
  await assert.rejects(xhsPreflight(config, call), /账号不一致/);
  owner = "";
  assert.equal((await xhsPreflight(config, call)).canPublish, true);
  creator = { is_logged_in: false, can_publish: false };
  await assert.rejects(xhsPreflight(config, call), /创作者中心未登录/);
  for (creator of [{}, { is_logged_in: true }, { can_publish: true }])
    await assert.rejects(xhsPreflight(config, call), /状态未知/);
  login = false;
  await assert.rejects(xhsPreflight(config, call), /小红书未登录/);
  await assert.rejects(xhsPreflight({ ...config, enabled: false }, call), /尚未启用/);
});
