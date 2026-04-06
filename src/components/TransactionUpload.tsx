import { useState, useRef } from "react";
import type { Transaction } from "../types";

/** Mock parser — returns fake parsed transactions from an uploaded file */
function mockParseFile(file: File): Promise<Omit<Transaction, "id">[]> {
  console.log(`Parsing file: ${file.name} (${file.type})`);
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve([
          {
            date: "2026-03-15",
            description: "רמי לוי - סופרמרקט",
            amount: 342.5,
            category: "מזון וטיפוח",
            subCategory: "סופרמרקט",
            status: "draft",
            billingMonth: 3,
            billingYear: 2026,
          },
          {
            date: "2026-03-14",
            description: "סונול - תחנת דלק",
            amount: 280.0,
            category: "תחבורה",
            subCategory: "דלק",
            status: "draft",
            billingMonth: 3,
            billingYear: 2026,
          },
          {
            date: "2026-03-12",
            description: "חברת החשמל",
            amount: 485.0,
            category: "דיור",
            subCategory: "חשמל",
            status: "draft",
            billingMonth: 3,
            billingYear: 2026,
          },
        ]),
      800
    )
  );
}

interface Props {
  onTransactionsParsed: (txs: Omit<Transaction, "id">[]) => void;
}

export default function TransactionUpload({ onTransactionsParsed }: Props) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setFileName(file.name);
    setLoading(true);
    try {
      const parsed = await mockParseFile(file);
      onTransactionsParsed(parsed);
    } finally {
      setLoading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function onFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <section className="mb-6">
      <h2 className="text-lg font-semibold text-primary mb-3">
        העלאת דף חיוב
      </h2>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`
          flex flex-col items-center justify-center gap-2
          rounded-xl border-2 border-dashed p-8 cursor-pointer
          transition-colors text-center
          ${
            dragging
              ? "border-accent bg-amber-50"
              : "border-slate-300 bg-white"
          }
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.csv"
          onChange={onFileSelect}
          className="hidden"
        />

        {loading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <span className="text-sm text-slate-500">מעבד את הקובץ...</span>
          </div>
        ) : (
          <>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-10 w-10 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16"
              />
            </svg>
            <p className="text-sm font-medium text-slate-600">
              גררו קובץ לכאן או לחצו לבחירה
            </p>
            <p className="text-xs text-slate-400">PDF / CSV</p>
            {fileName && (
              <p className="mt-1 text-xs text-success font-medium">
                {fileName} נטען בהצלחה
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
