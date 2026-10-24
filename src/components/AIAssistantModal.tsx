import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Sparkles, Send, X, Eraser, RotateCcw } from "lucide-react";
import { askAssistant, type AssistantCard, type ChatMessage } from "../services/aiAssistantService";
import { BankSyncError } from "../services/bankSyncService";
import { ERROR_MESSAGES } from "../constants/bankSyncMessages";
import { formatDate } from "../utils/formatDate";

// ─── AI financial assistant ──────────────────────────────────────────────────
// A floating button that opens a chat about the user's own data. Answers come
// from the server (POST /api/ai/query), which lets the model read the user's
// transactions only — no web — and returns cards with the exact figures.

interface Entry {
  id: number;
  role: "user" | "assistant";
  content: string;
  cards?: AssistantCard[];
  /** A failed request: shown, but not sent back as history. */
  error?: boolean;
}

const SUGGESTIONS = [
  { label: "ההוצאה הגדולה ביותר החודש", prompt: "מה ההוצאה הכי גדולה שהייתה החודש?" },
  { label: "סיכום הוצאות חודש אחרון", prompt: "תן לי סיכום של ההוצאות וההכנסות בחודש שעבר" },
  { label: "בדיקת העברות פנימיות", prompt: "האם היו לי העברות פנימיות החודש?" },
  { label: "כמה הוצאתי על מזון?", prompt: "כמה סך הכל הוצאתי על מזון החודש?" },
];

const AI_ERROR_MESSAGES: Record<string, string> = {
  AI_NOT_CONFIGURED: "העוזר עדיין לא הוגדר בשרת — חסר מפתח API (ANTHROPIC_API_KEY או GEMINI_API_KEY).",
  AI_RATE_LIMITED: "נשאלו הרבה שאלות בזמן קצר (או שנוצלה מכסת ה-AI). נסו שוב בעוד דקה.",
  AI_ERROR: "שירות ה-AI לא הגיב כרגע. נסו שוב בעוד רגע.",
};

function errorMessage(err: unknown) {
  if (err instanceof BankSyncError) {
    return AI_ERROR_MESSAGES[err.code] ?? ERROR_MESSAGES[err.code] ?? ERROR_MESSAGES.INTERNAL_ERROR;
  }
  return ERROR_MESSAGES.INTERNAL_ERROR;
}

const shekels = (n: number) => `${Math.abs(n).toLocaleString("he-IL", { maximumFractionDigits: 2 })} ₪`;

