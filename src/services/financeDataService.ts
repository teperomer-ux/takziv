import { collection, getDocs, type DocumentData, type Timestamp } from "firebase/firestore";
import { db, getUid } from "../lib/firebase";
import {
  EXPENSE_EXCLUDE_FIELD,
  INCOME_EXCLUDE_FIELD,
  readExcludeFlag,
  withDefaultExclusion,
} from "../utils/internalTransfers";
import type { FinanceRow, RowKind } from "../utils/financeQueries";

/** The signed-in user's rows for the AI assistant (client port of server/src/financeData.ts). */
export interface UserFinanceData {
  rows: FinanceRow[];
  /** Category → sub-categories, as set up in the app. */
  categories: Record<RowKind, Record<string, string[]>>;
}

/** Category docs → names and the set excluded from the totals (same rules as the app's hooks). */
function readCategories(docs: { id: string; data: DocumentData }[], excludeField: string) {
  const names: Record<string, string[]> = {};
  const flagged: string[] = [];
  for (const { id, data } of docs) {
    names[id] = Array.isArray(data.subCategories) ? data.subCategories.map(String) : [];
    if (readExcludeFlag(id, data[excludeField])) flagged.push(id);
  }
  return { names, excluded: withDefaultExclusion(names, flagged) };
}

/** Maps a stored doc to a FinanceRow, deriving the month the way the app's lists do. */
function toFinanceRow(kind: RowKind, data: DocumentData, excluded: ReadonlySet<string>): FinanceRow {
  const date = (data.date as Timestamp | undefined)?.toDate?.().toISOString().slice(0, 10) ?? "";
  const category = String(data.category ?? "");
  const billing =
    kind === "expense" && data.billingYear && data.billingMonth
      ? `${data.billingYear}-${String(data.billingMonth).padStart(2, "0")}`
      : date.slice(0, 7);
  const source = typeof data.source === "string" ? data.source : undefined;
  return {
    kind,
    date,
    month: billing,
    description: String(data.description ?? ""),
    amount: Number(data.amount ?? 0),
    category,
    subCategory: String(data.subCategory ?? ""),
    account: kind === "income" || source === "bank" ? "bank" : "card",
    ...(kind === "expense" && source && source !== "bank" && { provider: source }),
    excluded: category !== "" && excluded.has(category),
  };
}

/** Reads every transaction and income of the signed-in user (read-only, under users/{uid}). */
export async function loadUserFinanceData(): Promise<UserFinanceData> {
  const uid = getUid();
  const [expenses, incomes, expenseCats, incomeCats] = await Promise.all(
    ["transactions", "incomeTransactions", "categories", "incomeCategories"].map((c) =>
      getDocs(collection(db, "users", uid, c)),
    ),
  );
  const docs = (s: typeof expenses) => s.docs.map((d) => ({ id: d.id, data: d.data() }));
  const expenseCategories = readCategories(docs(expenseCats), EXPENSE_EXCLUDE_FIELD);
  const incomeCategories = readCategories(docs(incomeCats), INCOME_EXCLUDE_FIELD);

  return {
    rows: [
      ...expenses.docs.map((d) => toFinanceRow("expense", d.data(), expenseCategories.excluded)),
      ...incomes.docs.map((d) => toFinanceRow("income", d.data(), incomeCategories.excluded)),
    ].filter((r) => r.date),
    categories: { expense: expenseCategories.names, income: incomeCategories.names },
  };
}
