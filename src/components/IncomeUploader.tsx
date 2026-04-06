import { useState, useRef, useCallback, useEffect } from "react";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { useIncomeCategories } from "../hooks/useIncomeCategories";
import { suggestIncomeCategory, type UserMapping, type MatchSource } from "../utils/incomeClassifier";
import { bulkSaveIncomeTransactions } from "../services/incomeTransactionService";
import { getLearnedMappings, bulkSaveMappings } from "../services/mappingService";
import { auth } from "../lib/firebase";
import type { Transaction } from "../types";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PreviewRow extends Omit<Transaction, "id"> {
  _tempId: string;
  _autoMatched: boolean;
  _matchSource: MatchSource | "manual" | "none";
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

let _rowId = 0;
function tempId() {
  return `income-preview-${++_rowId}`;
}

/**
 * Parse a date string into { year, month, day } numbers.
 * Returns null if the date cannot be parsed — caller must skip the row.
 * Supports: DD/MM/YY, DD/MM/YYYY, DD-MM-YY, DD.MM.YY, YYYY-MM-DD
 */
function parseDate(raw: string): { year: number; month: number; day: number } | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // DD/MM/YY or DD/MM/YYYY (also with - or . separators)
  const slashMatch = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1], 10);
    const month = parseInt(slashMatch[2], 10);
    const rawYear = parseInt(slashMatch[3], 10);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }

  // YYYY-MM-DD (ISO)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }

  return null;
}

/** Format parsed date components to YYYY-MM-DD string. */
function formatDate(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** Check if a parsed date matches the target year and month exactly. */
function matchesTargetMonth(d: { year: number; month: number }, targetYear: number, targetMonth: number): boolean {
  return d.year === targetYear && d.month === targetMonth;
}

function parseAmount(raw: unknown): number {
  if (typeof raw === "number") return raw;
  let str = String(raw).trim();

  // Normalize Unicode minus signs (U+2212, U+2013 en-dash, U+2014 em-dash) to ASCII hyphen
  str = str.replace(/[\u2212\u2013\u2014\uFE63\uFF0D]/g, "-");

  // Strip RTL/LTR marks and other invisible chars that wrap around the minus
  str = str.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");

  // Remove ONLY commas (thousands separators), keep everything else intact
  const cleaned = str.replace(/,/g, "").trim();

  // Extract the number — only strip non-numeric chars AFTER preserving the minus
  const numStr = cleaned.replace(/[^0-9.\-]/g, "");

  // Handle trailing-minus convention (e.g. "3540-" → "-3540")
  if (numStr.endsWith("-") && !numStr.startsWith("-")) {
    return -(parseFloat(numStr.replace(/-/g, "")) || 0);
  }

  return parseFloat(numStr) || 0;
}

function cleanDescription(rawName: string): string {
  if (!rawName) return "";
  rawName = rawName.replace(/\d{2}\/\d{2}\/\d{2,4}/g, "");
  rawName = rawName.replace(/[\$€£₪]/g, "");
  rawName = rawName.replace(/\d+\.\d+/g, "");
  rawName = rawName.replace(/^\d{1,2}\s+/, "");
  rawName = rawName.replace(/^[-\s]+|[-\s]+$/g, "");
  rawName = rawName.replace(/\s{2,}/g, " ");
  return rawName.trim();
}

function buildRow(
  date: string,
  description: string,
  amount: number,
  userMappings?: UserMapping[]
): PreviewRow {
  const match = suggestIncomeCategory(description, userMappings);
  return {
    _tempId: tempId(),
    _autoMatched: !!match,
    _matchSource: match?.source ?? "none",
    date,
    description,
    amount,
    category: match?.category ?? "",
    subCategory: match?.subCategory ?? "",
    status: "draft",
    billingMonth: 0,
    billingYear: 0,
  };
}

// ─── CSV decoder (Windows-1255 → UTF-8) ─────────────────────────────────────

/**
 * Decode a CSV file trying Windows-1255 first (Israeli bank default),
 * then falling back to UTF-8.  Returns the decoded text.
 */
async function decodeCsvText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Check for UTF-8 BOM (EF BB BF) — if present, file is UTF-8
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder("utf-8").decode(buffer);
    console.info("[IncomeUploader] decoded CSV as utf-8 (BOM detected)");
    // Strip BOM character if TextDecoder didn't remove it
    return text.replace(/^\uFEFF/, "");
  }

  // Try Windows-1255 — this is what Discount Bank and most Israeli banks use.
  // Also try iso-8859-8 (Hebrew ISO) as an alternative label.
  for (const encoding of ["windows-1255", "iso-8859-8"]) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: true });
      const text = decoder.decode(buffer);
      if (/[\u0590-\u05FF]/.test(text)) {
        console.info(`[IncomeUploader] decoded CSV as ${encoding}`);
        return text;
      }
    } catch {
      console.info(`[IncomeUploader] ${encoding} decode failed, trying next...`);
    }
  }

  // Fallback: UTF-8
  const text = new TextDecoder("utf-8").decode(buffer);
  console.info("[IncomeUploader] decoded CSV as utf-8 (fallback)");
  return text.replace(/^\uFEFF/, "");
}

