import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { verifiedPublication } from "./publication.ts";
import type { Observation } from "../xiaohongshu/reader.ts";
export function readFeedback(directory: string, notes: string[]): Observation {
  const target = JSON.parse(readFileSync(join(directory, "feedback.json"), "utf8"));
  if (
    !Array.isArray(target.command) ||
    !target.command.length ||
    !target.command.every((v: unknown) => typeof v === "string") ||
    (!isAbsolute(target.command[0]) && target.command[0] !== "sudo")
  )
    throw Error("只读入口配置无效");
  const result = spawnSync(
    target.command[0] === "sudo" ? "/usr/bin/sudo" : target.command[0],
    target.command.slice(1),
    {
      input: JSON.stringify({ action: "read", notes }),
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 1_000_000,
      shell: false,
    },
  );
  if (result.error || result.status !== 0) return { state: "unknown", reason: "只读入口暂时不可用" };
  const value = JSON.parse(result.stdout);
  if (!["ready", "unknown", "blocked"].includes(value.state)) throw Error("只读响应无效");
  if (
    value.state === "ready" &&
    (value.account !== target.accountId ||
      !Number.isSafeInteger(value.followers) ||
      value.followers < 0 ||
      !Array.isArray(value.notes) ||
      value.notes.length !== new Set(notes).size ||
      value.notes.some(
        (n: any) =>
          !notes.includes(n.id) ||
          n.author !== target.accountId ||
          [n.likes, n.collects, n.comments, n.images].some((v) => !Number.isSafeInteger(v) || v < 0),
      ))
  )
    throw Error("只读响应账号或指标不符");
  return value;
}
const normalize = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
export function verifyPublication(directory: string, key: string, read = readFeedback) {
  const proof = verifiedPublication(directory, key);
  const frozen = JSON.parse(readFileSync(join(directory, "publications", key + ".json"), "utf8"));
  const artifact = frozen.artifacts.filter(
    (a: any) => a.path === "xiaohongshu.json" || a.path.endsWith("/xiaohongshu.json"),
  );
  if (
    frozen.key !== key ||
    artifact.length !== 1 ||
    createHash("sha256").update(artifact[0].content).digest("hex") !== artifact[0].sha256
  )
    throw Error("冻结稿不完整");
  const draft = JSON.parse(artifact[0].content),
    observation = read(directory, [proof.remoteId]);
  if (observation.state !== "ready") return observation;
  const note = observation.notes.find((n) => n.id === proof.remoteId);
  if (
    !note ||
    note.author !== observation.account ||
    normalize(note.title) !== normalize(draft.title) ||
    normalize(note.content) !== normalize(draft.content) ||
    note.images !== draft.images.length ||
    Date.parse(note.publishedAt) !== Date.parse(proof.publishedAt)
  )
    return { state: "unknown" as const, reason: "平台作者、正文、标题、图片数或时间与冻结稿不符" };
  return { state: "verified" as const, proof, observation };
}
export function verificationDelay(attempt: number) {
  return [15 * 60000, 60 * 60000][attempt];
}
