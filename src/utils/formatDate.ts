/** "2026-09-04" → "04/09/2026" (Israeli day-first order). Invalid input is returned as-is. */
export function formatDate(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : ymd;
}