/**
 * Parse CSV text using PapaParse with auto-delimiter detection.
 * Returns array of rows, each row is an array of string cells.
 */
function parseCsvRows(text: string): string[][] {
  const result = Papa.parse<string[]>(text, {
    header: false,       // return raw arrays, not objects
    skipEmptyLines: true,
    dynamicTyping: false, // keep everything as strings so we control parsing
  });
  if (result.errors.length > 0) {
    console.warn("[IncomeUploader] PapaParse warnings:", result.errors.slice(0, 5));
  }
  return result.data;
}

// ─── Header label sets ───────────────────────────────────────────────────────

const HEADER_DATE = ["תאריך", "תאריך ערך", "תאריך העסקה", "date", "Date"];
const HEADER_DESC = ["תיאור התנועה", "תיאור", "פרטים", "אסמכתא/תיאור", "description", "Description"];
const HEADER_COMBINED_AMT = ["זכות/חובה ₪", "זכות/חובה"];
const HEADER_CREDIT = ["זכות", "credit", "Credit"];
const HEADER_DEBIT = ["חובה", "debit", "Debit"];
const HEADER_AMT = ["סכום", "amount", "Amount"];

/** Strip BOM, zero-width chars, and excess whitespace from a cell value. */
function cleanCell(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")           // BOM
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "") // zero-width / bidi marks
    .trim();
}

/** Find the index of a column in a row by matching against a list of known labels. */
function findCol(cells: string[], labels: string[]): number {
  for (const label of labels) {
    const idx = cells.findIndex((cell) => {
      const c = cleanCell(cell);
      return c === label || c.includes(label);
    });
    if (idx >= 0) return idx;
  }
  return -1;
}

// ─── CSV parser (income-specific, Windows-1255 aware) ────────────────────────

