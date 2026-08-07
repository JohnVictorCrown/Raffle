/**
 * Startup dependency checks ("fail fast").
 *
 * On boot we verify the two external integrations the app depends on to
 * actually function — Gmail SMTP and Mercado Pago — and abort (process.exit(1))
 * if either is broken, so a deploy is never silently serving a raffle that
 * can't email or can't take PIX.
 *
 * Bypass with SKIP_STARTUP_CHECKS=1 if you need to boot anyway.
 */
import { sendEmail } from "./email";

function fail(msg: string): never {
  console.error(`[startup-check] FAIL: ${msg}`);
  process.exit(1);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms (${what})`)), ms);
  });
  return Promise.race([p, t]).finally(() => timer && clearTimeout(timer));
}

/** Verify Gmail SMTP works by sending a tiny test email to the sender address. */
async function checkEmail(): Promise<void> {
  const from = (process.env.EMAIL_FROM || `Golden Lion Raffle <${process.env.EMAIL_USER || ""}>`).trim();
  const to = process.env.EMAIL_USER;
  if (!to || !process.env.EMAIL_PASS) {
    fail(`EMAIL_USER / EMAIL_PASS are not configured (SMTP email will not send).`);
  }
  const ok = await withTimeout(
    sendEmail(to, "Rifa — startup email check", "This is an automated startup check. Emails are working ✓"),
    15_000,
    "smtp"
  );
  if (!ok) {
    fail(`could not send the SMTP test email to ${to}.`);
  }
  console.log(`[startup-check] email OK (SMTP test sent to ${to})`);
}

/** Validate MP_TOKEN by asking Mercado Pago who "me" is. */
async function checkMercadoPago(): Promise<void> {
  const token = process.env.MP_TOKEN;
  if (!token) {
    fail(`MP_TOKEN is not configured (Mercado Pago PIX will not work).`);
  }
  let status = 0;
  try {
    const res = await withTimeout(
      fetch("https://api.mercadopago.com/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      15_000,
      "mercadopago"
    );
    status = res.status;
    if (res.ok) {
      console.log(`[startup-check] mercadopago ok (GET /users/me -> ${status})`);
      return;
    }
  } catch (err: any) {
    fail(`Mercado Pago unreachable: ${err?.message ?? err}`);
  }
  fail(`Mercado Pago rejected the token (HTTP ${status}). MP_TOKEN is invalid or revoked.`);
}

export async function runStartupChecks(): Promise<void> {
  if (process.env.SKIP_STARTUP_CHECKS === "1") {
    console.warn("[startup-check] SKIPPED (SKIP_STARTUP_CHECKS=1)");
    return;
  }
  console.log("[startup-check] running email + mercadopago checks…");
  await Promise.all([checkEmail(), checkMercadoPago()]);
  console.log("[startup-check] all checks passed");
}