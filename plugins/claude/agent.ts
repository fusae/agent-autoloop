// Claude Code: the user's own, installed and signed in by them. This only ever runs the official program.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findProgram, tail, type Adapter, type Turn } from "../../worker/agents.ts";

const PERMISSIONS = { read: "plan", edit: "acceptEdits", full: "bypassPermissions" };

function settings(turn: Turn) {
  const secrets = [
    "/etc/agent-company",
    "/var/lib/company-publisher",
    "/var/lib/company-inbox",
    "/var/lib/company-reader",
    "/home/*/.ssh",
    "/var/lib/*/.ssh",
    "/root/.ssh",
    path.join(homedir(), ".ssh"),
    "/proc",
    path.join(turn.folder, "entry.json"),
  ];
  return JSON.stringify({
    disableAllHooks: true,
    autoMemoryEnabled: false,
    plansDirectory: path.join(turn.cwd, ".claude/plans"),
    permissions: {
      blockWritesOutsideWorkingDirectories: true,
      deny: [
        "Bash(sudo:*)",
        "Bash(su:*)",
        "Bash(ssh:*)",
        "Bash(scp:*)",
        ...secrets.flatMap((file) => [`Read(/${file})`, `Read(/${file}/**)`]),
        `Edit(/${turn.folder}/**)`,
        ...(turn.access === "read" ? ["Edit"] : []),
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      filesystem: {
        disabled: false,
        allowWrite: [],
        denyRead: secrets,
        // --add-dir exposes the context for reading, never the worker's journal for writing.
        denyWrite: [
          turn.folder,
          "/tmp",
          "/var/tmp",
          "/dev/shm",
          "/run/user",
          ...(turn.access === "read" ? [turn.cwd] : []),
        ],
      },
      network: { allowedDomains: [], allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
      credentials: { envVars: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }] },
    },
  });
}

/** The newest Claude Code the desktop app ships, for those without a separate install. */
function inTheApp() {
  const root = path.join(homedir(), "Library/Application Support/Claude/claude-code");
  if (!existsSync(root)) return [];
  const oldestFirst = readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return oldestFirst.reverse().flatMap((version) => {
    const builds = readdirSync(path.join(root, version));
    return builds.map((build) => path.join(root, version, build, "claude.app/Contents/MacOS/claude"));
  });
}

export default {
  command: (turn) => {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN && process.env.ANTHROPIC_API_KEY) {
      throw new Error("Claude OAuth 令牌与 ANTHROPIC_API_KEY 不能同时设置");
    }
    return [
      findProgram("claude", inTheApp),
      "-p",
      turn.prompt,
      ...(turn.resume ? ["--resume", turn.resume] : ["--session-id", turn.session]),
      "--output-format",
      "json",
      ...(turn.model ? ["--model", turn.model] : []),
      ...(turn.effort ? ["--effort", turn.effort] : []),
      "--permission-mode",
      PERMISSIONS[turn.access],
      "--add-dir",
      turn.folder,
      // Inline settings cannot be replaced by a writable per-turn file; no credentials enter argv.
      "--settings",
      settings(turn),
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      "Bash,Read,Glob,Grep,Edit,Write",
      // A worktree moves the conversation away from where a later --resume looks for it.
      "--disallowedTools=EnterWorktree,ExitWorktree",
    ];
  },
  read(stdout, code, stderr) {
    for (const line of stdout.split("\n").reverse()) {
      let result: any;
      try {
        result = JSON.parse(line);
      } catch {
        continue;
      }
      if (result?.type !== "result") continue;
      const usage = result.usage
        ? {
            input: result.usage.input_tokens ?? 0,
            output: result.usage.output_tokens ?? 0,
            cached: (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0),
            cost: result.total_cost_usd ?? 0,
          }
        : undefined;
      const said = String(result.result ?? "");
      if (result.is_error || result.subtype !== "success") {
        const error = said.split("\n")[0] || result.subtype || "没留下结果";
        return { session: result.session_id, usage, finished: true, error };
      }
      return { text: said, session: result.session_id, usage, finished: true };
    }
    return code === null ? {} : { error: tail(stderr || stdout) || "没留下结果" };
  },
  link: (session) => `claude://resume?session=${session}`,
  check() {
    try {
      const program = findProgram("claude", inTheApp);
      const status = JSON.parse(execFileSync(program, ["auth", "status"], { encoding: "utf8", timeout: 20_000 }));
      return status.loggedIn ? null : "Claude Code 没有登录：运行 claude auth login";
    } catch (error) {
      return `Claude Code 用不了：${(error as Error).message.split("\n")[0]}`;
    }
  },
} satisfies Adapter;
