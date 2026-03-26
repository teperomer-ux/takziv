import { useMemo } from "react";
import type { Transaction } from "../types";
import { detectNewRecurring, type NewRecurringDetection } from "../utils/recurringBills";

interface Props {
  transactions: Transaction[];
  averages: Map<string, number>;
  allTransactions: Transaction[];
  pinnedDescriptions: Set<string>;
  onPinBill: (detection: NewRecurringDetection) => void;
}

type InsightType = "positive" | "warning" | "info" | "new-recurring";

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
  allTransactions,
  pinnedDescriptions,
  onPinBill,
}: Props) {
  // Aggregate current month spending per category
  const spending = new Map<string, number>();
  let uncategorizedCount = 0;
  let miscCount = 0;

  for (const tx of transactions) {
    if (tx.category === "מקורות הכנסה") continue;
    if (!tx.category) {
      uncategorizedCount++;
      continue;
    }
    if (tx.category === "שונות") {
      miscCount++;
    }
    spending.set(tx.category, (spending.get(tx.category) ?? 0) + tx.amount);
  }

  // Detect new recurring expenses
  const newRecurring = useMemo(
    () => detectNewRecurring(allTransactions, pinnedDescriptions),
    [allTransactions, pinnedDescriptions]
  );

  const insights: Insight[] = [];

  // ── New recurring expense detections ──────────────────────────────
  for (const det of newRecurring) {
    insights.push({
      id: `new-recur-${det.description}`,
      emoji: "💡",
      text: `זיהינו הוצאה קבועה חדשה! העסק '${det.description}' חויב חודשיים ברצף לראשונה. האם זה מנוי חדש?`,
      type: "new-recurring",
      action: {
        label: "הגדר כהוצאה קבועה",
        onClick: () => onPinBill(det),
      },
    });
  }

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
  const totalUncat = uncategorizedCount + miscCount;
  if (totalUncat >= 3) {
    insights.push({
      id: "uncat",
      emoji: "💡",
      text: `יש לך ${totalUncat} עסקאות ללא סיווג, כדאי לסווג אותן כדי לדייק את הממוצע.`,
      type: "info",
    });
  }

  // Sort: new-recurring first, then warnings, info, positive
  const order: Record<string, number> = {
    "new-recurring": 0,
    warning: 1,
    info: 2,
    positive: 3,
  };
  insights.sort((a, b) => order[a.type] - order[b.type]);

  const top = insights.slice(0, 4);

  if (top.length === 0) return null;

  const cardStyle: Record<InsightType, { bg: string; text: string }> = {
    "new-recurring": { bg: "bg-violet-50 border-violet-200", text: "text-violet-800" },
    warning: { bg: "bg-red-50 border-red-200", text: "text-red-800" },
    info: { bg: "bg-blue-50 border-blue-200", text: "text-blue-800" },
    positive: { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-800" },
  };

  return (
    <div className="mb-5 -mx-1">
      <div className="flex gap-3 overflow-x-auto px-1 pb-2 snap-x snap-mandatory scrollbar-hide">
        {top.map((insight) => {
          const style = cardStyle[insight.type];
          return (
            <div
              key={insight.id}
              className={`snap-start shrink-0 w-[280px] rounded-xl p-4 shadow-sm border ${style.bg}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-xl leading-none mt-0.5">{insight.emoji}</span>
                <div className="flex-1 min-w-0">
                  {insight.type === "new-recurring" && (
                    <span className="inline-block text-[10px] font-bold bg-violet-200 text-violet-800 px-1.5 py-0.5 rounded-full mb-1.5">
                      חדש
                    </span>
                  )}
                  <p className={`text-sm leading-relaxed ${style.text}`}>
                    {insight.text}
                  </p>
                  {insight.action && (
                    <button
                      onClick={insight.action.onClick}
                      className="mt-2.5 rounded-lg bg-violet-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-violet-700 transition-colors"
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
