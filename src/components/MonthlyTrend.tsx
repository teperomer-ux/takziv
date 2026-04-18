import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { Transaction } from "../types";

const SHORT_MONTHS = [
  "ינו", "פבר", "מרץ", "אפר", "מאי", "יונ",
  "יול", "אוג", "ספט", "אוק", "נוב", "דצמ",
];

interface Props {
  allTransactions: Transaction[];
  year: number;
  month: number;
}

export default function MonthlyTrend({ allTransactions, year, month }: Props) {
  const data = useMemo(() => {
    const points: { key: string; label: string; total: number; isCurrent: boolean }[] = [];

    for (let i = 5; i >= 0; i--) {
      let m = month - i;
      let y = year;
      while (m <= 0) { m += 12; y--; }

      let total = 0;
      for (const tx of allTransactions) {
        if (tx.category === "מקורות הכנסה") continue;
        if (tx.billingYear === y && tx.billingMonth === m) total += tx.amount;
      }
      points.push({
        key: `${y}-${String(m).padStart(2, "0")}`,
        label: SHORT_MONTHS[m - 1],
        total: Math.round(total),
        isCurrent: i === 0,
      });
    }
    return points;
  }, [allTransactions, year, month]);

  const avg = useMemo(() => {
    const withData = data.filter((d) => d.total > 0);
    if (withData.length === 0) return 0;
    return Math.round(withData.reduce((s, d) => s + d.total, 0) / withData.length);
  }, [data]);

  if (data.every((d) => d.total === 0)) {
    return (
      <div className="flex items-center justify-center h-52 text-sm text-slate-400">
        אין נתונים להצגה
      </div>
    );
  }

  return (
    <div>
      {avg > 0 && (
        <div className="flex items-center gap-2 mb-3 px-1">
          <span className="w-5 border-t-2 border-dashed border-slate-400" />
          <span className="text-[11px] text-slate-400">
            ממוצע: {avg.toLocaleString("he-IL")} ₪
          </span>
        </div>
      )}
      <div className="h-52" dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid, #e2e8f0)" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#94a3b8" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) =>
                v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v)
              }
              width={42}
            />
            <Tooltip
              formatter={(value) => [`₪${Number(value).toLocaleString("he-IL")}`, "הוצאות"]}
              labelFormatter={() => ""}
              contentStyle={{
                borderRadius: 12,
                border: "1px solid #e2e8f0",
                background: "#ffffff",
                boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
                fontSize: 12,
                direction: "rtl",
              }}
              labelStyle={{ color: "#111827", fontWeight: 700 }}
              itemStyle={{ color: "#374151" }}
              cursor={{ fill: "rgba(0,0,0,0.04)" }}
            />
            {avg > 0 && (
              <ReferenceLine
                y={avg}
                stroke="#94a3b8"
                strokeDasharray="6 4"
                strokeWidth={1.5}
              />
            )}
            <Bar
              dataKey="total"
              fill="#f1f5f9"
              stroke="#fecaca"
              strokeWidth={1}
              radius={[4, 4, 0, 0]}
              maxBarSize={36}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
