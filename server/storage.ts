import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

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
  soldCount: number;
  winnerNumber: number | null;
  createdAt: number;
  endedAt: number;
}

const DATA_DIR = join(process.cwd(), "server", "data");
const FILE_USERS = join(DATA_DIR, "users.json");
const FILE_HISTORY = join(DATA_DIR, "history.json");

function read<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function write(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

let users: Record<string, UserRecord> = read<Record<string, UserRecord>>(FILE_USERS, {});
let history: PastRaffle[] = read<PastRaffle[]>(FILE_HISTORY, []);

export function ensureUser(email: string, name: string): UserRecord {
  const key = email.trim().toLowerCase();
  let user = users[key];
  if (!user) {
    user = { email: key, name: name.trim() || key, code: crypto.randomUUID(), createdAt: Date.now(), raffles: [] };
    users[key] = user;
    persistUsers();
  } else if (name.trim() && user.name !== name.trim()) {
    user.name = name.trim();
    persistUsers();
  }
  return user;
}

/** Record a paid participation for the user. Returns the updated record. */
export function recordParticipation(email: string, name: string, p: Participation): UserRecord {
  const user = ensureUser(email, name);
  user.raffles.push(p);
  persistUsers();
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
  persistHistory();
}

export function getHistory(): PastRaffle[] {
  return history;
}

function persistUsers() {
  write(FILE_USERS, users);
}

function persistHistory() {
  write(FILE_HISTORY, history);
}
