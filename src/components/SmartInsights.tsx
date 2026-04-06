import type { Transaction } from "../types";

interface Props {
  transactions: Transaction[];
  averages: Map<string, number>;
  onShowUncategorized?: () => void;
}

type InsightType = "positive" | "warning" | "info";

interface Insight {
  id: string;
  emoji: string;
  text: string;
  type: InsightType;
  action?: { label: string; onClick: () => void };
}

export default function SmartInsights({
  transactions,
  averages,
  onShowUncategorized,
}: Props) {
  // Aggregate current month spending per category
  const spending = new Map<string, number>();
  let uncategorizedCount = 0;

  for (const tx of transactions) {
    if (tx.category === "מקורות הכנסה") continue;
    if (!tx.category) {
      uncategorizedCount++;
      continue;
    }
    spending.set(tx.category, (spending.get(tx.category) ?? 0) + tx.amount);
  }

  const insights: Insight[] = [];

  // ── Category-based insights ───────────────────────────────────────
  for (const [cat, avg] of averages) {
    if (cat === "מקורות הכנסה" || avg === 0) continue;
    const spent = spending.get(cat) ?? 0;
    if (spent === 0) continue;

    const diff = spent - avg;
    const pct = Math.round(Math.abs(diff / avg) * 100);

    if (diff < 0 && pct >= 15) {
      insights.push({
        id: `pos-${cat}`,
        emoji: "🎉",
        text: `כל הכבוד! הוצאת החודש ${pct}% פחות על ${cat} מהממוצע שלך.`,
        type: "positive",
      });
    }

    if (diff > 0) {
      insights.push({
        id: `warn-${cat}`,
        emoji: "⚠️",
        text: `שים לב: חרגת מממוצע ההוצאות שלך על ${cat} ב-${Math.round(diff).toLocaleString("he-IL")} ש״ח.`,
        type: "warning",
      });
    }
  }

  // ── Uncategorized / misc alerts ───────────────────────────────────
  if (uncategorizedCount >= 3) {
    insights.push({
      id: "uncat",
      emoji: "💡",
      text: `יש לך ${uncategorizedCount} עסקאות ללא סיווג, כדאי לסווג אותן כדי לדייק את הממוצע.`,
      type: "info",
      action: onShowUncategorized
        ? { label: "סווג עכשיו", onClick: onShowUncategorized }
        : undefined,
    });
  }

  const order: Record<string, number> = {
    warning: 0,
    info: 1,
    positive: 2,
  };
  insights.sort((a, b) => order[a.type] - order[b.type]);

  const top = insights.slice(0, 5);

  if (top.length === 0) return null;

  const cardStyle: Record<InsightType, { bg: string; text: string }> = {
    warning: { bg: "bg-rose-50 dark:bg-rose-950/30 border-rose-200/60 dark:border-rose-700/40", text: "text-rose-800 dark:text-rose-300" },
    info: { bg: "bg-blue-50 dark:bg-blue-950/30 border-blue-200/60 dark:border-blue-700/40", text: "text-blue-800 dark:text-blue-300" },
    positive: { bg: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200/60 dark:border-emerald-700/40", text: "text-emerald-800 dark:text-emerald-300" },
  };

  return (
    <div className="mb-5 -mx-1">
      <div className="flex gap-3 overflow-x-auto px-1 pb-2 snap-x snap-mandatory scrollbar-hide">
        {top.map((insight) => {
          const style = cardStyle[insight.type];
          return (
            <div
              key={insight.id}
              className={`snap-start shrink-0 w-[280px] rounded-2xl p-4 shadow-sm border ${style.bg}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-xl leading-none mt-0.5">{insight.emoji}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm leading-relaxed ${style.text}`}>
                    {insight.text}
                  </p>
                  {insight.action && (
                    <button
                      onClick={insight.action.onClick}
                      className={`mt-2.5 rounded-lg text-white px-3 py-1.5 text-xs font-semibold transition-colors min-h-[32px] ${
                        insight.type === "info"
                          ? "bg-blue-600 hover:bg-blue-700"
                          : "bg-primary hover:bg-primary/90"
                      }`}
                    >
                      {insight.action.label}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
