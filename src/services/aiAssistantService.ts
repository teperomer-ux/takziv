import { apiRequest } from "./bankSyncService";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** A fact from the user's data, shown as a card under the assistant's answer (see server/src/assistantTools.ts). */
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

export interface AssistantReply {
  answer: string;
  cards: AssistantCard[];
}

/** How many earlier messages go along with a question, for follow-ups like "ובחודש שעבר?". */
const HISTORY_LIMIT = 10;

/** Asks the server-side assistant; it answers from the signed-in user's own data only. */
export async function askAssistant(messages: ChatMessage[]): Promise<AssistantReply> {
  const { answer, cards } = await apiRequest<AssistantReply & { success: true }>("POST", "/api/ai/query", {
    messages: messages.slice(-HISTORY_LIMIT),
  });
  return { answer, cards: cards ?? [] };
}
