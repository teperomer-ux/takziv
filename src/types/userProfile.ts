export interface UserFinancialProfile {
  banks: string[];
  creditCards: string[];
  consumerClubs: string[];
  walletsAndVouchers: string[];
}

export const DEFAULT_FINANCIAL_PROFILE: UserFinancialProfile = {
  banks: [],
  creditCards: [],
  consumerClubs: [],
  walletsAndVouchers: [],
};

// ── Typed option with ID ────────────────────────────────────────

export interface FinancialOption {
  id: string;
  name: string;
}

export interface ClubOption extends FinancialOption {
  requires: { cards?: string[]; banks?: string[] };
}

export interface WalletOption extends FinancialOption {
  requires?: { clubs: string[] };
}

// ── Banks ───────────────────────────────────────────────────────

export const BANKS: FinancialOption[] = [
  { id: "poalim", name: "בנק הפועלים" },
  { id: "leumi", name: "בנק לאומי" },
  { id: "discount", name: "בנק דיסקונט" },
  { id: "mizrahi", name: "מזרחי טפחות" },
  { id: "yahav", name: "בנק יהב" },
  { id: "beinleumi", name: "הבינלאומי" },
];

// ── Credit Cards ────────────────────────────────────────────────

export const CREDIT_CARDS: FinancialOption[] = [
  { id: "cal", name: "כאל (Cal)" },
  { id: "max", name: "מקס (Max)" },
  { id: "isracard", name: "ישראכרט" },
  { id: "amex", name: "אמריקן אקספרס" },
  { id: "diners", name: "דיינרס" },
];

// ── Consumer Clubs (with bank/card dependencies) ────────────────

export const CLUBS: ClubOption[] = [
  { id: "hever", name: "חבר", requires: { cards: ["cal", "isracard"], banks: ["beinleumi"] } },
  { id: "hitechzone", name: "הייטקזון", requires: { cards: ["cal"] } },
  { id: "beyahad", name: "ביחד בשבילך", requires: { cards: ["max"] } },
  { id: "ashmoret", name: "אשמורת", requires: { cards: ["isracard", "cal"] } },
  { id: "shotrim", name: "קרנות השוטרים", requires: { cards: ["max", "isracard"] } },
  { id: "hot_club", name: "מועדון הוֹט", requires: { cards: ["isracard"] } },
  { id: "shelach", name: "מועדון שלך", requires: { cards: ["max", "isracard"] } },
  { id: "rami_levy", name: "רמי לוי", requires: { cards: ["isracard"] } },
  { id: "shufersal", name: "שופרסל", requires: { cards: ["cal"] } },
  { id: "flycard", name: "Fly Card (אל על)", requires: { cards: ["cal", "max", "diners"] } },
  { id: "wonder", name: "פועלים Wonder", requires: { banks: ["poalim"] } },
  { id: "goodies", name: "לאומי Goodies", requires: { banks: ["leumi"] } },
  { id: "mafteach", name: "מפתח דיסקונט", requires: { banks: ["discount"] } },
  { id: "hatzdaah", name: "בהצדעה", requires: { cards: ["max", "isracard", "cal"], banks: ["leumi", "poalim", "discount", "mizrahi", "yahav", "beinleumi"] } },
];

// ── Wallets & Vouchers ──────────────────────────────────────────

export const WALLETS: WalletOption[] = [
  // Universal — always shown
  { id: "buyme", name: "BuyMe (ביימי)" },
  { id: "cibus", name: "סיבוס (Cibus)" },
  { id: "tenbis", name: "תן ביס (10bis)" },
  { id: "paybox", name: "PayBox" },
  { id: "tav_zahav", name: "תו זהב" },
  { id: "rav_tav", name: "רב-תו" },
  { id: "nofashonit", name: "נופשונית" },
  { id: "dreamcard", name: "Dream Card" },
  // Club-dependent reloadable wallets
  { id: "hever_sheli", name: "חבר שלי (נטען)", requires: { clubs: ["hever"] } },
  { id: "hatzdaah_wallet", name: "נטען בהצדעה", requires: { clubs: ["hatzdaah"] } },
  { id: "ashmoret_wallet", name: "אשמורת נטען", requires: { clubs: ["ashmoret"] } },
  { id: "zonepay", name: "ZonePay (הייטקזון)", requires: { clubs: ["hitechzone"] } },
  { id: "beyahad_wallet", name: "נטען ביחד בשבילך", requires: { clubs: ["beyahad"] } },
  { id: "shotrim_wallet", name: "נטען קרנות השוטרים", requires: { clubs: ["shotrim"] } },
  { id: "shelach_wallet", name: "נטען שלך", requires: { clubs: ["shelach"] } },
];

// ── Helpers ─────────────────────────────────────────────────────

/** Filter clubs to those matching the user's selected banks & cards. */
export function getAvailableClubs(
  selectedBankIds: string[],
  selectedCardIds: string[],
): ClubOption[] {
  return CLUBS.filter((club) => {
    const reqCards = club.requires.cards ?? [];
    const reqBanks = club.requires.banks ?? [];
    const matchesCard = reqCards.some((c) => selectedCardIds.includes(c));
    const matchesBank = reqBanks.some((b) => selectedBankIds.includes(b));
    return matchesCard || matchesBank;
  });
}

/**
 * Filter wallets: universal wallets (no `requires`) are always shown.
 * Club-dependent wallets appear only if the user selected the parent club.
 */
export function getAvailableWallets(
  selectedClubIds: string[],
): WalletOption[] {
  return WALLETS.filter((w) => {
    if (!w.requires) return true;
    return w.requires.clubs.some((c) => selectedClubIds.includes(c));
  });
}
