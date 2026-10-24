import { Router } from "express";
import { z } from "zod";
import { requireGoogleUser } from "./auth.js";
import { sendError } from "./errors.js";
import { loadUserFinanceData } from "./financeData.js";
import { AssistantNotConfiguredError, askAssistant } from "./assistantModel.js";

const bodySchema = z.object({
  // The client sends the recent conversation; the last message is the new question.
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(20)
    .refine((m) => m[m.length - 1].role === "user"),
});

/** Per-user cap on questions, per instance: each one costs a model call. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const recent = new Map<string, number[]>();

export function allowQuestion(uid: string, now = Date.now(), limit = RATE_LIMIT, store = recent) {
  const times = (store.get(uid) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (times.length >= limit) {
    store.set(uid, times);
    return false;
  }
  store.set(uid, [...times, now]);
  return true;
}

export const aiRouter = Router();

/** Answers a question about the signed-in user's own data. Reads Firestore only; writes nothing. */
aiRouter.post("/api/ai/query", requireGoogleUser, async (req, res) => {
  const uid: string = res.locals.uid;
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "INVALID_REQUEST");
  if (!allowQuestion(uid)) return sendError(res, "AI_RATE_LIMITED");

  const startedAt = Date.now();
  // Logged without the question or answer: they are the user's financial data.
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.info(JSON.stringify({ event: "ai_query", uid, outcome, ms: Date.now() - startedAt, ...extra }));

  try {
    const data = await loadUserFinanceData(uid);
    const reply = await askAssistant(parsed.data.messages, data);
    log("success", { rows: data.rows.length, cards: reply.cards.length });
    res.json({ success: true, ...reply });
  } catch (err) {
    if (err instanceof AssistantNotConfiguredError) {
      log("not_configured");
      return sendError(res, "AI_NOT_CONFIGURED");
    }
    const status = (err as { status?: number })?.status;
    log("error", { name: (err as Error)?.name, status });
    // The provider's own quota (e.g. Gemini free tier: a few requests a minute).
    sendError(res, status === 429 ? "AI_RATE_LIMITED" : "AI_ERROR");
  }
});
