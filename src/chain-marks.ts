/**
 * Brand marks for chains whose token-list icon is ambiguous.
 *
 * WHY THIS EXISTS
 * ---------------
 * chainIcon() in tokens.ts derives a logo from each chain's native/wrapped
 * token, which covers all 42 chains. But every ETH-native L2 (Base, Arbitrum,
 * Optimism, Linea, Scroll, zkSync, Blast, Mode, Manta, Aurora, Polygon zkEVM)
 * resolves to its local WETH token — and those all use the generic ETH diamond.
 * Distinct URLs, visually identical icons, twelve indistinguishable rows.
 *
 * So for those chains we ship the real brand mark inline. Data URIs keep the
 * project dependency-free and network-free: no CDN to rot, no hashed build
 * asset to break on OpenOcean's next deploy, nothing to rate-limit.
 *
 * Chains NOT listed here fall through to the token-list icon, which is already
 * unambiguous (BNB, Polygon, Avalanche, Solana, Sui, …).
 *
 * Marks are simplified single-colour glyphs on the brand colour — recognisable
 * at 21px, which is the only size they render at.
 */

/** Wrap raw SVG markup as a data URI usable in an <img src>. */
function svg(body: string): string {
  const doc =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;
  // encodeURIComponent (not base64) keeps these greppable and diff-friendly.
  return `data:image/svg+xml,${encodeURIComponent(doc)}`;
}

const circle = (fill: string) => `<circle cx="16" cy="16" r="16" fill="${fill}"/>`;

