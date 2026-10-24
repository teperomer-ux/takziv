import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  title: string;
  /** Optional context under the title, e.g. which row is about to be deleted. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Small RTL confirmation dialog for destructive actions. Focus starts on
 * "cancel" so a stray Enter never confirms; Escape and the backdrop cancel.
 */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "ביטול",
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />

      <div
        dir="rtl"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-xs rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-xl border border-slate-200/60 dark:border-slate-700/60"
      >
        <h2 id="confirm-dialog-title" className="text-base font-bold text-slate-800 dark:text-white">
          {title}
        </h2>
        {children && <div className="text-sm text-slate-500 dark:text-slate-400 mt-2 leading-relaxed">{children}</div>}

        <div className="flex gap-3 mt-6">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[44px]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-rose-500 text-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-rose-600 transition-colors min-h-[44px]"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
