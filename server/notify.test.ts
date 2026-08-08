import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import {
  createNotifDispatcher,
  retryEmail,
  notifDelay,
  NOTIF_BASE_DELAY_MS,
  NOTIF_MAX_ATTEMPTS,
  type NotifEmailState,
  type PendingNotif,
} from "./notify";

// Keep test output clean — retries log warnings/errors by design.
const origWarn = console.warn;
const origError = console.error;
beforeEach(() => {
  console.warn = () => {};
  console.error = () => {};
});
afterEach(() => {
  console.warn = origWarn;
  console.error = origError;
});

/** Let pending microtasks (async batches) settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function state(email: string, kind: "winner" | "result", sent: boolean, won = false): NotifEmailState {
  return { email, name: email, kind, won, url: `https://x.test/${email}`, sent };
}

function notif(partial: Partial<PendingNotif> = {}): PendingNotif {
  return {
    token: "tok-1",
    raffleTitle: "Test raffle",
    winnerName: "Winner",
    winnerNumber: 7,
    payout: 70,
    withdrawUrl: "https://x.test/withdraw",
    emails: [state("winner@x.test", "winner", false, true), state("loser@x.test", "result", false)],
    createdAt: Date.now(),
    attempts: 0,
    ...partial,
  };
}

function makeHarness(sendImpl?: (n: PendingNotif, e: NotifEmailState) => Promise<boolean>) {
  const sent: string[] = [];
  const saved: string[] = [];
  const removed: string[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];

  const notifs = createNotifDispatcher({
    sendEmail: async (n, e) => {
      sent.push(e.email); // record every attempt, then delegate
      return sendImpl ? sendImpl(n, e) : true;
    },
    save: async (n) => {
      saved.push(n.token);
    },
    remove: async (token) => {
      removed.push(token);
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
    },
  });

  return { notifs, sent, saved, removed, scheduled };
}

describe("notifDelay", () => {
  test("grows exponentially from the base delay", () => {
    expect(notifDelay(1)).toBe(NOTIF_BASE_DELAY_MS);
    expect(notifDelay(2)).toBe(NOTIF_BASE_DELAY_MS * 4);
    expect(notifDelay(3)).toBe(NOTIF_BASE_DELAY_MS * 16);
  });
});

describe("dispatchNotif", () => {
  test("delivers all emails on the first batch and deletes the record", async () => {
    const h = makeHarness();
    h.notifs.dispatchNotif(notif());
    await settle();

    expect(h.sent).toEqual(["winner@x.test", "loser@x.test"]);
    expect(h.saved).toContain("tok-1");
    expect(h.removed).toEqual(["tok-1"]);
    expect(h.scheduled).toHaveLength(0);
    expect(h.notifs.inFlightCount()).toBe(0);
  });

  test("is idempotent for a token already in flight (no double batch)", async () => {
    const h = makeHarness();
    const n = notif();
    h.notifs.dispatchNotif(n);
    h.notifs.dispatchNotif(n);
    h.notifs.dispatchNotif(n);
    await settle();

    expect(h.sent).toEqual(["winner@x.test", "loser@x.test"]);
  });

  test("retries only unsent emails on subsequent batches (no duplicates)", async () => {
    let loserFailsLeft = 1;
    const h = makeHarness(async (_n, e) => {
      if (e.kind === "result" && loserFailsLeft > 0) {
        loserFailsLeft -= 1;
        return false;
      }
      return true;
    });

    h.notifs.dispatchNotif(notif());
    await settle();

    // Batch 1: winner delivered, loser failed → scheduled with the first backoff.
    expect(h.sent).toEqual(["winner@x.test", "loser@x.test"]);
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0].ms).toBe(NOTIF_BASE_DELAY_MS);
    expect(h.removed).toHaveLength(0);

    // Batch 2: only the loser is re-sent; the winner must not be duplicated.
    h.scheduled[0].fn();
    await settle();

    expect(h.sent).toEqual(["winner@x.test", "loser@x.test", "loser@x.test"]);
    expect(h.removed).toEqual(["tok-1"]);
    expect(h.scheduled).toHaveLength(1);
  });

  test("backs off exponentially while emails keep failing", async () => {
    const h = makeHarness(async () => false);

    h.notifs.dispatchNotif(notif());
    await settle();
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0].ms).toBe(NOTIF_BASE_DELAY_MS);

    h.scheduled[0].fn();
    await settle();
    expect(h.scheduled).toHaveLength(2);
    expect(h.scheduled[1].ms).toBe(NOTIF_BASE_DELAY_MS * 4);
  });

  test("gives up after NOTIF_MAX_ATTEMPTS and keeps the record for manual action", async () => {
    const h = makeHarness(async () => false);

    h.notifs.dispatchNotif(notif());
    await settle();

    for (let i = 1; i < NOTIF_MAX_ATTEMPTS; i++) {
      expect(h.scheduled).toHaveLength(i);
      h.scheduled[i - 1].fn();
      await settle();
    }

    // The final batch ran and gave up: no further scheduling, record kept.
    expect(h.scheduled).toHaveLength(NOTIF_MAX_ATTEMPTS - 1);
    expect(h.removed).toHaveLength(0);
    expect(h.notifs.inFlightCount()).toBe(0);
  });
});

describe("loadPending", () => {
  test("removes fully-sent records, resumes partial ones, skips abandoned ones", async () => {
    const h = makeHarness();

    const done = notif({ token: "done", emails: [state("a@x.test", "winner", true, true), state("b@x.test", "result", true)] });
    const partial = notif({
      token: "partial",
      emails: [state("w@x.test", "winner", true, true), state("l@x.test", "result", false)],
      attempts: 2,
    });
    const abandoned = notif({
      token: "abandoned",
      emails: [state("x@x.test", "winner", false)],
      attempts: NOTIF_MAX_ATTEMPTS,
    });

    const resumed = await h.notifs.loadPending([done, partial, abandoned]);

    expect(resumed).toBe(1);
    expect(h.removed).toContain("done"); // stale fully-sent record dropped
    await settle();
    expect(h.sent).toEqual(["l@x.test"]); // only the partial record's unsent email
    expect(h.removed).toContain("partial"); // completed after resume
    expect(h.removed).not.toContain("abandoned"); // kept for manual attention
    expect(h.notifs.inFlightCount()).toBe(0);
  });
});

describe("retryEmail", () => {
  test("retries with backoff until the job succeeds", async () => {
    const scheduled: { fn: () => void; ms: number }[] = [];
    let calls = 0;

    retryEmail(
      async () => {
        calls += 1;
        return calls >= 3;
      },
      "test email",
      (fn, ms) => scheduled.push({ fn, ms })
    );
    await settle();

    expect(calls).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(NOTIF_BASE_DELAY_MS);

    scheduled[0].fn();
    await settle();
    expect(calls).toBe(2);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].ms).toBe(NOTIF_BASE_DELAY_MS * 4);

    scheduled[1].fn();
    await settle();
    expect(calls).toBe(3);
    expect(scheduled).toHaveLength(2); // success → no further scheduling
  });

  test("retries when the job throws", async () => {
    const scheduled: { fn: () => void; ms: number }[] = [];
    let calls = 0;

    retryEmail(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return true;
      },
      "flaky email",
      (fn, ms) => scheduled.push({ fn, ms })
    );
    await settle();

    expect(calls).toBe(1);
    expect(scheduled).toHaveLength(1);
    scheduled[0].fn();
    await settle();
    expect(calls).toBe(2);
    expect(scheduled).toHaveLength(1); // succeeded on the retry
  });

  test("gives up after NOTIF_MAX_ATTEMPTS", async () => {
    const scheduled: { fn: () => void; ms: number }[] = [];
    let calls = 0;

    retryEmail(async () => {
      calls += 1;
      return false;
    }, "doomed email", (fn, ms) => scheduled.push({ fn, ms }));
    await settle();

    for (let i = 0; i < NOTIF_MAX_ATTEMPTS - 1; i++) {
      scheduled[i].fn();
      await settle();
    }

    expect(calls).toBe(NOTIF_MAX_ATTEMPTS);
    expect(scheduled).toHaveLength(NOTIF_MAX_ATTEMPTS - 1); // no schedule after giving up
  });
});
