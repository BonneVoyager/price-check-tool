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


/**
 * Fallback icon by SYMBOL, for tokens whose source list carries no icon URL.
 *
 * Seeded chains (Stellar, Starknet) have no OpenOcean token list at all, so
 * every one of their tokens rendered as a letter circle. CoinCap's asset icons
 * are a plain URL keyed by lowercase symbol — no API, no key, no rate limit to
 * manage — and cover the majors we care about (verified in-browser: XLM, SUI,
 * APT, NEAR, STRK, BTC, ETH, USDC, USDT, WBTC, XRP, PYUSD all load; AQUA, EURC,
 * SHX, yXLM do not).
 *
 * A miss is harmless: the URL 404s, the <img> onerror fires, and the letter
 * circle comes back — exactly the state these tokens were in before. So this is
 * strictly additive, which is why it's fine to guess by symbol.
 *
 * CoinGecko was the alternative but its API needs a per-coin lookup and throttles
 * hard without a key; this needs neither.
 */
const SYMBOL_ICON_BASE = "https://assets.coincap.io/assets/icons";

/** Symbols we know CoinCap does NOT have, so we skip the doomed request. */
const NO_SYMBOL_ICON = new Set(["AQUA", "EURC", "SHX", "YXLM", "USDX", "USDGLO", "USDP", "SUSD", "VELO"]);

export function symbolIconUrl(symbol: string): string | undefined {
  const s = (symbol ?? "").trim();
  // Wrapped y-assets and long-tail Stellar anchors aren't on CoinCap.
  if (!s || !/^[A-Za-z0-9]{2,8}$/.test(s)) return undefined;
  if (NO_SYMBOL_ICON.has(s.toUpperCase())) return undefined;
  return `${SYMBOL_ICON_BASE}/${s.toLowerCase()}@2x.png`;
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
    icon: t.icon || symbolIconUrl(t.symbol ?? ""),
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

/**
 * Chains OpenOcean's /tokenList does NOT serve, so the picker has something to
 * show. Only needed where a non-OpenOcean aggregator brought the chain in.
 */
const SEED_TOKENS: Record<string, UiToken[]> = {
  stellar: [
    { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, isNative: true, isHot: true },
    { address: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", symbol: "USDC", name: "USDC", decimals: 7, isNative: false, isHot: true },
    { address: "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA", symbol: "AQUA", name: "AQUA", decimals: 7, isNative: false, isHot: true },
    { address: "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2", symbol: "EURC", name: "EURC", decimals: 7, isNative: false, isHot: true },
    { address: "yXLM:GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55", symbol: "yXLM", name: "yXLM", decimals: 7, isNative: false, isHot: true },
    { address: "XRP:GBXRPL45NPHCVMFFAYZVUVFFVKSIZ362ZXFP7I2ETNQ3QKZMFLPRDTD5", symbol: "XRP", name: "XRP", decimals: 7, isNative: false, isHot: true },
    { address: "SHX:GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH", symbol: "SHX", name: "SHX", decimals: 7, isNative: false, isHot: true },
    { address: "BTC:GDPJALI4AZKUU2W426U5WKMAT6CN3AJRPIIRYR2YM54TL2GDWO5O2MZM", symbol: "BTC", name: "BTC", decimals: 7, isNative: false, isHot: true },
    { address: "ETH:GBFXOHVAS43OIWNIO7XLRJAHT3BICFEIKOJLZVXNT572MISM4CMGSOCC", symbol: "ETH", name: "ETH", decimals: 7, isNative: false, isHot: true },
    { address: "PYUSD:GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5", symbol: "PYUSD", name: "PYUSD", decimals: 7, isNative: false, isHot: true },
  ],
  starknet: [
    { address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", symbol: "ETH", name: "Ether", decimals: 18, isNative: true, isHot: true },
    { address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8", symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false, isHot: true },
    { address: "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8", symbol: "USDT", name: "Tether USD", decimals: 6, isNative: false, isHot: true },
    { address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", symbol: "STRK", name: "Starknet Token", decimals: 18, isNative: false, isHot: true },
    { address: "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac", symbol: "WBTC", name: "Wrapped BTC", decimals: 8, isNative: false, isHot: true },
  ],
};

export async function loadTokens(chainCode: string): Promise<UiToken[]> {
  const hit = cache.get(chainCode);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tokens;

  const chain = findChain(chainCode);
  if (!chain) throw new Error(`Unknown chain "${chainCode}"`);

  const seeded = SEED_TOKENS[chainCode];
  if (seeded) {
    // Seeded chains have no upstream icons at all; fill them in by symbol.
    const withIcons = seeded.map((t) => ({
      ...t,
      icon: t.icon || symbolIconUrl(t.symbol),
    }));
    cache.set(chainCode, { at: Date.now(), tokens: withIcons });
    return withIcons;
  }

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
      icon: symbolIconUrl(chain.nativeSymbol),
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
export async function chainsWithIcons(
  chains: ChainInfo[],
  /**
   * Wall-clock budget. Past this we stop starting new upstream lookups and
   * return what we have, so the endpoint can't hang near a platform timeout.
   * Chains that miss out keep letter initials and resolve on a later request
   * (their token lists are cached by then, so the next call is fast).
   */
  budgetMs = 8000,
) {
  const out: (ChainInfo & { icon: string | null })[] = [];
  const started = Date.now();
  const BATCH = 8;

  for (let i = 0; i < chains.length; i += BATCH) {
    const slice = chains.slice(i, i + BATCH);

    // Built-in marks are free (no fetch), so never skip those on budget.
    const overBudget = Date.now() - started > budgetMs;
    const done = await Promise.all(
      slice.map(async (c) => {
        if (CHAIN_MARKS[c.code]) return { ...c, icon: CHAIN_MARKS[c.code]! };
        if (overBudget && !iconCache.has(c.code)) return { ...c, icon: null };
        return { ...c, icon: await chainIcon(c) };
      }),
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
