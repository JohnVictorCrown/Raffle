/**
 * Email delivery.
 *
 * Delivery is attempted in this order:
 *
 *  1. Brevo (Sendinblue) HTTP API — used when `BREVO_API_KEY` is set. This is
 *     the ONLY path that works on Render's free tier, which blocks outbound
 *     SMTP ports (25/465/587). Send from a sender address you verify in Brevo.
 *
 *     BREVO_API_KEY=xxxxxxxx
 *     EMAIL=stellar.0org@gmail.com              (sender address, must be verified)
 *     EMAIL_FROM=Rifa Leão Dourado <stellar.0org@gmail.com>
 *
 *  2. Gmail SMTP — when `EMAIL` / `EMAIL_P` (a Gmail app password) are set.
 *     Works locally and on paid Render instances; times out on free tier.
 *
 *     EMAIL_HOST=smtp.gmail.com
 *     EMAIL_PORT=465
 *     EMAIL=stellar.505org@gmail.com
 *     EMAIL_P=<gmail-app-password>
 *     EMAIL_FROM=Stellar Foundation Raffle <stellar.505org@gmail.com>
 *
 *  3. Log-only fallback (dev) when neither is configured.
 */
import tls from "node:tls";
import net from "node:net";

const host = process.env.EMAIL_HOST ?? "smtp.gmail.com";
const port = Number(process.env.EMAIL_PORT ?? 0);
const user = process.env.EMAIL ?? "";
const pass = process.env.EMAIL_P ?? "";
const from = process.env.EMAIL_FROM ?? `Golden Lion Raffle <${user}>`;
const brevoKey = process.env.BREVO_API_KEY ?? "";

const configured = Boolean(brevoKey || (user && pass));

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

function extractEmail(addr: string): string {
  const m = /<([^>]+)>/.exec(addr);
  return m ? m[1] : addr;
}

/** Split "Name <email>" into its parts. */
function parseFrom(addr: string): { name: string; email: string } {
  const m = /^(.*?)\s*<([^>]+)>$/.exec(addr.trim());
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: "Golden Lion Raffle", email: addr.trim() || user };
}

const senderEmail = parseFrom(from).email;

let brevoSenderStatus: boolean | null = null; // null = unknown, true = valid, false = invalid

/**
 * Ask Brevo whether our sender address is validated. Cached per process.
 * Brevo returns 201 even when it later rejects the message (as it did for an
 * unvalidated sender), so we must check this BEFORE sending to avoid the
 * "sent" lie. Returns null if the check itself fails (still proceed).
 */
async function brevoSenderValid(): Promise<boolean | null> {
  if (brevoSenderStatus !== null) return brevoSenderStatus;
  try {
    const res = await fetch("https://api.brevo.com/v3/senders", {
      headers: { "api-key": brevoKey },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { senders?: { email?: string; active?: boolean }[] };
    const senders = data?.senders ?? [];
    const found = senders.find((s) => (s.email ?? "").toLowerCase() === senderEmail.toLowerCase());
    brevoSenderStatus = found ? Boolean(found.active) : false;
  } catch {
    brevoSenderStatus = null;
  }
  if (brevoSenderStatus === false) {
    console.error(
      `[email] brevo sender "${senderEmail}" is NOT validated — verify it in Brevo (Senders) or authenticate a domain. Emails will be rejected.`
    );
  }
  return brevoSenderStatus;
}

/** Send via Brevo HTTP API (port 443 — not blocked on Render free tier). */
async function sendBrevo(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  const valid = await brevoSenderValid();
  if (valid === false) return false;

  const { name, email } = parseFrom(from);
  const payload = {
    sender: { name, email },
    to: [{ email: to }],
    subject,
    textContent: text,
    ...(html ? { htmlContent: html } : {}),
  };
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": brevoKey },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      console.log(`[email] sent (brevo) -> ${to} subject="${subject}"`);
      return true;
    }
    const body = await res.text().catch(() => "");
    console.error(`[email] brevo rejected (HTTP ${res.status}): ${body.slice(0, 300)}`);
    return false;
  } catch (err: any) {
    console.error(`[email] brevo error: ${err?.message ?? err}`);
    return false;
  }
}

interface Candidate {
  mode: "smtps" | "starttls";
  p: number;
}

