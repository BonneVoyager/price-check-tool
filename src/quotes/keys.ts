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
