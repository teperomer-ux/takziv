import type { TransactionSource } from "../types";

export type LoginField = "userCode" | "username" | "id" | "password" | "num" | "card6Digits";

export interface Institution {
  id: string; // israeli-bank-scrapers companyId
  label: string;
  /** Two-letter mark shown in place of a logo. */
  mark: string;
  kind: "bank" | "card";
  /** Source slug the sync tags this provider's expenses with. */
  source: TransactionSource;
  fields: LoginField[];
}

// Field lists mirror SCRAPERS[companyId].loginFields in israeli-bank-scrapers.
export const INSTITUTIONS: Institution[] = [
  { id: "hapoalim", label: "בנק הפועלים", mark: "פע", kind: "bank", source: "bank", fields: ["userCode", "password"] },
  { id: "leumi", label: "בנק לאומי", mark: "לא", kind: "bank", source: "bank", fields: ["username", "password"] },
  { id: "discount", label: "בנק דיסקונט", mark: "די", kind: "bank", source: "bank", fields: ["id", "password", "num"] },
  { id: "mizrahi", label: "בנק מזרחי טפחות", mark: "מז", kind: "bank", source: "bank", fields: ["username", "password"] },
  { id: "max", label: "מקס", mark: "מק", kind: "card", source: "max", fields: ["username", "password"] },
  { id: "isracard", label: "ישראכרט", mark: "יש", kind: "card", source: "isracard", fields: ["id", "card6Digits", "password"] },
  { id: "visaCal", label: "כאל", mark: "כא", kind: "card", source: "cal", fields: ["username", "password"] },
];

export function findInstitution(companyId: string): Institution | undefined {
  return INSTITUTIONS.find((i) => i.id === companyId);
}

export function institutionLabel(companyId: string): string {
  return findInstitution(companyId)?.label ?? companyId;
}
