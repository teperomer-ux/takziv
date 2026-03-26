import type { ReactNode } from "react";

export type Tab = "dashboard" | "upload" | "history";

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  {
    id: "dashboard",
    label: "ראשי",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
      </svg>
    ),
  },
  {
    id: "upload",
    label: "העלאה",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
      </svg>
    ),
  },
  {
    id: "history",
    label: "היסטוריה",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
];

export default function BottomNav({ active, onChange }: Props) {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 bg-white border-t border-slate-200 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
      <div className="mx-auto max-w-3xl flex items-center justify-around h-16">
        {TABS.map((tab) => {
          const selected = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={`flex flex-col items-center gap-0.5 min-w-[64px] py-1 transition-colors ${
                selected ? "text-primary" : "text-slate-400"
              }`}
            >
              {tab.icon}
              <span className={`text-[11px] ${selected ? "font-semibold" : "font-medium"}`}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
      {/* Safe area for phones with gesture bars */}
      <div className="h-[env(safe-area-inset-bottom)]" />
    </nav>
  );
}
