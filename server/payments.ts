import { MercadoPagoConfig, Payment } from "mercadopago";
import type { Options } from "mercadopago/dist/types";
import type { PaymentCreateRequest } from "mercadopago/dist/clients/payment/create/types";
import type { PaymentResponse } from "mercadopago/dist/clients/payment/commonTypes";

export interface PendingOrder {
  orderId: string;
  paymentId: string;
  status: string;
  createdAt: number;
  numbers: number[];
  buyer: string;
}

const orders = new Map<string, PendingOrder>();

function getClient(): MercadoPagoConfig {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(
      "Mercado Pago is not configured. Set MP_ACCESS_TOKEN (a TEST-… or APP_USR-… token) in your .env file, then restart the server."
    );
  }
  return new MercadoPagoConfig({ accessToken });
}

export interface CreatePixOrderOpts {
  transaction_amount: number;
  description: string;
  payerEmail: string;
  payerName: string;
  externalReference: string;
  numbers: number[];
  buyer: string;
}

/**
 * Creates a PIX payment via the Mercado Pago Payments API (Transparent
 * Checkout, `POST /v1/payments` with `payment_method_id: "pix"`). The result
 * carries the QR data under `point_of_interaction.transaction_data`.
 */
export async function createPixOrder(opts: CreatePixOrderOpts): Promise<{
  order: PaymentResponse;
  paymentId: string;
  qrCode: string;
  qrCodeBase64: string;
  pending: PendingOrder;
}> {
  const payment = new Payment(getClient());

  const body: PaymentCreateRequest = {
    transaction_amount: opts.transaction_amount,
    description: opts.description,
    payment_method_id: "pix",
    external_reference: opts.externalReference,
    payer: {
      email: opts.payerEmail,
      first_name: opts.payerName,
    },
  };

  const requestOptions: Options = {
    idempotencyKey: `${opts.externalReference}-${Date.now()}`,
  };

  const res = await payment.create({ body, requestOptions });

  const tx = res?.point_of_interaction?.transaction_data as
    | { qr_code?: string; qr_code_base64?: string }
    | undefined;
  const paymentId = String(res.id ?? "");

  const pending: PendingOrder = {
    orderId: paymentId,
    paymentId,
    status: String(res.status ?? "pending"),
    createdAt: Date.now(),
    numbers: opts.numbers,
    buyer: opts.buyer,
  };
  if (paymentId) orders.set(paymentId, pending);

  return {
    order: res,
    paymentId,
    qrCode: tx?.qr_code ?? "",
    qrCodeBase64: tx?.qr_code_base64 ?? "",
    pending,
  };
}

/** Fetch the current status of a payment by its payment id. */
export async function getPaymentStatusById(paymentId: string): Promise<string> {
  const payment = new Payment(getClient());
  const res = await payment.get({ id: paymentId });
  return String(res.status ?? "pending");
}

export function getPendingOrder(id: string): PendingOrder | undefined {
  return orders.get(id);
}

/**
 * Payout a winner by PIX. Requires the MP account to have PIX outgoing (PIX
 * automático / AUM) enabled; otherwise Mercado Pago returns an error which we
 * surface to the caller. Best-effort: resolves with the MP payment id on
 * success, or an error message.
 */
export async function processPixPayout(opts: {
  transactionAmount: number;
  pixKey: string;
  pixKeyType: "email" | "cpf" | "phone" | "random";
  description: string;
}): Promise<{ ok: boolean; id?: string; status?: string; error?: string }> {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "MP_ACCESS_TOKEN is not configured." };

  try {
    const res = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
      body: JSON.stringify({
        transaction_amount: opts.transactionAmount,
        description: opts.description,
        payment_method_id: "pix",
        payer: {
          email: opts.pixKey,
        },
        ...(opts.pixKeyType === "cpf" && {
          payer: { email: opts.pixKey, identification: { type: "CPF", number: opts.pixKey } },
        }),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      return { ok: false, error: data?.message ?? data?.error ?? `Mercado Pago error (${res.status})` };
    }
    return { ok: true, id: data?.id, status: data?.status };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Unable to reach Mercado Pago" };
  }
}