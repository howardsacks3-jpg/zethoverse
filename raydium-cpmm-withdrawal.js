/**
 * Read-only Raydium CPMM withdrawal verifier.
 *
 * Accepts a Solana getTransaction JSON response fetched at finalized commitment.
 * A withdrawal is emitted only when a successful transaction contains BOTH:
 *  - the official Raydium CPMM "withdraw" instruction for the configured pool,
 *  - the matching Raydium LpChangeEvent (change_type === 1) emitted by that program.
 *
 * This is deliberately CPMM-specific. Other Raydium pool programs need separate,
 * source-verified decoders. No RPC calls, wallet access, signing or transactions.
 */
export const RAYDIUM_CPMM_MAINNET_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const RAYDIUM_CPMM_DEVNET_PROGRAM_ID = "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb";
const WITHDRAW_DISCRIMINATOR = "b712469c946da122";
const LP_CHANGE_EVENT_DISCRIMINATOR = "79a3cdc939da753c";

function decodeBase58(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid base58");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (let i = 0; i < value.length && value[i] === "1"; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

function toHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function readU64LE(bytes, offset) {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value.toString();
}

function readPubkey(bytes, offset) {
  // Base58 encoding of the 32-byte public key.
  let number = 0n;
  for (const byte of bytes.slice(offset, offset + 32)) number = (number << 8n) | BigInt(byte);
  let encoded = "";
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (let i = offset; i < offset + 32 && bytes[i] === 0; i++) encoded = "1" + encoded;
  return encoded;
}

function decodeEvent(base64) {
  let binary;
  try {
    if (typeof atob === "function") binary = atob(base64);
    else return null;
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length !== 97 || toHex(bytes.slice(0, 8)) !== LP_CHANGE_EVENT_DISCRIMINATOR) return null;
  return {
    poolId: readPubkey(bytes, 8),
    lpSupplyBefore: readU64LE(bytes, 40),
    token0VaultBefore: readU64LE(bytes, 48),
    token1VaultBefore: readU64LE(bytes, 56),
    token0Amount: readU64LE(bytes, 64),
    token1Amount: readU64LE(bytes, 72),
    token0TransferFee: readU64LE(bytes, 80),
    token1TransferFee: readU64LE(bytes, 88),
    changeType: bytes[96]
  };
}

function accountKeyStrings(message, meta) {
  const staticKeys = (message?.accountKeys ?? []).map(key =>
    typeof key === "string" ? key : key?.pubkey
  );
  const loaded = meta?.loadedAddresses;
  const writable = loaded?.writable ?? [];
  const readonly = loaded?.readonly ?? [];
  const keys = [...staticKeys, ...writable, ...readonly];
  return keys.map(key => typeof key === "string" ? key : key?.pubkey).filter(Boolean);
}

function compiledInstructions(transaction, accountKeys) {
  const message = transaction?.transaction?.message;
  const outer = (message?.instructions ?? []).map(ix => ({ ix, outer: true }));
  const inner = (transaction?.meta?.innerInstructions ?? []).flatMap(group =>
    (group.instructions ?? []).map(ix => ({ ix, outer: false }))
  );
  return [...outer, ...inner].map(({ ix, outer: isOuter }) => {
    const programId = ix.programId ??
      (Number.isInteger(ix.programIdIndex) ? accountKeys[ix.programIdIndex] : null);
    const accounts = Array.isArray(ix.accounts)
      ? ix.accounts.map(account => typeof account === "number" ? accountKeys[account] : account)
      : [];
    let dataHex = null;
    if (typeof ix.data === "string") {
      try { dataHex = toHex(decodeBase58(ix.data)); } catch { /* malformed instruction */ }
    }
    return { programId, accounts, dataHex, outer: isOuter };
  });
}

function getProgramEvents(logMessages, programId) {
  const stack = [];
  const events = [];
  for (const line of logMessages ?? []) {
    const invoke = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[/);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (line.startsWith("Program data:") && stack.at(-1) === programId) {
      const event = decodeEvent(line.slice("Program data:".length).trim());
      if (event) events.push(event);
      continue;
    }
    const end = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/);
    if (end && stack.at(-1) === end[1]) stack.pop();
  }
  return events;
}

