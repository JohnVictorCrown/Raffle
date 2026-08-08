/**
 * Durable draw notifications: retry / backoff / dedupe engine.
 *
 * Extracted from index.ts so it can be unit-tested in isolation. The module is
 * pure — every side effect (sending, persistence, scheduling) is injected via
 * the deps object, so tests can substitute fakes and a manual scheduler.
 */

export interface NotifEmailState {
  email: string;
  name: string;
  kind: "winner" | "result";
  won: boolean;
  url: string;
  sent: boolean;
}

export interface PendingNotif {
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

export const NOTIF_MAX_ATTEMPTS = 6;
export const NOTIF_BASE_DELAY_MS = 30_000;

/** Exponential backoff for attempt N: 30s, 2m, 8m, 32m, ~2h. */
export function notifDelay(attempt: number): number {
  return NOTIF_BASE_DELAY_MS * Math.pow(4, attempt - 1);
}

export interface NotifDeps {
  /** Send one notification email; resolve true on success, false on failure. Must never throw. */
  sendEmail: (n: PendingNotif, e: NotifEmailState) => Promise<boolean>;
  /** Persist the record (sent flags / attempts). */
  save: (n: PendingNotif) => Promise<void>;
  /** Delete the record once fully delivered. */
  remove: (token: string) => Promise<void>;
  /** Schedule a retry; injected so tests can drive time manually. */
  schedule: (fn: () => void, ms: number) => unknown;
}

/**
 * A notification dispatcher. Dedupe state (`dispatching`) is per-instance, so
 * each test gets a clean copy.
 */
export function createNotifDispatcher(deps: NotifDeps) {
  const dispatching = new Set<string>();

  /**
   * Deliver a draw's notification emails with exponential backoff. Only unsent
   * emails are re-attempted, so retries never duplicate already-delivered mail.
   * A record is deleted once every email has been sent; after MAX attempts it
   * is kept (for manual action) and the batch stops.
   */
  function dispatchNotif(n: PendingNotif): void {
    if (dispatching.has(n.token)) return; // already in flight — no double batch
    dispatching.add(n.token);

    const runBatch = async () => {
      n.attempts += 1;
      for (const e of n.emails) {
        if (e.sent) continue; // never re-send delivered mail
        const ok = await deps.sendEmail(n, e);
        if (ok) {
          e.sent = true;
          // persist immediately so a crash mid-batch can't re-send this email
          await deps.save(n);
        } else {
          console.warn(
            `[notif] ${e.kind} email to ${e.email} failed (attempt ${n.attempts}/${NOTIF_MAX_ATTEMPTS}) for raffle "${n.raffleTitle}"`
          );
        }
      }
      await deps.save(n);

      const pending = n.emails.filter((e) => !e.sent);
      if (pending.length === 0) {
        dispatching.delete(n.token);
        await deps.remove(n.token);
        return;
      }
      if (n.attempts >= NOTIF_MAX_ATTEMPTS) {
        console.error(
          `[notif] GAVE UP after ${n.attempts} attempts for raffle "${n.raffleTitle}" — still pending: ` +
            pending.map((e) => `${e.kind}<${e.email}>`).join(", ") +
            ". MANUAL ACTION REQUIRED."
        );
        dispatching.delete(n.token);
        return;
      }
      const delay = notifDelay(n.attempts);
      console.warn(
        `[notif] ${pending.length} email(s) pending for raffle "${n.raffleTitle}" — retrying in ${Math.round(delay / 1000)}s`
      );
      deps.schedule(() => void runBatch(), delay);
    };

    void runBatch();
  }

  /**
   * Resume persisted batches after a restart. Fully-sent records are dropped,
   * resumable ones (attempts < MAX) are dispatched where they left off, and
   * abandoned ones (attempts >= MAX with unsent mail) are logged for manual
   * attention. Returns how many batches were resumed.
   */
  async function loadPending(records: PendingNotif[]): Promise<number> {
    let resumed = 0;
    for (const n of records) {
      const pending = n.emails.filter((e) => !e.sent);
      if (pending.length === 0) {
        await deps.remove(n.token); // stale fully-sent record
      } else if (n.attempts < NOTIF_MAX_ATTEMPTS) {
        resumed += 1;
        dispatchNotif(n);
      } else {
        console.error(
          `[notif] abandoned notification for raffle "${n.raffleTitle}" (${pending.length} email(s) unsent) needs manual attention`
        );
      }
    }
    return resumed;
  }

  function inFlightCount(): number {
    return dispatching.size;
  }

  return { dispatchNotif, loadPending, inFlightCount };
}

/**
 * Fire-and-forget email with backoff retries (transactional emails like the
 * participation confirmation). No persistence, but loud on failure.
 */
export function retryEmail(
  job: () => Promise<boolean>,
  what: string,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)
): void {
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
        schedule(run, delay);
      })
      .catch((err: any) => {
        console.error(`[email] ${what} threw:`, err?.message ?? err);
        if (attempts >= NOTIF_MAX_ATTEMPTS) {
          console.error(`[email] GAVE UP: ${what} after ${attempts} attempts — MANUAL ACTION REQUIRED`);
          return;
        }
        schedule(run, notifDelay(attempts));
      });
  };
  run();
}
