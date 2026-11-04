import { join } from "node:path";

// A deterministic coordinator: no model, credentials or business code execute in this adapter.
export default {
  command(turn: { command?: string[]; contextFile: string }) {
    const config = turn.command?.[0];
    if (!config) throw new Error("company Agent 的 command 需要公司配置文件路径");
    return [process.execPath, join(import.meta.dirname, "run.ts"), config, turn.contextFile];
  },
  read(stdout: string, code: number | null, stderr: string) {
    if (code === null) return {};
    return code === 0 ? { text: stdout } : { error: stderr.trim().slice(-500) || "公司任务调度失败" };
  },
};
