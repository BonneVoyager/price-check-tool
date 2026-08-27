/**
 * Derive Soroban contract ids for classic Stellar assets.
 *
 * Soroswap's API only accepts Soroban contract ids (`C…`) — passing the classic
 * `CODE:ISSUER` form gets "Invalid Stellar address". Its own `/api/tokens`
 * endpoint returns an EMPTY asset list for mainnet (only testnet is populated),
 * so it can't supply the mapping either.
 *
 * Fortunately the id isn't arbitrary: every classic asset has a deterministic
 * Stellar Asset Contract address, `SHA-256` of an XDR preimage, so we can
 * compute it for ANY asset instead of maintaining a hand-written table that
 * silently rejects everything not in it.
 *
 * Verified against three independently-known ids (XLM, USDC, AQUA) — see
 * `contractIdForAsset`'s test vectors in the README.
 *
 * Zero dependencies: StrKey is base32 + CRC16-XModem, both short enough to
 * implement directly rather than pull in `@stellar/stellar-base`.
 */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Mainnet passphrase. Testnet would hash to different contract ids. */
const PUBLIC_NETWORK = "Public Global Stellar Network ; September 2015";

/**
 * XDR discriminants, from stellar-xdr. These are the values that matter and the
 * ones easiest to get wrong — `ENVELOPE_TYPE_CONTRACT_ID` is 8, not the 2 that
 * `ENVELOPE_TYPE_TX` uses.
 */
const ENVELOPE_TYPE_CONTRACT_ID = 8;
const CONTRACT_ID_PREIMAGE_FROM_ASSET = 1;
const ASSET_TYPE_NATIVE = 0;
const ASSET_TYPE_CREDIT_ALPHANUM4 = 1;
const ASSET_TYPE_CREDIT_ALPHANUM12 = 2;
/** PublicKey union: ed25519 is discriminant 0. */
const PUBLIC_KEY_TYPE_ED25519 = 0;
/** StrKey version byte for a contract address, which renders as a leading "C". */
const STRKEY_VERSION_CONTRACT = 2 << 3;

function base32Decode(input: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "")) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Not base32: "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** CRC16-XModem, as StrKey's checksum (little-endian, appended). */
function crc16(data: Uint8Array): Uint8Array {
  let crc = 0;
  for (const byte of data) {
    let code = (crc >>> 8) & 0xff;
    code ^= byte;
    code ^= code >>> 4;
    crc = ((crc << 8) & 0xffff) ^ ((code << 12) & 0xffff) ^ ((code << 5) & 0xffff) ^ code;
  }
  return new Uint8Array([crc & 0xff, (crc >> 8) & 0xff]);
}

/** Strip a StrKey's version byte and checksum, leaving the 32-byte payload. */
function strkeyDecode(key: string): Uint8Array {
  const raw = base32Decode(key);
  if (raw.length < 3) throw new Error(`StrKey too short: ${key}`);
  return raw.slice(1, raw.length - 2);
}

function strkeyEncode(version: number, payload: Uint8Array): string {
  const body = new Uint8Array(1 + payload.length);
  body[0] = version;
  body.set(payload, 1);
  const checksum = crc16(body);
  const full = new Uint8Array(body.length + checksum.length);
  full.set(body);
  full.set(checksum, body.length);
  return base32Encode(full);
}

/** XDR ints are 4-byte big-endian. */
function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  // Explicit ArrayBuffer (not ArrayBufferLike) so the result satisfies
  // BufferSource for crypto.subtle.digest.
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * XDR-encode a classic Asset.
 *
 * The asset code is zero-padded to a fixed 4 or 12 bytes — which of the two
 * decides the union discriminant, so a 5-character code is ALPHANUM12.
 */
function encodeAsset(code: string, issuer: string): Uint8Array {
  if (code === "native") return u32(ASSET_TYPE_NATIVE);

  const width = code.length <= 4 ? 4 : 12;
  const type = code.length <= 4 ? ASSET_TYPE_CREDIT_ALPHANUM4 : ASSET_TYPE_CREDIT_ALPHANUM12;
  if (code.length > 12) throw new Error(`Asset code too long: ${code}`);

  const codeBytes = new Uint8Array(width);
  codeBytes.set(new TextEncoder().encode(code));

  return concat([
    u32(type),
    codeBytes,
    u32(PUBLIC_KEY_TYPE_ED25519),
    strkeyDecode(issuer),
  ]);
}

/**
 * The Soroban contract id for a classic asset written as `CODE:ISSUER`
 * (or the literal `"native"` for XLM).
 *
 * Test vectors, each confirmed against the live Soroswap API:
 *   native → CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA
 *   USDC:GA5ZSE… → CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
 *   AQUA:GBNZIL… → CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK
 */
export async function contractIdForAsset(asset: string): Promise<string> {
  // Already a contract id — pass it straight through, so a user pasting a `C…`
  // address works without a round trip through the classic form.
  if (/^C[A-Z2-7]{55}$/.test(asset)) return asset;

  let code: string;
  let issuer: string;
  if (asset === "native") {
    code = "native";
    issuer = "";
  } else {
    const [c, i] = asset.split(":");
    if (!c || !i) throw new Error(`Not a classic Stellar asset: "${asset}"`);
    code = c;
    issuer = i;
  }

  const networkId = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PUBLIC_NETWORK)),
  );

  // HashIDPreimage for ENVELOPE_TYPE_CONTRACT_ID:
  //   envelopeType . networkID . contractIDPreimageType . asset
  const preimage = concat([
    u32(ENVELOPE_TYPE_CONTRACT_ID),
    networkId,
    u32(CONTRACT_ID_PREIMAGE_FROM_ASSET),
    encodeAsset(code, issuer),
  ]);

  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage));
  return strkeyEncode(STRKEY_VERSION_CONTRACT, hash);
}

/** Cheap shape check so callers can reject junk before hashing. */
export function isStellarAsset(value: string): boolean {
  if (value === "native") return true;
  if (/^C[A-Z2-7]{55}$/.test(value)) return true;
  const [code, issuer] = value.split(":");
  return Boolean(code && issuer && /^G[A-Z2-7]{55}$/.test(issuer) && code.length <= 12);
}
