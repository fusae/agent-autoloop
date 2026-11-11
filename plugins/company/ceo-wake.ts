export type CEOWakeState = {
  handled?: string;
  pending?: { facts: string; dueAt: number; types: string[] };
  lastBucket?: number;
  lastAt?: string;
  record?: { at: string; result: "merged" | "dispatched" | "unchanged"; types: string[] };
};
// Facts remain in the office/operations journals. This durable cursor only coalesces notification of them.
export function ceoWake(state: CEOWakeState, facts: string, now: Date, types: string[] = []) {
  const bucket = Math.floor(now.getTime() / 300_000);
  if (facts === state.handled) {
    state.record = { at: now.toISOString(), result: "unchanged", types: [...new Set(types)].sort() };
    delete state.pending;
    return false;
  }
  const pending = (state.pending ??= { facts, dueAt: (bucket + 1) * 300_000, types: [] });
  pending.facts = facts;
  pending.types = [...new Set([...pending.types, ...types])].sort();
  state.record = { at: now.toISOString(), result: "merged", types: pending.types };
  if (now.getTime() < pending.dueAt || state.lastBucket === bucket) return false;
  state.handled = pending.facts;
  state.lastBucket = bucket;
  state.lastAt = now.toISOString();
  state.record = { at: now.toISOString(), result: "dispatched", types: pending.types };
  delete state.pending;
  return true;
}
