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
import net from "node:net";

const host = process.env.EMAIL_HOST ?? "smtp.gmail.com";
const port = Number(process.env.EMAIL_PORT ?? 0);
const user = process.env.EMAIL ?? "";
const pass = process.env.EMAIL_P ?? "";
const from = process.env.EMAIL_FROM ?? `Golden Lion Raffle <${user}>`;

const configured = Boolean(user && pass);

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

function extractEmail(addr: string): string {
  const m = /<([^>]+)>/.exec(addr);
  return m ? m[1] : addr;
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

/** Send one plain-text email over SMTP (SMTPS 465 then STARTTLS 587). */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
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