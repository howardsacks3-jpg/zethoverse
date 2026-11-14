import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../server/raydium-worker.js";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = "1" + out;
  return out;
}
const signature = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
const env = {
  API_BEARER_TOKEN: "test-only-secret",
  SOLANA_RPC_URL: "https://rpc.example.invalid",
  POOL_ID: base58(new Uint8Array(32).fill(1)),
  TOKEN0_MINT: base58(new Uint8Array(32).fill(2)),
  TOKEN1_MINT: base58(new Uint8Array(32).fill(3)),
  TOKEN0_VAULT: base58(new Uint8Array(32).fill(4)),
  TOKEN1_VAULT: base58(new Uint8Array(32).fill(5))
};
const request = (body = { signature }, headers = {}) => new Request("https://worker.example/verify-withdrawal", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body)
});

test("rejects unauthenticated calls before contacting RPC", async () => {
  let called = false;
  const response = await handleRequest(request(), env, async () => { called = true; });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("requests getTransaction at finalized commitment and returns verifier result", async () => {
  let rpcRequest;
  const fakeTransaction = {
    slot: 1,
    transaction: { signatures: [signature], message: { accountKeys: [], instructions: [] } },
    meta: { err: null, logMessages: [], innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } }
  };
  const response = await handleRequest(request(undefined, { authorization: "Bearer test-only-secret" }), env, async (url, init) => {
    assert.equal(url, env.SOLANA_RPC_URL);
    rpcRequest = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: fakeTransaction }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  });
  assert.equal(rpcRequest.method, "getTransaction");
  assert.equal(rpcRequest.params[1].commitment, "finalized");
  assert.equal(rpcRequest.params[1].encoding, "json");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.confirmed, false);
});

test("rejects malformed signatures without calling RPC", async () => {
  let called = false;
  const response = await handleRequest(request({ signature: "not-a-signature" }, {
    authorization: "Bearer test-only-secret"
  }), env, async () => { called = true; });
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("returns not-found when finalized RPC has no transaction", async () => {
  const response = await handleRequest(request(undefined, {
    authorization: "Bearer test-only-secret"
  }), env, async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }));
  assert.equal(response.status, 404);
});
