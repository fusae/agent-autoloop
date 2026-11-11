import { rabbitDraft, rabbitText, type RabbitRequest } from "../company/rabbitrun.ts";
import { squareLink, type SquareReceipt } from "../company/rabbitrun-receipt.ts";

const normalize = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .join("\n")
    .trim();
// Only structured posts attributed to the pinned author can prove success. An empty or client-rendered
// profile, a challenge page, missing fields or multiple matches never prove absence.
export function squareProfileReceipt(
  html: string,
  author: string,
  text: string,
  startedAt: string,
): SquareReceipt | undefined {
  const found = new Map<string, SquareReceipt>();
  const visit = (node: any, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 30) return;
    const user = node.author ?? node.userInfo;
    const body = node.bodyTextOnly ?? node.bodyText;
    const at = typeof node.publishTime === "number" ? node.publishTime : Date.parse(node.publishTime ?? "");
    if (
      user?.username === author &&
      typeof body === "string" &&
      normalize(body) === normalize(text) &&
      Number.isFinite(at) &&
      at >= Date.parse(startedAt) - 60_000 &&
      at <= Date.now() + 60_000
    ) {
      try {
        const proof = squareLink(node.shareLink);
        if (String(node.id) === proof.remoteId) found.set(proof.remoteId, proof);
      } catch {
        /* Unverifiable profile entries cannot become a receipt. */
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(script[1]));
    } catch {
      /* A rendered page can omit its structured data. */
    }
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}
export async function readSquareAuthor(request: RabbitRequest, startedAt: string, network = fetch) {
  const author = "rabbitrun_eth";
  try {
    const response = await network(`https://www.binance.com/square/profile/${author}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return;
    const html = await response.text();
    if (Buffer.byteLength(html) > 2_000_000) return;
    return squareProfileReceipt(html, author, rabbitText(rabbitDraft(request)), startedAt);
  } catch {
    return;
  }
}
