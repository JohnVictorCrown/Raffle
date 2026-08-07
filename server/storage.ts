import crypto from "node:crypto";
import { initDb, kvGet, kvSet, kvAll } from "./db";

export interface Participation {
  raffleId: string;
  title: string;
  numbers: number[];
  amount: number;
  at: number;
}

export interface UserRecord {
  email: string;
  name: string;
  code: string;
  createdAt: number;
  raffles: Participation[];
}

export interface PastRaffle {
  id: string;
  title: string;
  prize: string;
  prizePt?: string;
  soldCount: number;
  raised?: number;
  winnerNumber: number | null;
  winner?: { number: number; email: string; name?: string; token: string; at: number; paid?: boolean } | null;
  sold?: { number: number; email: string; name: string; amount: number; at: number }[];
  createdAt: number;
  endedAt: number;
}

let users: Record<string, UserRecord> = {};
let history: PastRaffle[] = [];

// Load persisted users/history from the Turso kv table.
export async function loadStorage(): Promise<void> {
  await initDb();

  users = {};
  history = [];

  try {
    for (const row of await kvAll("user:")) {
      const key = row.key.slice("user:".length);
      users[key] = JSON.parse(row.data) as UserRecord;
    }
    for (const row of await kvAll("hist:")) {
      history.push(JSON.parse(row.data) as PastRaffle);
    }
    history.sort((a, b) => a.endedAt - b.endedAt);
  } catch (err) {
    console.error("Failed to read storage from Turso, starting fresh", err);
  }
}

/** Deterministic, stable code derived from the email (an alias for the email).
 *  The same email always maps to the same code, so a code can be recovered from
 *  an email (and email can be used directly to look up a user's history). */
export function aliasCode(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export function ensureUser(email: string, name: string): UserRecord {
  const key = email.trim().toLowerCase();
  let user = users[key];
  if (!user) {
    user = { email: key, name: name.trim() || key, code: aliasCode(key), createdAt: Date.now(), raffles: [] };
    users[key] = user;
    persistUser(key);
  } else if (name.trim() && user.name !== name.trim()) {
    user.name = name.trim();
    persistUser(key);
  }
  return user;
}

/** Record a paid participation for the user. Returns the updated record. */
export function recordParticipation(email: string, name: string, p: Participation): UserRecord {
  const user = ensureUser(email, name);
  user.raffles.push(p);
  persistUser(email.trim().toLowerCase());
  return user;
}

export function getUserByCode(code: string): UserRecord | undefined {
  for (const u of Object.values(users)) {
    if (u.code === code) return u;
  }
  return undefined;
}

export function getUserByEmail(email: string): UserRecord | undefined {
  return users[email.trim().toLowerCase()];
}

export function addToHistory(r: PastRaffle) {
  history.push(r);
  void kvSet(`hist:${r.id}`, r).catch((err) => console.error("history save failed", err));
}

export function getHistory(): PastRaffle[] {
  return history;
}

/** Find a drawn raffle (past) by its winner's claim token. */
export function findDrawnByToken(token: string): PastRaffle | undefined {
  return history.find((h) => h.winner?.token === token);
}

/** Mark the winner of a drawn raffle as paid (persisted). */
export function markWinnerPaid(token: string): boolean {
  const h = history.find((x) => x.winner?.token === token);
  if (h && h.winner) {
    h.winner.paid = true;
    void kvSet(`hist:${h.id}`, h).catch((err) => console.error("history save failed", err));
    return true;
  }
  return false;
}

function persistUser(key: string) {
  void kvSet(`user:${key}`, users[key]).catch((err) => console.error("user save failed", err));
}