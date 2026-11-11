const israelDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The Israeli calendar day of an instant, as YYYY-MM-DD (same as the server's
 * israelYmd). Stored dates are midnight either in UTC (bank sync, date
 * inputs) or in Israel (older uploads); both fall on the intended day here,
 * whereas toISOString() moves Israeli midnight back to the previous day.
 */
export function israelYmd(d: Date): string {
  return israelDate.format(d);
}

/** "2026-09-04" → "04/09/2026" (Israeli day-first order). Invalid input is returned as-is. */
export function formatDate(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : ymd;
}