async function parseCsvForIncome(
  file: File,
  targetYear: number,
  targetMonth: number,
  userMappings?: UserMapping[]
): Promise<PreviewRow[]> {
  const text = await decodeCsvText(file);

  // PapaParse handles delimiter detection, quoted fields, and commas inside values
  const allRows = parseCsvRows(text);
  console.info(`[IncomeUploader] PapaParse returned ${allRows.length} rows`);
  if (allRows.length < 2) return [];

  // ── Find header row ────────────────────────────────────────────────────
  let headerIdx = -1;
  let dateCol = -1;
  let descCol = -1;
  let combinedAmtCol = -1;
  let creditCol = -1;
  let debitCol = -1;
  let amtCol = -1;

  for (let i = 0; i < Math.min(allRows.length, 30); i++) {
    const cleaned = allRows[i].map(cleanCell);

    // Log first 10 rows for debugging
    if (i < 10) {
      console.log(`[IncomeUploader] row ${i} (${cleaned.length} cells): ${JSON.stringify(cleaned)}`);
    }

    const dc = findCol(cleaned, HEADER_DATE);
    const nc = findCol(cleaned, HEADER_DESC);
    if (dc >= 0 && nc >= 0) {
      headerIdx = i;
      dateCol = dc;
      descCol = nc;
      combinedAmtCol = findCol(cleaned, HEADER_COMBINED_AMT);
      creditCol = combinedAmtCol < 0 ? findCol(cleaned, HEADER_CREDIT) : -1;
      debitCol = combinedAmtCol < 0 ? findCol(cleaned, HEADER_DEBIT) : -1;
      amtCol = combinedAmtCol < 0 ? findCol(cleaned, HEADER_AMT) : -1;
      console.info(
        `[IncomeUploader] ✓ HEADER at row ${i}: date=${dc} desc=${nc} combinedAmt=${combinedAmtCol} credit=${creditCol} debit=${debitCol} amt=${amtCol}`
      );
      break;
    }
  }

  if (headerIdx < 0) {
    console.warn("[IncomeUploader] ✗ header not found in CSV");
    return [];
  }

  // ── Parse data rows ────────────────────────────────────────────────────
  const results: PreviewRow[] = [];
  let debugCount = 0;

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    try {
      const cells = allRows[i];
      if (cells.length < 2) continue;

      const rawDate = cleanCell(cells[dateCol] ?? "");
      const rawDesc = cleanCell(cells[descCol] ?? "");

      if (!rawDate && !rawDesc) continue;
      if (rawDate.includes("סך הכל") || rawDesc.includes("סך הכל")) continue;
      if (rawDate.includes('סה"כ') || rawDesc.includes('סה"כ')) continue;

      // ── Amount ─────────────────────────────────────────────────────
      let amount = 0;
      if (combinedAmtCol >= 0) {
        amount = parseAmount(cleanCell(cells[combinedAmtCol] ?? ""));
      } else if (creditCol >= 0) {
        amount = parseAmount(cleanCell(cells[creditCol] ?? ""));
      }
      if (amount === 0 && amtCol >= 0) {
        const generalAmt = parseAmount(cleanCell(cells[amtCol] ?? ""));
        if (debitCol >= 0) {
          const debitAmt = parseAmount(cleanCell(cells[debitCol] ?? ""));
          if (debitAmt === 0 && generalAmt > 0) amount = generalAmt;
        } else if (generalAmt > 0) {
          amount = generalAmt;
        }
      }

      // Debug: log first 10 data rows
      if (debugCount < 10) {
        const rawAmtCell = cleanCell(cells[combinedAmtCol >= 0 ? combinedAmtCol : (creditCol >= 0 ? creditCol : amtCol)] ?? "");
        console.log(`[IncomeUploader] data ${i}: date="${rawDate}" desc="${rawDesc}" rawAmt="${rawAmtCell}" → amount=${amount} ${amount > 0 ? "✓ INCOME" : "✗ skip"}`);
        debugCount++;
      }

      // Strict: only positive amounts (incomes)
      if (amount <= 0) continue;

      const desc = cleanDescription(rawDesc);
      if (!desc) continue;

      // ── STRICT date filter: numeric month/year comparison ──────────
      const parsedDate = parseDate(rawDate);
      if (!parsedDate) continue;
      if (!matchesTargetMonth(parsedDate, targetYear, targetMonth)) continue;

      results.push(buildRow(formatDate(parsedDate), desc, amount, userMappings));
    } catch {
      continue;
    }
  }

  console.info(
    `[IncomeUploader] CSV result: ${results.length} income rows for ${targetMonth}/${targetYear}`
  );
  return results;
}

// ─── Excel parser (xlsx/xls only) ────────────────────────────────────────────

