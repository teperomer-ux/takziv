import { useState, useEffect } from "react";

interface RingData {
  label: string;
  current: number;
  target: number;
  color: string;
  tooltipPrefix: string;
}

interface Props {
  totalSpent: number;
  income: number;
  variableSpending: number;
  monthlyAverage: number;
  savingsGoalPct?: number; // default 20%
}

// ── Single ring (stroke-dashoffset animation) ────────────────────────────────

function Ring({
  cx,
  cy,
  radius,
  thickness,
  pct,
  color,
  ready,
  delay,
}: {
  cx: number;
  cy: number;
  radius: number;
  thickness: number;
  pct: number;         // 0–100+
  color: string;
  ready: boolean;      // triggers the animation
  delay: number;       // stagger in ms
}) {
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(Math.max(pct, 0), 100);
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <g>
      {/* Background track */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={thickness}
        opacity={0.15}
      />
      {/* Foreground arc */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={ready ? offset : circumference}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{
          transition: `stroke-dashoffset 1.2s cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms`,
        }}
      />
    </g>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function FinanceRings({
  totalSpent,
  income,
  variableSpending,
  monthlyAverage,
  savingsGoalPct = 20,
}: Props) {
  const [ready, setReady] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Kick off entrance animation after mount
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // ── Ring data ─────────────────────────────────────────────────────────────
  const savingsGoal = income * (savingsGoalPct / 100);
  const actualSavings = Math.max(income - totalSpent, 0);

  const rings: RingData[] = [
    {
      label: "הוצאה כוללת",
      current: totalSpent,
      target: income || 1,
      color: "#ef4468",
      tooltipPrefix: "ניצלת",
    },
    {
      label: "הוצאות משתנות",
      current: variableSpending,
      target: monthlyAverage > 0 ? monthlyAverage : variableSpending || 1,
      color: "#f59e0b",
      tooltipPrefix: "הוצאת",
    },
    {
      label: "יעד חיסכון",
      current: actualSavings,
      target: savingsGoal > 0 ? savingsGoal : 1,
      color: "#10b981",
      tooltipPrefix: "חסכת",
    },
  ];

  const size = 180;
  const center = size / 2;
  const thickness = 14;
  const gap = 5;

  function handlePointerMove(idx: number, e: React.PointerEvent) {
    setHoveredIdx(idx);
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }

  const fmt = (n: number) => Math.round(Math.abs(n)).toLocaleString("he-IL");

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100 mb-5">
      <div className="flex items-center gap-5">
        {/* ── SVG rings ──────────────────────────────────────────── */}
        <div className="relative shrink-0">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="block"
          >
            {rings.map((ring, i) => {
              const radius = center - thickness / 2 - i * (thickness + gap);
              const pct =
                ring.target > 0
                  ? (Math.abs(ring.current) / ring.target) * 100
                  : 0;

              return (
                <g
                  key={ring.label}
                  onPointerMove={(e) => handlePointerMove(i, e)}
                  onPointerLeave={() => setHoveredIdx(null)}
                  style={{ cursor: "pointer" }}
                >
                  {/* Wider invisible hit-area for easier hover */}
                  <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={thickness + 10}
                  />
                  <Ring
                    cx={center}
                    cy={center}
                    radius={radius}
                    thickness={thickness}
                    pct={pct}
                    color={ring.color}
                    ready={ready}
                    delay={i * 150}
                  />
                </g>
              );
            })}

            {/* Center label */}
            <text
              x={center}
              y={center - 4}
              textAnchor="middle"
              className="text-[11px] font-bold fill-slate-600"
            >
              {income > 0
                ? `${Math.min(Math.round((totalSpent / income) * 100), 999)}%`
                : "—"}
            </text>
            <text
              x={center}
              y={center + 12}
              textAnchor="middle"
              className="text-[9px] fill-slate-400"
            >
              ניצול
            </text>
          </svg>
        </div>

        {/* ── Legend (מקרא) ───────────────────────────────────────── */}
        <div className="flex flex-col gap-3 min-w-0">
          {rings.map((ring, i) => {
            const pct =
              ring.target > 0
                ? Math.round((Math.abs(ring.current) / ring.target) * 100)
                : 0;
            return (
              <div
                key={ring.label}
                className="flex items-center gap-2"
                onPointerEnter={() => setHoveredIdx(i)}
                onPointerLeave={() => setHoveredIdx(null)}
              >
                <span
                  className="inline-block w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: ring.color }}
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-600 leading-tight">
                    {ring.label}
                  </p>
                  <p className="text-[10px] text-slate-400 leading-tight">
                    {fmt(ring.current)} / {fmt(ring.target)} ₪
                    <span
                      className={`mr-1 font-medium ${
                        i === 2
                          ? pct >= 100
                            ? "text-emerald-600"
                            : "text-slate-400"
                          : pct > 100
                          ? "text-red-500"
                          : "text-slate-400"
                      }`}
                    >
                      ({pct}%)
                    </span>
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Hover tooltip (fixed position, follows cursor) ────── */}
      {hoveredIdx !== null && (
        <div
          className="fixed z-[100] pointer-events-none rounded-lg bg-slate-800 text-white px-3 py-2 text-xs shadow-lg whitespace-nowrap"
          style={{
            top: tooltipPos.y - 48,
            left: tooltipPos.x,
            transform: "translateX(-50%)",
          }}
        >
          {rings[hoveredIdx].tooltipPrefix} {fmt(rings[hoveredIdx].current)} ₪
          {" "}מתוך {fmt(rings[hoveredIdx].target)} ₪
        </div>
      )}
    </div>
  );
}
