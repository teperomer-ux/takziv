import { useState, useRef, useCallback, useEffect } from "react";
import * as XLSX from "xlsx";
import * as pdfjsLib from "pdfjs-dist";
import { useCategories } from "../hooks/useCategories";
import { suggestCategory, type UserMapping, type MatchSource } from "../utils/classifier";
import { bulkSaveTransactions } from "../services/transactionService";
import { getLearnedMappings, bulkSaveMappings } from "../services/mappingService";
import { calculateFileHash } from "../utils/fileHash";
import { checkFileHash, saveFileHash } from "../services/uploadedFilesService";
import type { Transaction } from "../types";

// pdf.js worker — jsdelivr hosts v5; cdnjs only goes up to v4
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

// ─── Types ──────────────────────────────────────────────────────────────────

/** A row being previewed before saving — uses a local temp id */
interface PreviewRow extends Omit<Transaction, "id"> {
  _tempId: string;
  _autoMatched: boolean;
  _matchSource: MatchSource | "manual" | "none";
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

let _rowId = 0;
function tempId() {
  return `preview-${++_rowId}`;
}

/** Try to parse a DD/MM/YYYY or YYYY-MM-DD string into YYYY-MM-DD */
function normalizeDate(raw: string): string {
  if (!raw) return new Date().toISOString().split("T")[0];

  // DD/MM/YYYY
  const slashMatch = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (slashMatch) {
    const [, d, m, y] = slashMatch;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().split("T")[0];
}

function parseAmount(raw: unknown): number {
  if (typeof raw === "number") return raw;
  const cleaned = String(raw).replace(/[^\d.\-]/g, "");
  return parseFloat(cleaned) || 0;
}

function buildRow(
  date: string,
  description: string,
  amount: number,
  userMappings?: UserMapping[]
): PreviewRow {
  const match = suggestCategory(description, userMappings);

  // Auto-categorize credits/refunds (negative amounts)
  const isCredit = amount < 0;
  const category = match?.category ?? (isCredit ? "זיכויים/החזרים" : "");
  const subCategory = match?.subCategory ?? (isCredit ? "החזר כספי" : "");

  return {
    _tempId: tempId(),
    _autoMatched: !!match || isCredit,
    _matchSource: match?.source ?? (isCredit ? "system" : "none"),
    date: normalizeDate(date),
    description,
    amount,
    category,
    subCategory,
    status: "draft",
  };
}

// ─── Excel / CSV parser ─────────────────────────────────────────────────────

/** Known header labels → semantic role. Longest first for best matching. */
const HEADER_DATE = ["תאריך עסקה", "תאריך", "date", "Date"];
const HEADER_DESC = ["שם בית העסק", "בית עסק", "תיאור", "description", "Description"];
const HEADER_AMT  = ["סכום חיוב", "סכום עסקה", "סכום", "amount", "Amount"];

/** Find the column index for a known header label inside a row of cells. */
function findCol(row: unknown[], labels: string[]): number {
  for (const label of labels) {
    const idx = row.findIndex(
      (cell) => cell != null && String(cell).trim() === label
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

async function parseExcel(file: File, userMappings?: UserMapping[]): Promise<PreviewRow[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", raw: false });
  const results: PreviewRow[] = [];

  // Iterate ALL sheets (domestic / foreign may be separate sheets)
  for (const sheetName of workbook.SheetNames) {
    try {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      // Convert to a 2D array so we can scan for the header row dynamically
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
      if (!rows || rows.length === 0) continue;

      // ── Find the header row ─────────────────────────────────────────
      let headerIdx = -1;
      let dateCol = -1;
      let descCol = -1;
      let amtCol = -1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !Array.isArray(row) || row.length < 2) continue;

        const dc = findCol(row, HEADER_DATE);
        const nc = findCol(row, HEADER_DESC);
        // Require at least date + description to identify the header
        if (dc >= 0 && nc >= 0) {
          headerIdx = i;
          dateCol = dc;
          descCol = nc;
          amtCol = findCol(row, HEADER_AMT);
          break;
        }
      }

      // If no header found, fall back to sheet_to_json with named keys
      if (headerIdx < 0) {
        const namedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
        for (const row of namedRows) {
          try {
            const date = String(
              row["תאריך"] ?? row["תאריך עסקה"] ?? row["date"] ?? row["Date"] ?? ""
            );
            const rawDesc = String(
              row["שם בית העסק"] ?? row["בית עסק"] ?? row["תיאור"] ?? row["description"] ?? row["Description"] ?? ""
            );
            const amt = row["סכום"] ?? row["סכום חיוב"] ?? row["סכום עסקה"] ?? row["amount"] ?? row["Amount"] ?? 0;
            const desc = cleanBusinessName(rawDesc);
            if (!desc && parseAmount(amt) === 0) continue;
            results.push(buildRow(date, desc, parseAmount(amt), userMappings));
          } catch {
            continue;
          }
        }
        continue;
      }

      // ── Extract data rows below the header ──────────────────────────
      for (let i = headerIdx + 1; i < rows.length; i++) {
        try {
          const row = rows[i];
          if (!row || !Array.isArray(row) || row.length < 2) continue;

          const rawDate = row[dateCol] != null ? String(row[dateCol]).trim() : "";
          const rawDesc = row[descCol] != null ? String(row[descCol]).trim() : "";

          // Skip summary / empty rows
          if (!rawDate && !rawDesc) continue;
          if (rawDate.includes("סך הכל") || rawDesc.includes("סך הכל")) continue;
          if (rawDate.includes('סה"כ') || rawDesc.includes('סה"כ')) continue;

          // Parse amount (handle minus for credits, strip currency symbols)
          const rawAmt = amtCol >= 0 && row[amtCol] != null ? row[amtCol] : 0;
          const amount = parseAmount(rawAmt);
          if (amount === 0 && !rawDesc) continue;

          // Clean the description
          const desc = cleanBusinessName(rawDesc);
          if (!desc) continue;

          // Normalize date: handle DD-MM-YYYY, DD/MM/YYYY, etc.
          const normalizedDate = rawDate.replace(/-/g, "/");

          results.push(buildRow(normalizedDate, desc, amount, userMappings));
        } catch {
          continue;
        }
      }

      console.info(`[parseExcel] sheet "${sheetName}": header at row ${headerIdx}, extracted ${results.length} transactions so far`);
    } catch (sheetErr) {
      console.warn(`[parseExcel] failed to process sheet "${sheetName}":`, sheetErr);
    }
  }

  return results;
}

// ─── PDF parser ─────────────────────────────────────────────────────────────

// ─── Company detection ──────────────────────────────────────────────────────

type CardCompany = "isracard" | "max" | "cal";

/** Safely extract .str from a pdf.js item, returns "" on failure. */
function safeStr(item: unknown): string {
  try {
    if (!item || typeof item !== "object") return "";
    const val = (item as Record<string, unknown>)?.str;
    if (val === undefined || val === null) return "";
    return String(val);
  } catch {
    return "";
  }
}

/**
 * Detect the card company from concatenated first-page text.
 * Text is already joined WITHOUT spaces so partial tokens match.
 */
function detectCompanyFromText(rawText: string): CardCompany {
  if (!rawText) return "isracard";
  const clean = rawText.replace(/\s/g, "");

  if (/MAX/.test(clean) || /מקס/.test(clean) || clean.includes("עסקותבארץ")) {
    return "max";
  }
  if (/כאל/.test(clean) || /Cal/i.test(clean) || /cal-online/i.test(clean) || clean.includes("035726444")) {
    return "cal";
  }
  return "isracard";
}

// ─── Shared constants ───────────────────────────────────────────────────────

const SUMMARY_EXCLUSIONS = ['סה"כ', "סה״כ", "סהכ", 'סה"כ חיוב', "סך הכל", "סה״כ חיוב"];

function isSummaryRow(row: string): boolean {
  if (!row) return false;
  return SUMMARY_EXCLUSIONS.some((ex) => row.includes(ex));
}

const DATE_RE = /\b(\d{2}\/\d{2}\/\d{2,4})\b/;
const AMOUNT_RE_G = /-?\d{1,3}(?:,\d{3})*(?:\.\d{2})/g;

// ─── String-based row grouping (bulletproof) ────────────────────────────────

/**
 * Group text items by Y-coordinate into row strings.
 * Filters items up-front: only items that are objects with a truthy .str
 * and a valid .transform array (length >= 6) are used.
 * Returns plain strings — downstream code never touches item arrays.
 */
function extractVisualRowStrings(rawItems: unknown[]): string[] {
  // Absolute safety: if anything is wrong with input, return empty
  if (!rawItems) return [];
  if (!Array.isArray(rawItems)) return [];
  if (rawItems.length === 0) return [];

  // Step 1: build a flat list of valid {x, y, str} entries
  // Every single item access is wrapped individually
  const valid: { x: number; y: number; str: string }[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    try {
      const item = rawItems[i];
      if (!item) continue;
      if (typeof item !== "object") continue;

      // Use optional chaining + nullish coalescing for every property
      const rec = item as Record<string, unknown>;
      const str = (rec?.str != null) ? String(rec.str) : "";
      if (!str || str.trim() === "") continue;

      const transform = rec?.transform;
      if (!transform) continue;
      if (!Array.isArray(transform)) continue;
      if (transform.length < 6) continue;

      const rawX = transform[4];
      const rawY = transform[5];
      if (rawX == null || rawY == null) continue;

      const x = Number(rawX) || 0;
      const y = Math.round(Number(rawY) || 0);
      valid.push({ x, y, str });
    } catch {
      // Skip this item entirely — never crash
      continue;
    }
  }

  if (valid.length === 0) return [];

  // Step 2: bucket by Y
  const buckets = new Map<number, { x: number; str: string }[]>();
  for (let i = 0; i < valid.length; i++) {
    try {
      const v = valid[i];
      if (!v) continue;
      const bucket = buckets.get(v.y);
      if (bucket) {
        bucket.push({ x: v.x, str: v.str });
      } else {
        buckets.set(v.y, [{ x: v.x, str: v.str }]);
      }
    } catch {
      continue;
    }
  }

  if (buckets.size === 0) return [];

  // Step 3: sort rows top→bottom, items within each row by X descending (RTL)
  const rows: string[] = [];
  try {
    const sortedKeys = [...buckets.keys()].sort((a, b) => b - a);
    for (let i = 0; i < sortedKeys.length; i++) {
      try {
        const key = sortedKeys[i];
        const spans = buckets.get(key);
        if (!spans) continue;
        if (!Array.isArray(spans)) continue;
        if (spans.length === 0) continue;

        spans.sort((a, b) => (b?.x ?? 0) - (a?.x ?? 0));

        const parts: string[] = [];
        for (let j = 0; j < spans.length; j++) {
          const s = spans[j]?.str;
          if (s) parts.push(s);
        }
        const rowStr = parts.join(" ");
        if (rowStr && rowStr.length >= 5) rows.push(rowStr);
      } catch {
        // Skip bad row — never crash
        continue;
      }
    }
  } catch {
    // If sorting itself fails, return whatever we have
  }
  return rows;
}

// ─── "Sandwich" extraction ──────────────────────────────────────────────────

/**
 * Extract the business name from a row string using the "sandwich" method:
 * everything between the date and the first numeric amount is the raw name.
 *
 * Example: "10/02/26 בזק הוראת קבע 150.00" → sandwich = "בזק הוראת קבע"
 * Then cleanBusinessName removes "הוראת קבע" → "בזק"
 */
function extractSandwich(fullRow: string, dateStr: string): string {
  if (!fullRow || !dateStr) return "";

  // Find where the date ends
  const dateIdx = fullRow.indexOf(dateStr);
  if (dateIdx < 0) return "";
  const afterDate = fullRow.substring(dateIdx + dateStr.length);
  if (!afterDate || afterDate.length < 2) return "";

  // Find the first decimal amount (possibly negative) in the remaining text
  const amountMatch = afterDate.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d{2})/);
  let middle: string;
  if (amountMatch && amountMatch.index !== undefined && amountMatch.index > 0) {
    middle = afterDate.substring(0, amountMatch.index);
  } else {
    middle = afterDate;
  }

  return cleanBusinessName(middle);
}

// ─── Post-processing sanitizer ──────────────────────────────────────────────

/**
 * Aggressive post-processing sanitizer for extracted business names.
 * Removes noise from all card companies: Isracard, MAX, and Cal.
 */
function cleanBusinessName(rawName: string): string {
  if (!rawName) return "";
  // ── Strip credit-card transaction-type prefixes ────────────────────────
  // These appear at the start of the extracted text when PDF columns merge.
  // Order matters: longer/more-specific patterns first.
  rawName = rawName.replace(/^ה\s*\.\s*קבע\s+/, "");       // "ה . קבע " / "ה. קבע "
  rawName = rawName.replace(/^הוראת\s*קבע\s+/, "");         // "הוראת קבע "
  rawName = rawName.replace(/^לא\s+הוצג\s+/, "");           // "לא הוצג "
  rawName = rawName.replace(/^תש\s*\.\s*נייד\s*/, "");      // "תש . נייד" / "תש.נייד"
  rawName = rawName.replace(/^נייד\s*\.\s*תש\s*/, "");      // reversed variant
  rawName = rawName.replace(/^אינטרנט\s+/, "");             // "אינטרנט "
  rawName = rawName.replace(/^טלפוני[ת]?\s+/, "");          // "טלפוני " / "טלפונית "
  rawName = rawName.replace(/^זיכוי\s+/, "");               // "זיכוי "
  // Remove any dates (DD/MM/YY or DD/MM/YYYY)
  rawName = rawName.replace(/\d{2}\/\d{2}\/\d{2,4}/g, "");
  // Remove currency symbols
  rawName = rawName.replace(/[\$€£₪]/g, "");
  // Remove standalone decimal numbers (amounts, exchange rates)
  rawName = rawName.replace(/\d+\.\d+/g, "");
  // Remove remaining mid-string occurrences of these tokens (any position)
  rawName = rawName.replace(/ה\s*\.\s*קבע|קבע\s*\.\s*ה|לא\s+הוצג|הוצג\s+לא|תש\s*\.\s*נייד|נייד\s*\.\s*תש|זיכוי/g, "");
  // Remove "הוראת קבע" aggressively — covers all companies, all spacing
  rawName = rawName.replace(/הוראת\s*קבע/g, "");
  rawName = rawName.replace(/קבע\s*הוראת/g, "");
  // Remove Hebrew stop-words (MAX + Isracard + Cal tx types)
  rawName = rawName.replace(/רגילה|תשלומים|פלוס|עסקה|חיוב/g, "");
  // Remove English stop-words (currency codes, stray tokens) — case-insensitive
  rawName = rawName.replace(/\b(?:ILS|USD|EUR|GBP|te)\b/gi, "");
  // Remove Isracard category suffixes
  rawName = rawName.replace(/כלי בית|בית כלי|מכולת\/סופר|מסעדות\/קפה|שונות|רכב שירותי|הלבשה|תקשורת|פארמה|מעדניות|בניה\/שיפוץ|אינט['\u05F3] קניה|ביטוח|ותיור נופש|ותיור ונופש|נופש ותיור/g, "");
  // Remove stray leading category code (e.g. "7 ", "12 ")
  rawName = rawName.replace(/^\d{1,2}\s+/, "");
  // Remove stray leading 'ל' (foreign transaction marker)
  rawName = rawName.replace(/^\s*ל\s+/, "");
  // Remove stray standalone numbers (long IDs, short codes)
  rawName = rawName.replace(/\b\d{4,}\b/g, "");
  // Trim dashes/spaces from edges, collapse multiple spaces
  rawName = rawName.replace(/^[-\s]+|[-\s]+$/g, "");
  rawName = rawName.replace(/\s{2,}/g, " ");
  return rawName;
}

async function parsePdf(file: File, userMappings?: UserMapping[]): Promise<PreviewRow[]> {
  // ── 1. Read file ───────────────────────────────────────────────────
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    console.error("[parsePdf] failed to read file as ArrayBuffer:", e);
    throw new Error("שגיאה בקריאת הקובץ. ודאו שהקובץ תקין ונסו שנית.");
  }

  // ── 2. Open PDF ────────────────────────────────────────────────────
  let pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  } catch (e) {
    console.error("[parsePdf] pdf.js getDocument failed:", e);
    throw new Error(
      "שגיאה בפענוח הקובץ. וודא שזהו קובץ פירוט אשראי תקין (ישראכרט, מקס או כאל)."
    );
  }

  // ── 3. Extract text from every page ────────────────────────────────
  //    Nuclear-safe: every operation is individually wrapped. Nothing
  //    can throw an uncaught "reading 'length' of undefined" here.
  const allRows: string[] = [];
  let firstPageText = "";

  const numPages = pdf?.numPages ?? 0;
  for (let i = 1; i <= numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      if (!page || typeof page.getTextContent !== "function") continue;

      const content = await page.getTextContent();
      // content?.items may be undefined, null, or non-array
      const items = (content as Record<string, unknown> | null)?.items;
      if (!items || !Array.isArray(items)) continue;

      // Build first-page identification string from raw items
      if (i === 1) {
        const parts: string[] = [];
        for (let j = 0; j < items.length; j++) {
          try {
            const s = safeStr(items[j]);
            if (s) parts.push(s);
          } catch { /* skip */ }
        }
        firstPageText = parts.join("");
      }

      // Group items into row strings — this function is fully guarded
      const rows = extractVisualRowStrings(items);
      for (let k = 0; k < (rows?.length ?? 0); k++) {
        if (rows[k] && typeof rows[k] === "string" && rows[k].length >= 5) {
          allRows.push(rows[k]);
        }
      }
    } catch (pageErr) {
      console.warn(`[parsePdf] failed to process page ${i}, skipping:`, pageErr);
    }
  }

