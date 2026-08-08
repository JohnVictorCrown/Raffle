import { describe, expect, test } from "bun:test";
import { payoutOf, prizeAmountOf, payoutAllowed, PAYOUT_RATIO } from "./money";

describe("payoutOf — winner gets raised × 0.7", () => {
  test("pays 70% of the raised total", () => {
    expect(PAYOUT_RATIO).toBe(0.7);
    expect(payoutOf(100)).toBe(70);
    expect(payoutOf(8)).toBe(5.6); // live example: 80 tickets × R$ 0.1
    expect(payoutOf(0.6)).toBe(0.42); // live example: 6 sold × R$ 0.1
  });

  test("rounds to exactly 2 decimals", () => {
    expect(payoutOf(0.33)).toBe(0.23); // 0.231 → 0.23
    expect(payoutOf(1.05)).toBe(0.74); // 0.735 → 0.74 (rounds half up)
    expect(payoutOf(1)).toBe(0.7);
  });

  test("survives JS float noise in the raised sum", () => {
    // 6 × 0.1 === 0.6000000000000001 in IEEE-754 — must still yield R$ 0.42.
    expect(6 * 0.1).not.toBe(0.6);
    expect(payoutOf(6 * 0.1)).toBe(0.42);
    expect(payoutOf(3 * 0.33)).toBe(0.69); // 0.99 × 0.7 = 0.693 → 0.69
  });

  test("zero raised yields a zero payout (nothing to share)", () => {
    expect(payoutOf(0)).toBe(0);
  });
});

describe("prizeAmountOf — advertised prize at full sell-out", () => {
  test("ticketCount × price × 0.7", () => {
    expect(prizeAmountOf(0.1, 80)).toBe(5.6); // live raffle
    expect(prizeAmountOf(5, 100)).toBe(350);
  });

  test("rounds to 2 decimals", () => {
    expect(prizeAmountOf(0.33, 3)).toBe(0.69);
  });
});

describe("payoutAllowed — withdraw refuses non-positive payouts", () => {
  test("refuses zero or negative (no funds to pay out)", () => {
    expect(payoutAllowed(0)).toBe(false);
    expect(payoutAllowed(-0.01)).toBe(false);
  });

  test("allows a real payout", () => {
    expect(payoutAllowed(0.42)).toBe(true);
    expect(payoutAllowed(payoutOf(0.6))).toBe(true);
    expect(payoutAllowed(payoutOf(0))).toBe(false);
  });
});
