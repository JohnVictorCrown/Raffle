import { createPixOrder, getPaymentStatusById, processPixPayout } from "./payments";
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
  isFull,
  persist,
  onRaffleDrawn,
  loadRaffleFromDb,
  loadReservations,
  flushSaves,
  archiveCurrentForAdmin,
  type Raffle,
} from "./raffle";
import { sendWinnerEmail, prizeClaimPath, sendParticipationEmail, sendResultEmail, myRafflesPath } from "./email";
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
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: number;
}

// orders keyed by external_reference and by payment id
const orders = new Map<string, PendingOrder>();

// Pending orders are persisted to Turso so an approved webhook is still
// registered even after a restart, and re-indexed in memory on boot.
async function saveOrder(p: PendingOrder) {
  try {
    await kvSet(`order:${p.paymentId}`, p);
  } catch (err) {
    console.error("order save failed", err);
  }
}

async function removeOrder(p: PendingOrder) {
  orders.delete(p.extRef);
  orders.delete(p.paymentId);
  try {
    await kvDelete(`order:${p.paymentId}`);
  } catch (err) {
    console.error("order delete failed", err);
  }
}

async function loadOrders() {
  try {
    for (const row of await kvAll("order:")) {
      const p = JSON.parse(row.data) as PendingOrder;
      orders.set(p.extRef, p);
      orders.set(p.paymentId, p);
    }
    console.log(`Loaded ${orders.size / 2} pending order(s) from Turso`);
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
    exists: true,
    claimPath: r.winner ? prizeClaimPath(r.title, r.winner.token) : null,
  };
}

const notifiedRaffles = new Set<string>();

function notifyRaffleEnded(r: Raffle) {
  if (!r?.winner || notifiedRaffles.has(r.winner.token)) return;
  notifiedRaffles.add(r.winner.token);

  const raised = r.sold.reduce((a, s) => a + s.amount, 0);
  const payout = Math.round(raised * 0.7 * 100) / 100;
  const winnerNum = r.winner.number;
  const winnerUser = getUserByEmail(r.winner.email);
  const winnerName = winnerUser?.name || r.winner.name || r.winner.email;

  const base = `https://${process.env.PUBLIC_HOST ?? "localhost:3000"}`;
  const withdrawUrl = `${base}${prizeClaimPath(r.title, r.winner.token)}`;

  // Winner: withdraw instructions.
  sendWinnerEmail({
    email: r.winner.email,
    name: winnerName,
    raffleTitle: r.title,
    amount: payout,
    withdrawUrl,
  }).catch(() => {});

  // Result to every participant (winner + everyone else).
  const seen = new Set<string>();
  for (const sale of r.sold) {
    if (seen.has(sale.email)) continue;
    seen.add(sale.email);
    const user = getUserByEmail(sale.email);
    const isWinner = sale.email === r.winner.email;
    const url = isWinner
      ? withdrawUrl
      : `${base}${myRafflesPath(user?.code ?? "")}`;
    sendResultEmail({
      email: sale.email,
      name: user?.name || sale.name,
      raffleTitle: r.title,
      won: isWinner,
      winnerName,
      winnerNumber: winnerNum,
      resultUrl: url,
    }).catch(() => {});
  }
}

// When a raffle is drawn it is immediately archived and replaced by a fresh
// empty clone; notifications must therefore use the archived snapshot.
onRaffleDrawn((drawn) => {
  notifyRaffleEnded(drawn);
});

// Commit sold numbers once a payment is approved. Idempotent: the guard on
// pending.status ensures webhook + client polling can't double-commit.
function onApproved(extRef: string) {
  const pending = orders.get(extRef);
  if (!pending || pending.status === "approved") return;
  pending.status = "approved";
  const r = getRaffle();
  if (r && r.id === pending.raffleId) {
    commitSale(r, pending.numbers, pending.email, pending.name);
    const user = recordParticipation(pending.email, pending.name, {
      raffleId: r.id,
      title: r.title,
      numbers: pending.numbers,
      amount: pending.amount,
      at: Date.now(),
    });
    sendParticipationEmail({
      email: user.email,
      name: user.name,
      raffleTitle: r.title,
      myRafflesUrl: `https://${process.env.PUBLIC_HOST ?? "localhost:3000"}${myRafflesPath(user.code)}`,
    }).catch(() => {});
  } else {
    console.warn(
      `Approved payment ${pending.paymentId} has no matching active raffle (${pending.raffleId}); participation not recorded`
    );
  }
  removeOrder(pending);
}

// A payment that was rejected/cancelled releases its reserved numbers.
function onRejected(paymentId: string) {
  const pending = findPendingByPaymentId(paymentId);
  if (!pending) return;
  pending.status = "rejected";
  releaseNumbers(pending.numbers);
  removeOrder(pending);
}

// Re-check every pending order against Mercado Pago. This is the safety net for
// webhooks that never arrive (missed/delayed), so approved/rejected payments
// are still settled promptly.
async function reconcileOrders() {
  const seen = new Set<string>();
  for (const p of orders.values()) {
    if (seen.has(p.paymentId)) continue;
    seen.add(p.paymentId);
    if (p.status === "approved" || p.status === "rejected" || p.status === "cancelled") continue;
    try {
      const status = await getPaymentStatusById(p.paymentId);
      if (status === "approved") onApproved(p.extRef);
      else if (status === "rejected" || status === "cancelled") onRejected(p.paymentId);
    } catch (err) {
      console.error(`Reconcile failed for payment ${p.paymentId}:`, err);
    }
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
    await loadStorage();
    await loadRaffleFromDb();
    await loadReservations();
    await loadOrders();
    void reconcileOrders();
  } catch (err) {
    console.error("Storage init failed", err);
  }
  const boot = getRaffle();
  if (boot && isFull(boot) && !boot.winner) {
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
        " EMAIL_USER=" + has("EMAIL_USER") +
        " EMAIL_PASS=" + has("EMAIL_PASS") +
        " PUBLIC_HOST=" + (process.env.PUBLIC_HOST || "(default)") +
        " PORT=" + (process.env.PORT ?? "(default)")
    );
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