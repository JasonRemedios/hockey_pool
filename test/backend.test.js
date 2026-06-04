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

test("account, database, and payment APIs work together", async () => {
  const dataFile = await makeDataFile("api");
  const schedule = makeFutureSchedule();
  delete process.env.DATABASE_URL;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  process.env.HOCKEY_POOL_DATA_FILE = dataFile;

  const [{ createPoolApp }, { initializeStore, readStore }] = await Promise.all([
    import("../server/app.js"),
    import("../server/store.js"),
  ]);

  await initializeStore();
  const devServer = await startTestServer(
    createPoolApp({
      currentTicketSchedule: async () => schedule,
      previousTicketSchedule: async () => ({ ticketId: "20990521", games: [] }),
      stripeClient: null,
    }),
  );

  try {
    const health = await apiRequest(devServer.url, "/api/health");
    assert.equal(health.ok, true);

    const registered = await apiRequest(devServer.url, "/api/auth/register", {
      method: "POST",
      body: { name: "  Jamie  ", email: "JAMIE@example.COM ", password: "secret123" },
    });

    assert.match(registered.token, /^session_/);
    assert.equal(registered.user.name, "Jamie");
    assert.equal(registered.user.email, "jamie@example.com");
    assert.equal(registered.user.passwordHash, undefined);

    await assert.rejects(
      () =>
        apiRequest(devServer.url, "/api/auth/register", {
          method: "POST",
          body: { name: "Jamie", email: "jamie@example.com", password: "secret123" },
        }),
      { status: 409 },
    );

    const loggedIn = await apiRequest(devServer.url, "/api/auth/login", {
      method: "POST",
      body: { email: "jamie@example.com", password: "secret123" },
    });
    const me = await apiRequest(devServer.url, "/api/me", { token: loggedIn.token });

    assert.equal(me.user.email, "jamie@example.com");
    await assert.rejects(() => apiRequest(devServer.url, "/api/tickets", { method: "POST", body: { picks: {} } }), {
      status: 401,
    });

    const submitted = await apiRequest(devServer.url, "/api/tickets", {
      method: "POST",
      token: loggedIn.token,
      body: { picks: { 101: "BOSTON", 102: "TORONTO" } },
    });

    assert.equal(submitted.paymentRequired, false);
    assert.equal(submitted.ticket.status, "paid");

    const checkout = await apiRequest(devServer.url, `/api/tickets/${submitted.ticket.id}/checkout`, {
      method: "POST",
      token: loggedIn.token,
    });
    assert.equal(checkout.url, `/payment-success?ticket=${submitted.ticket.id}`);

    const persisted = await readStore();
    assert.equal(persisted.users.length, 1);
    assert.equal(persisted.sessions.length, 2);
    assert.equal(persisted.tickets[0].status, "paid");
  } finally {
    await devServer.close();
  }

  const stripeSession = {
    id: "cs_test_123",
    url: "https://checkout.stripe.test/pay/cs_test_123",
    client_secret: "cs_test_123_secret_abc",
    client_reference_id: null,
    payment_status: "paid",
  };
  const stripeSessionPayloads = [];
  const stripeClient = {
    checkout: {
      sessions: {
        create: async (payload) => {
          stripeSessionPayloads.push(payload);
          stripeSession.client_reference_id = payload.client_reference_id;
          return stripeSession;
        },
        retrieve: async () => stripeSession,
      },
    },
    webhooks: {
      constructEvent: () => ({ type: "checkout.session.completed", data: { object: stripeSession } }),
    },
  };
  const stripeServer = await startTestServer(
    createPoolApp({
      currentTicketSchedule: async () => schedule,
      previousTicketSchedule: async () => ({ ticketId: "20990521", games: [] }),
      stripeClient,
    }),
  );

  try {
    const loggedIn = await apiRequest(stripeServer.url, "/api/auth/login", {
      method: "POST",
      body: { email: "jamie@example.com", password: "secret123" },
    });
    const submitted = await apiRequest(stripeServer.url, "/api/tickets", {
      method: "POST",
      token: loggedIn.token,
      body: { picks: { 101: "BOSTON", 102: "TORONTO" } },
    });

    assert.equal(submitted.paymentRequired, true);
    assert.equal(submitted.ticket.status, "pending_payment");

    const checkout = await apiRequest(stripeServer.url, `/api/tickets/${submitted.ticket.id}/checkout`, {
      method: "POST",
      token: loggedIn.token,
    });
    assert.equal(checkout.url, stripeSession.url);
    assert.equal(stripeSessionPayloads.at(-1).ui_mode, undefined);
    assert.match(stripeSessionPayloads.at(-1).success_url, /payment-success/);

    const verified = await apiRequest(stripeServer.url, `/api/tickets/${submitted.ticket.id}/verify-payment`, {
      method: "POST",
      token: loggedIn.token,
      body: { sessionId: stripeSession.id },
    });

    assert.equal(verified.ticket.status, "paid");
    assert.match(verified.ticket.paidAt, /^\d{4}-\d{2}-\d{2}T/);

    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_embedded";
    const embeddedTicket = await apiRequest(stripeServer.url, "/api/tickets", {
      method: "POST",
      token: loggedIn.token,
      body: { picks: { 101: "BOSTON", 102: "TORONTO" } },
    });
    const embeddedCheckout = await apiRequest(stripeServer.url, `/api/tickets/${embeddedTicket.ticket.id}/checkout`, {
      method: "POST",
      token: loggedIn.token,
      body: { embedded: true },
    });

    assert.equal(embeddedCheckout.clientSecret, stripeSession.client_secret);
    assert.equal(embeddedCheckout.sessionId, stripeSession.id);
    assert.equal(stripeSessionPayloads.at(-1).ui_mode, "embedded_page");
    assert.equal(stripeSessionPayloads.at(-1).redirect_on_completion, "never");
    assert.equal(stripeSessionPayloads.at(-1).success_url, undefined);
  } finally {
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    await stripeServer.close();
  }
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

function makeFutureSchedule() {
  return {
    ticketId: "20990522",
    days: [
      {
        date: "2099-05-22",
        label: "Friday, May 22",
        games: [
          {
            id: 101,
            awayTeam: "BOSTON",
            homeTeam: "MONTREAL",
            startTimeUTC: "2099-05-22T23:00:00Z",
          },
          {
            id: 102,
            awayTeam: "TORONTO",
            homeTeam: "OTTAWA",
            startTimeUTC: "2099-05-23T00:00:00Z",
          },
        ],
      },
    ],
    games: [
      {
        id: 101,
        awayTeam: "BOSTON",
        homeTeam: "MONTREAL",
        startTimeUTC: "2099-05-22T23:00:00Z",
      },
      {
        id: 102,
        awayTeam: "TORONTO",
        homeTeam: "OTTAWA",
        startTimeUTC: "2099-05-23T00:00:00Z",
      },
    ],
  };
}

async function startTestServer(app) {
  const server = await new Promise((resolve) => {
    const startedServer = app.listen(0, "127.0.0.1", () => resolve(startedServer));
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function apiRequest(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    throw error;
  }

  return data;
}
