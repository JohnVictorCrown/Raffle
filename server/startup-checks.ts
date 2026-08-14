/**
 * Startup dependency checks ("fail fast").
 *
 * Each integration is only tested when its own env vars are configured:
 *   - email → runs when `EMAIL` is set (needs BREVO_API_KEY or EMAIL_P)
 *   - Mercado Pago → runs when `MP_TOKEN` is set
 * A configured-but-broken integration aborts the deploy (process.exit(1)) so a
 * service never silently comes up unable to email or take PIX. Unset vars
 * simply skip their check.
 *
 * Bypass all checks with SKIP_STARTUP_CHECKS=1.
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

/** Verify email delivery works (Brevo API or Gmail SMTP) via a test email. */
async function checkEmail(): Promise<void> {
  const to = process.env.EMAIL;
  if (!to) {
    console.log("[startup-check] email check SKIPPED (EMAIL not set)");
    return;
  }
  if (!process.env.BREVO_API_KEY && !process.env.EMAIL_P) {
    fail(`EMAIL is set but no transport configured: set BREVO_API_KEY (or EMAIL_P for SMTP).`);
  }
  const ok = await withTimeout(
    sendEmail(to, "Rifa — startup email check", "This is an automated startup check. Emails are working ✓"),
    15_000,
    "email"
  );
  if (!ok) {
    fail(`could not send the test email to ${to}.`);
  }
  console.log(`[startup-check] email OK (test sent to ${to})`);
}

/** Validate MP_TOKEN by asking Mercado Pago who "me" is. */
async function checkMercadoPago(): Promise<void> {
  const token = process.env.MP_TOKEN;
  if (!token) {
    console.log("[startup-check] mercadopago check SKIPPED (MP_TOKEN not set)");
    return;
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