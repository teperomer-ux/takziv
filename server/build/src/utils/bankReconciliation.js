// ─── Bank ↔ credit-card reconciliation ───────────────────────────────────────
// Helpers for matching credit-card charge rows inside a bank (עו״ש) statement
// and comparing the per-provider aggregate against the detailed credit-card
// files so the same money is never counted twice.
/** Hebrew display label for every transaction source — used by the UI badge. */
export const SOURCE_LABELS = {
    max: "מקס",
    isracard: "ישראכרט",
    cal: "כאל",
    bank: "בנק",
};
// JS regex `\b` is defined on \w characters (ASCII) — Hebrew letters fall in
// \W, so `\bמקס\b` would NOT match "חיוב מקס". For the Hebrew patterns we
// therefore drop \b and rely on the explicit context tokens (חיוב / כרטיס /
// איט / לאומי קארד) as the gate instead. For the English patterns \b works
// normally and prevents "MAX" from matching inside "MAXIMA" / "CLIMAX" /
// "MAXIMUS".
const CC_COMPANY_PATTERNS = [
    {
        source: "max",
        patterns: [
            /מקס\s*איט/, // "מקס איט" / "מקס איט פי" / "מקס איט פיננסים"
            /\bMAX\s*IT\b/i, // "MAX IT" / "MAX IT FINANCIAL"
            /לאומי\s+קארד/, // legacy pre-rebrand label
            /\bLEUMI\s*CARD\b/i,
            /חיוב.{0,30}מקס/, // "חיוב … מקס"
            /מקס.{0,30}חיוב/, // "מקס … חיוב"
            /כרטיס.{0,30}מקס/, // "כרטיס … מקס"
            /מקס.{0,30}כרטיס/,
        ],
    },
    {
        source: "isracard",
        patterns: [
            // "ישראכרט" is a coined word — no overlap with normal Hebrew business names.
            /ישראכרט/,
            /\bISRACARD\b/i,
        ],
    },
    {
        source: "cal",
        patterns: [
            /כא[״"׳']ל/, // dotted spelling "כא״ל" / "כא"ל" — CAL's signature label
            /\bCAL[\s-]*ONLINE\b/i,
            /\bCAL[\s-]+(?:VISA|MASTERCARD|CARD)\b/i,
            /ויזה\s+כאל/,
            /חיוב.{0,30}כאל/, // "חיוב … כאל"
            /כאל.{0,30}חיוב/, // "כאל … חיוב"
            /חברה\s+לאשראי.{0,30}כאל/,
            /כאל.{0,30}חברה\s+לאשראי/,
        ],
    },
];
/**
 * Resolve a bank-statement description to a credit-card provider slug, or
 * null when the row is not a credit-card BILL payment. Keys returned here
 * align with `Transaction.source` so callers can compare against tagged CC
 * rows without an extra lookup.
 *
 * Contract: this function answers "is this row the monthly lump-sum payment
 * to a CC issuer?" — NOT "does this description mention a card name?". The
 * distinction is what keeps a "MAXIMA" supermarket charge from disappearing
 * out of the user's bank-statement expenses.
 */
export function matchCreditCardCompany(description) {
    if (!description)
        return null;
    for (const { source, patterns } of CC_COMPANY_PATTERNS) {
        if (patterns.some((p) => p.test(description)))
            return source;
    }
    return null;
}
/** Gaps at or below this many NIS are treated as rounding noise and ignored. */
export const GAP_THRESHOLD_NIS = 1;
/**
 * Compare per-provider bank charges against the detailed credit-card totals
 * for the same month. Returns one entry per provider whose gap exceeds the
 * rounding threshold — i.e. only the discrepancies worth warning about.
 *
 * Both sides are keyed by the provider slug ("max" | "isracard" | "cal").
 * A provider present on either side is included in the scan so a missing
 * upload (zero on one side, a real number on the other) still surfaces.
 */
export function reconcileCreditCards(bankCcCharges, detailedSumsByCompany) {
    const providers = new Set([
        ...Object.keys(bankCcCharges),
        ...Object.keys(detailedSumsByCompany),
    ]);
    const results = [];
    for (const source of providers) {
        const bankSum = bankCcCharges[source] ?? 0;
        const detailedSum = detailedSumsByCompany[source] ?? 0;
        const gap = Math.abs(bankSum - detailedSum);
        if (gap <= GAP_THRESHOLD_NIS)
            continue;
        results.push({
            source,
            company: SOURCE_LABELS[source],
            bankSum,
            detailedSum,
            gap,
        });
    }
    return results;
}
/** Format a NIS amount with thousands separators and exactly 2 decimals. */
export function formatNis(amount) {
    return amount.toLocaleString("he-IL", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}
/** Build the Hebrew discrepancy message for a reconciliation result. */
export function formatReconciliationMessage(r) {
    return (`חיוב ${r.company} בעובר ושב הוא ${formatNis(r.bankSum)} ₪, ` +
        `אך הפירוט בכרטיס מסתכם ב-${formatNis(r.detailedSum)} ₪ ` +
        `(פער של ${formatNis(r.gap)} ₪).`);
}
