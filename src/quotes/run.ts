/**
 * Fan out one request to every adapter and rank the answers.
 *
 * Design notes:
 * - Results stream. `compareQuotes` takes an `onResult` callback so the UI can
 *   render each source the moment it lands; a slow API never blocks a fast one.
 * - Nothing rejects. Every adapter resolves to a `QuoteOutcome`, so one broken
 *   source can't take down the comparison.
 * - "Unsupported" is decided BEFORE any request, from `supports()`, so a source
 *   that legitimately can't serve a chain costs zero network time and is shown
 *   as a neutral note rather than an error.
 */

import { ADAPTERS } from "./adapters.ts";
import {
  isCrossChain,
  NoRouteError,
  type QuoteOutcome,
  type QuoteRequest,
} from "./types.ts";

/** What a caller may pass: either the full triple, or just `chain`. */
export type QuoteRequestInput = Omit<QuoteRequest, "chain" | "fromChain" | "toChain"> &
  Partial<Pick<QuoteRequest, "chain" | "fromChain" | "toChain">>;

/**
 * Fill in the chain triple so `chain`, `fromChain` and `toChain` are always
 * consistent. Callers can pass `chain` alone (same-chain, the common case) or
 * `fromChain`/`toChain` for a bridge; `chain` always mirrors the source.
 */
function normalise(input: QuoteRequestInput): QuoteRequest {
  const from = input.fromChain ?? input.chain;
  const to = input.toChain ?? input.fromChain ?? input.chain;
  if (!from || !to) throw new Error("A chain (or fromChain/toChain) is required");
  return { ...input, chain: from, fromChain: from, toChain: to } as QuoteRequest;
}

/**
 * Per-source timeout.
 *
 * Raised from 12s after WOWMAX was cut off around 15s and would have succeeded
 * given longer. Measured latency is normally sub-second (0.4–1.1s across
 * Stellar and EVM pairs), so a slow response means a cold start or transient
 * upstream slowness — exactly the case worth waiting out rather than reporting
 * as a timeout.
 *
 * 30s is the ceiling because the fan-out runs in parallel: one slow source
 * delays only its own row, not the others, and rows render as they land. The
 * cost of waiting is a single pending row; the cost of cutting early is a
 * missing quote that looks like a broken integration.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Reject a request whose token addresses don't match the chain's address format
 * BEFORE any adapter sees it.
 *
 * This is a backstop for UI state getting out of sync — a chain-switch race
 * once left "Stellar" selected with ETH/USDC `0x…` addresses, which every
 * adapter then dutifully forwarded. WOWMAX surfaced it as a 502, and their
 * team had to add error handling for a malformed request we should never have
 * sent. Catching it here means one clear message instead of N confusing
 * upstream errors, and no wasted requests.
 */
function addressShapeError(req: QuoteRequest): string | null {
  const isEvmAddr = (a: string) => /^0x[a-fA-F0-9]{40}$/.test(a.trim());

  // Each token is checked against its OWN chain — cross-chain means the two
  // sides can legitimately have different address formats (ETH `0x…` in,
  // Stellar `CODE:ISSUER` out).
  const sides: [{ address: string; symbol: string }, typeof req.fromChain][] = [
    [req.inToken, req.fromChain],
    [req.outToken, req.toChain],
  ];

  for (const [token, chain] of sides) {
    const evmShaped = isEvmAddr(token.address);
    if (chain.evm && !evmShaped) {
      return `${token.symbol} is not an EVM address — ${chain.name} expects 0x…`;
    }
    if (!chain.evm && evmShaped) {
      return `${token.symbol} is an EVM address, but ${chain.name} is not EVM — reselect the token`;
    }
  }
  return null;
}

/** Compare outputs of possibly-different decimals on a common scale. */
function toNumber(outAmount: string, decimals: number): number {
  const n = Number(outAmount);
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** decimals;
}

export interface CompareOptions {
  timeoutMs?: number;
  /** Called as each source settles, for progressive rendering. */
  onResult?: (outcome: QuoteOutcome) => void;
  /** Restrict to these adapter ids; default is all. */
  only?: string[];
}

