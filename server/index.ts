import { createPixOrder, getPaymentStatusById, processPixPayout, refundPixPayment } from "./payments";
import { WebhookSignatureValidator } from "mercadopago";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  getRaffle,
  createRaffle,
  reserveNumbers,
  releaseNumbers,
  commitSale,
  availableCount,
  pruneReservations,
  drawNow,
  drawDue,
  drawDeadline,
  persist,
  onRaffleDrawn,
  loadRaffleFromDb,
  loadReservations,
  flushSaves,
  archiveCurrentForAdmin,
  type Raffle,
} from "./raffle";
import { sendWinnerEmail, prizeClaimPath, sendParticipationEmail, sendResultEmail, myRafflesPath } from "./email";
import { runStartupChecks } from "./startup-checks";
import {
  recordParticipation,
  getUserByCode,
  getUserByEmail,
  addToHistory,
  getHistory,
  findDrawnByToken,
  markWinnerPaid,
  loadStorage,
  type PastRaffle,
  type UserRecord,
} from "./storage";
import { db, kvSet, kvAll, kvDelete, flushDb } from "./db";

const PORT = Number(process.env.PORT ?? 3001);

const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface PendingOrder {
  extRef: string;
  paymentId: string;
  raffleId: string;
  numbers: number[];
  email: string;
  name: string;
  amount: number;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired" | "refunded";
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
}

// How long a PIX order may stay pending before it is considered abandoned
// (holds released, order reaped). Longer than the 15-min reservation hold so a
// slow payer isn't cut off mid-payment; overridable via ORDER_TTL_MINUTES.
const ttlMinutes = Number(process.env.ORDER_TTL_MINUTES ?? 30);
const ORDER_TTL_MS = Math.max(5 * 60_000, (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 30) * 60_000);

// Final statuses that never need a refund: the payment was fulfilled
// (approved) or no money moved (rejected/cancelled/refunded). Used to keep
// in-memory `orders` bounded and to ignore duplicate/retried notifications for
// payments we already handled.
const FULFILLED: ReadonlySet<PendingOrder["status"]> = new Set(["approved", "rejected", "cancelled", "refunded"]);

// orders keyed by external_reference and by payment id
const orders = new Map<string, PendingOrder>();

// Payment ids already resolved (fulfilled or refunded). Late or duplicate
// webhooks/polls for these are no-ops instead of double-committing/refunding.
const settled = new Set<string>();

// Pending orders are persisted to Turso so an approved webhook is still
// registered even after a restart, and re-indexed in memory on boot.
async function saveOrder(p: PendingOrder) {
  try {
    await kvSet(`order:${p.paymentId}`, p);
  } catch (err) {
    console.error("order save failed", err);
  }
}

/**
 * Finalize an order: remove it from memory, keep a tombstone in Turso so a
 * late/duplicate notification still knows the outcome, and record fulfilled
 * payments in `settled`. "expired" is deliberately NOT settled: an approved
 * payment for an expired order must still reach the orphan-refund path.
 */
async function resolveOrder(p: PendingOrder, status: PendingOrder["status"]) {
  p.status = status;
  p.resolvedAt = Date.now();
  orders.delete(p.extRef);
  orders.delete(p.paymentId);
  if (FULFILLED.has(status)) settled.add(p.paymentId);
  try {
    await kvSet(`order:${p.paymentId}`, p);
  } catch (err) {
    console.error("order save failed", err);
  }
}