  if (allRows.length === 0) {
    throw new Error(
      "שגיאה בחילוץ טקסט מה-PDF. וודא שזהו קובץ פירוט אשראי תקין (ישראכרט, מקס או כאל)."
    );
  }

  // ── 3b. Detect card company from first page text ───────────────────
  const company = detectCompanyFromText(firstPageText);

  console.log("Detected Company:", company);
  console.info(`[parsePdf] detected company: ${company}, extracted ${allRows.length} visual rows from ${numPages} pages`);

  // ── 4. Parse transaction rows using "sandwich" method ──────────────
  const results: PreviewRow[] = [];
  let skippedSummary = 0;
  let skippedErrors = 0;

  for (let r = 0; r < allRows.length; r++) {
    try {
      const fullRow = allRows[r];
      if (!fullRow || typeof fullRow !== "string" || fullRow.length < 5) continue;

      // Skip summary rows
      if (isSummaryRow(fullRow)) {
        skippedSummary++;
        continue;
      }

      // Must contain a date
      const dateMatch = fullRow.match(DATE_RE);
      if (!dateMatch) continue;
      const dateStr = dateMatch[1];

      // Must contain at least one decimal amount
      const amounts = fullRow.match(AMOUNT_RE_G);
      if (!amounts || amounts.length === 0) continue;

      // ILS charge = last amount on the row (leftmost column in RTL)
      const ilsToken = amounts[amounts.length - 1];
      const ilsAmount = parseAmount(ilsToken);
      if (ilsAmount === 0) continue;

      // Extract business name via the sandwich method
      const desc = extractSandwich(fullRow, dateStr);
      if (!desc) continue;

      // Build row with auto-classification
      results.push(buildRow(dateStr, desc, ilsAmount, userMappings));
    } catch (rowErr) {
      skippedErrors++;
      try {
        console.warn("[parsePdf] skipped row due to error:", rowErr, allRows[r]);
      } catch {
        console.warn("[parsePdf] skipped row due to error");
      }
    }
  }

