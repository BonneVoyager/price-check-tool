/**
 * Token list fetching, normalisation and caching.
 *
 * Two quirks in the raw /tokenList data that this module papers over:
 *
 * 1. NATIVE COIN MISSING. polygon, avax and every non-EVM chain omit their
 *    native coin from the list, even though the sentinel address swaps fine.
 *    We inject a synthetic entry so it stays selectable.
 *
 * 2. SENTINEL SQUATTERS. On eth, FOUR tokens claim an address that lowercases
 *    to the native sentinel (ELK, ETH, ASKO, ETHV) — only the exact-case
 *    `0xEeeeeEee…EEeE` one is the real native coin. Naively taking the first
 *    lowercase match hands you `ELK` instead of `ETH`. We de-dupe so the real
 *    native always wins.
 */

import { CHAIN_MARKS } from "./chain-marks.ts";
import {
  findChain,
  isNativeAddress,
  nativeAddressFor,
  type ChainInfo,
} from "./chains.ts";
import { getTokenList } from "./openocean.ts";
import type { OoToken } from "./types.ts";

export interface UiToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
  /** USD price as a number, when the API supplied one. */
  usd?: number;
  /** True for the chain's gas coin. */
  isNative: boolean;
  /** API marks ~20 popular tokens per chain; we surface these first. */
  isHot: boolean;
}

/** In-memory cache — token lists change rarely and are up to ~660 entries. */
const cache = new Map<string, { at: number; tokens: UiToken[] }>();
const TTL_MS = 10 * 60 * 1000;

function toUi(t: OoToken & { hot?: unknown; usd?: string }, native: boolean): UiToken {
  const usd = t.usd !== undefined && t.usd !== null ? Number(t.usd) : undefined;
  return {
    address: t.address,
    symbol: t.symbol ?? "?",
    name: t.name ?? "",
    decimals: Number(t.decimals ?? 18),
    icon: t.icon,
    usd: Number.isFinite(usd) ? usd : undefined,
    isNative: native,
    isHot: t.hot !== null && t.hot !== undefined && t.hot !== "",
  };
}

/**
 * Sort: native first, then hot tokens, then by USD price as a rough liquidity
 * proxy, then alphabetically. Keeps the useful tokens at the top of a 600-entry
 * list without needing a separate liquidity feed.
 */
function sortTokens(a: UiToken, b: UiToken): number {
  if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
  if (a.isHot !== b.isHot) return a.isHot ? -1 : 1;
  const au = a.usd ?? -1;
  const bu = b.usd ?? -1;
  if (au !== bu) return bu - au;
  return a.symbol.localeCompare(b.symbol);
}

export async function loadTokens(chainCode: string): Promise<UiToken[]> {
  const hit = cache.get(chainCode);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tokens;

  const chain = findChain(chainCode);
  if (!chain) throw new Error(`Unknown chain "${chainCode}"`);

  const raw = await getTokenList(chainCode);
  const tokens = normalise(raw, chain);

  cache.set(chainCode, { at: Date.now(), tokens });
  return tokens;
}

/** Exported for testing without a network call. */
export function normalise(raw: OoToken[], chain: ChainInfo): UiToken[] {
  const nativeAddr = nativeAddressFor(chain);

  // Keep only the genuine native entry: exact-case sentinel match, or failing
  // that, the one whose symbol matches the chain's known native symbol. This is
  // what stops ELK/ASKO/ETHV from being mistaken for ETH.
  const isRealNative = (t: OoToken) =>
    t.address === nativeAddr ||
    (isNativeAddress(t.address) &&
      (t.symbol ?? "").toUpperCase() === chain.nativeSymbol.toUpperCase());

  const out: UiToken[] = [];
  let sawNative = false;

  for (const t of raw ?? []) {
    if (!t?.address || !t?.symbol) continue;

    if (isNativeAddress(t.address)) {
      // Drop squatters; keep the one true native.
      if (!isRealNative(t) || sawNative) continue;
      sawNative = true;
      out.push(toUi(t, true));
      continue;
    }
    out.push(toUi(t, false));
  }

  // Chains whose list omits native (polygon, avax, non-EVM): synthesise it.
  if (!sawNative) {
    out.push({
      address: nativeAddr,
      symbol: chain.nativeSymbol,
      name: `${chain.name} native coin`,
      decimals: 18,
      isNative: true,
      isHot: true,
    });
  }

  return out.sort(sortTokens);
}

