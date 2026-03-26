import type { RecurringBill } from "../utils/recurringBills";

interface Props {
  bills: RecurringBill[];
}

export default function RecurringBills({ bills }: Props) {
  if (bills.length === 0) return null;

  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-3">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4 text-primary"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.828a1 1 0 101.415-1.414L11 9.586V6z"
            clipRule="evenodd"
          />
        </svg>
        <h3 className="text-sm font-semibold text-slate-500">
          חיובים קבועים צפויים
        </h3>
      </div>

      <div className="space-y-2">
        {bills.map((bill) => (
          <div
            key={bill.description}
            className="flex items-center gap-3 rounded-xl bg-white p-3.5 shadow-sm border border-slate-100"
          >
            {/* Calendar icon with day */}
            <div className="shrink-0 flex flex-col items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-3.5 w-3.5 mb-0.5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-[10px] font-bold leading-none">{bill.typicalDay}</span>
            </div>

            {/* Description + recurring info */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-700 truncate">
                {bill.description}
              </p>
              <p className="text-[11px] text-slate-400">
                מופיע ב-{bill.monthCount} חודשים
              </p>
            </div>

            {/* Expected amount */}
            <span className="shrink-0 text-sm font-semibold text-slate-600">
              {Math.round(bill.avgAmount).toLocaleString("he-IL")} ₪
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
