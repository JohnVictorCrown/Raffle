import crypto from "node:crypto";
import { kvGet, kvSet } from "./db";
import { addToHistory } from "./storage";

export interface Sale {
  number: number;
  email: string;
  name: string;
  amount: number;
  at: number;
}

export interface Raffle {
  id: string;
  title: string;
  titlePt: string;
  prize: string;
  prizePt: string;
  price: number;
  currency: string;
  ticketCount: number;
  createdAt: number;
  sold: Sale[];
  winner: { number: number; email: string; name?: string; token: string; at: number; paid?: boolean } | null;
  drawing: boolean; // true while a draw is scheduled/in progress
  sellsAt: number; // timestamp when the raffle filled up
}

const RAFFLE_KEY = "raffle:current";

let current: Raffle | null = null;
let drawTimer: ReturnType<typeof setTimeout> | null = null;

type Drawer = (drawn: Raffle) => void;
let onDraw: Drawer | null = null;

/** Register a callback invoked right after a raffle is drawn (winner picked). */
export function onRaffleDrawn(fn: Drawer) {
  onDraw = fn;
}

// pending (reserved) numbers not yet paid — persisted to Turso so they survive restarts
const reserved = new Map<number, { email: string; expiresAt: number }>();
const RESERVATIONS_KEY = "raffle:reservations";

let reservationQueue: Promise<void> = Promise.resolve();
function saveReservations() {
  reservationQueue = reservationQueue
    .then(() => kvSet(RESERVATIONS_KEY, Object.fromEntries(reserved)))
    .catch((err) => console.error("reservations save failed", err));
}

export async function loadReservations(): Promise<void> {
  try {
    const row = await kvGet(RESERVATIONS_KEY);
    if (row) {
      const data = JSON.parse(row) as Record<string, { email: string; expiresAt: number }>;
      reserved.clear();
      for (const [k, v] of Object.entries(data)) reserved.set(Number(k), v);
    }
  } catch (err) {
    console.error("Failed to load reservations", err);
  }
  pruneReservations();
}

function emptyRaffle(): Raffle {
  return {
    id: String(Math.floor(Date.now() / 1000)),
    title: "",
    titlePt: "",
    prize: "",
    prizePt: "",
    price: 0,
    currency: "BRL",
    ticketCount: 0,
    createdAt: Date.now(),
    sold: [],
    winner: null,
    drawing: false,
    sellsAt: 0,
  };
}

export function persist(r: Raffle) {
  // Serialize writes to the single raffle key: the drawn raffle is immediately
  // replaced by an empty clone (archiveAndRestart), so ordering must be exact.
  saveQueue = saveQueue
    .then(() => kvSet(RAFFLE_KEY, r))
    .catch((err) => console.error("raffle save failed", err));
}

let saveQueue: Promise<void> = Promise.resolve();

// Load the current raffle from Turso.
export async function loadRaffleFromDb(): Promise<Raffle | null> {
  current = null;
  try {
    const row = await kvGet(RAFFLE_KEY);
    if (row) current = JSON.parse(row) as Raffle;
  } catch (err) {
    console.error("Failed to read raffle from Turso", err);
  }
  return current;
}

export function getRaffle(): Raffle | null {
  return current;
}

/** Replace the current (single) raffle, wiping sales/winner. */
export function createRaffle(input: {
  title: string;
  titlePt?: string;
  prize: string;
  prizePt?: string;
  price: number;
  currency: string;
  ticketCount: number;
}): Raffle {
  reserved.clear();
  const r: Raffle = {
    ...emptyRaffle(),
    id: String(Math.floor(Date.now() / 1000)),
    title: input.title,
    titlePt: input.titlePt?.trim() || "",
    prize: input.prize,
    prizePt: input.prizePt?.trim() || "",
    price: input.price,
    currency: input.currency,
    ticketCount: input.ticketCount,
  };
  current = r;
  persist(r);
  return r;
}

/** Numbers that are still available to buy (not sold, not reserved). */
export function availableNumbers(r: Raffle): number[] {
  const sold = new Set(r.sold.map((s) => s.number));
  const held = new Set(reserved.keys());
  const out: number[] = [];
  for (let n = 1; n <= r.ticketCount; n++) {
    if (!sold.has(n) && !held.has(n)) out.push(n);
  }
  return out;
}

export function availableCount(r: Raffle): number {
  return availableNumbers(r).length;
}

export function isAvailable(r: Raffle, n: number): boolean {
  if (r.sold.some((s) => s.number === n)) return false;
  const held = reserved.get(n);
  return !held || held.expiresAt < Date.now();
}

/**
 * Mark numbers as reserved so two buyers don't pick the same one. A number
 * already held by the SAME email (or whose hold has expired) is considered
 * available again, so an abandoned or failed attempt never bricks a buyer out
 * of re-picking their own numbers. The hold TTL is refreshed on re-reserve.
 */
