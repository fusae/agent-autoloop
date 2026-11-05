import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { parseXhsDraft, xhsApi } from "./publisher.ts";
const [action, file, ...args] = process.argv.slice(2);
try {
  if (action === "pack") {
    const [output, ...images] = args;
    const draft = JSON.parse(readFileSync(file, "utf8"));
    const mime: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    };
    const content = JSON.stringify(
      {
        title: draft.title,
        content: draft.content,
        images: images.map((path) => ({
          mime: mime[extname(path).toLowerCase()],
          base64: readFileSync(path).toString("base64"),
        })),
      },
      null,
      2,
    );
    parseXhsDraft({
      key: "0".repeat(32),
      action: "lookup",
      channel: "小红书",
      business: "validation",
      artifacts: [{ path: "xiaohongshu.json", content, sha256: createHash("sha256").update(content).digest("hex") }],
    });
    writeFileSync(output, content, { mode: 0o600 });
    console.log("图文稿已生成：" + resolve(output));
  } else {
    const config = JSON.parse(readFileSync(file, "utf8")),
      call = xhsApi(config);
    if (action === "login") {
      const data = await call("/api/v1/login/qrcode");
      if (data.is_logged_in) {
        console.log("已登录");
      } else {
        if (!args[0] || !/^data:image\/png;base64,/.test(data.img || "")) throw Error("未取得二维码或缺少保存路径");
        writeFileSync(args[0], Buffer.from(data.img.split(",")[1], "base64"), { mode: 0o600 });
        console.log("请用小红书扫码：" + resolve(args[0]));
      }
    } else if (action === "status" || action === "bind") {
      const data = await call("/api/v1/login/status");
      if (action === "bind") {
        if (!data.is_logged_in || !data.user_id) throw Error("尚未登录或平台未返回账号编号");
        config.accountId = data.user_id;
        config.enabled = false;
        writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
        chmodSync(file, 0o600);
      }
      console.log(
        JSON.stringify({
          loggedIn: data.is_logged_in === true,
          accountId: data.user_id || null,
          name: data.username || null,
          bound: config.accountId === data.user_id,
          enabled: config.enabled === true,
        }),
      );
    } else throw Error("用法：login 配置 二维码路径 | status 配置 | bind 配置 | pack 正文JSON 输出JSON 图片...");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "小红书连接失败");
  process.exitCode = 1;
}
