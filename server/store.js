import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

const DATA_FILE = process.env.HOCKEY_POOL_DATA_FILE || path.resolve("data", "pool.json");
const DATA_DIR = path.dirname(DATA_FILE);
const DATABASE_URL = process.env.DATABASE_URL;
const usePostgres = Boolean(DATABASE_URL);
const { Pool } = pg;
const pool = usePostgres
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    })
  : null;
let postgresReady = false;

const emptyStore = {
  users: [],
  sessions: [],
  tickets: [],
};

export async function readStore() {
  if (usePostgres) {
    return readPostgresStore();
  }

  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return { ...emptyStore, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await writeStore(emptyStore);
    return structuredClone(emptyStore);
  }
}

export async function writeStore(store) {
  if (usePostgres) {
    await writePostgresStore(store);
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
}

export async function updateStore(updater) {
  if (usePostgres) {
    return updatePostgresStore(updater);
  }

  const store = await readStore();
  const result = await updater(store);
  await writeStore(store);
  return result;
}

export async function initializeStore() {
  if (usePostgres) {
    await ensurePostgres();
  } else {
    await readStore();
  }
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt);
  return `${salt}:${hash}`;
}

export async function verifyPassword(password, passwordHash) {
  const [salt, hash] = passwordHash.split(":");
  const candidate = await scrypt(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey.toString("hex"));
      }
    });
  });
}

async function ensurePostgres() {
  if (postgresReady) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL,
      picks JSONB NOT NULL,
      status TEXT NOT NULL,
      stripe_session_id TEXT,
      submitted_at TIMESTAMPTZ NOT NULL,
      paid_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS tickets_ticket_id_status_idx ON tickets(ticket_id, status);
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  `);

  postgresReady = true;
}

async function readPostgresStore(client = pool) {
  await ensurePostgres();
  const usersResult = await client.query(`
      SELECT id, name, email, password_hash AS "passwordHash", created_at AS "createdAt"
      FROM users
      ORDER BY created_at ASC
    `);
  const sessionsResult = await client.query(`
      SELECT token, user_id AS "userId", created_at AS "createdAt"
      FROM sessions
      ORDER BY created_at ASC
    `);
  const ticketsResult = await client.query(`
      SELECT
        id,
        user_id AS "userId",
        ticket_id AS "ticketId",
        picks,
        status,
        stripe_session_id AS "stripeSessionId",
        submitted_at AS "submittedAt",
        paid_at AS "paidAt"
      FROM tickets
      ORDER BY submitted_at ASC
    `);

  return {
    users: usersResult.rows.map(normalizeDates),
    sessions: sessionsResult.rows.map(normalizeDates),
    tickets: ticketsResult.rows.map(normalizeDates),
  };
}

async function writePostgresStore(store, client = pool) {
  await ensurePostgres();
  await client.query("DELETE FROM tickets");
  await client.query("DELETE FROM sessions");
  await client.query("DELETE FROM users");

  for (const user of store.users) {
    await client.query(
      `
        INSERT INTO users (id, name, email, password_hash, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [user.id, user.name, user.email, user.passwordHash, user.createdAt],
    );
  }

  for (const session of store.sessions) {
    await client.query(
      `
        INSERT INTO sessions (token, user_id, created_at)
        VALUES ($1, $2, $3)
      `,
      [session.token, session.userId, session.createdAt],
    );
  }

  for (const ticket of store.tickets) {
    await client.query(
      `
        INSERT INTO tickets (
          id, user_id, ticket_id, picks, status, stripe_session_id, submitted_at, paid_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        ticket.id,
        ticket.userId,
        ticket.ticketId,
        JSON.stringify(ticket.picks),
        ticket.status,
        ticket.stripeSessionId || null,
        ticket.submittedAt,
        ticket.paidAt || null,
      ],
    );
  }
}

async function updatePostgresStore(updater) {
  await ensurePostgres();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const store = await readPostgresStore(client);
    const result = await updater(store);
    await writePostgresStore(store, client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function normalizeDates(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}