/** Connection candidates: configured port first, then the alternate transport. */
function candidates(): Candidate[] {
  const list: Candidate[] = [];
  const add = (mode: Candidate["mode"], p: number) => {
    if (!list.some((c) => c.p === p)) list.push({ mode, p });
  };
  if (port) add(port === 465 ? "smtps" : "starttls", port);
  add("smtps", 465);
  add("starttls", 587);
  return list;
}

/**
 * One SMTP dialog over a connection that is either already TLS (465, "smtps")
 * or plain text that must be upgraded via STARTTLS (587). Resolves true only
 * after the server accepts the message (250) — anything else is logged and
 * resolves false so the caller can try the next candidate.
 */
function runSession(cand: Candidate, to: string, subject: string, text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: net.Socket | tls.TLSSocket;
    let buffer = "";
    let pending: { resolve: (line: string) => void } | null = null;
    let settled = false;

    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      console.error(`[email] SMTP ${cand.mode}/${cand.p} failed for ${to}: ${why}`);
      try {
        socket.destroy();
      } catch {}
      resolve(false);
    };

    const onData = (d: Buffer) => {
      buffer += d.toString("utf-8");
      let idx = buffer.indexOf("\r\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const cb = pending;
        pending = null;
        if (cb) cb.resolve(line);
        idx = buffer.indexOf("\r\n");
      }
    };
    const onError = (err: any) => fail(`[${err?.code ?? "ERR"}] ${err?.message ?? err}`);
    const onClose = () => {
      if (!settled) fail("connection closed early");
    };

    // Whole-session deadline so a filtered port doesn't stall the deploy.
    const deadline = setTimeout(() => fail(`timed out after 25s (${cand.mode}:${cand.p})`), 25_000);

    const session = async () => {
      try {
        const read = () =>
          new Promise<{ code: number; line: string }>((res) => {
            pending = {
              resolve: (line) => res({ code: Number(line.slice(0, 3)) || 0, line }),
            };
          });
        const step = (cmd: string) =>
          new Promise<{ code: number; line: string }>((res) => {
            const label = cmd.split(" ")[0] || cmd;
            pending = {
              resolve: (line) => {
                const code = Number(line.slice(0, 3)) || 0;
                if (process.env.DEBUG_SMTP) console.log(`[email] < ${label} -> ${code} ${line}`);
                if (code >= 400) {
                  fail(`rejected ${label}: ${line}`);
                  res({ code, line });
                  return;
                }
                res({ code, line });
              },
            };
            socket.write(cmd + "\r\n");
          });

        // Gmail greets us immediately on connect: a lone "220 ... ESMTP" line.
        await read();
        if (cand.mode === "starttls") {
          await step(`EHLO ${host}`);
          await step("STARTTLS");
          const secure = await new Promise<tls.TLSSocket>((resUp, rejUp) => {
            const tlsSock = tls.connect({ socket: socket as net.Socket, servername: host, rejectUnauthorized: false }, () => {
              socket.removeAllListeners("data");
              socket.removeAllListeners("error");
              socket.removeAllListeners("close");
              socket = tlsSock;
              tlsSock.on("data", onData);
              tlsSock.on("error", onError);
              tlsSock.on("close", onClose);
              resUp(tlsSock);
            });
            tlsSock.on("error", rejUp);
          });
          socket = secure;
          await step(`EHLO ${host}`);
        } else {
          await step(`EHLO ${host}`);
        }
        await step("AUTH LOGIN");
        await step(b64(user));
        await step(b64(pass));
        await step(`MAIL FROM:<${extractEmail(from)}>`);
        await step(`RCPT TO:<${to}>`);
        await step("DATA");
        await step(`Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${to}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.`);
        await step("QUIT");
        clearTimeout(deadline);
        settled = true;
        socket.end();
        console.log(`[email] sent -> ${to} subject="${subject}" (${cand.mode}:${cand.p})`);
        resolve(true);
      } catch {
        // all failures are reported through fail()
      }
    };

    if (cand.mode === "smtps") {
      socket = tls.connect({ host, port: cand.p, rejectUnauthorized: false }, () => void session().catch(() => {}));
    } else {
      socket = net.connect({ host, port: cand.p }, () => void session().catch(() => {}));
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

/** Send one plain-text email with an optional styled HTML version. */
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (brevoKey) return sendBrevo(to, subject, text, html);
  if (!configured) {
    console.log(`[email] (dev) -> ${to} subject="${subject}"`);
    console.log(text.replace(/^/gm, "    "));
    return true;
  }
  for (const cand of candidates()) {
    const ok = await runSession(cand, to, subject, text);
    if (ok) return true;
  }
  return false;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function prizeClaimPath(raffleTitle: string, token: string): string {
  return `/withdraw/${slug(raffleTitle) || "rifa"}?token=${token}`;
}

export function myRafflesPath(code: string): string {
  return `/me?code=${encodeURIComponent(code)}`;
}

/** Render a simple, inline-styled HTML email from the plain-text paragraphs. */
function htmlEmail(title: string, lines: string[]): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const linkify = (s: string) => s.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" style="color:#c9a227;font-weight:600;">${url}</a>`);
  const paragraphs = lines
    .map((l) => (l ? `<p style="margin:0 0 12px;">${linkify(esc(l))}</p>` : `<p style="margin:0 0 12px;">&nbsp;</p>`))
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#14100c;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:600px;margin:0 auto;background-color:#1c1711;color:#f3ead9;">
    <div style="background-color:#14100c;padding:24px 32px;border-bottom:3px solid #c9a227;">
      <span style="color:#c9a227;font-size:20px;font-weight:bold;letter-spacing:1px;">&#129409; GOLDEN LION RAFFLE</span>
    </div>
    <div style="padding:28px 32px;">
      <h1 style="color:#c9a227;font-size:22px;margin:0 0 18px;font-family:Arial,sans-serif;">${esc(title)}</h1>
      ${paragraphs}
    </div>
    <div style="background-color:#14100c;padding:18px 32px;border-top:1px solid #3a3124;color:#9a8c72;font-size:12px;">
      You're receiving this because you joined a Golden Lion raffle.
    </div>
  </div>
</body>
</html>`;
}

interface WinnerEmail {
  email: string;
  name: string;
  raffleTitle: string;
  amount: number;
  withdrawUrl: string;
}

export async function sendWinnerEmail(m: WinnerEmail): Promise<boolean> {
  const lines = [
    `Congratulations ${m.name || m.email}, the random draw chose your number and you won the raffle!`,
    ``,
    `Prize to withdraw: ${m.amount.toFixed(2)}`,
    ``,
    `Use the link below to select your PIX key and receive your prize:`,
    m.withdrawUrl,
  ];
  return sendEmail(
    m.email,
    `🎉 You won "${m.raffleTitle}"!`,
    lines.join("\n"),
    htmlEmail(`You won "${m.raffleTitle}"!`, lines)
  );
}

interface ParticipationEmail {
  email: string;
  name: string;
  raffleTitle: string;
  myRafflesUrl: string;
}

export async function sendParticipationEmail(m: ParticipationEmail): Promise<boolean> {
  const lines = [
    `Hi ${m.name || m.email},`,
    ``,
    `Your participation in "${m.raffleTitle}" is confirmed.`,
    `Track your raffles anytime at:`,
    m.myRafflesUrl,
  ];
  return sendEmail(
    m.email,
    `You joined "${m.raffleTitle}"`,
    lines.join("\n"),
    htmlEmail(`Participation confirmed`, lines)
  );
}

interface ResultEmail {
  email: string;
  name: string;
  raffleTitle: string;
  won: boolean;
  winnerName: string;
  winnerNumber: number;
  resultUrl: string;
}

export async function sendResultEmail(m: ResultEmail): Promise<boolean> {
  const subject = m.won ? `🎉 You WON "${m.raffleTitle}"` : `"${m.raffleTitle}" result is in`;
  const lines = [
    m.won ? `Congratulations ${m.name || m.email}, you won!` : `Hi ${m.name || m.email},`,
    ``,
    `Raffle: ${m.raffleTitle}`,
    `Winning number: #${String(m.winnerNumber).padStart(2, "0")}`,
    `Winner paid out to: ${m.winnerName}`,
    ``,
    m.won
      ? "Use the link below to choose your PIX key and receive your prize:"
      : "See your raffles and the result at:",
    m.resultUrl,
  ];
  return sendEmail(
    m.email,
    subject,
    lines.join("\n"),
    htmlEmail(m.won ? `You won "${m.raffleTitle}"!` : `"${m.raffleTitle}" result`, lines)
  );
}