import type { Insight, InsightType } from "../utils/insights";

interface Props {
  /** Already ranked and capped by buildInsights (utils/insights.ts). */
  insights: Insight[];
  onShowUncategorized?: () => void;
}

const CARD_STYLE: Record<InsightType, { bg: string; text: string }> = {
  warning: { bg: "bg-rose-50 dark:bg-rose-950/30 border-rose-200/60 dark:border-rose-700/40", text: "text-rose-800 dark:text-rose-300" },
  info: { bg: "bg-blue-50 dark:bg-blue-950/30 border-blue-200/60 dark:border-blue-700/40", text: "text-blue-800 dark:text-blue-300" },
  positive: { bg: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200/60 dark:border-emerald-700/40", text: "text-emerald-800 dark:text-emerald-300" },
};

export default function SmartInsights({ insights, onShowUncategorized }: Props) {
  if (insights.length === 0) return null;

  return (
    <div className="mb-5 -mx-1">
      <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-2 px-2">תובנות החודש</h3>
      <div className="flex gap-3 overflow-x-auto px-1 pb-2 snap-x snap-mandatory scrollbar-hide">
        {insights.map((insight) => {
          const style = CARD_STYLE[insight.type];
          const action = insight.action === "categorize" ? onShowUncategorized : undefined;
          return (
            <div
              key={insight.id}
              className={`snap-start shrink-0 w-[290px] rounded-2xl p-4 shadow-sm border ${style.bg}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-xl leading-none mt-0.5" aria-hidden="true">{insight.emoji}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm leading-relaxed ${style.text}`}>{insight.text}</p>
                  {action && (
                    <button
                      onClick={action}
                      className="mt-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-semibold transition-colors min-h-[32px]"
                    >
                      סווג עכשיו
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