export function reserveNumbers(r: Raffle, numbers: number[], email: string, ttlMs = 15 * 60_000): boolean {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  for (const n of numbers) {
    if (r.sold.some((s) => s.number === n)) return false;
    const held = reserved.get(n);
    if (held && held.expiresAt >= now && held.email !== email) return false;
  }
  for (const n of numbers) reserved.set(n, { email, expiresAt });
  saveReservations();
  return true;
}

export function releaseNumbers(numbers: number[]) {
  for (const n of numbers) reserved.delete(n);
  saveReservations();
}

/** Commit paid numbers (already reserved) to the raffle; triggers a win when the raffle is full. */
export function commitSale(r: Raffle, numbers: number[], email: string, name?: string) {
  let changed = false;
  for (const n of numbers) {
    if (r.sold.some((s) => s.number === n)) continue;
    r.sold.push({ number: n, email, name: name?.trim() || "", amount: r.price, at: Date.now() });
    reserved.delete(n);
    changed = true;
  }
  if (changed) {
    // holds won't release reservations for these; drop reservations
    r.sold.sort((a, b) => a.number - b.number);
    persist(r);
    saveReservations();
    maybeScheduleDraw(r);
  }
}

export function isFull(r: Raffle): boolean {
  return r.ticketCount > 0 && r.sold.length >= r.ticketCount;
}

function maybeScheduleDraw(r: Raffle) {
  if (!isFull(r) || r.winner || drawTimer) return;
  r.drawing = true;
  r.sellsAt = Date.now();
  persist(r);
  // pick a "truly random" delay between 15 and 60 seconds
  const delay = 15_000 + Math.floor(Math.random() * 45_000);
  drawTimer = setTimeout(() => {
    drawWinner(r);
    drawTimer = null;
  }, delay);
}

export function drawNow(r: Raffle) {
  if (drawTimer) {
    clearTimeout(drawTimer);
    drawTimer = null;
  }
  drawWinner(r);
}

function drawWinner(r: Raffle) {
  if (!r.sold.length || r.winner) return;
  const pick = r.sold[Math.floor(Math.random() * r.sold.length)];
  r.winner = { number: pick.number, email: pick.email, name: pick.name, token: crypto.randomUUID(), at: Date.now(), paid: false };
  r.drawing = false;
  persist(r);
  archiveAndRestart(r);
  onDraw?.(r);
}

/**
 * Archive the drawn raffle (full snapshot, winner + sales) into history, then
 * start a brand-new empty raffle that clones the drawn one's settings.
 */
function archiveAndRestart(r: Raffle) {
  addToHistory({
    id: r.id,
    title: r.title,
    prize: r.prize,
    prizePt: r.prizePt,
    soldCount: r.sold.length,
    raised: Math.round(r.sold.reduce((a, s) => a + s.amount, 0) * 100) / 100,
    winnerNumber: r.winner?.number ?? null,
    winner: r.winner,
    sold: r.sold.map((s) => ({ number: s.number, email: s.email, name: s.name, amount: s.amount, at: s.at })),
    createdAt: r.createdAt,
    endedAt: Date.now(),
  });
  createRaffle({
    title: r.title,
    titlePt: r.titlePt,
    prize: r.prize,
    prizePt: r.prizePt,
    price: r.price,
    currency: r.currency,
    ticketCount: r.ticketCount,
  });
}

/** Prune expired reservations and persist the result. */
export function pruneReservations() {
  const now = Date.now();
  let changed = false;
  for (const [n, v] of reserved) {
    if (v.expiresAt < now) {
      reserved.delete(n);
      changed = true;
    }
  }
  if (changed) saveReservations();
}

/**
 * Archive the active raffle when the admin replaces it with a new one. If it
 * has sales but no winner yet, a winner is drawn first so the sold numbers are
 * honored instead of silently discarded.
 */
export function archiveCurrentForAdmin(r: Raffle): void {
  let announced = false;
  if (r.sold.length > 0) {
    if (!r.winner) {
      const pick = r.sold[Math.floor(Math.random() * r.sold.length)];
      r.winner = {
        number: pick.number,
        email: pick.email,
        name: pick.name,
        token: crypto.randomUUID(),
        at: Date.now(),
        paid: false,
      };
      r.drawing = false;
      announced = true;
    }
    persist(r);
  }
  if (r.sold.length === 0 && !r.winner) return;
  addToHistory({
    id: r.id,
    title: r.title,
    prize: r.prize,
    prizePt: r.prizePt,
    soldCount: r.sold.length,
    raised: Math.round(r.sold.reduce((a, s) => a + s.amount, 0) * 100) / 100,
    winnerNumber: r.winner?.number ?? null,
    winner: r.winner,
    sold: r.sold.map((s) => ({ number: s.number, email: s.email, name: s.name, amount: s.amount, at: s.at })),
    createdAt: r.createdAt,
    endedAt: Date.now(),
  });
  if (announced) onDraw?.(r);
}

export function getPendingReservation(numbers: number[]) {
  return numbers.map((n) => reserved.get(n)).filter(Boolean);
}

/** Await all in-flight raffle + reservation writes (used at shutdown). */
export async function flushSaves(): Promise<void> {
  await saveQueue;
  await reservationQueue;
}