/**
 * Chain logo, resolved in two tiers.
 *
 * 1. A built-in brand mark (CHAIN_MARKS), for chains the token list cannot
 *    distinguish. Every ETH-native L2 resolves to its local WETH token, and
 *    those all use the generic ETH diamond — so Base, Arbitrum, Optimism,
 *    Linea, Scroll, zkSync, Blast, Mode, Manta, Aurora and Polygon zkEVM would
 *    otherwise render as eleven identical icons. Inline SVG data URIs, so
 *    there's no CDN to rot and no build asset to break.
 *
 * 2. Otherwise the token list: a chain's native coin and its wrapped twin share
 *    a logo (the Polygon mark IS the wPOL icon). Native first, then wrapped —
 *    26 of 42 chains have no icon on the bare native entry (often because we
 *    synthesised it) while the wrapped ERC-20 always does. That fallback is
 *    what takes token-derived coverage from 16/42 to 42/42.
 *
 * Cached per chain, so repeat lookups across /api/chainIcons calls are free.
 */
const iconCache = new Map<string, string | null>();

export async function chainIcon(chain: ChainInfo): Promise<string | null> {
  if (iconCache.has(chain.code)) return iconCache.get(chain.code) ?? null;

  const mark = CHAIN_MARKS[chain.code];
  if (mark) {
    iconCache.set(chain.code, mark);
    return mark;
  }

  let icon: string | null = null;
  try {
    const tokens = await loadTokens(chain.code);
    const sym = chain.nativeSymbol.toUpperCase();
    // e.g. ETH -> ETH, WETH;  POL -> POL, WPOL;  rBTC -> RBTC, WRBTC
    const candidates = [sym, `W${sym}`];
    for (const want of candidates) {
      const hit = tokens.find((t) => t.symbol.toUpperCase() === want && t.icon);
      if (hit?.icon) {
        icon = hit.icon;
        break;
      }
    }
  } catch {
    // A chain whose token list fails just falls back to initials in the UI.
    icon = null;
  }

  iconCache.set(chain.code, icon);
  return icon;
}

/**
 * CHAINS decorated with logo URLs.
 *
 * Chains with a built-in mark resolve instantly; the rest need a token-list
 * fetch, so those run in small batches. Firing all 30 at once made the whole
 * response exceed Bun.serve's 10s idleTimeout on a cold cache.
 */
export async function chainsWithIcons(chains: ChainInfo[]) {
  const out: (ChainInfo & { icon: string | null })[] = [];
  const BATCH = 8;

  for (let i = 0; i < chains.length; i += BATCH) {
    const slice = chains.slice(i, i + BATCH);
    const done = await Promise.all(
      slice.map(async (c) => ({ ...c, icon: await chainIcon(c) })),
    );
    out.push(...done);
  }
  return out;
}

/**
 * Resolve user input to an address: a 0x/base58 address passes through, a
 * symbol is matched case-insensitively against the chain's list.
 */
export function resolveToken(
  tokens: UiToken[],
  input: string,
): UiToken | undefined {
  const v = (input ?? "").trim();
  if (!v) return undefined;

  const byAddress = tokens.find(
    (t) => t.address.toLowerCase() === v.toLowerCase(),
  );
  if (byAddress) return byAddress;

  const up = v.toUpperCase();
  // Prefer an exact symbol hit; hot/native sort order breaks ties sensibly.
  return tokens.find((t) => t.symbol.toUpperCase() === up);
}
