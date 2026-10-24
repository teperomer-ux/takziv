import { z } from "zod";
import type { UserFinanceData } from "./financeData.js";
import {
  availableMonths,
  categoryTotals,
  filterRows,
  largestRows,
  monthSummary,
  resolveCategories,
  totals,
  type FinanceRow,
  type RowFilter,
} from "./financeQueries.js";

/**
 * The data tools the AI assistant may call. They only read the signed-in
 * user's own rows (loaded once per request) — there is no web or other
 * outside source, so whatever the assistant answers comes from here.
 */

/** A display-ready fact the app renders under the assistant's answer. */
export type AssistantCard =
  | {
      type: "transaction";
      kind: "expense" | "income";
      date: string;
      description: string;
      amount: number;
      category: string;
      subCategory: string;
      account: "bank" | "card";
      excluded: boolean;
    }
  | { type: "total"; label: string; amount: number; kind?: "expense" | "income"; detail?: string };

export interface ToolOutcome {
  /** Sent back to the model as the tool result. */
  result: unknown;
  cards: AssistantCard[];
}

const HEBREW_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

/** "2026-04" → "אפריל 2026" */
export function monthLabel(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${HEBREW_MONTHS[m - 1] ?? month} ${y}`;
}

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe("YYYY-MM");
const kind = z.enum(["expense", "income"]).describe("expense = הוצאה, income = הכנסה");
const range = {
  month: month.optional().describe("A single month, YYYY-MM"),
  from_month: month.optional().describe("Start of a range of months, YYYY-MM, inclusive"),
  to_month: month.optional().describe("End of a range of months, YYYY-MM, inclusive"),
  account: z
    .enum(["bank", "card"])
    .optional()
    .describe("Expenses only: bank = paid from the עו״ש checking account, card = credit card. Omit for both."),
  date_basis: z
    .enum(["billing", "purchase"])
    .default("billing")
    .describe("Which month a card expense falls in: billing = the month it is charged (as the app shows it), purchase = the month it was bought"),
};

const SCHEMAS = {
  list_available_months: z.object({}),
  get_month_summary: z.object({ month, date_basis: range.date_basis }),
  get_category_totals: z.object({
    kind,
    ...range,
    include_excluded: z.boolean().default(false).describe("Also list internal transfers (העברות פנימיות)"),
  }),
  get_largest_transactions: z.object({
    kind,
    ...range,
    category: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(20).default(5),
    include_excluded: z.boolean().default(false).describe("Also consider internal transfers (העברות פנימיות)"),
  }),
  search_transactions: z.object({
    kind: kind.optional(),
    ...range,
    category: z.string().max(80).optional().describe("Category name, e.g. מזון or העברות פנימיות"),
    text: z.string().max(80).optional().describe("Part of the transaction description, e.g. a business name"),
    min_amount: z.number().optional(),
    max_amount: z.number().optional(),
    include_excluded: z.boolean().default(true),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  list_categories: z.object({ kind }),
} as const;

type ToolName = keyof typeof SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  list_available_months:
    "Lists the months that have data, newest first, with the number of expenses and incomes in each. Use it to resolve 'last month' or to check whether a month has data at all.",
  get_month_summary:
    "Totals for one month: spending (split into עו״ש bank debits and credit cards), income, balance, top expense categories, and internal transfers kept out of the totals.",
  get_category_totals:
    "Total and count per category and sub-category, largest first, for a month or a range of months.",
  get_largest_transactions:
    "The largest expenses or incomes by amount, optionally within a category or account.",
  search_transactions:
    "Finds transactions by category, description text, amount range, month or account. Returns the count, the sum, and up to `limit` rows.",
  list_categories: "The user's category and sub-category names, to match a category the user mentions.",
};

/** Tool definitions in JSON Schema, for the model provider. */
export const ASSISTANT_TOOLS = (Object.keys(SCHEMAS) as ToolName[]).map((name) => {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(SCHEMAS[name], { io: "input" });
  return { name, description: DESCRIPTIONS[name], inputSchema };
});

function rangeFilter(args: {
  month?: string;
  from_month?: string;
  to_month?: string;
  account?: "bank" | "card";
  date_basis: "billing" | "purchase";
}): RowFilter {
  return {
    month: args.month,
    fromMonth: args.from_month,
    toMonth: args.to_month,
    account: args.account,
    byPurchaseDate: args.date_basis === "purchase",
  };
}

function describeRange(args: { month?: string; from_month?: string; to_month?: string; date_basis?: string }) {
  if (args.month) return `${monthLabel(args.month)}${args.date_basis === "purchase" ? " (לפי תאריך רכישה)" : ""}`;
  if (args.from_month || args.to_month) {
    return `${args.from_month ? monthLabel(args.from_month) : "ההתחלה"} – ${args.to_month ? monthLabel(args.to_month) : "היום"}`;
  }
  return "כל התקופה";
}

/** A row as the model sees it. */
function forModel(r: FinanceRow) {
  return {
    kind: r.kind,
    date: r.date,
    month: r.month,
    description: r.description,
    amount: r.amount,
    category: r.category || null,
    subCategory: r.subCategory || null,
    account: r.account,
    ...(r.provider && { provider: r.provider }),
    ...(r.excluded && { internalTransfer: true }),
  };
}

function transactionCard(r: FinanceRow): AssistantCard {
  return {
    type: "transaction",
    kind: r.kind,
    date: r.date,
    description: r.description,
    amount: r.amount,
    category: r.category,
    subCategory: r.subCategory,
    account: r.account,
    excluded: r.excluded,
  };
}

const KIND_LABEL = { expense: "הוצאות", income: "הכנסות" } as const;

function run(name: ToolName, args: never, data: UserFinanceData): ToolOutcome {
  const { rows } = data;
  switch (name) {
    case "list_available_months":
      return { result: { months: availableMonths(rows) }, cards: [] };

    case "get_month_summary": {
      const a = args as z.output<(typeof SCHEMAS)["get_month_summary"]>;
      const summary = monthSummary(rows, a.month, a.date_basis === "purchase");
      if (!summary.expenses.count && !summary.incomes.count) {
        return { result: { month: a.month, noData: true }, cards: [] };
      }
      const label = describeRange(a);
      const transfers = summary.expenses.excluded + summary.incomes.excluded;
      return {
        result: summary,
        cards: [
          { type: "total", kind: "expense", label: `הוצאות — ${label}`, amount: summary.expenses.counted, detail: `עו״ש ${summary.expenses.bank.toLocaleString("he-IL")} ₪ · אשראי ${summary.expenses.card.toLocaleString("he-IL")} ₪` },
          { type: "total", kind: "income", label: `הכנסה שוטפת — ${label}`, amount: summary.incomes.counted },
          ...(transfers
            ? [{ type: "total" as const, label: "העברות פנימיות (לא נספרו)", amount: transfers }]
            : []),
        ],
      };
    }

    case "get_category_totals": {
      const a = args as z.output<(typeof SCHEMAS)["get_category_totals"]>;
      const matched = filterRows(rows, { ...rangeFilter(a), kind: a.kind, includeExcluded: a.include_excluded });
      const byCategory = categoryTotals(matched);
      return {
        result: { range: describeRange(a), kind: a.kind, totals: totals(matched), categories: byCategory },
        cards: byCategory.slice(0, 3).map((c) => ({
          type: "total",
          kind: a.kind,
          label: c.category || "ללא קטגוריה",
          amount: c.total,
          detail: `${describeRange(a)} · ${c.count} תנועות`,
        })),
      };
    }

    case "get_largest_transactions": {
      const a = args as z.output<(typeof SCHEMAS)["get_largest_transactions"]>;
      const filter = { ...rangeFilter(a), kind: a.kind, category: a.category, includeExcluded: a.include_excluded };
      const top = largestRows(filterRows(rows, filter), a.limit);
      return {
        result: {
          range: describeRange(a),
          kind: a.kind,
          ...(a.category && { matchedCategories: [...resolveCategories(rows, a.category)] }),
          transactions: top.map(forModel),
        },
        cards: top.slice(0, 5).map(transactionCard),
      };
    }

    case "search_transactions": {
      const a = args as z.output<(typeof SCHEMAS)["search_transactions"]>;
      const matched = filterRows(rows, {
        ...rangeFilter(a),
        kind: a.kind,
        category: a.category,
        text: a.text,
        minAmount: a.min_amount,
        maxAmount: a.max_amount,
        includeExcluded: a.include_excluded,
      });
      const newest = [...matched].sort((x, y) => y.date.localeCompare(x.date));
      const sum = totals(matched);
      return {
        result: {
          range: describeRange(a),
          ...(a.category && { matchedCategories: [...resolveCategories(rows, a.category)] }),
          totals: sum,
          transactions: newest.slice(0, a.limit).map(forModel),
          truncated: matched.length > a.limit,
        },
        cards: matched.length
          ? [
              {
                type: "total",
                ...(a.kind && { kind: a.kind }),
                label: `${a.kind ? KIND_LABEL[a.kind] : "תנועות"} — ${describeRange(a)}`,
                amount: roundTotal(sum),
                detail: `${matched.length} תנועות${a.category ? ` · ${a.category}` : ""}${a.text ? ` · "${a.text}"` : ""}`,
              },
              ...newest.slice(0, 5).map(transactionCard),
            ]
          : [],
      };
    }

    case "list_categories": {
      const a = args as z.output<(typeof SCHEMAS)["list_categories"]>;
      return { result: { kind: a.kind, categories: data.categories[a.kind] }, cards: [] };
    }
  }
}

/** Sum of every matched row, transfers included, since a search reports what it found. */
function roundTotal(t: { counted: number; excluded: number }) {
  return Math.round((t.counted + t.excluded) * 100) / 100;
}

/** Runs one tool call; bad names or arguments come back as an error for the model to correct. */
export function executeTool(name: string, rawArgs: unknown, data: UserFinanceData): ToolOutcome {
  if (!(name in SCHEMAS)) return { result: { error: `Unknown tool ${name}` }, cards: [] };
  const parsed = SCHEMAS[name as ToolName].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { result: { error: "Invalid arguments", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, cards: [] };
  }
  return run(name as ToolName, parsed.data as never, data);
}
