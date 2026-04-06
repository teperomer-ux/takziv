import { useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

interface Props {
  spending: Map<string, number>;
  totalSpent: number;
}

const COLORS = [
  "#0d9488", // teal
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#ef4444", // red
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f97316", // orange
  "#06b6d4", // cyan
  "#84cc16", // lime
];

export default function CategoryBreakdown({ spending, totalSpent }: Props) {
  const rows = useMemo(() => {
    const entries: { cat: string; amount: number; pct: number; color: string }[] = [];
    let idx = 0;
    for (const [cat, amount] of spending) {
      if (amount <= 0) continue;
      entries.push({
        cat,
        amount,
        pct: totalSpent > 0 ? (amount / totalSpent) * 100 : 0,
        color: COLORS[idx % COLORS.length],
      });
      idx++;
    }
    entries.sort((a, b) => b.amount - a.amount);
    entries.forEach((e, i) => { e.color = COLORS[i % COLORS.length]; });
    return entries;
  }, [spending, totalSpent]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-52 text-sm text-slate-400">
        אין נתונים להצגה
      </div>
    );
  }

  const pieData = rows.map((r) => ({ name: r.cat, value: r.amount }));

  return (
    <div className="flex items-start gap-3">
      {/* ── Donut (right side in RTL) ─────────────────────── */}
      <div className="relative shrink-0" style={{ width: 140, height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={pieData}
              dataKey="value"
              cx="50%"
              cy="50%"
              innerRadius={42}
              outerRadius={62}
              paddingAngle={2}
              strokeWidth={0}
            >
              {rows.map((r) => (
                <Cell key={r.cat} fill={r.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {/* Center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-sm font-bold text-slate-700 dark:text-slate-200 leading-tight" dir="ltr">
            ₪{Math.round(totalSpent).toLocaleString("he-IL")}
          </span>
          <span className="text-[9px] text-slate-400 leading-tight">סה״כ</span>
        </div>
      </div>

      {/* ── Legend list (left side in RTL) ─────────────────── */}
      <div className="flex-1 min-w-0 space-y-2.5 pt-1">
        {rows.map((r) => (
          <div key={r.cat} className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0 mt-0.5 self-start"
              style={{ backgroundColor: r.color }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold text-slate-800 dark:text-slate-100 truncate leading-tight">
                {r.cat}
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-tight mt-0.5">
                {Math.round(r.pct)}%
              </p>
            </div>
            <span className="text-[13px] font-bold text-slate-800 dark:text-slate-100 shrink-0 tabular-nums self-start" dir="ltr">
              ₪{Math.round(r.amount).toLocaleString("he-IL")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
