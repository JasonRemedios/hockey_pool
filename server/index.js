import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import {
  createId,
  hashPassword,
  readStore,
  updateStore,
  verifyPassword,
} from "./store.js";
import { getCurrentTicketSchedule, getPreviousTicketSchedule, scoreTicket } from "./nhl.js";

const app = express();
const port = Number(process.env.PORT || 4242);
const ticketPriceCents = Number(process.env.TICKET_PRICE_CENTS || 300);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (request, response) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return response.status(400).send("Stripe webhook is not configured.");
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      request.body,
      request.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    return response.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === "checkout.session.completed") {
    await markTicketPaidForStripeSession(event.data.object.id);
  }

  response.json({ received: true });
});

app.use(express.json());

app.get("/api/schedule/current", async (_request, response) => {
  response.json(await getCurrentTicketSchedule());
});

app.get("/api/me", async (request, response) => {
  const user = await getUserFromRequest(request);
  response.json({ user: publicUser(user) });
});

app.post("/api/auth/register", async (request, response) => {
  const { name, email, password } = request.body;

  if (!name || !email || !password) {
    return response.status(400).json({ error: "Name, email, and password are required." });
  }

  if (password.length < 8) {
    return response.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const session = await updateStore(async (store) => {
    const normalizedEmail = email.trim().toLowerCase();

    if (store.users.some((user) => user.email === normalizedEmail)) {
      return null;
    }

    const user = {
      id: createId("user"),
      name: name.trim(),
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    const token = createId("session");

    store.users.push(user);
    store.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });

    return { token, user: publicUser(user) };
  });

  if (!session) {
    return response.status(409).json({ error: "An account already exists for that email." });
  }

  response.json(session);
});

app.post("/api/auth/login", async (request, response) => {
  const { email, password } = request.body;
  const store = await readStore();
  const user = store.users.find((storedUser) => storedUser.email === String(email || "").trim().toLowerCase());

  if (!user || !(await verifyPassword(password || "", user.passwordHash))) {
    return response.status(401).json({ error: "Invalid email or password." });
  }

  const session = await updateStore(async (draft) => {
    const token = createId("session");
    draft.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
    return { token, user: publicUser(user) };
  });

  response.json(session);
});

app.post("/api/tickets", requireAuth, async (request, response) => {
  const schedule = await getCurrentTicketSchedule();
  const gameIds = new Set(schedule.games.map((game) => String(game.id)));
  const firstStart = schedule.games[0]?.startTimeUTC ? new Date(schedule.games[0].startTimeUTC) : null;
  const picks = request.body.picks || {};

  if (firstStart && firstStart <= new Date()) {
    return response.status(409).json({ error: "This ticket is closed because the first game has started." });
  }

  if (!gameIds.size || gameIds.size !== Object.keys(picks).filter((gameId) => gameIds.has(gameId)).length) {
    return response.status(400).json({ error: "Please make a pick for every game on the ticket." });
  }

  const ticket = await updateStore(async (store) => {
    const newTicket = {
      id: createId("ticket"),
      userId: request.user.id,
      ticketId: schedule.ticketId,
      picks,
      status: stripe ? "pending_payment" : "paid",
      stripeSessionId: null,
      submittedAt: new Date().toISOString(),
      paidAt: stripe ? null : new Date().toISOString(),
    };

    store.tickets.push(newTicket);
    return newTicket;
  });

  response.json({
    ticket: sanitizeTicket(ticket),
    paymentRequired: Boolean(stripe),
  });
});