async function parseExcelForIncome(
  file: File,
  targetYear: number,
  targetMonth: number,
  userMappings?: UserMapping[]
): Promise<PreviewRow[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", raw: false });
  const results: PreviewRow[] = [];

  for (const sheetName of workbook.SheetNames) {
    try {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
      if (!rows || rows.length === 0) continue;

      // Find header row
      let headerIdx = -1;
      let dateCol = -1;
      let descCol = -1;
      let combinedAmtCol = -1;
      let creditCol = -1;
      let debitCol = -1;
      let amtCol = -1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !Array.isArray(row) || row.length < 2) continue;

        const strCells = row.map((c) => (c != null ? String(c).trim() : ""));
        const dc = findCol(strCells, HEADER_DATE);
        const nc = findCol(strCells, HEADER_DESC);
        if (dc >= 0 && nc >= 0) {
          headerIdx = i;
          dateCol = dc;
          descCol = nc;
          combinedAmtCol = findCol(strCells, HEADER_COMBINED_AMT);
          creditCol = combinedAmtCol < 0 ? findCol(strCells, HEADER_CREDIT) : -1;
          debitCol = combinedAmtCol < 0 ? findCol(strCells, HEADER_DEBIT) : -1;
          amtCol = combinedAmtCol < 0 ? findCol(strCells, HEADER_AMT) : -1;
          break;
        }
      }

      if (headerIdx < 0) continue;

      let debugCount = 0;

      for (let i = headerIdx + 1; i < rows.length; i++) {
        try {
          const row = rows[i];
          if (!row || !Array.isArray(row) || row.length < 2) continue;

          const rawDate = row[dateCol] != null ? String(row[dateCol]).trim() : "";
          const rawDesc = row[descCol] != null ? String(row[descCol]).trim() : "";

          if (!rawDate && !rawDesc) continue;
          if (rawDate.includes("סך הכל") || rawDesc.includes("סך הכל")) continue;
          if (rawDate.includes('סה"כ') || rawDesc.includes('סה"כ')) continue;

          let amount = 0;
          if (combinedAmtCol >= 0 && row[combinedAmtCol] != null) {
            amount = parseAmount(row[combinedAmtCol]);
          } else if (creditCol >= 0 && row[creditCol] != null) {
            amount = parseAmount(row[creditCol]);
          }
          if (amount === 0 && amtCol >= 0 && row[amtCol] != null) {
            const generalAmt = parseAmount(row[amtCol]);
            if (debitCol >= 0) {
              const debitAmt = parseAmount(row[debitCol] ?? 0);
              if (debitAmt === 0 && generalAmt > 0) amount = generalAmt;
            } else if (generalAmt > 0) {
              amount = generalAmt;
            }
          }

          if (debugCount < 5) {
            console.log(`[IncomeUploader] xlsx row ${i}: date="${rawDate}" desc="${rawDesc}" → amount=${amount}`);
            debugCount++;
          }

          if (amount <= 0) continue;

          const desc = cleanDescription(rawDesc);
          if (!desc) continue;

          const parsedDate = parseDate(rawDate);
          if (!parsedDate) continue;
          if (!matchesTargetMonth(parsedDate, targetYear, targetMonth)) continue;

          results.push(buildRow(formatDate(parsedDate), desc, amount, userMappings));
        } catch {
          continue;
        }
      }
    } catch (sheetErr) {
      console.warn(`[IncomeUploader] failed to process sheet "${sheetName}":`, sheetErr);
    }
  }

  return results;
}

// ─── Component ──────────────────────────────────────────────────────────────

const ADD_NEW = "__add_new__";
const INCOME_MAPPINGS_COLLECTION = "learnedIncomeMappings";

interface Props {
  year: number;
  month: number;
  onDone?: () => void;
}