export const CHAIN_MARKS: Record<string, string> = {
  // Optimism — red circle, white "O" ring.
  optimism: svg(
    `${circle("#FF0420")}<circle cx="16" cy="16" r="6.5" fill="none" stroke="#fff" stroke-width="3.2"/>`,
  ),

  // Base — blue circle with the white square-ish arc.
  base: svg(
    `${circle("#0052FF")}<path d="M16 7.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 8.35-7H16v-3h8.35A8.5 8.5 0 0 0 16 7.5z" fill="#fff"/>`,
  ),

  // Arbitrum — dark navy with the blue/white peak motif.
  arbitrum: svg(
    `${circle("#213147")}<path d="M16 6l7.5 13H18l-2-3.6-2 3.6H8.5L16 6z" fill="#12AAFF"/><path d="M16 15.4l3.6 6.6h-7.2l3.6-6.6z" fill="#fff"/>`,
  ),

  // Linea — black with white angular "L".
  linea: svg(
    `${circle("#121212")}<path d="M11 8h3.4v12.2H23V24H11V8z" fill="#fff"/><circle cx="21.5" cy="10.5" r="3" fill="#fff"/>`,
  ),

  // Scroll — parchment/amber scroll.
  scroll: svg(
    `${circle("#FFDEB5")}<path d="M9 11.5a3.5 3.5 0 0 1 3.5-3.5H23v11.5H12.5A3.5 3.5 0 0 1 9 16v-4.5z" fill="none" stroke="#101010" stroke-width="2"/><path d="M13 20h10a3 3 0 0 1-3 4H12" fill="none" stroke="#101010" stroke-width="2"/>`,
  ),

  // zkSync Era — white bg, dark chevrons.
  zksync: svg(
    `${circle("#F4F4F4")}<path d="M24 16l-7-6v4.4H10.5L8 16l7 6v-4.4h6.5L24 16z" fill="#1E69FF"/>`,
  ),

  // Blast — yellow with black "B".
  blast: svg(
    `${circle("#FCFC03")}<path d="M9 12h9.5c2.5 0 4 1.3 4 3.2 0 1.4-.8 2.3-2 2.7 1.4.3 2.4 1.3 2.4 3 0 2.1-1.7 3.6-4.4 3.6H9V12zm3.4 2.6v2.3h5.3c1 0 1.6-.4 1.6-1.2s-.6-1.1-1.6-1.1h-5.3zm0 4.6v2.6h5.6c1.1 0 1.8-.4 1.8-1.3s-.7-1.3-1.8-1.3h-5.6z" fill="#000"/><path d="M8 8h16l-2 2.4H8V8z" fill="#000"/>`,
  ),

  // Mode — lime green with dark "M".
  mode: svg(
    `${circle("#DFFE00")}<path d="M8 23V10h4.6l3.4 7 3.4-7H24v13h-3.4v-7.6L17.4 23h-2.8l-3.2-7.6V23H8z" fill="#000"/>`,
  ),

  // Manta Pacific — deep blue with white ring + dot.
  manta: svg(
    `${circle("#1B2233")}<circle cx="16" cy="16" r="7" fill="none" stroke="#29CCB9" stroke-width="2.4"/><circle cx="22.4" cy="9.6" r="2.6" fill="#29CCB9"/>`,
  ),

  // Aurora — green circle with white swoosh.
  aurora: svg(
    `${circle("#70D44B")}<path d="M16 7l7.5 13.5H8.5L16 7z" fill="#fff"/>`,
  ),

  // Polygon zkEVM — purple with the Polygon-style hexes plus zk bar.
  polygon_zkevm: svg(
    `${circle("#7B3FE4")}<path d="M21 12.6l-3.4-2-3.4 2v3.9l-2.6 1.5-2.6-1.5v-3l2.6-1.5 1.7 1V11l-1.7-1L8 11.5v4.6l3.6 2.1 3.6-2.1v-3.9l2.5-1.4 2.5 1.4v3l-2.5 1.4-1.7-1v2.5l1.7 1 3.6-2.1v-4.6L21 12.6z" fill="#fff"/>`,
  ),

  // Ethereum mainnet — keep the canonical diamond, but on-brand so it reads as
  // "mainnet" rather than "some ETH token".
  eth: svg(
    `${circle("#627EEA")}<path d="M16 5v8.2l6.9 3.1L16 5z" fill="#fff" fill-opacity=".6"/><path d="M16 5L9.1 16.3l6.9-3.1V5z" fill="#fff"/><path d="M16 21.5V27l6.9-9.6-6.9 4.1z" fill="#fff" fill-opacity=".6"/><path d="M16 27v-5.5l-6.9-4.1L16 27z" fill="#fff"/><path d="M16 20.2l6.9-4.1-6.9-3.1v7.2z" fill="#fff" fill-opacity=".2"/><path d="M9.1 16.1l6.9 4.1V13l-6.9 3.1z" fill="#fff" fill-opacity=".6"/>`,
  ),

  // ---------------------------------------------------------------------------
  // The two chains below need a mark for a different reason than the L2s above.
  // They aren't ambiguous — they're absent: OpenOcean serves neither, so the
  // token-list tier has nothing at all to derive a logo from and they fell
  // through to letter initials.
  // ---------------------------------------------------------------------------

  // Starknet — deep navy with the angular StarkNet chevron/star motif.
  starknet: svg(
    `${circle("#0C0C4F")}<path d="M16 6.5l2.6 5.4 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.9L16 6.5z" fill="#FF8A00"/><circle cx="16" cy="15.4" r="2.1" fill="#0C0C4F"/>`,
  ),

  // Gravity — the one chain with no icon anywhere: DefiLlama has no entry, and
  // its native ticker "G" 404s on every symbol CDN (too short to be unique).
  // Orange disc with a white G, matching Gravity's brand colour.
  gravity: svg(
    `${circle("#FF5C00")}<path d="M20.6 12.4a5.6 5.6 0 1 0 .6 5.2h-5V15h7.6v1.2a8.2 8.2 0 1 1-1.6-5l-1.6 1.2z" fill="#fff"/>`,
  ),

  // Stellar — black with the white rocket/orbit glyph.
  stellar: svg(
    `${circle("#0F0F0F")}<path d="M24.5 9.9l-3 1.5a7.4 7.4 0 0 0-11 7.7l-2.9 1.5-.9-1.8 2.6-1.3a9.4 9.4 0 0 1 13.9-9.4l1.3.6v1.2z" fill="#fff"/><path d="M7.5 22.1l3-1.5a7.4 7.4 0 0 0 11-7.7l2.9-1.5.9 1.8-2.6 1.3a9.4 9.4 0 0 1-13.9 9.4l-1.3-.6v-1.2z" fill="#fff"/>`,
  ),
};