export async function compareQuotes(
  input: QuoteRequestInput,
  opts: CompareOptions = {},
): Promise<QuoteOutcome[]> {
  const req = normalise(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const adapters = opts.only
    ? ADAPTERS.filter((a) => opts.only!.includes(a.id))
    : ADAPTERS;

  // One shape check for the whole fan-out: a mismatched pair is a UI-state bug,
  // not something any individual source can answer.
  const shapeError = addressShapeError(req);

  const tasks = adapters.map(async (a): Promise<QuoteOutcome> => {
    const started = Date.now();

    if (shapeError) {
      const outcome: QuoteOutcome = {
        ok: false,
        source: a.id,
        label: a.label,
        kind: "unsupported",
        message: shapeError,
        ms: 0,
      };
      opts.onResult?.(outcome);
      return outcome;
    }

    // A cross-chain request is meaningless to a same-chain source; say so up
    // front rather than letting each adapter quote the wrong thing.
    if (isCrossChain(req) && !a.crossChain) {
      const outcome: QuoteOutcome = {
        ok: false,
        source: a.id,
        label: a.label,
        kind: "unsupported",
        message: "Same-chain only — cannot bridge",
        ms: 0,
      };
      opts.onResult?.(outcome);
      return outcome;
    }

    // Cheap pre-flight: skip the network entirely when unsupported.
    const ok = a.supports(req);
    if (ok !== true) {
      const outcome: QuoteOutcome = {
        ok: false,
        source: a.id,
        label: a.label,
        kind: "unsupported",
        message: ok,
        ms: 0,
      };
      opts.onResult?.(outcome);
      return outcome;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const q = await a.quote(req, ctrl.signal);
      const outcome: QuoteOutcome = { ok: true, ...q, ms: Date.now() - started };
      opts.onResult?.(outcome);
      return outcome;
    } catch (err: unknown) {
      const aborted = ctrl.signal.aborted;
      // A NoRouteError carrying a transport/WAF message is really an error;
      // don't label a 403 or a bot-check as "no route", which would imply the
      // pair is illiquid when the request never reached the router.
      const msg = err instanceof Error ? err.message : String(err);
      const transport = /\b(403|401|429|5\d\d)\b|cloudflare|bot protection|non-json|failed to fetch|networkerror/i.test(msg);
      const noRoute = err instanceof NoRouteError && !transport;
      const outcome: QuoteOutcome = {
        ok: false,
        source: a.id,
        label: a.label,
        kind: aborted ? "timeout" : noRoute ? "no-route" : "error",
        message: aborted
          ? `No response in ${Math.round(timeoutMs / 1000)}s`
          : err instanceof Error
            ? err.message
            : String(err),
        ms: Date.now() - started,
      };
      opts.onResult?.(outcome);
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  });

  return Promise.all(tasks);
}

export interface RankedQuote {
  outcome: Extract<QuoteOutcome, { ok: true }>;
  /** 1 = best output. */
  rank: number;
  /** Percentage below the winner; 0 for the winner itself. */
  deltaPct: number;
  human: number;
}

/**
 * Rank successful quotes by output, best first.
 *
 * Compares on human-scaled values, since sources can report different decimals
 * for the same token — ranking raw base units would be wrong whenever they
 * disagree.
 */
export function rank(outcomes: QuoteOutcome[]): RankedQuote[] {
  const good = outcomes.filter(
    (o): o is Extract<QuoteOutcome, { ok: true }> => o.ok,
  );
  const scored = good
    .map((outcome) => ({
      outcome,
      human: toNumber(outcome.outAmount, outcome.outDecimals),
    }))
    .filter((x) => x.human > 0)
    .sort((a, b) => b.human - a.human);

  const best = scored[0]?.human ?? 0;
  return scored.map((x, i) => ({
    outcome: x.outcome,
    human: x.human,
    rank: i + 1,
    deltaPct: best > 0 ? ((x.human - best) / best) * 100 : 0,
  }));
}

/** Failures, ordered so genuine problems sort above "not supported here". */
export function failures(outcomes: QuoteOutcome[]) {
  const order = { error: 0, timeout: 1, "no-route": 2, unsupported: 3 };
  return outcomes
    .filter((o): o is Extract<QuoteOutcome, { ok: false }> => !o.ok)
    .sort((a, b) => order[a.kind] - order[b.kind]);
}
