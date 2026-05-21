import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("store persists submitted tickets to the database file", async () => {
  const dataFile = await makeDataFile("store");
  process.env.HOCKEY_POOL_DATA_FILE = dataFile;
  const { readStore, updateStore } = await import(`../server/store.js?store=${Date.now()}`);

  const savedTicket = await updateStore((store) => {
    const ticket = {
      id: "ticket_saved",
      userId: "user_saved",
      ticketId: "20260522",
      picks: { 1: "COLORADO" },
      status: "paid",
      submittedAt: "2026-05-21T00:00:00.000Z",
      paidAt: "2026-05-21T00:00:00.000Z",
    };

    store.tickets.push(ticket);
    return ticket;
  });
  const store = await readStore();
  const rawFile = JSON.parse(await fs.readFile(dataFile, "utf8"));

  assert.equal(savedTicket.id, "ticket_saved");
  assert.deepEqual(store.tickets, [savedTicket]);
  assert.deepEqual(rawFile.tickets, [savedTicket]);
});

test("winner calculation returns every paid ticket tied for the most correct picks", async () => {
  const { calculateWinners } = await import("../server/winners.js");
  const schedule = {
    ticketId: "20260515",
    games: [
      { id: 101, winnerTeam: "BOSTON" },
      { id: 102, winnerTeam: "TORONTO" },
      { id: 103, winnerTeam: "DALLAS" },
    ],
  };
  const users = [
    { id: "user_amy", name: "Amy" },
    { id: "user_ben", name: "Ben" },
    { id: "user_cy", name: "Cy" },
  ];
  const tickets = [
    {
      id: "ticket_amy",
      userId: "user_amy",
      ticketId: "20260515",
      status: "paid",
      picks: { 101: "BOSTON", 102: "TORONTO", 103: "DALLAS" },
    },
    {
      id: "ticket_ben",
      userId: "user_ben",
      ticketId: "20260515",
      status: "paid",
      picks: { 101: "BOSTON", 102: "TORONTO", 103: "DALLAS" },
    },
    {
      id: "ticket_cy",
      userId: "user_cy",
      ticketId: "20260515",
      status: "paid",
      picks: { 101: "BOSTON", 102: "MONTREAL", 103: "DALLAS" },
    },
    {
      id: "ticket_unpaid",
      userId: "user_cy",
      ticketId: "20260515",
      status: "pending_payment",
      picks: { 101: "BOSTON", 102: "TORONTO", 103: "DALLAS" },
    },
  ];

  const result = calculateWinners({ tickets, users, schedule });

  assert.equal(result.possible, 3);
  assert.deepEqual(
    result.winners.map((winner) => winner.name),
    ["Amy", "Ben"],
  );
  assert.deepEqual(
    result.winners.map((winner) => winner.correct),
    [3, 3],
  );
});

test("ticket payment state is paid in local dev and pending when Stripe is required", async () => {
  const { createTicketRecord } = await import("../server/tickets.js");
  const picks = { 101: "BOSTON" };
  const devTicket = createTicketRecord({
    userId: "user_dev",
    ticketId: "20260522",
    picks,
    paymentRequired: false,
  });
  const stripeTicket = createTicketRecord({
    userId: "user_stripe",
    ticketId: "20260522",
    picks,
    paymentRequired: true,
  });

  assert.equal(devTicket.status, "paid");
  assert.match(devTicket.paidAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stripeTicket.status, "pending_payment");
  assert.equal(stripeTicket.paidAt, null);
});

async function makeDataFile(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `hockey-pool-${prefix}-`));
  return path.join(directory, "pool.json");
}