app.post("/api/tickets/:ticketId/checkout", requireAuth, async (request, response) => {
  const store = await readStore();
  const ticket = store.tickets.find((storedTicket) => storedTicket.id === request.params.ticketId);

  if (!ticket || ticket.userId !== request.user.id) {
    return response.status(404).json({ error: "Ticket not found." });
  }

  if (!stripe) {
    return response.json({ url: `/payment-success?ticket=${ticket.id}` });
  }

  const origin = request.headers.origin || `http://127.0.0.1:${port}`;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: ticket.id,
    customer_email: request.user.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "cad",
          unit_amount: ticketPriceCents,
          product_data: {
            name: "Trinity-Placentia Minor Hockey Pool Ticket",
          },
        },
      },
    ],
    metadata: {
      ticketId: ticket.id,
      userId: request.user.id,
    },
    success_url: `${origin}/payment-success?ticket=${ticket.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/payment-cancelled?ticket=${ticket.id}`,
  });

  await updateStore(async (draft) => {
    const draftTicket = draft.tickets.find((storedTicket) => storedTicket.id === ticket.id);
    draftTicket.stripeSessionId = session.id;
  });

  response.json({ url: session.url });
});

app.post("/api/tickets/:ticketId/verify-payment", requireAuth, async (request, response) => {
  if (!stripe) {
    return response.status(404).json({ error: "Stripe is not configured." });
  }

  const { sessionId } = request.body;
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session.client_reference_id !== request.params.ticketId || session.payment_status !== "paid") {
    return response.status(400).json({ error: "Payment has not been completed." });
  }

  const ticket = await markTicketPaidForStripeSession(session.id);
  response.json({ ticket: sanitizeTicket(ticket) });
});

app.post("/api/dev/pay/:ticketId", requireAuth, async (request, response) => {
  if (stripe) {
    return response.status(404).json({ error: "Dev payment is disabled when Stripe is configured." });
  }

  const ticket = await updateStore(async (store) => {
    const storedTicket = store.tickets.find((item) => item.id === request.params.ticketId);

    if (!storedTicket || storedTicket.userId !== request.user.id) {
      return null;
    }

    storedTicket.status = "paid";
    storedTicket.paidAt = new Date().toISOString();
    return storedTicket;
  });

  if (!ticket) {
    return response.status(404).json({ error: "Ticket not found." });
  }

  response.json({ ticket: sanitizeTicket(ticket) });
});

app.get("/api/winner/latest", async (_request, response) => {
  const schedule = await getPreviousTicketSchedule();
  const store = await readStore();
  const eligibleTickets = store.tickets.filter(
    (ticket) => ticket.ticketId === schedule.ticketId && ticket.status === "paid",
  );
  const scoredTickets = eligibleTickets
    .map((ticket) => ({
      ticket,
      score: scoreTicket(ticket, schedule.games),
      user: store.users.find((user) => user.id === ticket.userId),
    }))
    .filter((entry) => entry.score.possible > 0)
    .sort((a, b) => b.score.correct - a.score.correct);
  const bestScore = scoredTickets[0]?.score.correct;
  const winners = scoredTickets.filter((entry) => entry.score.correct === bestScore);

  response.json({
    ticketId: schedule.ticketId,
    possible: scoredTickets[0]?.score.possible || 0,
    winners: winners.map((entry) => ({
      name: entry.user?.name || "Unknown",
      correct: entry.score.correct,
      ticketId: entry.ticket.id,
    })),
  });
});

app.listen(port, () => {
  console.log(`Pool API server listening on http://127.0.0.1:${port}`);
});

async function markTicketPaidForStripeSession(sessionId) {
  return updateStore(async (store) => {
    const ticket = store.tickets.find((storedTicket) => storedTicket.stripeSessionId === sessionId);

    if (!ticket) {
      return null;
    }

    ticket.status = "paid";
    ticket.paidAt = ticket.paidAt || new Date().toISOString();
    return ticket;
  });
}

async function requireAuth(request, response, next) {
  const user = await getUserFromRequest(request);

  if (!user) {
    return response.status(401).json({ error: "Please sign in first." });
  }

  request.user = user;
  next();
}

async function getUserFromRequest(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return null;
  }

  const store = await readStore();
  const session = store.sessions.find((storedSession) => storedSession.token === token);
  const user = session ? store.users.find((storedUser) => storedUser.id === session.userId) : null;
  return user || null;
}

function publicUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

function sanitizeTicket(ticket) {
  return {
    id: ticket.id,
    ticketId: ticket.ticketId,
    status: ticket.status,
    submittedAt: ticket.submittedAt,
    paidAt: ticket.paidAt,
  };
}
