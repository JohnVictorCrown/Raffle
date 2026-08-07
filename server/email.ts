/**
 * Email delivery.
 *
 * When `EMAIL` / `EMAIL_P` (a Gmail app password) are configured it
 * sends real email over SMTP (SMTPS on 465). Otherwise it falls back to
 * logging so the feature can be developed locally.
 *
 *    EMAIL_HOST=smtp.gmail.com
 *    EMAIL_PORT=465
 *    EMAIL=stellar.505org@gmail.com
 *    EMAIL_P=<gmail-app-password>
 *    EMAIL_FROM=Stellar Foundation Raffle <stellar.505org@gmail.com>
 */
import tls from "node:tls";

const host = process.env.EMAIL_HOST ?? "smtp.gmail.com";
const port = Number(process.env.EMAIL_PORT ?? 465);
const user = process.env.EMAIL ?? "";
const pass = process.env.EMAIL_P ?? "";
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
    let pending: { resolve: (line: string) => void } | null = null;

    // Read SMTP reply. Replies are framed by CRLF (one line; multiline 250-x
    // responses are fine since we only look at the leading code).
    socket.on("data", (d: Buffer) => {
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
    });

    socket.on("error", (err) => {
      console.error(`[email] SMTP error to ${to}: ${err?.message ?? err}`);
      if (pending) pending.resolve("");
      resolve(false);
    });

    socket.on("close", () => resolve(false));

    async function run() {
let cmdNow = "";
      try {
        const onReply = (line: string) => {
          const code = Number(line.slice(0, 3)) || 0;
          return { code, line };
        };
        // read the next reply line WITHOUT sending anything
        const read = () =>
          new Promise<{ code: number; line: string }>((res) => {
            pending = { resolve: (line) => res(onReply(line)) };
          });
        const step = (cmd: string) =>
          new Promise<{ code: number; line: string }>((res) => {
            cmdNow = cmd.split(" ")[0] || cmd;
            pending = {
              resolve: (line) => {
                const code = Number(line.slice(0, 3)) || 0;
                if (process.env.DEBUG_SMTP) console.log(`[email] < ${cmdNow} -> ${code} ${line}`);
                if (code >= 400) {
                  console.error(`[email] SMTP rejected ${cmdNow}/${to}: ${line}`);
                  socket.destroy();
                  res({ code, line });
                  return;
                }
                res({ code, line });
              },
            };
            socket.write(cmd + "\r\n");
          });

        // Gmail greets us immediately on connect: a lone "220 ... ESMTP" line.
        // Consume it first so every command below maps to its own reply.
        await read();
        await step(`EHLO ${host}`);
        await step("AUTH LOGIN");
        await step(b64(user));
        await step(b64(pass));
        await step(`MAIL FROM:<${extractEmail(from)}>`);
        await step(`RCPT TO:<${to}>`);
        await step("DATA");
        // send final message + terminating "."; server replies 250 Message accepted
        await step(`Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${to}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.`);
        await step("QUIT");
        socket.end();
        console.log(`[email] sent -> ${to} subject="${subject}"`);
        resolve(true);
      } catch {
        // Already reported/logged by step()'s rejection path or the error handler.
        try {
          socket.destroy();
        } catch {}
        resolve(false);
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