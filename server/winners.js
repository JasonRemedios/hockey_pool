import { scoreTicket } from "./nhl.js";

export function calculateWinners({ tickets, users, schedule }) {
  const eligibleTickets = tickets.filter(
    (ticket) => ticket.ticketId === schedule.ticketId && ticket.status === "paid",
  );
  const scoredTickets = eligibleTickets
    .map((ticket) => ({
      ticket,
      score: scoreTicket(ticket, schedule.games),
      user: users.find((user) => user.id === ticket.userId),
    }))
    .filter((entry) => entry.score.possible > 0)
    .sort((a, b) => b.score.correct - a.score.correct);
  const bestScore = scoredTickets[0]?.score.correct;
  const winners = scoredTickets.filter((entry) => entry.score.correct === bestScore);

  return {
    ticketId: schedule.ticketId,
    possible: scoredTickets[0]?.score.possible || 0,
    winners: winners.map((entry) => ({
      name: entry.user?.name || "Unknown",
      correct: entry.score.correct,
      ticketId: entry.ticket.id,
    })),
  };
}
