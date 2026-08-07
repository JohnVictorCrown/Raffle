import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
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

const DATA_DIR = join(process.cwd(), "server", "data");
const FILE = join(DATA_DIR, "raffle.json");

let current: Raffle | null = null;
let drawTimer: ReturnType<typeof setTimeout> | null = null;

type Drawer = (drawn: Raffle) => void;
let onDraw: Drawer | null = null;

/** Register a callback invoked right after a raffle is drawn (winner picked). */
export function onRaffleDrawn(fn: Drawer) {
  onDraw = fn;
}

// pending (reserved) numbers not yet paid — in-memory only
const reserved = new Map<number, { email: string; expiresAt: number }>();

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
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(r, null, 2));
}

export function loadRaffle(): Raffle | null {
  try {
    if (existsSync(FILE)) {
      current = JSON.parse(readFileSync(FILE, "utf-8")) as Raffle;
    }
  } catch {
    current = null;
  }
  return current ?? null;
}

export function getRaffle(): Raffle | null {
  return current ?? loadRaffle();
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
  return availableNumbers(r).includes(n);
}

/** Mark numbers as reserved so two buyers don't pick the same one. */
export function reserveNumbers(r: Raffle, numbers: number[], email: string, ttlMs = 15 * 60_000): boolean {
  for (const n of numbers) {
    if (!isAvailable(r, n)) return false;
  }
  const expiresAt = Date.now() + ttlMs;
  for (const n of numbers) reserved.set(n, { email, expiresAt });
  return true;
}

export function releaseNumbers(numbers: number[]) {
  for (const n of numbers) reserved.delete(n);
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

/** Prune expired reservations (kept on reads). */
export function pruneReservations(r: Raffle) {
  const now = Date.now();
  for (const [n, v] of reserved) {
    if (v.expiresAt < now) reserved.delete(n);
  }
  void r;
}

export function getPendingReservation(numbers: number[]) {
  return numbers.map((n) => reserved.get(n)).filter(Boolean);
}