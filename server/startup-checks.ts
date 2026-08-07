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

/** Verify email delivery works (Brevo API or Gmail SMTP) via a test email. */
async function checkEmail(): Promise<void> {
  const to = process.env.EMAIL;
  if (!to) {
    fail(`EMAIL is not configured (email will not send).`);
  }
  if (!process.env.BREVO_API_KEY && !process.env.EMAIL_P) {
    fail(`no email transport configured: set BREVO_API_KEY (or EMAIL / EMAIL_P for SMTP).`);
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