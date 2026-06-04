import express from "express";
import path from "node:path";
import Stripe from "stripe";
import {
  createId,
  hashPassword,
  readStore,
  updateStore,
  verifyPassword,
} from "./store.js";
import { getCurrentTicketSchedule, getPreviousTicketSchedule } from "./nhl.js";
import { createTicketRecord } from "./tickets.js";
import { calculateWinners } from "./winners.js";

export function createPoolApp({
  currentTicketSchedule = getCurrentTicketSchedule,
  previousTicketSchedule = getPreviousTicketSchedule,
  stripeClient = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null,
  stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  ticketPriceCents = Number(process.env.TICKET_PRICE_CENTS || 300),
  port = Number(process.env.PORT || 4242),
  clientBuildPath = path.resolve("dist"),
} = {}) {
  const app = express();

  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (request, response) => {
    if (!stripeClient || !stripeWebhookSecret) {
      return response.status(400).send("Stripe webhook is not configured.");
    }

    let event;

    try {
      event = stripeClient.webhooks.constructEvent(
        request.body,
        request.headers["stripe-signature"],
        stripeWebhookSecret,
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

  app.get("/api/health", async (_request, response) => {
    await readStore();
    response.json({ ok: true });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    });
  });

  app.get("/api/schedule/current", async (_request, response) => {
    response.json(await currentTicketSchedule());
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
    const schedule = await currentTicketSchedule();
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
      const newTicket = createTicketRecord({
        userId: request.user.id,
        ticketId: schedule.ticketId,
        picks,
        paymentRequired: Boolean(stripeClient),
      });

      store.tickets.push(newTicket);
      return newTicket;
    });

    response.json({
      ticket: sanitizeTicket(ticket),
      paymentRequired: Boolean(stripeClient),
    });
  });

  app.post("/api/tickets/:ticketId/checkout", requireAuth, async (request, response) => {
    const store = await readStore();
    const ticket = store.tickets.find((storedTicket) => storedTicket.id === request.params.ticketId);

    if (!ticket || ticket.userId !== request.user.id) {
      return response.status(404).json({ error: "Ticket not found." });
    }

    if (!stripeClient) {
      return response.json({ url: `/payment-success?ticket=${ticket.id}` });
    }

    const origin = request.headers.origin || `http://127.0.0.1:${port}`;
    const useEmbeddedCheckout = Boolean(request.body?.embedded && process.env.STRIPE_PUBLISHABLE_KEY);
    const sessionPayload = {
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
    };

    if (useEmbeddedCheckout) {
      sessionPayload.ui_mode = "embedded";
      sessionPayload.redirect_on_completion = "never";
    } else {
      sessionPayload.success_url = `${origin}/payment-success?ticket=${ticket.id}&session_id={CHECKOUT_SESSION_ID}`;
      sessionPayload.cancel_url = `${origin}/payment-cancelled?ticket=${ticket.id}`;
    }

    const session = await stripeClient.checkout.sessions.create(sessionPayload);

    await updateStore(async (draft) => {
      const draftTicket = draft.tickets.find((storedTicket) => storedTicket.id === ticket.id);
      draftTicket.stripeSessionId = session.id;
    });

    if (useEmbeddedCheckout) {
      return response.json({
        clientSecret: session.client_secret,
        sessionId: session.id,
      });
    }

    response.json({ url: session.url });
  });

  app.post("/api/tickets/:ticketId/verify-payment", requireAuth, async (request, response) => {
    if (!stripeClient) {
      return response.status(404).json({ error: "Stripe is not configured." });
    }

    const { sessionId } = request.body;
    const session = await stripeClient.checkout.sessions.retrieve(sessionId);

    if (session.client_reference_id !== request.params.ticketId || session.payment_status !== "paid") {
      return response.status(400).json({ error: "Payment has not been completed." });
    }

    const ticket = await markTicketPaidForStripeSession(session.id);
    if (!ticket) {
      return response.status(404).json({ error: "Ticket not found for completed payment." });
    }

    response.json({ ticket: sanitizeTicket(ticket) });
  });

  app.post("/api/dev/pay/:ticketId", requireAuth, async (request, response) => {
    if (stripeClient) {
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
    const schedule = await previousTicketSchedule();
    const store = await readStore();
    response.json(calculateWinners({ tickets: store.tickets, users: store.users, schedule }));
  });

  app.use(express.static(clientBuildPath));

  app.use((request, response, next) => {
    if (request.path.startsWith("/api/")) {
      next();
      return;
    }

    response.sendFile(path.join(clientBuildPath, "index.html"));
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

  return app;
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