  console.info(
    `[parsePdf] parsed ${results.length} transactions (${company}), skipped ${skippedSummary} summary rows, ${skippedErrors} error rows`
  );
  return results;
}

// ─── Component ──────────────────────────────────────────────────────────────

const ADD_NEW = "__add_new__";

export default function FileUploader() {
  const { categories, categoryNames, addCategory, addSubCategory } = useCategories();
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("טוען...");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mappingsRef = useRef<UserMapping[]>([]);

  // ── Inline "add new" state ──────────────────────────────────────────
  const [addingCatFor, setAddingCatFor] = useState<string | null>(null);
  const [addingSubFor, setAddingSubFor] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newSubName, setNewSubName] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // ── Duplicate detection state ─────────────────────────────────────────
  const [hashChecking, setHashChecking] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const pendingFileRef = useRef<File | null>(null);
  const pendingHashRef = useRef<string>("");

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

  // ── Load learned mappings on mount ────────────────────────────────

  useEffect(() => {
    getLearnedMappings()
      .then((m) => {
        mappingsRef.current = m;
        console.info(`[FileUploader] loaded ${m.length} learned mappings`);
      })
      .catch((err) =>
        console.warn("[FileUploader] failed to load learned mappings:", err)
      );
  }, []);

  // ── File handling ───────────────────────────────────────────────────

  /** Parse a file into preview rows (no duplicate check). */
  const parseFile = useCallback(async (file: File) => {
    setLoading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      const mappings = mappingsRef.current;
      let parsed: PreviewRow[];
      if (ext === "pdf") {
        setLoadingLabel("טוען PDF...");
        parsed = await parsePdf(file, mappings);
      } else if (
        ext === "xlsx" ||
        ext === "xls" ||
        ext === "csv"
      ) {
        setLoadingLabel("טוען גיליון...");
        parsed = await parseExcel(file, mappings);
      } else {
        throw new Error("סוג קובץ לא נתמך. יש להעלות PDF, Excel או CSV.");
      }

      if (parsed.length === 0) {
        throw new Error(
          ext === "pdf"
            ? "לא נמצאו עסקאות ב-PDF. וודא שזהו קובץ פירוט אשראי תקין (ישראכרט, מקס או כאל)."
            : "לא נמצאו עסקאות בקובץ. ודאו שהפורמט תקין."
        );
      }
      setRows(parsed);
    } catch (err) {
      console.error("[FileUploader] parseFile error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "שגיאה בפענוח הקובץ. וודא שזהו קובץ פירוט אשראי תקין (ישראכרט, מקס או כאל)."
      );
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Full handler: hash → duplicate check → parse. */
  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setSaved(false);
    setDuplicateWarning(false);
    pendingFileRef.current = null;
    pendingHashRef.current = "";

    // Step 1: calculate hash & check for duplicates
    setHashChecking(true);
    try {
      const hash = await calculateFileHash(file);
      const existing = await checkFileHash(hash);

      if (existing) {
        // Duplicate found — stash file and show warning
        pendingFileRef.current = file;
        pendingHashRef.current = hash;
        setDuplicateWarning(true);
        setHashChecking(false);
        return;
      }

      // No duplicate — proceed to parse
      pendingHashRef.current = hash;
      pendingFileRef.current = file;
      setHashChecking(false);
      await parseFile(file);
    } catch (err) {
      console.error("[FileUploader] hash check error:", err);
      // If hashing/check fails, fall through to parse anyway
      pendingFileRef.current = file;
      setHashChecking(false);
      await parseFile(file);
    }
  }, [parseFile]);

  /** User chose "Upload Anyway" after duplicate warning. */
  const handleUploadAnyway = useCallback(async () => {
    setDuplicateWarning(false);
    const file = pendingFileRef.current;
    if (!file) return;
    await parseFile(file);
  }, [parseFile]);

  /** User chose "Cancel" after duplicate warning. */
  function handleCancelDuplicate() {
    setDuplicateWarning(false);
    pendingFileRef.current = null;
    pendingHashRef.current = "";
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
    if (inputRef.current) inputRef.current.value = "";
  }

  // ── Row editing ─────────────────────────────────────────────────────

  function updateRow(tempId: string, field: string, value: string | number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r._tempId !== tempId) return r;
        const updated = { ...r, [field]: value };
        // When user manually picks a category, mark it as manual + reset sub
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

  function removeRow(tempId: string) {
    setRows((prev) => prev.filter((r) => r._tempId !== tempId));
  }

  // ── Save to Firebase ────────────────────────────────────────────────

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
      await bulkSaveTransactions(toSave);

      // Learn from every row that has a category assigned
      const mappingsToLearn = rows
        .filter((r) => r.category && r.description.trim())
        .map((r) => ({
          description: r.description.trim(),
          category: r.category,
          subCategory: r.subCategory,
        }));
      if (mappingsToLearn.length > 0) {
        await bulkSaveMappings(mappingsToLearn);
        // Update local cache so subsequent parses use new mappings immediately
        const fresh = await getLearnedMappings();
        mappingsRef.current = fresh;
        console.info(`[FileUploader] learned ${mappingsToLearn.length} new mappings`);
      }

      // Save file fingerprint so future uploads detect duplicates
      if (pendingHashRef.current && pendingFileRef.current) {
        await saveFileHash(pendingHashRef.current, pendingFileRef.current.name).catch((err) =>
          console.warn("[FileUploader] failed to save file hash:", err)
        );
      }
      pendingFileRef.current = null;
      pendingHashRef.current = "";

      setSaved(true);
      setRows([]);
    } catch {
      setError("שגיאה בשמירה ל-Firebase. נסו שוב.");
    } finally {
      setSaving(false);
    }
  }

  // ── Summary stats ───────────────────────────────────────────────────

  const learnedCount = rows.filter((r) => r._matchSource === "learned").length;
  const systemCount = rows.filter((r) => r._matchSource === "system").length;
  const manualCount = rows.filter((r) => r._matchSource === "manual").length;
  const unmatched = rows.filter((r) => r._matchSource === "none").length;
  const total = rows.reduce((sum, r) => sum + r.amount, 0);

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <section className="mb-6">
      <h2 className="text-lg font-semibold text-primary mb-3">
        העלאת דף חיוב
      </h2>

      {/* ─── Drop zone ─────────────────────────────────────────── */}
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
          ${dragging ? "border-accent bg-amber-50" : "border-slate-300 bg-white"}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.xlsx,.xls,.csv"
          onChange={onFileSelect}
          className="hidden"
        />

        {loading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <span className="text-sm text-slate-500">{loadingLabel}</span>
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
            <p className="text-xs text-slate-400">
              Excel (.xlsx / .xls) &middot; CSV &middot; PDF
            </p>
          </>
        )}
      </div>

      {/* ─── Hash checking indicator ───────────────────────────── */}
      {hashChecking && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-700">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent shrink-0" />
          וודא שאין כפילויות...
        </div>
      )}

      {/* ─── Duplicate warning ───────────────────────────────── */}
      {duplicateWarning && (
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-300 px-4 py-4">
          <p className="text-sm font-medium text-amber-800 mb-3">
            קובץ זה כבר הועלה למערכת בעבר. האם ברצונך להעלות אותו שוב?
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleUploadAnyway}
              className="rounded-lg bg-amber-500 text-white px-3 py-1.5 text-xs font-medium hover:bg-amber-600 transition-colors"
            >
              העלה בכל זאת
            </button>
            <button
              onClick={handleCancelDuplicate}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors"
            >
              בטל העלאה
            </button>
          </div>
        </div>
      )}

      {/* ─── Error ─────────────────────────────────────────────── */}
      {error && (
        <div className="mt-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ─── Success ───────────────────────────────────────────── */}
      {saved && (
        <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          העסקאות נשמרו בהצלחה!
        </div>
      )}

      {/* ─── Toast ─────────────────────────────────────────────── */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-slate-800 text-white px-4 py-2.5 text-sm shadow-lg animate-[fadeIn_0.2s_ease-out]">
          {toast}
        </div>
      )}

      {/* ─── Preview ───────────────────────────────────────────── */}
      {rows.length > 0 && (
        <div className="mt-5">
          {/* Stats bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-4 text-sm">
            <span className="font-semibold text-primary">
              {rows.length} עסקאות
            </span>
            {learnedCount > 0 && (
              <span className="text-blue-600">
                {learnedCount} מהיסטוריה
              </span>
            )}
            {systemCount > 0 && (
              <span className="text-emerald-600">
                {systemCount} זוהו אוטומטית
              </span>
            )}
            {manualCount > 0 && (
              <span className="text-violet-600">
                {manualCount} סווגו ידנית
              </span>
            )}
            {unmatched > 0 && (
              <span className="text-amber-600">
                {unmatched} לסיווג ידני
              </span>
            )}
            <span className="ms-auto font-semibold">
              סה״כ {total.toLocaleString("he-IL")} ₪
            </span>
          </div>

          {/* ── Desktop table (hidden on mobile) ─────────────── */}
          <div className="hidden md:block overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">תאריך</th>
                  <th className="px-3 py-2 text-start font-medium">בית עסק</th>
                  <th className="px-3 py-2 text-start font-medium">סכום</th>
                  <th className="px-3 py-2 text-start font-medium">סעיף</th>
                  <th className="px-3 py-2 text-start font-medium">תת סעיף</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr
                    key={row._tempId}
                    className={
                      row._matchSource === "none"
                        ? "bg-amber-50/50"
                        : row._matchSource === "learned"
                          ? "bg-blue-50/30"
                          : row._matchSource === "system"
                            ? "bg-emerald-50/30"
                            : row._matchSource === "manual"
                              ? "bg-violet-50/30"
                              : ""
                    }
                  >
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        value={row.date}
                        onChange={(e) =>
                          updateRow(row._tempId, "date", e.target.value)
                        }
                        className="w-[130px] rounded border border-slate-200 bg-transparent px-1.5 py-1 text-sm"
                        dir="ltr"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={row.description}
                        onChange={(e) =>
                          updateRow(row._tempId, "description", e.target.value)
                        }
                        className="w-full rounded border border-slate-200 bg-transparent px-1.5 py-1 text-sm"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        value={row.amount}
                        onChange={(e) =>
                          updateRow(
                            row._tempId,
                            "amount",
                            parseFloat(e.target.value) || 0
                          )
                        }
                        className={`w-[90px] rounded border border-slate-200 bg-transparent px-1.5 py-1 text-sm ${
                          row.amount < 0 ? "text-green-600 font-medium" : ""
                        }`}
                        dir="ltr"
                      />
                    </td>
                    <td className="px-3 py-2">
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
                            className="min-w-0 flex-1 rounded border border-primary bg-white px-1.5 py-1 text-sm"
                            placeholder="שם סעיף חדש..."
                            autoFocus
                          />
                          <button
                            onClick={() => handleAddCategory(row._tempId)}
                            className="shrink-0 rounded bg-primary text-white px-1.5 py-1 text-xs font-medium"
                          >
                            הוסף
                          </button>
                          <button
                            onClick={() => { setAddingCatFor(null); setNewCatName(""); }}
                            className="shrink-0 rounded border border-slate-200 px-1.5 py-1 text-xs text-slate-500"
                          >
                            ✕
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
                          className={`w-full rounded border px-1.5 py-1 text-sm ${
                            row.category === ""
                              ? "border-amber-300 bg-amber-50"
                              : "border-slate-200 bg-transparent"
                          }`}
                        >
                          <option value="">— בחרו סעיף —</option>
                          {categoryNames.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                          <option value={ADD_NEW}>＋ הוסף סעיף חדש...</option>
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2">
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
                            className="min-w-0 flex-1 rounded border border-primary bg-white px-1.5 py-1 text-sm"
                            placeholder="שם תת סעיף חדש..."
                            autoFocus
                          />
                          <button
                            onClick={() => handleAddSubCategory(row._tempId, row.category)}
                            className="shrink-0 rounded bg-primary text-white px-1.5 py-1 text-xs font-medium"
                          >
                            הוסף
                          </button>
                          <button
                            onClick={() => { setAddingSubFor(null); setNewSubName(""); }}
                            className="shrink-0 rounded border border-slate-200 px-1.5 py-1 text-xs text-slate-500"
                          >
                            ✕
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
                          className="w-full rounded border border-slate-200 bg-transparent px-1.5 py-1 text-sm"
                        >
                          <option value="">— תת סעיף —</option>
                          {(categories[row.category] ?? []).map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                          {row.category && (
                            <option value={ADD_NEW}>＋ הוסף תת סעיף...</option>
                          )}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => removeRow(row._tempId)}
                        className="text-slate-300 hover:text-danger transition-colors"
                        aria-label="הסר שורה"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-4 w-4"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Mobile cards (hidden on desktop) ─────────────── */}
          <div className="md:hidden space-y-3">
            {rows.map((row) => (
              <div
                key={row._tempId}
                className={`rounded-xl p-4 shadow-sm border ${
                  row._matchSource === "none"
                    ? "border-amber-200 bg-amber-50/40"
                    : row._matchSource === "learned"
                      ? "border-blue-200 bg-white"
                      : row._matchSource === "system"
                        ? "border-emerald-200 bg-white"
                        : row._matchSource === "manual"
                          ? "border-violet-200 bg-white"
                          : "border-slate-100 bg-white"
                }`}
              >
                {/* Top: date + amount + remove */}
                <div className="flex items-center justify-between mb-2">
                  <input
                    type="date"
                    value={row.date}
                    onChange={(e) =>
                      updateRow(row._tempId, "date", e.target.value)
                    }
                    className="w-[130px] rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
                    dir="ltr"
                  />
                  <div className="flex items-center gap-2">
                    {row._matchSource === "learned" && (
                      <span className="text-[10px] bg-blue-100 text-blue-700 font-medium px-1.5 py-0.5 rounded-full">
                        היסטוריה
                      </span>
                    )}
                    {row._matchSource === "system" && (
                      <span className="text-[10px] bg-emerald-100 text-emerald-700 font-medium px-1.5 py-0.5 rounded-full">
                        זוהה
                      </span>
                    )}
                    {row._matchSource === "manual" && (
                      <span className="text-[10px] bg-violet-100 text-violet-700 font-medium px-1.5 py-0.5 rounded-full">
                        ידני
                      </span>
                    )}
                    {row._matchSource === "none" && (
                      <span className="text-[10px] bg-amber-100 text-amber-700 font-medium px-1.5 py-0.5 rounded-full">
                        לסיווג
                      </span>
                    )}
                    <button
                      onClick={() => removeRow(row._tempId)}
                      className="text-slate-300 hover:text-danger transition-colors p-1"
                      aria-label="הסר שורה"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Description + amount */}
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={row.description}
                    onChange={(e) =>
                      updateRow(row._tempId, "description", e.target.value)
                    }
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
                    placeholder="בית עסק"
                  />
                  <div className="relative shrink-0">
                    <input
                      type="number"
                      value={row.amount}
                      onChange={(e) =>
                        updateRow(
                          row._tempId,
                          "amount",
                          parseFloat(e.target.value) || 0
                        )
                      }
                      className={`w-[90px] rounded-lg border border-slate-200 bg-slate-50 pe-6 px-2 py-1.5 text-sm ${
                        row.amount < 0 ? "text-green-600 font-medium" : ""
                      }`}
                      dir="ltr"
                    />
                    <span className="absolute end-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">
                      ₪
                    </span>
                  </div>
                </div>

                {/* Category dropdowns */}
                <div className="space-y-2">
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
                      className={`w-full rounded-lg border px-2 py-1.5 text-sm appearance-none ${
                        row.category === ""
                          ? "border-amber-300 bg-amber-50"
                          : "border-slate-200 bg-slate-50"
                      }`}
                    >
                      <option value="">— סעיף —</option>
                      {categoryNames.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                      <option value={ADD_NEW}>＋ הוסף סעיף חדש...</option>
                    </select>
                  )}

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
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm appearance-none"
                    >
                      <option value="">— תת סעיף —</option>
                      {(categories[row.category] ?? []).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                      {row.category && (
                        <option value={ADD_NEW}>＋ הוסף תת סעיף...</option>
                      )}
                    </select>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* ── Save button ──────────────────────────────────── */}
          <button
            onClick={handleSave}
            disabled={saving}
            className="
              mt-5 w-full rounded-xl bg-primary py-3 text-white font-semibold
              text-base shadow-md transition-colors
              hover:bg-primary-light active:scale-[0.98]
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          >
            {saving ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                שומר...
              </span>
            ) : (
              `שמור הכל (${rows.length} עסקאות)`
            )}
          </button>
        </div>
      )}
    </section>
  );
}
