import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyRaydiumCpmmWithdrawal,
  RAYDIUM_CPMM_MAINNET_PROGRAM_ID
} from "../raydium-cpmm-withdrawal.js";

const encodeBase58 = bytes => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) encoded = "1" + encoded;
  return encoded;
};
const key = seed => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (seed + i) % 256));
const pool = {
  poolId: key(10),
  token0Mint: key(50),
  token1Mint: key(90),
  token0Vault: key(130),
  token1Vault: key(170)
};
const programId = RAYDIUM_CPMM_MAINNET_PROGRAM_ID;
const accountKeys = [
  key(1), key(2), pool.poolId, key(3), key(4), key(5),
  pool.token0Vault, pool.token1Vault, key(6), key(7),
  pool.token0Mint, pool.token1Mint, key(8), key(9), programId
];

function u64(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}
function makeEvent(changeType = 1, eventPool = pool.poolId) {
  const bytes = Buffer.concat([
    Buffer.from("79a3cdc939da753c", "hex"),
    Buffer.from(decodeKey(eventPool)),
    u64(1000000), u64(500000), u64(600000),
    u64(50000), u64(60000), u64(0), u64(0),
    Buffer.from([changeType])
  ]);
  return bytes.toString("base64");
}
function decodeKey(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const char of value) number = number * 58n + BigInt(alphabet.indexOf(char));
  const out = [];
  while (number > 0n) { out.unshift(Number(number & 255n)); number >>= 8n; }
  for (let i = 0; i < value.length && value[i] === "1"; i++) out.unshift(0);
  return Uint8Array.from([...Array(Math.max(0, 32 - out.length)).fill(0), ...out]);
}
function transaction({ event = makeEvent(), err = null, data = "withdraw", targetPool = pool.poolId } = {}) {
  const instructionData = data === "withdraw"
    ? Buffer.from("b712469c946da122" + "00".repeat(24), "hex")
    : Buffer.from("12345678", "hex");
  // Base58-encode the compiled instruction data.
  const instruction = {
    programIdIndex: 14,
    accounts: Array.from({ length: 14 }, (_, i) => i),
    data: encodeBase58(instructionData)
  };
  const logs = [
    `Program ${programId} invoke [1]`,
    ...(event ? [`Program data: ${event}`] : []),
    `Program ${programId} ${err ? "failed: custom program error" : "success"}`
  ];
  return {
    slot: 123456,
    transaction: { signatures: [encodeBase58(Uint8Array.from({ length: 64 }, (_, i) => i + 1))], message: { accountKeys, instructions: [instruction] } },
    meta: { err, logMessages: logs, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } }
  };
}
const verify = tx => verifyRaydiumCpmmWithdrawal(tx, pool, { commitment: "finalized" });

test("confirms a successful finalized CPMM withdrawal with matching pool event", () => {
  const result = verify(transaction());
  assert.equal(result.confirmed, true);
  assert.equal(result.type, "liquidity-withdrawal-confirmed");
  assert.equal(result.poolId, pool.poolId);
  assert.equal(result.token0Amount, "50000");
  assert.equal(result.token1Amount, "60000");
  assert.equal(result.slot, 123456);
  assert.ok(result.signature);
});

test("does not classify a swap or unrelated instruction as a withdrawal", () => {
  assert.equal(verify(transaction({ data: "swap" })).confirmed, false);
});

test("does not confirm an event for a different pool", () => {
  assert.equal(verify(transaction({ event: makeEvent(1, key(210)) })).confirmed, false);
});

test("does not confirm a deposit event", () => {
  assert.equal(verify(transaction({ event: makeEvent(0) })).confirmed, false);
});

test("does not confirm a failed transaction", () => {
  assert.equal(verify(transaction({ err: { InstructionError: [0, "Custom"] } })).confirmed, false);
});

test("does not confirm when the event is missing", () => {
  assert.equal(verify(transaction({ event: null })).confirmed, false);
});

test("requires finalized commitment", () => {
  const tx = transaction();
  const result = verifyRaydiumCpmmWithdrawal(tx, pool, { commitment: "confirmed" });
  assert.equal(result.confirmed, false);
  assert.match(result.reason, /finalized/);
});
