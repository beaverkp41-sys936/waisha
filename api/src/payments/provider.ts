/** PaymentProvider interface (spec 14: swappable behind an interface).
 *  Mock is active in sandbox; AzamPay activates by env when credentials land. */
import { env } from "../env.js";

export interface PushInput {
  intentReference: string;
  amount: number;
  currency: string;
  phone: string;
  description: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** Initiate the customer push (USSD/app PIN prompt). Resolves once the
   *  request is ACCEPTED by the network - completion arrives via webhook. */
  push(input: PushInput): Promise<void>;
}

export class MockProvider implements PaymentProvider {
  readonly name = "mock";
  async push(input: PushInput): Promise<void> {
    console.log(`[mock:push] ref=${input.intentReference} to=${input.phone} amount=${input.amount} ${input.currency}`);
  }
}

/** AzamPay adapter - structured now; endpoints marked VERIFY-ON-INTEGRATION
 *  against the official developer docs the day credentials arrive. */
export class AzamPayProvider implements PaymentProvider {
  readonly name = "azampesa";

  constructor(
    private baseUrl: string,
    private clientId: string,
    private clientSecret: string
  ) {
    if (!baseUrl || !clientId || !clientSecret) {
      throw new Error("AzamPay not configured: set AZAMPAY_BASE_URL / CLIENT_ID / CLIENT_SECRET");
    }
  }

  private async token(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/v8/Checkout/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appInfo: { appId: this.clientId, appName: this.clientSecret } })
    });
    if (!res.ok) throw new Error(`AzamPay token failed: ${res.status}`);
    const j: any = await res.json();
    return j.data?.access_token ?? j.access_token;
  }

  async push(input: PushInput): Promise<void> {
    const t = await this.token();
    const res = await fetch(`${this.baseUrl}/api/v8/Checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({
        tranreference: input.intentReference,
        amount: input.amount,
        currency: input.currency,
        msisdn: input.phone,
        narration: input.description
      })
    });
    if (!res.ok) throw new Error(`AzamPay push failed: ${res.status} ${await res.text()}`);
  }
}

export function getProvider(): PaymentProvider {
  if (env.PAYMENT_PROVIDER === "azampay") {
    return new AzamPayProvider(env.AZAMPAY_BASE_URL, env.AZAMPAY_CLIENT_ID, env.AZAMPAY_CLIENT_SECRET);
  }
  return new MockProvider();
}