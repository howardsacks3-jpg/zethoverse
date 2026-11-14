import { verifyRaydiumCpmmWithdrawal, RAYDIUM_CPMM_MAINNET_PROGRAM_ID } from "../raydium-cpmm-withdrawal.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function configuredPool(env) {
  const pool = {
    poolId: env.POOL_ID,
    token0Mint: env.TOKEN0_MINT,
    token1Mint: env.TOKEN1_MINT,
    token0Vault: env.TOKEN0_VAULT,
    token1Vault: env.TOKEN1_VAULT
  };
  if (Object.values(pool).some(value => typeof value !== "string" || value.length < 32)) {
    throw new Error("Pool identity is not fully configured");
  }
  return pool;
}

function validSignature(value) {
  return typeof value === "string" &&
    value.length >= 80 && value.length <= 90 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ service: "zethosphere-raydium-cpmm-readonly", status: "ok" });
  }
  if (request.method !== "POST" || url.pathname !== "/verify-withdrawal") {
    return json({ error: "Not found" }, 404);
  }
  if (!env.API_BEARER_TOKEN || request.headers.get("authorization") !== `Bearer ${env.API_BEARER_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!env.SOLANA_RPC_URL || !/^https:\/\//.test(env.SOLANA_RPC_URL)) {
    return json({ error: "Server RPC endpoint is not configured" }, 503);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Request body must be valid JSON" }, 400); }
  if (!validSignature(body?.signature)) {
    return json({ error: "A valid Solana transaction signature is required" }, 400);
  }

  let pool;
  try { pool = configuredPool(env); }
  catch (error) { return json({ error: error.message }, 503); }

  let rpc;
  try {
    const response = await fetchImpl(env.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [body.signature, {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0
        }]
      })
    });
    if (!response.ok) return json({ error: `Solana RPC returned HTTP ${response.status}` }, 502);
    rpc = await response.json();
  } catch {
    return json({ error: "Solana RPC request failed" }, 502);
  }
  if (rpc?.error) return json({ error: "Solana RPC returned an error", rpcCode: rpc.error.code }, 502);
  if (!rpc || !Object.prototype.hasOwnProperty.call(rpc, "result")) {
    return json({ error: "Malformed Solana RPC response" }, 502);
  }
  if (rpc.result === null) return json({ confirmed: false, reason: "Transaction not found at finalized commitment" }, 404);

  const result = verifyRaydiumCpmmWithdrawal(rpc.result, pool, {
    commitment: "finalized",
    programId: RAYDIUM_CPMM_MAINNET_PROGRAM_ID
  });
  return json(result, result.confirmed ? 200 : 200);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
