import { createId } from "./store.js";

export function createTicketRecord({ userId, ticketId, picks, paymentRequired }) {
  const now = new Date().toISOString();

  return {
    id: createId("ticket"),
    userId,
    ticketId,
    picks,
    status: paymentRequired ? "pending_payment" : "paid",
    stripeSessionId: null,
    submittedAt: now,
    paidAt: paymentRequired ? null : now,
  };
}