/**
 * Verify a successful finalized CPMM withdrawal for one explicitly configured pool.
 *
 * expectedPool: { poolId, token0Mint, token1Mint, token0Vault, token1Vault }
 * transaction: raw JSON result from Solana getTransaction (encoding: "json")
 * commitment: must be "finalized", supplied by the RPC adapter that made the request.
 */
export function verifyRaydiumCpmmWithdrawal(transaction, expectedPool, options = {}) {
  const programId = options.programId ?? RAYDIUM_CPMM_MAINNET_PROGRAM_ID;
  const failures = [];
  if (options.commitment !== "finalized") failures.push("Transaction was not fetched at finalized commitment");
  if (!expectedPool || !["poolId", "token0Mint", "token1Mint", "token0Vault", "token1Vault"].every(key =>
    typeof expectedPool[key] === "string" && expectedPool[key].length > 0
  )) failures.push("Expected pool identity is incomplete");
  if (!transaction?.meta || transaction.meta.err !== null) failures.push("Transaction is missing metadata or did not succeed");
  if (!Number.isInteger(transaction?.slot) || transaction.slot < 0) failures.push("Transaction slot is missing");
  const signature = transaction?.transaction?.signatures?.[0];
  if (typeof signature !== "string" || !signature) failures.push("Transaction signature is missing");
  else {
    try { if (decodeBase58(signature).length !== 64) failures.push("Transaction signature is not a 64-byte Solana signature"); }
    catch { failures.push("Transaction signature is not valid base58"); }
  }
  if (failures.length) return { confirmed: false, reason: failures.join("; ") };

  const keys = accountKeyStrings(transaction.transaction.message, transaction.meta);
  const instructions = compiledInstructions(transaction, keys);
  const matchingWithdrawals = instructions.filter(ix =>
    ix.programId === programId &&
    ix.dataHex?.startsWith(WITHDRAW_DISCRIMINATOR) &&
    ix.dataHex.length === 64 &&
    ix.accounts.length >= 13 &&
    ix.accounts[2] === expectedPool.poolId &&
    ix.accounts[6] === expectedPool.token0Vault &&
    ix.accounts[7] === expectedPool.token1Vault &&
    ix.accounts[10] === expectedPool.token0Mint &&
    ix.accounts[11] === expectedPool.token1Mint
  );
  if (!matchingWithdrawals.length) {
    return { confirmed: false, reason: "No matching CPMM withdraw instruction for the configured pool" };
  }

  const events = getProgramEvents(transaction.meta.logMessages, programId);
  const event = events.find(candidate =>
    candidate.changeType === 1 &&
    candidate.poolId === expectedPool.poolId &&
    BigInt(candidate.token0Amount) > 0n &&
    BigInt(candidate.token1Amount) > 0n
  );
  if (!event) {
    return { confirmed: false, reason: "No matching successful Raydium LP-withdrawal event was found" };
  }

  return {
    confirmed: true,
    type: "liquidity-withdrawal-confirmed",
    signature,
    slot: transaction.slot,
    commitment: "finalized",
    programId,
    poolId: expectedPool.poolId,
    lpSupplyBefore: event.lpSupplyBefore,
    token0VaultBefore: event.token0VaultBefore,
    token1VaultBefore: event.token1VaultBefore,
    token0Amount: event.token0Amount,
    token1Amount: event.token1Amount,
    token0TransferFee: event.token0TransferFee,
    token1TransferFee: event.token1TransferFee,
    evidence: "Successful finalized CPMM withdraw instruction plus matching Raydium LpChangeEvent (change_type=1)"
  };
}
