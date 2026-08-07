/**
 * Email delivery.
 *
 * When `EMAIL_USER` / `EMAIL_PASS` (a Gmail app password) are configured it
 * sends real email over SMTP (SMTPS on 465). Otherwise it falls back to
 * logging so the feature can be developed locally.
 *
 *    EMAIL_HOST=smtp.gmail.com
 *    EMAIL_PORT=465
 *    EMAIL_USER=stellar.505org@gmail.com
 *    EMAIL_PASS=<gmail-app-password>
 *    EMAIL_FROM=Stellar Foundation Raffle <stellar.505org@gmail.com>
 */
import tls from "node:tls";

const host = process.env.EMAIL_HOST ?? "smtp.gmail.com";
const port = Number(process.env.EMAIL_PORT ?? 465);
const user = process.env.EMAIL_USER ?? "";
const pass = process.env.EMAIL_PASS ?? "";
const from = process.env.EMAIL_FROM ?? `Golden Lion Raffle <${user}>`;

const configured = Boolean(user && pass);

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

function extractEmail(addr: string): string {
  const m = /<([^>]+)>/.exec(addr);
  return m ? m[1] : addr;
}

/** Send one plain-text email over SMTPS. Resolves true on success. */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!configured) {
    console.log(`[email] (dev) -> ${to} subject="${subject}"`);
    console.log(text.replace(/^/gm, "    "));
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => run());

    let buffer = "";
    let pending: ((line: string) => void) | null = null;

    const step = (cmd: string) =>
      new Promise<string>((res) => {
        pending = res;
        socket.write(cmd + "\r\n");
      });

    socket.on("data", (d: Buffer) => {
      buffer += d.toString("utf-8");
      let idx = buffer.indexOf("\r\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const cb = pending;
        pending = null;
        if (cb) cb(line);
        idx = buffer.indexOf("\r\n");
      }
    });

    socket.on("error", () => {
      if (pending) pending("");
      resolve(false);
    });

    socket.on("close", () => resolve(true));

    async function run() {
      try {
        await step(`EHLO ${host}`);
        await step("AUTH LOGIN");
        await step(b64(user));
        await step(b64(pass));
        await step(`MAIL FROM:<${extractEmail(from)}>`);
        await step(`RCPT TO:<${to}>`);
        await step("DATA");
        await step(`Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${to}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.`);
        await step("QUIT");
        socket.end();
      } catch {
        resolve(false);
        socket.destroy();
      }
    }
  });
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

interface WinnerEmail {
  email: string;
  name: string;
  raffleTitle: string;
  amount: number;
  withdrawUrl: string;
}

export async function sendWinnerEmail(m: WinnerEmail): Promise<boolean> {
  return sendEmail(
    m.email,
    `🎉 You won "${m.raffleTitle}"!`,
    [
      `Congratulations ${m.name || m.email}, the random draw chose your number and you won the raffle!`,
      ``,
      `Prize to withdraw: ${m.amount.toFixed(2)}`,
      ``,
      `Use the link below to select your PIX key and receive your prize:`,
      m.withdrawUrl,
    ].join("\n")
  );
}

interface ParticipationEmail {
  email: string;
  name: string;
  raffleTitle: string;
  myRafflesUrl: string;
}

export async function sendParticipationEmail(m: ParticipationEmail): Promise<boolean> {
  return sendEmail(
    m.email,
    `You joined "${m.raffleTitle}"`,
    [
      `Hi ${m.name || m.email},`,
      ``,
      `Your participation in "${m.raffleTitle}" is confirmed.`,
      `Track your raffles anytime at:`,
      m.myRafflesUrl,
    ].join("\n")
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
  return sendEmail(
    m.email,
    subject,
    [
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
    ].join("\n")
  );
}