function TransactionCard({ card }: { card: Extract<AssistantCard, { type: "transaction" }> }) {
  // A negative expense is a refund, i.e. money in.
  const incoming = card.kind === "income" || card.amount < 0;
  const color = card.excluded ? "text-slate-400" : incoming ? "text-emerald-600" : "text-rose-600";
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 space-y-1.5 ${
        card.excluded
          ? "border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50"
          : "border-slate-200/70 dark:border-slate-700/70 bg-white dark:bg-slate-900"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words leading-snug">
          {card.description || "—"}
        </p>
        <span className={`shrink-0 text-sm font-bold tabular-nums ${color}`} dir="ltr">
          {incoming ? "+" : "−"}
          {shekels(card.amount)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="tabular-nums" dir="ltr">{formatDate(card.date)}</span>
        <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5">
          {card.account === "bank" ? "עו״ש" : "אשראי"}
        </span>
        {card.category && (
          <span className="rounded-md bg-primary/10 text-primary dark:text-primary-light px-1.5 py-0.5">
            {card.category}
            {card.subCategory && ` · ${card.subCategory}`}
          </span>
        )}
        {card.excluded && (
          <span className="rounded-md bg-slate-200/70 dark:bg-slate-800 px-1.5 py-0.5">העברה פנימית — לא נספר</span>
        )}
      </div>
    </div>
  );
}

function TotalCard({ card }: { card: Extract<AssistantCard, { type: "total" }> }) {
  const color =
    card.kind === "income" ? "text-emerald-600" : card.kind === "expense" ? "text-rose-600" : "text-slate-700 dark:text-slate-200";
  return (
    <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/70 bg-gradient-to-l from-slate-50 to-white dark:from-slate-800/60 dark:to-slate-900 px-3 py-2.5">
      <p className="text-xs text-slate-500 dark:text-slate-400">{card.label}</p>
      <p className={`text-lg font-bold tabular-nums ${color}`} dir="ltr">
        {shekels(card.amount)}
      </p>
      {card.detail && <p className="text-[11px] text-slate-500 dark:text-slate-400">{card.detail}</p>}
    </div>
  );
}

export default function AIAssistantModal() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const nextId = useRef(1);
  const fabRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    fabRef.current?.focus();
  }, []);

  // Focus the input, close on Escape, and keep the page behind from scrolling.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && close();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, loading]);

  async function send(text: string, history: Entry[] = entries) {
    const question = text.trim();
    if (!question || loading) return;
    const userEntry: Entry = { id: nextId.current++, role: "user", content: question };
    const withQuestion = [...history, userEntry];
    setEntries(withQuestion);
    setInput("");
    setLoading(true);
    try {
      const messages: ChatMessage[] = withQuestion
        .filter((e) => !e.error)
        .map(({ role, content }) => ({ role, content }));
      const reply = await askAssistant(messages);
      setEntries((prev) => [...prev, { id: nextId.current++, role: "assistant", content: reply.answer, cards: reply.cards }]);
    } catch (err) {
      setEntries((prev) => [...prev, { id: nextId.current++, role: "assistant", content: errorMessage(err), error: true }]);
    } finally {
      setLoading(false);
    }
  }

  /** Re-asks the question that failed, without leaving the failed attempt in the chat. */
  function retry(failedId: number) {
    const idx = entries.findIndex((e) => e.id === failedId);
    const question = entries[idx - 1];
    if (question?.role !== "user") return;
    void send(question.content, entries.slice(0, idx - 1));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <>
      <button
        ref={fabRef}
        onClick={() => setOpen(true)}
        className="fixed z-30 left-4 sm:left-6 bottom-[calc(80px+env(safe-area-inset-bottom))] h-14 w-14 rounded-full bg-gradient-to-br from-primary to-primary-light text-white shadow-lg shadow-primary/30 flex items-center justify-center hover:scale-105 active:scale-95 transition-transform focus:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
        aria-label="פתיחת העוזר הפיננסי"
        aria-haspopup="dialog"
        title="העוזר הפיננסי"
      >
        <Sparkles className="h-6 w-6" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={close} aria-hidden="true" />

          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-assistant-title"
            dir="rtl"
            className="absolute inset-x-0 bottom-0 h-[88dvh] rounded-t-3xl sm:inset-x-auto sm:left-6 sm:bottom-6 sm:w-[420px] sm:h-[min(680px,calc(100dvh-3rem))] sm:rounded-3xl bg-slate-50 dark:bg-slate-950 shadow-2xl flex flex-col overflow-hidden animate-[fadeIn_0.15s_ease-out]"
          >
            {/* Header */}
            <header className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-slate-900 border-b border-slate-200/60 dark:border-slate-800">
              <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-primary to-primary-light text-white flex items-center justify-center">
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="ai-assistant-title" className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  העוזר הפיננסי
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">עונה רק מתוך הנתונים שלך באפליקציה</p>
              </div>
              {entries.length > 0 && (
                <button
                  onClick={() => setEntries([])}
                  disabled={loading}
                  className="p-2.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40"
                  aria-label="ניקוי השיחה"
                  title="ניקוי השיחה"
                >
                  <Eraser className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={close}
                className="p-2.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                aria-label="סגירה"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            {/* Messages */}
            <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-4" aria-live="polite">
              {entries.length === 0 && (
                <div className="text-center pt-6 space-y-4">
                  <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                    שאלו על ההוצאות וההכנסות שלכם — למשל ההוצאה הגדולה בחודש מסוים, סך הוצאות בקטגוריה או העברות פנימיות.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s.label}
                        onClick={() => void send(s.prompt)}
                        className="rounded-full border border-primary/30 bg-white dark:bg-slate-900 text-primary dark:text-primary-light px-3.5 py-2 text-xs font-medium hover:bg-primary/5 active:bg-primary/10 transition-colors min-h-[36px]"
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {entries.map((entry) =>
                entry.role === "user" ? (
                  <div key={entry.id} className="flex justify-start">
                    <p className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-white px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">
                      {entry.content}
                    </p>
                  </div>
                ) : (
                  <div key={entry.id} className="flex flex-col items-end gap-2">
                    <div
                      className={`max-w-[92%] rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed ${
                        entry.error
                          ? "bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300"
                          : "bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 text-slate-800 dark:text-slate-100"
                      }`}
                    >
                      {entry.content}
                      {entry.error && (
                        <button
                          onClick={() => retry(entry.id)}
                          disabled={loading}
                          className="mt-2 flex items-center gap-1.5 text-xs font-semibold underline disabled:opacity-40"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          נסו שוב
                        </button>
                      )}
                    </div>
                    {entry.cards && entry.cards.length > 0 && (
                      <div className="w-[92%] space-y-2">
                        {entry.cards.map((card, i) =>
                          card.type === "total" ? <TotalCard key={i} card={card} /> : <TransactionCard key={i} card={card} />,
                        )}
                      </div>
                    )}
                  </div>
                ),
              )}

              {loading && (
                <div className="flex justify-end" role="status" aria-label="העוזר בודק את הנתונים">
                  <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 px-3.5 py-3 text-xs text-slate-500">
                    <span className="flex gap-1" aria-hidden="true">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:-0.3s]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:-0.15s]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce" />
                    </span>
                    בודק בנתונים…
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <form
              onSubmit={onSubmit}
              className="flex items-end gap-2 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-white dark:bg-slate-900 border-t border-slate-200/60 dark:border-slate-800"
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={Math.min(4, Math.max(1, input.split("\n").length))}
                maxLength={1000}
                placeholder="שאלו על הנתונים שלכם…"
                aria-label="שאלה לעוזר הפיננסי"
                className="flex-1 resize-none rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-100 px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="h-11 w-11 shrink-0 rounded-full bg-primary text-white flex items-center justify-center hover:bg-primary-light transition-colors disabled:opacity-40"
                aria-label="שליחה"
              >
                {/* The arrow points left: "forward" in RTL. */}
                <Send className="h-5 w-5 -scale-x-100" />
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
