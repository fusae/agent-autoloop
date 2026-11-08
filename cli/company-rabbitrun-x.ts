import { runMacX, recordMacX } from "../plugins/company/rabbitrun-mac.ts";
try {
  const [action, key, url] = process.argv.slice(2);
  if (action === "complete") {
    if (!/^[a-f0-9]{32}$/.test(key ?? "") || !/^https:\/\/x\.com\/rabbitrun_eth\/status\/\d{1,30}$/.test(url ?? ""))
      throw Error("需要审核编号和核对后的X链接");
    recordMacX({ action, key, url });
    process.stdout.write("X 回执已登记。\n");
  } else if (action === "fail") {
    recordMacX({ action, key, reason: url });
    process.stdout.write("X 失败状态已登记。\n");
  } else if (!action || action === "list") {
    const result = runMacX({ listOnly: action === "list" });
    if (Array.isArray(result))
      process.stdout.write(result.map((r) => `${r.key} ${r.x.state} ${r.title}`).join("\n") + "\n");
    else
      process.stdout.write(
        result.state === "idle"
          ? "没有X待发稿。\n"
          : result.state === "published"
            ? "X已发布并登记链接。\n"
            : "X未确认发布成功；后台和飞书会提示，请核对。\n",
      );
  } else throw Error("命令无效");
} catch {
  process.stderr.write("X任务未完成，保留已有记录；请核对后台状态，勿重复发送。\n");
  process.exitCode = 1;
}
