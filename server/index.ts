import { createPixOrder, getPaymentStatusById, processPixPayout } from "./payments";
import { WebhookSignatureValidator } from "mercadopago";
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
} from "./raffle";
import { sendWinnerEmail, prizeClaimPath, sendParticipationEmail, sendResultEmail, myRafflesPath } from "./email";
import { recordParticipation, getUserByCode, getUserByEmail, addToHistory, getHistory } from "./storage";

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
  status: "pending" | "approved" | "rejected";
  createdAt: number;
}

// orders keyed by external_reference and by payment id
const orders = new Map<string, PendingOrder>();

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

function publicRaffle() {
  const r = getRaffle();
  if (!r) return null;
  pruneReservations(r);
  return {
    id: r.id,
    title: r.title,
    prize: r.prize,
    price: r.price,
    currency: r.currency,
    ticketCount: r.ticketCount,
    available: availableCount(r),
    soldNumbers: r.sold.map((s) => s.number),
    soldCount: r.sold.length,
    winner: r.winner
      ? { number: r.winner.number, email: r.winner.email, at: r.winner.at }
      : null,
    drawing: r.drawing,
    exists: true,
    claimPath: r.winner ? prizeClaimPath(r.title, r.winner.token) : null,
  };
}

const notifiedRaffles = new Set<string>();

function notifyRaffleEnded() {
  const r = getRaffle();
  if (!r?.winner || notifiedRaffles.has(r.id)) return;
  notifiedRaffles.add(r.id);

  const raised = r.sold.reduce((a, s) => a + s.amount, 0);
  const payout = Math.round(raised * 0.7 * 100) / 100;
  const winnerNum = r.winner.number;
  const winnerName = r.sold.find((s) => s.number === winnerNum)?.name || r.winner.email;

  const base = `https://${process.env.PUBLIC_HOST ?? "localhost:3000"}`;
  const withdrawUrl = `${base}${prizeClaimPath(r.title, r.winner.token)}`;

  // Winner: withdraw instructions.
  const winnerUser = getUserByEmail(r.winner.email);
  sendWinnerEmail({
    email: r.winner.email,
    name: winnerUser?.name || winnerName,
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

// Commit sold numbers once a payment is approved.
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
    notifyRaffleEnded();
  }
}

export const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, hasToken: !!process.env.MP_ACCESS_TOKEN });
    }

    // Public: current raffle (single raffle only)
    if (req.method === "GET" && url.pathname === "/api/raffle") {
      return json({ raffle: publicRaffle() });
    }

    // Public: "My raffles" — code-actuated login from the participation email
    if (req.method === "GET" && url.pathname === "/api/me") {
      const code = url.searchParams.get("code") ?? "";
      if (!code) return json({ error: "missing code" }, 400);
      const user = getUserByCode(code);
      if (!user) return json({ error: "invalid or expired link" }, 404);

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
      if (!r?.winner || r.winner.token !== token) {
        return json({ error: "invalid or expired link" }, 404);
      }
      if (r.winner.paid) return json({ ok: true, alreadyPaid: true });

      const raised = r.sold.reduce((a, s) => a + s.amount, 0);
      const payout = Math.round(raised * 0.7 * 100) / 100;
      if (payout <= 0) return json({ error: "no funds to pay out" }, 400);

      const result = await processPixPayout({
        transactionAmount: payout,
        pixKey,
        pixKeyType,
        description: `Rifa payout: ${r.title}`,
      });
      if (!result.ok) {
        return json({ ok: false, error: result.error ?? "Payout failed" }, 502);
      }
      r.winner.paid = true;
      persist(r);
      return json({ ok: true, payoutId: result.id, status: result.status });
    }

    // Admin: create / replace the single raffle
    if (req.method === "POST" && url.pathname === "/api/admin/raffle") {
      const body = await readBody(req);
      const adminPass = process.env.ADMIN_PASSWORD ?? "admin";
      if (!body.password || body.password !== adminPass) {
        return json({ error: "wrong password" }, 401);
      }
      const { title, prize, price, currency = "BRL", ticketCount } = body;
      if (!title || !prize || typeof price !== "number" || price <= 0 || typeof ticketCount !== "number" || ticketCount < 1) {
        return json({ error: "invalid raffle data" }, 400);
      }
      const prev = getRaffle();
      if (prev && prev.sold.length > 0) {
        addToHistory({
          id: prev.id,
          title: prev.title,
          prize: prev.prize,
          soldCount: prev.sold.length,
          winnerNumber: prev.winner?.number ?? null,
          createdAt: prev.createdAt,
          endedAt: Date.now(),
        });
      }
      const r = createRaffle({ title, prize, price, currency, ticketCount });
      return json({ ok: true, raffle: { id: r.id, title: r.title } });
    }

    // Create a PIX payment via the Orders API
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
        }
        return json({ ok: true, status });
      } catch (err: any) {
        return json({ error: err?.message ?? String(err) }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },
});

// reload persisted raffle on boot and re-arm auto-draw if it filled while offline
const boot = getRaffle();
if (boot && isFull(boot) && !boot.winner) {
  drawNow(boot);
  notifyRaffleEnded();
}

console.log(`Mercado Pago API server listening on http://localhost:${PORT}`);