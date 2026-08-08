/**
 * Money math for the raffle payout rule. Pure and dependency-free so the
 * 70%-of-raised rule can be unit-tested in isolation.
 *
 * Rule: the winner receives PAYOUT_RATIO (70%) of the total money raised;
 * the organizer keeps the remaining 30% (ticket money lands in their account
 * directly, only the prize is sent out).
 */

/** Fraction of raised money paid out to the winner (organizer keeps the rest). */
export const PAYOUT_RATIO = 0.7;

/**
 * Winner payout for a given raised total: raised × PAYOUT_RATIO, rounded to
 * exactly 2 decimal places (money-safe against JS float noise).
 */
export function payoutOf(raised: number): number {
  return Math.round(raised * PAYOUT_RATIO * 100) / 100;
}

/**
 * Advertised prize at full sell-out (ticketCount × price × PAYOUT_RATIO).
 * Used for the prize shown on the public page; the real payout uses the
 * actually-raised total (see payoutOf).
 */
export function prizeAmountOf(price: number, ticketCount: number): number {
  return Math.round(ticketCount * price * PAYOUT_RATIO * 100) / 100;
}

/**
 * True when a payout is legal to send. The withdraw endpoint refuses to send
 * money when the computed payout is zero or negative (no sales = no funds).
 */
export function payoutAllowed(payout: number): boolean {
  return payout > 0;
}