export default function IncomeUploader({ year, month, onDone }: Props) {
  const { categories, categoryNames, addCategory, addSubCategory } = useIncomeCategories();
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mappingsRef = useRef<UserMapping[]>([]);

  const [addingCatFor, setAddingCatFor] = useState<string | null>(null);
  const [addingSubFor, setAddingSubFor] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newSubName, setNewSubName] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function handleAddCategory(rowId: string) {
    const trimmed = newCatName.trim();
    if (!trimmed) return;
    await addCategory(trimmed);
    updateRow(rowId, "category", trimmed);
    updateRow(rowId, "subCategory", "");
    setNewCatName("");
    setAddingCatFor(null);
    showToast(`סעיף "${trimmed}" נוסף בהצלחה`);
  }

  async function handleAddSubCategory(rowId: string, category: string) {
    const trimmed = newSubName.trim();
    if (!trimmed || !category) return;
    await addSubCategory(category, trimmed);
    updateRow(rowId, "subCategory", trimmed);
    setNewSubName("");
    setAddingSubFor(null);
    showToast(`תת סעיף "${trimmed}" נוסף בהצלחה`);
  }

  // Load learned INCOME mappings (separate collection)
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    getLearnedMappings(uid, INCOME_MAPPINGS_COLLECTION)
      .then((m) => {
        mappingsRef.current = m;
        console.info(`[IncomeUploader] loaded ${m.length} learned income mappings`);
      })
      .catch((err) =>
        console.warn("[IncomeUploader] failed to load income mappings:", err)
      );
  }, []);

  const parseFile = useCallback(async (file: File) => {
    setLoading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      const mappings = mappingsRef.current;

      if (ext === "csv") {
        // CSV: dedicated parser with Windows-1255 encoding support
        const parsed = await parseCsvForIncome(file, year, month, mappings);
        if (parsed.length === 0) {
          throw new Error(
            `לא נמצאו הכנסות (זכויות) בקובץ עבור החודש הנבחר. ודאו שהקובץ מכיל נתוני עו״ש עם עמודת זכות.`
          );
        }
        setRows(parsed);
      } else if (ext === "xlsx" || ext === "xls") {
        // Excel: XLSX library handles encoding internally
        const parsed = await parseExcelForIncome(file, year, month, mappings);
        if (parsed.length === 0) {
          throw new Error(
            `לא נמצאו הכנסות (זכויות) בקובץ עבור החודש הנבחר. ודאו שהקובץ מכיל נתוני עו״ש עם עמודת זכות.`
          );
        }
        setRows(parsed);
      } else if (ext === "pdf") {
        throw new Error("להכנסות יש להעלות קובץ Excel או CSV של דף עו״ש. קבצי PDF אינם נתמכים כאן.");
      } else {
        throw new Error("סוג קובץ לא נתמך. יש להעלות Excel או CSV.");
      }
    } catch (err) {
      console.error("[IncomeUploader] parseFile error:", err);
      setError(
        err instanceof Error ? err.message : "שגיאה בפענוח הקובץ."
      );
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  const handleFile = useCallback(async (file: File) => {
    // Clear previous results before parsing new file — prevents duplicates
    setRows([]);
    setError(null);
    setSaved(false);
    await parseFile(file);
  }, [parseFile]);

  function updateRow(
    tempId: string,
    field: keyof PreviewRow,
    value: string | number
  ) {
    setRows((prev) =>
      prev.map((r) => {
        if (r._tempId !== tempId) return r;
        const updated = { ...r, [field]: value };
        if (field === "category") {
          updated.subCategory = categories[value as string]?.[0] ?? "";
          updated._matchSource = "manual";
          updated._autoMatched = false;
        }
        if (field === "subCategory") {
          updated._matchSource = "manual";
          updated._autoMatched = false;
        }
        return updated;
      })
    );
  }

  function removeRow(tid: string) {
    setRows((prev) => prev.filter((r) => r._tempId !== tid));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const toSave = rows.map(
        ({ _tempId: _, _autoMatched: __, _matchSource: ___, ...rest }) => ({
          ...rest,
          status: "confirmed" as const,
        })
      );
      await bulkSaveIncomeTransactions(toSave);

      // Learn income mappings (separate collection from expenses)
      const mappingsToLearn = rows
        .filter((r) => r.category && r.description.trim())
        .map((r) => ({
          description: r.description.trim(),
          category: r.category,
          subCategory: r.subCategory,
        }));
      const uid = auth.currentUser?.uid;
      if (mappingsToLearn.length > 0 && uid) {
        await bulkSaveMappings(uid, mappingsToLearn, INCOME_MAPPINGS_COLLECTION);
        const fresh = await getLearnedMappings(uid, INCOME_MAPPINGS_COLLECTION);
        mappingsRef.current = fresh;
        console.info(`[IncomeUploader] learned ${mappingsToLearn.length} new income mappings`);
      }

      setSaved(true);
      setRows([]);
      onDone?.();
    } catch {
      setError("שגיאה בשמירה ל-Firebase. נסו שוב.");
    } finally {
      setSaving(false);
    }
  }

  const total = rows.reduce((sum, r) => sum + r.amount, 0);

  const MONTH_NAMES = [
    "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
    "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
  ];

  return (
    <section className="mb-6">
      <h2 className="text-lg font-semibold text-primary mb-3">
        העלאת דף עו״ש — הכנסות בלבד
      </h2>
      <p className="text-xs text-slate-400 mb-4">
        המערכת תסנן אוטומטית רק זכויות (הכנסות) מתוך {MONTH_NAMES[month - 1]} {year}.
      </p>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] rounded-lg bg-slate-800 text-white px-4 py-2.5 text-sm shadow-lg animate-[fadeIn_0.2s_ease-out]">
          {toast}
        </div>
      )}

      {/* Drop zone */}
      {rows.length === 0 && !loading && !saved && (
        <div
          className={`relative rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
            dragging
              ? "border-primary bg-primary/5"
              : "border-slate-200 hover:border-primary/40"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="mx-auto h-10 w-10 text-slate-300 mb-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
          <p className="text-sm text-slate-500 mb-3">
            גררו קובץ עו״ש (Excel / CSV) לכאן
          </p>
          <button
            onClick={() => inputRef.current?.click()}
            className="rounded-xl bg-primary text-white px-5 py-2.5 text-sm font-semibold shadow-sm hover:bg-primary/90 transition-colors min-h-[44px]"
          >
            בחרו קובץ
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center gap-3 py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-slate-400">מעבד קובץ...</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
          <button
            onClick={() => { setError(null); setRows([]); }}
            className="block mt-2 text-xs text-red-500 hover:underline"
          >
            נסו קובץ אחר
          </button>
        </div>
      )}

      {/* Preview table */}
      {rows.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-sm text-slate-500">
              <span className="font-bold text-emerald-600">{rows.length}</span> הכנסות נמצאו |
              סה״כ: <span className="font-bold text-emerald-600">{Math.round(total).toLocaleString("he-IL")} ₪</span>
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-xl bg-emerald-600 text-white px-5 py-2 text-sm font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50 min-h-[36px]"
              >
                {saving ? "שומר..." : "שמור הכנסות"}
              </button>
              <button
                onClick={() => setRows([])}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-500 hover:bg-slate-50 transition-colors min-h-[36px]"
              >
                ביטול
              </button>
            </div>
          </div>

          {rows.map((row) => (
            <div
              key={row._tempId}
              className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm border border-slate-200/60 dark:border-slate-700/60"
            >
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-slate-400 w-[80px] shrink-0" dir="ltr">
                    {row.date}
                  </span>
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                    {row.description}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-bold text-sm text-emerald-600 whitespace-nowrap">
                    +{row.amount.toLocaleString("he-IL")} ₪
                  </span>
                  <button
                    onClick={() => removeRow(row._tempId)}
                    className="text-slate-300 hover:text-red-400 transition-colors p-1"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Category dropdowns */}
              <div className="flex gap-2">
                <div className="flex-1">
                  {addingCatFor === row._tempId ? (
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={newCatName}
                        onChange={(e) => setNewCatName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAddCategory(row._tempId);
                          if (e.key === "Escape") { setAddingCatFor(null); setNewCatName(""); }
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-primary bg-white px-2 py-1.5 text-sm"
                        placeholder="שם סעיף חדש..."
                        autoFocus
                      />
                      <button
                        onClick={() => handleAddCategory(row._tempId)}
                        className="shrink-0 rounded-lg bg-primary text-white px-2 py-1.5 text-xs font-medium"
                      >
                        הוסף
                      </button>
                      <button
                        onClick={() => { setAddingCatFor(null); setNewCatName(""); }}
                        className="shrink-0 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-500"
                      >
                        ביטול
                      </button>
                    </div>
                  ) : (
                    <select
                      value={row.category}
                      onChange={(e) => {
                        if (e.target.value === ADD_NEW) {
                          setAddingCatFor(row._tempId);
                          setNewCatName("");
                          return;
                        }
                        updateRow(row._tempId, "category", e.target.value);
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm appearance-none"
                    >
                      <option value="">סעיף</option>
                      {categoryNames.map((cat) => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                      <option value={ADD_NEW}>+ הוסף סעיף חדש...</option>
                    </select>
                  )}
                </div>

                <div className="flex-1">
                  {addingSubFor === row._tempId ? (
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={newSubName}
                        onChange={(e) => setNewSubName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAddSubCategory(row._tempId, row.category);
                          if (e.key === "Escape") { setAddingSubFor(null); setNewSubName(""); }
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-primary bg-white px-2 py-1.5 text-sm"
                        placeholder="שם תת סעיף חדש..."
                        autoFocus
                      />
                      <button
                        onClick={() => handleAddSubCategory(row._tempId, row.category)}
                        className="shrink-0 rounded-lg bg-primary text-white px-2 py-1.5 text-xs font-medium"
                      >
                        הוסף
                      </button>
                      <button
                        onClick={() => { setAddingSubFor(null); setNewSubName(""); }}
                        className="shrink-0 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-500"
                      >
                        ביטול
                      </button>
                    </div>
                  ) : (
                    <select
                      value={row.subCategory}
                      onChange={(e) => {
                        if (e.target.value === ADD_NEW) {
                          if (!row.category) return;
                          setAddingSubFor(row._tempId);
                          setNewSubName("");
                          return;
                        }
                        updateRow(row._tempId, "subCategory", e.target.value);
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm appearance-none"
                    >
                      <option value="">תת סעיף</option>
                      {(categories[row.category] ?? []).map((sub) => (
                        <option key={sub} value={sub}>{sub}</option>
                      ))}
                      {row.category && <option value={ADD_NEW}>+ הוסף תת סעיף...</option>}
                    </select>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Success */}
      {saved && (
        <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          ההכנסות נשמרו בהצלחה!
        </div>
      )}
    </section>
  );
}
