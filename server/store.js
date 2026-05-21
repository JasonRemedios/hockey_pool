import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve("data");
const DATA_FILE = path.join(DATA_DIR, "pool.json");

const emptyStore = {
  users: [],
  sessions: [],
  tickets: [],
};

export async function readStore() {
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
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
}

export async function updateStore(updater) {
  const store = await readStore();
  const result = await updater(store);
  await writeStore(store);
  return result;
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
