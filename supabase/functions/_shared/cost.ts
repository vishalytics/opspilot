// Cost of one query in INR. Prices are read from env vars because they change;
// copy them from https://ai.google.dev/gemini-api/docs/pricing when you deploy.

export interface Prices {
  inPerMillionUsd: number;
  outPerMillionUsd: number;
  embedPerMillionUsd: number;
  usdInr: number;
}

export function pricesFromEnv(get: (k: string) => string | undefined): Prices {
  const n = (k: string, d: number) => {
    const v = Number(get(k));
    return Number.isFinite(v) && get(k) !== undefined && get(k) !== "" ? v : d;
  };
  return {
    inPerMillionUsd: n("PRICE_IN_PER_M", 0),
    outPerMillionUsd: n("PRICE_OUT_PER_M", 0),
    embedPerMillionUsd: n("PRICE_EMBED_PER_M", 0.15),
    usdInr: n("USD_INR", 85),
  };
}

export function costInr(p: Prices, inputTokens: number, outputTokens: number, embedTokens: number): number {
  const usd = (inputTokens * p.inPerMillionUsd + outputTokens * p.outPerMillionUsd + embedTokens * p.embedPerMillionUsd) / 1_000_000;
  return Math.round(usd * p.usdInr * 100000) / 100000;
}
