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
  drawsAt: number; // draw date: the deadline draw fires here if the raffle isn't sold out first
  sold: Sale[];
  winner: { number: number; email: string; name?: string; token: string; at: number; paid?: boolean } | null;
  drawing: boolean; // true while a draw is scheduled/in progress
  sellsAt: number; // timestamp when the raffle filled up
}

const raffleDays = Number(process.env.RAFFLE_DAYS ?? 6);
// How long a raffle runs: the draw fires automatically when the raffle is sold
// out OR when this deadline is reached, whichever comes first. Overridable via
// RAFFLE_DAYS.
const RAFFLE_DURATION_MS = (Number.isFinite(raffleDays) && raffleDays > 0 ? raffleDays : 6) * 24 * 3_600_000;

const RAFFLE_KEY = "raffle:current";

let current: Raffle | null = null;
let drawTimer: ReturnType<typeof setTimeout> | null = null;
// Timer armed at the raffle's draw date (drawsAt). Re-armed whenever a raffle
// is created or loaded so the deadline draw fires even with zero further sales.
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

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
    drawsAt: Date.now() + RAFFLE_DURATION_MS,
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
  if (current) armDeadlineTimer(current);
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
  const now = Date.now();
  const r: Raffle = {
    ...emptyRaffle(),
    id: String(Math.floor(now / 1000)),
    title: input.title,
    titlePt: input.titlePt?.trim() || "",
    prize: input.prize,
    prizePt: input.prizePt?.trim() || "",
    price: input.price,
    currency: input.currency,
    ticketCount: input.ticketCount,
    createdAt: now,
    drawsAt: now + RAFFLE_DURATION_MS, // the draw date: creation + 6 days
  };
  current = r;
  persist(r);
  armDeadlineTimer(r);
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

/**
 * Commit paid numbers (already reserved) to the raffle; triggers a win when the
 * raffle is full. Returns the numbers that were actually committed: a late
 * payment (after its hold expired) may find some numbers already sold to
 * someone else, and those are silently skipped. Callers must record
 * participation with the returned subset only.
 */
export function commitSale(r: Raffle, numbers: number[], email: string, name?: string): number[] {
  const committed: number[] = [];
  const now = Date.now();
  for (const n of numbers) {
    if (r.sold.some((s) => s.number === n)) continue;
    // Never take a number another buyer currently holds — their unexpired hold
    // means they were told it was available and may still pay for it.
    const held = reserved.get(n);
    if (held && held.expiresAt >= now && held.email !== email) continue;
    r.sold.push({ number: n, email, name: name?.trim() || "", amount: r.price, at: now });
    reserved.delete(n);
    committed.push(n);
  }
  if (committed.length > 0) {
    // holds won't release reservations for these; drop reservations
    r.sold.sort((a, b) => a.number - b.number);
    persist(r);
    saveReservations();
    maybeScheduleDraw(r);
  }
  return committed;
}

export function isFull(r: Raffle): boolean {
  return r.ticketCount > 0 && r.sold.length >= r.ticketCount;
}

/** The moment this raffle's deadline draw fires if it isn't sold out first. */
export function drawDeadline(r: Raffle): number {
  return r.drawsAt && r.drawsAt > 0 ? r.drawsAt : r.createdAt + RAFFLE_DURATION_MS;
}

/** True when a draw should happen: the raffle is sold out or the draw date is reached. */
export function drawDue(r: Raffle): boolean {
  return isFull(r) || Date.now() >= drawDeadline(r);
}

function maybeScheduleDraw(r: Raffle) {
  if (r.winner || drawTimer || !drawDue(r)) return;
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

/**
 * Arm a timer that fires at the raffle's draw date (drawsAt). This is what
 * makes an unsold raffle still end on schedule — the deadline draw happens
 * even if nobody buys another ticket. Re-armed on every create/load; the old
 * timer is cleared automatically when a new raffle replaces the previous one.
 */
// Node clamps setTimeout delays above 2^31-1 ms (~24.8 days) to 1ms, which
// would fire an immediate draw for very long RAFFLE_DAYS values — so each tick
// is capped well below the limit and re-armed until the real deadline.
const MAX_TIMER_MS = 2_000_000_000; // ~23.1 days
function armDeadlineTimer(r: Raffle) {
  if (deadlineTimer) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  const remaining = drawDeadline(r) - Date.now();
  if (remaining <= 0) return; // already due — the boot/commit paths draw it
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    // only draw the raffle this timer belongs to, and only if it's still live
    if (current !== r || r.winner) return;
    if (Date.now() >= drawDeadline(r)) {
      maybeScheduleDraw(r);
    } else {
      armDeadlineTimer(r); // capped tick fired early; re-arm for the remainder
    }
  }, Math.min(remaining, MAX_TIMER_MS));
}

export function drawNow(r: Raffle) {
  if (drawTimer) {
    clearTimeout(drawTimer);
    drawTimer = null;
  }
  drawWinner(r);
}

function drawWinner(r: Raffle) {
  if (r.winner) return;
  if (r.sold.length > 0) {
    const pick = r.sold[Math.floor(Math.random() * r.sold.length)];
    r.winner = { number: pick.number, email: pick.email, name: pick.name, token: crypto.randomUUID(), at: Date.now(), paid: false };
  }
  // Even with zero sales (deadline reached, nobody bought), the raffle ends and
  // a fresh one starts; the winner stays null so nothing is notified.
  r.drawing = false;
  persist(r);
  archiveAndRestart(r);
  // The draw itself (winner picked + archived) is already complete and saved;
  // a failing notification listener must never break it.
  try {
    onDraw?.(r);
  } catch (err) {
    console.error("[raffle] draw notification callback failed", err);
  }
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
  if (announced) {
    try {
      onDraw?.(r);
    } catch (err) {
      console.error("[raffle] draw notification callback failed", err);
    }
  }
}

export function getPendingReservation(numbers: number[]) {
  return numbers.map((n) => reserved.get(n)).filter(Boolean);
}

/** Await all in-flight raffle + reservation writes (used at shutdown). */
export async function flushSaves(): Promise<void> {
  await saveQueue;
  await reservationQueue;
}