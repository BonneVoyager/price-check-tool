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
  NoRouteError,
  type QuoteOutcome,
  type QuoteRequest,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 12_000;

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
  req: QuoteRequest,
  opts: CompareOptions = {},
): Promise<QuoteOutcome[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const adapters = opts.only
    ? ADAPTERS.filter((a) => opts.only!.includes(a.id))
    : ADAPTERS;

  const tasks = adapters.map(async (a): Promise<QuoteOutcome> => {
    const started = Date.now();

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
