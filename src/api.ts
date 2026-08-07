export interface CreatePaymentInput {
  email: string;
  name?: string;
  numbers: number[];
}

export interface PaymentCreated {
  id: string | number;
  status: string;
  external_reference: string;
  qr_code: string;
  qr_code_base64: string;
}

export interface PaymentStatus {
  id: string | number;
  status: string;
  external_reference?: string;
}

export interface WinnerInfo {
  number: number;
  email: string;
  at: number;
}

export interface PublicRaffle {
  id: string;
  title: string;
  prize: string;
  price: number;
  currency: string;
  ticketCount: number;
  available: number;
  soldNumbers: number[];
  soldCount: number;
  prizeAmount: number;
  winner: WinnerInfo | null;
  drawing: boolean;
  exists: boolean;
  claimPath: string | null;
}

export interface RaffleResponse {
  raffle: PublicRaffle | null;
}

// Backend base URL. In dev/self-hosted the frontend proxies "/api" to the
// Bun server. When deployed as a separate static site (e.g. Render), set
// VITE_API_URL at build time to the backend origin, e.g. https://api.example.com.
const API_ORIGIN = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
const BASE = `${API_ORIGIN}/api`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error((body as any)?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function createPixPayment(input: CreatePaymentInput): Promise<PaymentCreated> {
  return request<PaymentCreated>("/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getPaymentStatus(id: string | number): Promise<PaymentStatus> {
  return request<PaymentStatus>(`/payments/${id}`);
}

export async function getRaffle(lang?: string): Promise<PublicRaffle | null> {
  const q = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  const res = await request<RaffleResponse>(`/raffle${q}`);
  return res.raffle;
}

export function createAdminRaffle(input: {
  password: string;
  title: string;
  titlePt?: string;
  prize: string;
  prizePt?: string;
  price: number;
  currency: string;
  ticketCount: number;
}): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/admin/raffle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function checkApi(): Promise<{ ok: boolean; hasToken: boolean }> {
  try {
    return await request<{ ok: boolean; hasToken: boolean }>("/health");
  } catch {
    return { ok: false, hasToken: false };
  }
}

export interface MyRaffleEntry {
  raffleId: string;
  title: string;
  numbers: number[];
  amount: number;
  at: number;
  winnerNumber: number | null;
  won: boolean;
  ended: boolean;
}

export interface MyRaffles {
  name: string;
  email: string;
  raffles: MyRaffleEntry[];
}

export async function getMyRaffles(code: string): Promise<MyRaffles> {
  const res = await request<{ ok: boolean; user: MyRaffles }>(`/me?code=${encodeURIComponent(code)}`);
  return res.user;
}

export interface ClaimInfo {
  ok: boolean;
  number: number;
  prize: string;
  raffleTitle: string;
  payout: number;
  paid: boolean;
}

export function getClaim(token: string): Promise<ClaimInfo> {
  return request<ClaimInfo>(`/claim/check?token=${encodeURIComponent(token)}`);
}

export interface WithdrawResult {
  ok: boolean;
  payoutId?: string;
  status?: string;
  alreadyPaid?: boolean;
  error?: string;
}

export function submitWithdraw(input: {
  token: string;
  pixKey: string;
  pixKeyType: "email" | "cpf" | "phone" | "random";
}): Promise<WithdrawResult> {
  return request<WithdrawResult>("/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}