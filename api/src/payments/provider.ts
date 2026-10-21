/** PaymentProvider interface (spec 14: swappable behind an interface).
 *  Which implementation runs is decided by registry.ts — the gateway desk, not this file. */
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
  /**
   * Ask the network to acknowledge these credentials without creating a charge.
   *
   * Optional, because not every rail can answer a question that costs nothing. The gateway desk
   * calls it so that "activate it and the system works" can be tested before a customer is the
   * first one to find out.
   */
  probe?(): Promise<string>;
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

  private async token(signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/v8/Checkout/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ appInfo: { appId: this.clientId, appName: this.clientSecret } })
    });
    if (!res.ok) throw new Error(`AzamPay token failed: ${res.status}`);
    const j: any = await res.json();
    const t = j.data?.access_token ?? j.access_token;
    // Checked here rather than left to the checkout call: a token that is really `undefined`
    // would otherwise be sent as the string "Bearer undefined" and come back as a 401 nobody
    // can explain.
    if (!t) throw new Error("The gateway answered but returned no token - check the app id and app name.");
    return String(t);
  }

  /** The desk's Test button. The same call a push begins with, so a rail that answers here has
   *  a reachable address and a working app id - and no money moves, because a token is not a
   *  charge. Capped: a network that hangs must not hang the person trying it. */
  async probe(): Promise<string> {
    const t = await this.token(AbortSignal.timeout(8000));
    return `The gateway accepted these credentials and issued a token (${t.length} characters).`;
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
