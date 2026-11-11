// Only an adapter's explicit absence permits a write; missing search results after submission are unknown.
export type Readback = {
  state: "published" | "absent" | "unknown" | "blocked";
  reason?: string;
  [key: string]: unknown;
};
export function submitAndReadback(adapter: {
  lookup: (remainingMs?: number) => Readback;
  publish: () => Readback;
  beforeSubmit: () => void;
  lookupOnly: boolean;
  maxMs: number;
  now?: () => number;
  wait?: (ms: number) => void;
}): Readback {
  const now = adapter.now ?? Date.now;
  const wait = adapter.wait ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const read = (remainingMs?: number) => {
    try {
      return adapter.lookup(remainingMs);
    } catch {
      return { state: "unknown", reason: "发布入口暂时不可读，不能重复发布" } as Readback;
    }
  };
  let result = read();
  if (adapter.lookupOnly || result.state !== "absent") return result;
  for (let attempt = 0; attempt < 2 && result.state === "absent"; attempt++) {
    adapter.beforeSubmit();
    try {
      result = adapter.publish();
    } catch {
      result = { state: "unknown" };
    }
    if (result.state === "published") return result;
    const deadline = now() + adapter.maxMs;
    do {
      result = read(Math.max(1, deadline - now()));
      if (result.state !== "unknown" || now() >= deadline) break;
      wait(Math.min(10_000, deadline - now()));
    } while (now() <= deadline);
  }
  return result;
}