async function loadOrders() {
  orders.clear();
  settled.clear();
  try {
    for (const row of await kvAll("order:")) {
      const p = JSON.parse(row.data) as PendingOrder;
      if (p.status === "pending") {
        orders.set(p.extRef, p);
        orders.set(p.paymentId, p);
      } else if (FULFILLED.has(p.status)) {
        settled.add(p.paymentId);
      }
      // "expired" tombstones are intentionally ignored: a late approval for
      // them must still reach the orphan-refund path after a restart.
    }
    console.log(`Loaded ${orders.size / 2} pending order(s) from Turso (+${settled.size} settled)`);
  } catch (err) {
    console.error("Failed to load pending orders", err);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function readBody(req: Request): Promise<Record<string, any>> {
  return req.json().then((v) => (v ?? {}) as Record<string, any>).catch(() => ({}));
}

/**
 * Public base URL for links in emails (participation / winner / result).
 * Resolution order: HOST (frontend domain) → CORS_ORIGIN (frontend
 * origin, used as a fallback) → http://localhost:3000 (local dev only).
 * Ensures a production deploy with HOST unset never emails localhost
 * links when CORS_ORIGIN is configured.
 */
function publicBase(): string {
  const host = (process.env.HOST ?? "").trim();
  if (host) return `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  const origin = (process.env.CORS_ORIGIN ?? "").trim();
  if (origin && origin !== "*") return origin.replace(/\/+$/, "");
  return "http://localhost:3000";
}

function findPendingByPaymentId(paymentId: string): PendingOrder | undefined {
  for (const o of orders.values()) {
    if (o.paymentId === paymentId) return o;
  }
  return undefined;
}

function publicRaffle(lang: string) {
  const r = getRaffle();
  if (!r) return null;
  pruneReservations();
  const pt = lang === "pt";
  return {
    id: r.id,
    title: pt && r.titlePt ? r.titlePt : r.title,
    prize: pt && r.prizePt ? r.prizePt : r.prize,
    price: r.price,
    currency: r.currency,
    ticketCount: r.ticketCount,
    available: availableCount(r),
    soldNumbers: r.sold.map((s) => s.number),
    soldCount: r.sold.length,
    prizeAmount: Math.round(r.ticketCount * r.price * 0.7 * 100) / 100,
    winner: r.winner
      ? { number: r.winner.number, email: r.winner.email, at: r.winner.at }
      : null,
    drawing: r.drawing,
    drawDate: drawDeadline(r),
    exists: true,
    claimPath: r.winner ? prizeClaimPath(r.title, r.winner.token) : null,
  };
}

const notifiedRaffles = new Set<string>();

// ---------------------------------------------------------------------------
// Durable draw notifications: winner + result emails with backoff retries.
// Progress is persisted per email (`sent` flags) under `notif:` keys so a
// crash/restart resumes exactly where it left off instead of going silent or
// double-sending. After NOTIF_MAX_ATTEMPTS a batch is abandoned and logged
// loudly for manual action.
// ---------------------------------------------------------------------------

interface NotifEmailState {
  email: string;
  name: string;
  kind: "winner" | "result";
  won: boolean;
  url: string;
  sent: boolean;
}

interface PendingNotif {
  token: string; // winner claim token — also the dedupe key
  raffleTitle: string;
  winnerName: string;
  winnerNumber: number;
  payout: number;
  withdrawUrl: string;
  emails: NotifEmailState[];
  createdAt: number;
  attempts: number;
}

const NOTIF_MAX_ATTEMPTS = 6;
const NOTIF_BASE_DELAY_MS = 30_000; // backoff: 30s, 2m, 8m, 32m, ~2h

function notifDelay(attempt: number): number {
  return NOTIF_BASE_DELAY_MS * Math.pow(4, attempt - 1);
}

const dispatchingNotifs = new Set<string>();

async function saveNotif(n: PendingNotif) {
  try {
    await kvSet(`notif:${n.token}`, n);
  } catch (err) {
    console.error("notif save failed", err);
  }
}

async function deleteNotif(token: string) {
  try {
    await kvDelete(`notif:${token}`);
  } catch (err) {
    console.error("notif delete failed", err);
  }
}

/** Send one notification email (winner/result) for a raffle. Never throws. */
async function sendNotifEmail(n: PendingNotif, e: NotifEmailState): Promise<boolean> {
  try {
    if (e.kind === "winner") {
      return await sendWinnerEmail({
        email: e.email,
        name: e.name,
        raffleTitle: n.raffleTitle,
        amount: n.payout,
        withdrawUrl: n.withdrawUrl,
      });
    }
    return await sendResultEmail({
      email: e.email,
      name: e.name,
      raffleTitle: n.raffleTitle,
      won: e.won,
      winnerName: n.winnerName,
      winnerNumber: n.winnerNumber,
      resultUrl: e.url,
    });
  } catch (err: any) {
    console.error(`[notif] ${e.kind} email to ${e.email} threw:`, err?.message ?? err);
    return false;
  }
}

/**
 * Deliver a draw's notification emails with exponential backoff. Only unsent
 * emails are re-attempted, so retries never duplicate already-delivered mail.
 */
function dispatchNotif(n: PendingNotif) {
  if (dispatchingNotifs.has(n.token)) return;
  dispatchingNotifs.add(n.token);

  const runBatch = async () => {
    n.attempts += 1;
    for (const e of n.emails) {
      if (e.sent) continue;
      const ok = await sendNotifEmail(n, e);
      if (ok) {
        e.sent = true;
        console.log(`[notif] ${e.kind} email sent -> ${e.email}`);
        // Persist immediately so a crash mid-batch can't re-send this email.
        await saveNotif(n);
      } else {
        console.warn(
          `[notif] ${e.kind} email to ${e.email} failed (attempt ${n.attempts}/${NOTIF_MAX_ATTEMPTS}) for raffle "${n.raffleTitle}"`
        );
      }
    }
    await saveNotif(n);

    const pending = n.emails.filter((e) => !e.sent);
    if (pending.length === 0) {
      console.log(`[notif] all ${n.emails.length} notification email(s) delivered for raffle "${n.raffleTitle}"`);
      dispatchingNotifs.delete(n.token);
      void deleteNotif(n.token);
      return;
    }
    if (n.attempts >= NOTIF_MAX_ATTEMPTS) {
      console.error(
        `[notif] GAVE UP after ${n.attempts} attempts for raffle "${n.raffleTitle}" — still pending: ` +
          pending.map((e) => `${e.kind}<${e.email}>`).join(", ") +
          ". MANUAL ACTION REQUIRED."
      );
      dispatchingNotifs.delete(n.token);
      return;
    }
    const delay = notifDelay(n.attempts);
    console.warn(`[notif] ${pending.length} email(s) pending for raffle "${n.raffleTitle}" — retrying in ${Math.round(delay / 1000)}s`);
    setTimeout(() => void runBatch(), delay);
  };

  void runBatch();
}

/** Resume persisted notification batches after a restart. */
async function loadPendingNotifs() {
  try {
    let loaded = 0;
    for (const row of await kvAll("notif:")) {
      const n = JSON.parse(row.data) as PendingNotif;
      const pending = n.emails.filter((e) => !e.sent);
      if (pending.length === 0) {
        await deleteNotif(n.token); // stale fully-sent record
      } else if (n.attempts < NOTIF_MAX_ATTEMPTS) {
        loaded += 1;
        dispatchNotif(n); // resume exactly where it left off
      } else {
        console.error(
          `[notif] abandoned notification for raffle "${n.raffleTitle}" (${pending.length} email(s) unsent) needs manual attention`
        );
        // Prune abandoned records older than 30 days so they don't accumulate.
        if (Date.now() - n.createdAt > 30 * 24 * 3_600_000) {
          await deleteNotif(n.token);
        }
      }
    }
    console.log(`Loaded ${loaded} pending notification(s) from Turso`);
  } catch (err) {
    console.error("Failed to load pending notifications", err);
  }
}

/** Fire-and-forget email with backoff retries (transactional emails like the
 *  participation confirmation). No persistence, but loud on failure. */
function retryEmail(job: () => Promise<boolean>, what: string) {
  let attempts = 0;
  const run = () => {
    attempts += 1;
    Promise.resolve()
      .then(job)
      .then((ok) => {
        if (ok) return;
        if (attempts >= NOTIF_MAX_ATTEMPTS) {
          console.error(`[email] GAVE UP: ${what} after ${attempts} attempts — MANUAL ACTION REQUIRED`);
          return;
        }
        const delay = notifDelay(attempts);
        console.warn(`[email] ${what} failed (attempt ${attempts}/${NOTIF_MAX_ATTEMPTS}) — retrying in ${Math.round(delay / 1000)}s`);
        setTimeout(run, delay);
      })
      .catch((err: any) => {
        console.error(`[email] ${what} threw:`, err?.message ?? err);
        if (attempts >= NOTIF_MAX_ATTEMPTS) {
          console.error(`[email] GAVE UP: ${what} after ${attempts} attempts — MANUAL ACTION REQUIRED`);
          return;
        }
        const delay = notifDelay(attempts);
        setTimeout(run, delay);
      });
  };
  run();
}

function notifyRaffleEnded(r: Raffle) {
  if (!r?.winner || notifiedRaffles.has(r.winner.token)) return;
  notifiedRaffles.add(r.winner.token);

  const raised = r.sold.reduce((a, s) => a + s.amount, 0);
  const payout = Math.round(raised * 0.7 * 100) / 100;
  const winnerNum = r.winner.number;
  const winnerUser = getUserByEmail(r.winner.email);
  const winnerName = winnerUser?.name || r.winner.name || r.winner.email;

  const base = publicBase();
  const withdrawUrl = `${base}${prizeClaimPath(r.title, r.winner.token)}`;

  const emails: NotifEmailState[] = [
    {
      email: r.winner.email,
      name: winnerName,
      kind: "winner",
      won: true,
      url: withdrawUrl,
      sent: false,
    },
  ];

  // Result to every participant (winner + everyone else).
  const seen = new Set<string>();
  for (const sale of r.sold) {
    if (seen.has(sale.email)) continue;
    seen.add(sale.email);
    const user = getUserByEmail(sale.email);
    const isWinner = sale.email === r.winner.email;
    emails.push({
      email: sale.email,
      name: user?.name || sale.name,
      kind: "result",
      won: isWinner,
      url: isWinner ? withdrawUrl : `${base}${myRafflesPath(user?.code ?? "")}`,
      sent: false,
    });
  }

  const notif: PendingNotif = {
    token: r.winner.token,
    raffleTitle: r.title,
    winnerName,
    winnerNumber: winnerNum,
    payout,
    withdrawUrl,
    emails,
    createdAt: Date.now(),
    attempts: 0,
  };
  void saveNotif(notif).then(() => dispatchNotif(notif));
}

// When a raffle is drawn it is immediately archived and replaced by a fresh
// empty clone; notifications must therefore use the archived snapshot.
onRaffleDrawn((drawn) => {
  notifyRaffleEnded(drawn);
});

// Commit sold numbers once a payment is approved. Idempotent: the guard on
// pending.status ensures webhook + client polling can't double-commit. An
// approval that can no longer be fulfilled (raffle replaced, or every number
// sold to someone else while pending) issues a refund instead of letting the
// buyer pay for nothing.
function onApproved(extRef: string) {
  const pending = orders.get(extRef);
  if (!pending || pending.status === "approved") return;
  pending.status = "approved";
  const r = getRaffle();
  let refunded = false;
  if (r && r.id === pending.raffleId) {
    // commitSale only commits numbers still unsold — a late payment may have
    // lost some to other buyers, so the returned subset is the truth.
    const committed = commitSale(r, pending.numbers, pending.email, pending.name);
    if (committed.length > 0) {
      const missing = pending.numbers.length - committed.length;
      if (missing > 0) {
        // Under-fulfillment: some numbers were sold to other buyers while this
        // payment was pending — refund what they paid for the ones they lost.
        const refundAmount = Math.round(r.price * missing * 100) / 100;
        console.warn(
          `Payment ${pending.paymentId} under-fulfilled (${committed.length}/${pending.numbers.length} numbers) — refunding ${refundAmount}`
        );
        void refundPixPayment(pending.paymentId, refundAmount);
      }
      const user = recordParticipation(pending.email, pending.name, {
        raffleId: r.id,
        title: r.title,
        numbers: committed,
        amount: pending.amount,
        at: Date.now(),
      });
      retryEmail(
        () =>
          sendParticipationEmail({
            email: user.email,
            name: user.name,
            raffleTitle: r.title,
            drawDate: drawDeadline(r),
            myRafflesUrl: `${publicBase()}${myRafflesPath(user.code)}`,
          }),
        `participation email to ${user.email}`
      );
    } else {
      console.warn(
        `Approved payment ${pending.paymentId} has no available numbers (sold while pending) — refunding`
      );
      void refundPixPayment(pending.paymentId);
      refunded = true;
    }
  } else {
    console.warn(
      `Approved payment ${pending.paymentId} has no matching active raffle (${pending.raffleId}) — refunding`
    );
    void refundPixPayment(pending.paymentId);
    refunded = true;
  }
  void resolveOrder(pending, refunded ? "refunded" : "approved");
}

// A payment that was rejected/cancelled releases its reserved numbers.
function onRejected(paymentId: string) {
  const pending = findPendingByPaymentId(paymentId);
  if (!pending) return;
  releaseNumbers(pending.numbers);
  void resolveOrder(pending, "rejected");
}

// A pending order past its TTL is abandoned: release the holds and drop the
// order. If the buyer pays afterwards, the orphan-approval path refunds them.
function expireOrder(p: PendingOrder) {
  console.warn(`Order ${p.paymentId} expired (${p.numbers.length} hold(s) released)`);
  releaseNumbers(p.numbers);
  void resolveOrder(p, "expired");
}

// An approved payment with no active order: either its order expired (reaped)
// or it was never created by us. Either way it can't be fulfilled, so refund
// it — unless it is already settled (a duplicate notification for a payment we
// already handled).
async function handleOrphanApproved(paymentId: string) {
  if (settled.has(paymentId)) return;
  settled.add(paymentId); // guard against concurrent webhook + poll double-refund
  console.warn(`Approved payment ${paymentId} has no active order — refunding (cannot fulfill)`);
  const res = await refundPixPayment(paymentId);
  if (!res.ok) {
    console.error(`[refund] MANUAL ACTION REQUIRED: payment ${paymentId} could not be refunded (${res.error}).`);
  }
  try {
    await kvSet(`order:${paymentId}`, { paymentId, status: "refunded", resolvedAt: Date.now() });
  } catch (err) {
    console.error("order save failed", err);
  }
}

// Re-check every pending order against Mercado Pago. This is the safety net for
// webhooks that never arrive (missed/delayed), so approved/rejected payments
// are still settled promptly. Also acts as the TTL reaper: a pending order
// past its expiry is dropped and its holds released.
let lastOrderPrune = 0;
async function reconcileOrders() {
  const seen = new Set<string>();
  const expired: PendingOrder[] = [];
  for (const p of orders.values()) {
    if (seen.has(p.paymentId)) continue;
    seen.add(p.paymentId);
    if (p.status !== "pending") continue;
    try {
      const status = await getPaymentStatusById(p.paymentId);
      if (status === "approved") {
        onApproved(p.extRef);
        continue;
      }
      if (status === "rejected" || status === "cancelled") {
        onRejected(p.paymentId);
        continue;
      }
    } catch (err) {
      console.error(`Reconcile failed for payment ${p.paymentId}:`, err);
    }
    const deadline = p.expiresAt ?? p.createdAt + ORDER_TTL_MS;
    if (deadline <= Date.now()) expired.push(p);
  }
  for (const p of expired) expireOrder(p);
  void maybePruneResolvedOrders();
}

// Drop old resolved-order tombstones from Turso so the boot scan stays small.
// Runs at most every 6 hours. `settled` is left intact so duplicate
// notifications within this process still no-op.
async function maybePruneResolvedOrders() {
  if (Date.now() - lastOrderPrune < 6 * 3_600_000) return;
  lastOrderPrune = Date.now();
  try {
    const cutoff = Date.now() - 30 * 24 * 3_600_000;
    for (const row of await kvAll("order:")) {
      const p = JSON.parse(row.data) as PendingOrder;
      if (p.status !== "pending" && (p.resolvedAt ?? 0) < cutoff) {
        await kvDelete(`order:${p.paymentId}`);
      }
    }
  } catch (err) {
    console.error("failed to prune resolved orders", err);
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      let dbOk = true;
      try {
        await db.execute("SELECT 1");
      } catch {
        dbOk = false;
      }
      const r = getRaffle();
      return json({
        ok: true,
        hasToken: !!process.env.MP_TOKEN,
        db: dbOk,
        raffleId: r?.id ?? null,
        pendingOrders: orders.size / 2,
        inFlightNotifications: dispatchingNotifs.size,
      });
    }

    // Public: current raffle (single raffle only)
    if (req.method === "GET" && url.pathname === "/api/raffle") {
      return json({ raffle: publicRaffle(url.searchParams.get("lang") ?? "en") });
    }

    // Public: "My raffles" — code (alias) or email-actuated login
    if (req.method === "GET" && url.pathname === "/api/me") {
      const code = url.searchParams.get("code") ?? "";
      const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();

      let user: UserRecord | undefined;
      if (email) {
        user = getUserByEmail(email);
        if (!user) {
          // Email is an alias for the code: an email with no participations yet
          // still yields an (empty) result so the page doesn't 404.
          return json({ ok: true, user: { name: email, email, raffles: [] } });
        }
      } else if (code) {
        user = getUserByCode(code);
        if (!user) return json({ error: "invalid or expired link" }, 404);
      } else {
        return json({ error: "missing code or email" }, 400);
      }

      const current = getRaffle();
      const history = getHistory();
      const raffles = user.raffles.map((p) => {
        let winnerNumber: number | null = null;
        let ended = false;
        if (current && current.id === p.raffleId) {
          winnerNumber = current.winner?.number ?? null;
          ended = !!current.winner;
        } else {
          const past = history.find((h) => h.id === p.raffleId);
          if (past) {
            winnerNumber = past.winnerNumber;
            ended = true;
          }
        }
        return {
          raffleId: p.raffleId,
          title: p.title,
          numbers: p.numbers,
          amount: p.amount,
          at: p.at,
          winnerNumber,
          won: winnerNumber !== null && p.numbers.includes(winnerNumber),
          ended,
        };
      });

      return json({ ok: true, user: { name: user.name, email: user.email, raffles } });
    }

    // Public: claim a prize with the token from the winner email
    if (req.method === "GET" && url.pathname.startsWith("/api/claim/")) {
      const token = url.searchParams.get("token");
      const r = getRaffle();
      if (r?.winner && r.winner.token === token) {
        const raised = r.sold.reduce((a, s) => a + s.amount, 0);
        return json({
          ok: true,
          number: r.winner.number,
          prize: r.prize,
          raffleTitle: r.title,
          payout: Math.round(raised * 0.7 * 100) / 100,
          paid: !!r.winner.paid,
        });
      }
      const past = token ? findDrawnByToken(token) : undefined;
      if (past && past.winner) {
        return json({
          ok: true,
          number: past.winner.number,
          prize: past.prize,
          raffleTitle: past.title,
          payout: Math.round((past.raised ?? past.soldCount * 0) * 0.7 * 100) / 100,
          paid: !!past.winner.paid,
        });
      }
      return json({ error: "invalid or expired link" }, 404);
    }

    // Public: withdraw the prize via PIX (winner token + PIX key)
    if (req.method === "POST" && url.pathname === "/api/withdraw") {
      const body = await readBody(req);
      const { token, pixKey, pixKeyType } = body as {
        token?: string;
        pixKey?: string;
        pixKeyType?: "email" | "cpf" | "phone" | "random";
      };
      if (!token || !pixKey || !pixKeyType) {
        return json({ error: "token, pixKey and pixKeyType are required" }, 400);
      }
      const r = getRaffle();
      const drawn =
        r && r.winner && r.winner.token === token
          ? r
          : findDrawnByToken(token) ?? null;
      if (!drawn?.winner || drawn.winner.token !== token) {
        return json({ error: "invalid or expired link" }, 404);
      }
      if (drawn.winner.paid) return json({ ok: true, alreadyPaid: true });

      const raised =
        drawn === r
          ? r.sold.reduce((a, s) => a + s.amount, 0)
          : ((drawn as PastRaffle).raised ?? 0);
      const payout = Math.round(raised * 0.7 * 100) / 100;
      if (payout <= 0) return json({ error: "no funds to pay out" }, 400);

      const result = await processPixPayout({
        transactionAmount: payout,
        pixKey,
        pixKeyType,
        description: `Rifa payout: ${drawn.title}`,
      });
      if (!result.ok) {
        return json({ ok: false, error: result.error ?? "Payout failed" }, 502);
      }
      if (drawn === r) {
        drawn.winner.paid = true;
        persist(r);
      } else {
        markWinnerPaid(token);
      }
      return json({ ok: true, payoutId: result.id, status: result.status });
    }

    // Admin: create / replace the single raffle
    if (req.method === "POST" && url.pathname === "/api/admin/raffle") {
      const body = await readBody(req);
      const adminPass = process.env.ADMIN_PASSWORD ?? "admin";
      if (!body.password || body.password !== adminPass) {
        return json({ error: "wrong password" }, 401);
      }
      const { title, titlePt, prize, prizePt, price, currency = "BRL", ticketCount } = body;
      if (!title || !prize || typeof price !== "number" || price <= 0 || typeof ticketCount !== "number" || ticketCount < 1) {
        return json({ error: "invalid raffle data" }, 400);
      }
      const prev = getRaffle();
      if (prev) archiveCurrentForAdmin(prev);
      const r = createRaffle({ title, titlePt, prize, prizePt, price, currency, ticketCount });
      return json({ ok: true, raffle: { id: r.id, title: r.title } });
    }

    // Create a PIX payment (Transparent Checkout) and hold it pending
    if (req.method === "POST" && url.pathname === "/api/payments") {
      const body = await readBody(req);
      const { email, numbers, name } = body as { email?: string; numbers?: number[]; name?: string };

      if (!email || !Array.isArray(numbers) || numbers.length === 0) {
        return json({ error: "email and numbers[] are required" }, 400);
      }

      const r = getRaffle();
      if (!r) return json({ error: "no active raffle" }, 404);

      const total = numbers.length * r.price;
      if (!reserveNumbers(r, numbers, email)) {
        return json({ error: "one or more numbers are no longer available" }, 409);
      }

      const extRef = `rifa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

      try {
        const { paymentId, qrCode, qrCodeBase64 } = await createPixOrder({
          transaction_amount: total,
          description: `Rifa: ${r.title} — ${numbers.join(", ")}`,
          payerEmail: email,
          payerName: email,
          externalReference: extRef,
          numbers,
          buyer: email,
        });

        const pending: PendingOrder = {
          extRef,
          paymentId,
          raffleId: r.id,
          numbers,
          email,
          name: name?.trim() ?? "",
          amount: total,
          status: "pending",
          createdAt: Date.now(),
          expiresAt: Date.now() + ORDER_TTL_MS,
        };
        orders.set(extRef, pending);
        orders.set(paymentId, pending);
        await saveOrder(pending);

        return json({
          id: paymentId,
          external_reference: extRef,
          status: "pending",
          qr_code: qrCode,
          qr_code_base64: qrCodeBase64,
        });
      } catch (err: any) {
        releaseNumbers(numbers);
        return json({ error: err?.message ?? String(err), detail: err?.cause ?? null }, 500);
      }
    }

    // Check a payment status (client polling) and commit if approved
    if (req.method === "GET" && url.pathname.startsWith("/api/payments/")) {
      const id = url.pathname.split("/").pop()!;
      try {
        const status = await getPaymentStatusById(id);
        if (status === "approved") {
          const pending = findPendingByPaymentId(id) ?? orders.get(id);
          if (pending) onApproved(pending.extRef);
          else void handleOrphanApproved(id);
        } else if (status === "rejected" || status === "cancelled") {
          onRejected(id);
        }
        return json({ id, status });
      } catch (err: any) {
        return json({ error: err?.message ?? String(err) }, 500);
      }
    }

    // Mercado Pago webhook (payment notifications)
    if (req.method === "POST" && url.pathname.startsWith("/api/webhooks")) {
      const body = await readBody(req);
      const rawId = body?.data?.id ?? body?.id ?? body?.payment?.id;
      if (!rawId) return json({ ok: false }, 400);

      const secret = process.env.MP_WEBHOOK_SECRET;
      if (secret) {
        try {
          WebhookSignatureValidator.validate({
            xSignature: req.headers.get("x-signature"),
            xRequestId: req.headers.get("x-request-id"),
            dataId: url.searchParams.get("data.id") ?? String(rawId),
            secret,
            toleranceSeconds: Number(process.env.MP_WEBHOOK_TOLERANCE ?? 300),
          });
        } catch (err: any) {
          console.error(`Webhook rejected: ${err?.reason ?? err?.message ?? err}`);
          return json({ ok: false, error: "invalid signature" }, 401);
        }
      }

      const id = String(rawId);
      try {
        const status = await getPaymentStatusById(id);
        if (status === "approved") {
          const pending = findPendingByPaymentId(id) ?? orders.get(id);
          if (pending) onApproved(pending.extRef);
          else void handleOrphanApproved(id);
        } else if (status === "rejected" || status === "cancelled") {
          onRejected(id);
        }
        return json({ ok: true, status });
      } catch (err: any) {
        return json({ error: err?.message ?? String(err) }, 500);
      }
    }

    return json({ error: "not found" }, 404);
}

const RECONCILE_MS = 60_000;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

// reload persisted raffle on boot and re-arm auto-draw if it filled while offline
async function bootstrap() {
  try {
    await runStartupChecks();
    await loadStorage();
    await loadRaffleFromDb();
    await loadReservations();
    await loadOrders();
    await loadPendingNotifs();
    void reconcileOrders();
  } catch (err) {
    console.error("Storage init failed", err);
  }
  const boot = getRaffle();
  if (boot && !boot.winner && drawDue(boot)) {
    // sold out OR the 6-day draw date was reached while the server was down
    drawNow(boot); // archives the drawn raffle, starts the replacement, notifies
  }
  server.listen(PORT, () => {
    console.log(`Rifa API server listening on http://localhost:${PORT}`);
    const has = (k: string) =>
      Object.prototype.hasOwnProperty.call(process.env, k)
        ? process.env[k]
          ? "SET(" + String(process.env[k]).slice(0, 10) + "…)"
          : "EMPTY-BUT-PRESENT"
        : "unset";
    console.log(
      "[env] MP_TOKEN=" + has("MP_TOKEN") +
        " MP_URL=" + has("MP_URL") +
        " ADMIN_PASSWORD=" + has("ADMIN_PASSWORD") +
        " TURSO_URL=" + has("TURSO_URL") +
        " TURSO_TOKEN=" + has("TURSO_TOKEN") +
        " EMAIL=" + has("EMAIL") +
        " EMAIL_P=" + has("EMAIL_P") +
        " BREVO_API_KEY=" + has("BREVO_API_KEY") +
        " HOST=" + (process.env.HOST || "(default)") +
        " PORT=" + (process.env.PORT ?? "(default)")
    );
    const pubHost = (process.env.HOST ?? "").trim();
    const corsOrigin = (process.env.CORS_ORIGIN ?? "").trim();
    if (!pubHost && (!corsOrigin || corsOrigin === "*")) {
      console.warn(
        "[config] HOST is not set — participation/winner emails will link to http://localhost:3000 " +
          "instead of your domain. Set HOST (e.g. raffle-oqkf.onrender.com) in the raffle env group on Render."
      );
    }
  });
  reconcileTimer = setInterval(() => void reconcileOrders(), RECONCILE_MS);
}

bootstrap();

// Crash resilience: log (and keep running) on unhandled async errors.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// Graceful shutdown: flush all pending DB writes then close the server.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — flushing storage and shutting down…`);
  try {
    await Promise.all([flushSaves(), flushDb()]);
  } catch (err) {
    console.error("Flush during shutdown failed:", err);
  }
  if (reconcileTimer) clearInterval(reconcileTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Node HTTP server (no Bun/docker needed). Adapts node:http to the fetch-style
// handler above so the same logic runs on Render's Node runtime.
function toNodeRequest(req: IncomingMessage, body: Buffer): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const x of v) headers.append(k, x);
    } else {
      headers.append(k, v);
    }
  }
  const method = (req.method ?? "GET").toUpperCase();
  return new Request(url.toString(), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" || method === "OPTIONS" || body.length === 0 ? undefined : body,
  });
}

async function writeResponse(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  const payload = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
  res.end(payload);
}

export const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const request = toNodeRequest(req, Buffer.concat(chunks));
    handle(request)
      .then((response) => writeResponse(res, response))
      .catch((err: any) => {
        console.error(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message ?? String(err) }));
      });
  });
  req.on("error", () => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad request" }));
  });
});