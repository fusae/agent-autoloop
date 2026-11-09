import type { Leadership, StaffPlan } from "./executive.ts";
import type { Plan } from "./operations.ts";

export function waitingReason(
  daily: Pick<StaffPlan, "waiting" | "focus" | "doneWhen" | "mode">,
  business: string,
  chief: Leadership,
  plans: Pick<Plan, "id" | "status">[],
): string | undefined {
  if (daily.waiting?.kind === "owner") {
    const question = chief.questions.find((q) => q.id === daily.waiting?.id);
    return question?.state === "open" &&
      question.issues.some((id) =>
        chief.issues.some((i) => i.id === id && i.business === business && i.state !== "answered"),
      )
      ? undefined
      : "等待负责人答复未关联本业务未关闭的问题";
  }
  if (daily.waiting?.kind === "plan") {
    const plan = plans.find((p) => p.id === daily.waiting?.id);
    return plan && !["closed", "observing", "delivered"].includes(plan.status)
      ? undefined
      : "等待的依赖不存在或已经完成";
  }
  // Legacy CEO schedules had prose-only waits; never invent a question link from their wording.
  if (
    daily.mode !== "work" &&
    /(?:等|待|尚未).{0,15}(?:负责人|董事长|老板).{0,12}(?:答复|回复)|(?:负责人|董事长|老板).{0,8}(?:尚未|未|还没|还未)(?:答复|回复)/.test(
      daily.focus + daily.doneWhen,
    )
  )
    return "等待负责人答复没有问题编号";
}
