/**
 * Where to find the server-side proxy, and whether to bother.
 *
 * Two deployments, deliberately different:
 *
 *  1. Vercel  — hosts /api/proxy AND uses it (same origin, so a relative path).
 *  2. Pages   — static only; calls deployment 1 cross-origin.
 *
 * Pages must keep working if the Vercel side is down or removed. So the proxy
 * is probed once, lazily, with a short timeout — on failure the two
 * proxy-dependent sources (OpenOcean, 0x) report themselves unavailable and the
 * other 18 quote exactly as they do today. Nothing else changes.
 */

/** The public Vercel deployment that hosts the proxy. */
const REMOTE_PROXY = "https://price-routing-tool.vercel.app/api/proxy";

/** How long to wait for the health probe before giving up on the proxy. */
const PROBE_TIMEOUT_MS = 4000;

/** Re-probe at most this often, so a transient failure isn't permanent. */
const PROBE_TTL_MS = 60_000;

function currentHost(): string {
  const loc = (globalThis as { location?: { hostname?: string } }).location;
  return loc?.hostname ?? "";
}

/**
 * Resolve the proxy base for this environment.
 *
 * - Same-origin when the page is served by something that has the function
 *   (the Vercel deployment), so it works on preview URLs too without a list of
 *   hostnames to maintain.
 * - `bun run dev` has its own /api/quote proxy already; that path is handled
 *   inside the OpenOcean adapter and doesn't come through here.
 * - Everything else (GitHub Pages, file://) uses the remote deployment.
 *
 * `localStorage.proxyBase` overrides all of it. Without that, a proxy change
 * can only be exercised after deploying — a localhost page points at the
 * DEPLOYED function, so new proxy targets fail with "Unknown target" until the
 * deploy lands, which looks like a code bug and isn't one. Set it to
 * `http://localhost:4319` (or wherever you run api/proxy.ts) to test locally.
 */
export function proxyBase(): string {
  try {
    const override = globalThis.localStorage?.getItem("proxyBase");
    if (override) return override;
  } catch {
    // Private mode / disabled storage: fall through to the defaults.
  }
  const host = currentHost();
  // Any *.vercel.app deployment of this project serves /api/proxy itself.
  if (host.endsWith(".vercel.app")) return "/api/proxy";
  // `bun run dev` mounts the same function, so localhost uses its OWN proxy and
  // therefore its own .env keys. Pointing at the deployed one instead would
  // silently ignore a key you just set locally.
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return "/api/proxy";
  }
  return REMOTE_PROXY;
}

/** Build a proxied URL for one of the allowlisted targets. */
export function proxyUrl(
  target: "openocean" | "zerox" | "zeroxCross" | "oneinch" | "oneclick",
  params: Record<string, string | number | undefined>,
): string {
  const qs = new URLSearchParams({ target });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    qs.set(k, String(v));
  }
  return `${proxyBase()}?${qs}`;
}

/**
 * Is the proxy reachable? Cached, and never throws.
 *
 * The probe is a real quote request rather than a /health route: a 200 proves
 * the whole path works (function up, upstream allowlisted, CORS readable),
 * which is the only thing worth knowing. A 502/timeout means "assume no proxy".
 */
let probe: { at: number; p: Promise<boolean> } | null = null;

export function proxyAvailable(): Promise<boolean> {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.p;

  const p = (async () => {
    try {
      // Cheapest real request: a tiny mainnet quote.
      const url = proxyUrl("openocean", {
        chain: "eth",
        in: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        out: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amount: "0.01",
        gasPrice: "5",
        slippage: "1",
      });
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const j = (await res.json()) as { code?: number };
      return j?.code === 200;
    } catch {
      // Offline, blocked, timed out, deployment gone — all "no proxy".
      return false;
    }
  })();

  probe = { at: Date.now(), p };
  return p;
}
