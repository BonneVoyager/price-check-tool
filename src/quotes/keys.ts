/**
 * API keys for sources that require one.
 *
 * ⚠️  THESE ARE PUBLIC. This app is a static site with no backend, so anything
 * here is bundled into `public/app.js` and visible to every visitor in DevTools
 * — and to anyone who fetches the JS directly. There is no way to hide a key in
 * a browser-only app; a "secret" in client code is not a secret.
 *
 * That is an acceptable trade for a local tool with free-tier keys. It is NOT
 * acceptable for anything metered, paid, or rate-limited against your quota.
 *
 * If a key here matters to you:
 *   1. Restrict it by HTTP referrer / allowed origin in the provider dashboard,
 *      so a copied key is useless from another domain; or
 *   2. Move the call behind a server route (a Vercel Function) and keep the key
 *      in an env var — the app was static-only by choice, not necessity.
 *
 * Override at build time without editing this file:
 *   ENSO_API_KEY=... bun run build
 */

/** Read a build-time env var where available, else fall back to the literal. */
function envOr(name: string, fallback: string): string {
  // `process` exists in Bun at build time; bundled output keeps the literal.
  const v =
    typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v && v.length > 0 ? v : fallback;
}

/**
 * Enso — works from the browser (sends CORS headers). Key is public by
 * necessity; see the warning above.
 */
export const ENSO_API_KEY = envOr(
  "ENSO_API_KEY",
  "1c7bf8a2-87e3-4b70-bd36-4d9852913fe7",
);

/**
 * 0x — read from the environment, with NO literal fallback here on purpose.
 *
 * `api.0x.org` sends no `access-control-allow-origin` header, so the browser
 * can never call it; shipping this key to the client would be both public and
 * useless. Absence is what keeps it out of `public/app.js` — I tried a
 * `--define` dead branch first and the string still survived minification, so
 * only *not writing it here* actually works.
 *
 * The CLI picks it up from `.env`, which Bun loads automatically and git
 * ignores:
 *
 *     echo 'ZEROX_API_KEY=your-key' >> .env
 *     bun run compare -- --chain eth --in ETH --out USDC --amount 1
 */
export const ZEROX_API_KEY: string = envOr("ZEROX_API_KEY", "");

/**
 * Soroswap (Stellar) — free key, but registration is required: sign up at
 * api.soroswap.finance/login and generate one. Without it every request is
 * `403 Forbidden`, so the adapter declares itself unsupported rather than
 * showing a permanent error row.
 *
 * Soroswap DOES send CORS headers, so unlike 0x this one can be used from the
 * browser — meaning a key placed here is public. Prefer restricting it by
 * origin in their dashboard, or set it only for CLI use via `.env`.
 */
export const SOROSWAP_API_KEY: string = envOr(
  "SOROSWAP_API_KEY",
  "sk_ae72b141d7477805d0d8e8e2173e006dd3f1b7cf66590f5c5ee7111232ad192a",
);

/**
 * Panora (Aptos) — the key below is the PUBLIC one Panora publishes in their own
 * docs (docs.panora.exchange/developer/swap/api) for open use, so it is not a
 * secret and shipping it in the bundle costs nothing. Override with
 * PANORA_API_KEY to use your own.
 */
export const PANORA_API_KEY: string = envOr(
  "PANORA_API_KEY",
  "a4^KV_EaTf4MW#ZdvgGKX#HUD^3IFEAOV_kzpIE^3BQGA8pDnrkT7JcIy#HNlLGi",
);

/**
 * 1inch — a free key from portal.1inch.dev. No literal on purpose: their API
 * sends no CORS headers, so it can only be called server-side anyway, and a
 * literal here would ship a personal key to every browser.
 */
export const ONEINCH_API_KEY: string = envOr("ONEINCH_API_KEY", "");

/**
 * Squid — `x-integrator-id` is a public identifier, not a secret: it is how they
 * attribute volume, and their own docs hand out ids for open use. `squid-api`
 * was verified working. Ships in the bundle, which is fine; override with
 * SQUID_INTEGRATOR_ID to attribute traffic to your own account.
 */
export const SQUID_INTEGRATOR_ID: string = envOr(
  "SQUID_INTEGRATOR_ID",
  "squid-api",
);

/**
 * NEAR Intents (1Click) — a partner JWT from partners.near-intents.org.
 *
 * This one materially changes the PRICE, not just access: unauthenticated
 * requests carry a 0.2% (20 bps) platform fee baked silently into `amountOut`,
 * while authenticated ones pay only the 0.0001% protocol fee. Measured on
 * 1 ETH -> USDC(base): 0.2646% implied cost with no key.
 *
 * No literal on purpose. It is a real secret, so it must never enter the browser
 * bundle — the adapter routes through the proxy, which reads it from env. 1Click
 * is CORS-open and even allows `x-api-key` from a browser, so the proxy hop
 * exists purely to keep the key server-side.
 */
export const ONECLICK_API_KEY: string = envOr("ONECLICK_API_KEY", "");

/**
 * Socket V3 (the API behind Bungee) — optional.
 *
 * Without it the adapter uses `public-backend`, which needs no key but is
 * "testing and prototyping" per Socket's own docs and rate-limits hard. With a
 * key it switches to `dedicated-backend` (20 rps, 100 for enterprise). Access is
 * request-only via a Google Form, not self-service:
 * https://docs.socket.tech/integrate/get-api-access
 *
 * No literal — a dedicated key is a real secret.
 */
export const SOCKET_API_KEY: string = envOr("SOCKET_API_KEY", "");

/**
 * Socket's affiliate id — issued alongside the API key, not derivable.
 *
 * `dedicated-backend` rejects a request without it ("Affiliate header is
 * required"), and rejects a guessed one ("Unrecognized affiliate"), so BOTH
 * values are needed to leave the free tier. Without it the adapter stays on
 * `public-backend`, which still quotes, just rate-limited.
 */
export const SOCKET_AFFILIATE: string = envOr("SOCKET_AFFILIATE", "");

/**
 * Pegaroute — a cross-chain routing engine (pegaroute.com).
 *
 * No literal: the key is private, and it is scoped to ONE environment. The
 * stagenet key is rejected by `api.pegaroute.com` with "Invalid API key", so
 * whichever key is configured must match PEGAROUTE_BASE below.
 */
export const PEGAROUTE_API_KEY: string = envOr("PEGAROUTE_API_KEY", "");

/**
 * Which Pegaroute deployment to call. Stagenet is the default because that is
 * what the current key is scoped to — it serves real mainnet prices, it is just
 * their pre-production host. Point this at the production base once a
 * production key exists.
 */
export const PEGAROUTE_BASE: string = envOr(
  "PEGAROUTE_BASE",
  "https://stagenet-app.pegaroute.com/api",
);
