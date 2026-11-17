# ZETHOSPHERE monitoring operations

## Current operating mode

The monitor is read-only. It verifies the Solana mainnet cluster by genesis hash, checks the configured SPL mint, scans configured public addresses, classifies transactions, persists a deduplicated event history, and queues critical/warning email alerts. It does not sign, submit, or simulate transactions.

The monitor must remain in WAITING_FOR_CONFIGURATION until the official mint, verified public address register, and email delivery configuration are present. OPERATIONAL is reserved for a completed mainnet scan with those dependencies available. The dashboard treats a status document older than 15 minutes as stale.

Address scanning uses a bounded signature window. A detected cursor gap is an error, not a clean scan. The first scan establishes a baseline and deliberately does not import historic transactions as fresh alerts.

## GitHub Actions configuration

Repository Settings → Secrets and variables → Actions:

Secrets:
- RESEND_API_KEY: Resend API key. Never put it in source code or a public variable.
- SOLANA_RPC_URL: optional dedicated mainnet RPC URL. If omitted, the public Solana mainnet endpoint is used.

Variables:
- ZETHO_MINT_ADDRESS: official verified mainnet SPL mint address, once created and independently checked.
- ZETHO_MONITOR_ADDRESSES: comma-separated verified project public addresses.
- ZETHO_PROGRAM_ADDRESSES: comma-separated verified upgradeable Solana program IDs; the monitor checks each program account, ProgramData address, deployment slot and upgrade authority.
- ALERT_EMAIL_TO: founder alert destination.
- ALERT_EMAIL_FROM: sender address verified by Resend.

Do not add devnet addresses or unverified wallets. Keep the mint and address variables blank until verified.

The workflow runs unit tests on pushes to this branch. The scheduled five-minute trigger becomes active after the workflow is merged into the repository's default branch. It writes status and event history into monitor-data/.

## Email verification

The monitor records a message as accepted only after Resend's API accepts it. API acceptance is not proof that a message reached the inbox. Configure a verified sender domain and run the workflow manually with test_email=true; inspect the recipient inbox and Resend delivery logs. A failed send remains queued for retry.

## Founder authentication deployment

The founder authentication code is a Cloudflare Worker. It requires:
- FOUNDER_PASSWORD_HASH: generated locally by running scripts/create-founder-password-hash.mjs with FOUNDER_PASSWORD set in the local shell environment. The password is never stored in this repository. Use a unique password of at least 20 characters.
- SESSION_SIGNING_SECRET: a separate random secret of at least 32 characters.
- AUTH_LIMITS: a Cloudflare KV namespace binding used for login rate limiting.

Deploy the Worker with Wrangler after configuring the KV binding in wrangler.toml. Add the Worker route zethoverse.com/api/founder/* only if the domain is managed through Cloudflare DNS and the route is configured to the Worker. If the site is not routed through Cloudflare, the login page's same-origin /api/founder requests will remain unavailable until a same-origin reverse proxy is configured. Do not expose the Worker with permissive CORS or put passwords in query strings.

The Worker fails closed if password hashing, session signing, or KV rate limiting is not configured. Sessions are HttpOnly, Secure, SameSite=Strict, and expire after eight hours. Password-only is the requested first phase; adding MFA should be considered before production use.

## Known limits requiring a later verified-address phase

- Program upgrade / ProgramData monitoring is implemented for upgradeable-loader programs and requires verified program IDs in ZETHO_PROGRAM_ADDRESSES.
- Vesting protocol event decoding needs the final deployed program and the exact program version/IDL.
- Liquidity pool and swap classification needs the verified pool address and supported venue program IDs.
- A signature scanner is not a substitute for an archival/indexing RPC provider. The bounded scan detects a cursor gap and degrades rather than claiming complete history.
- External security advisories and market price/volume feeds are not part of this on-chain scanner.
- No automatic containment, token movement, authority changes, or wallet signing is performed.

## Validation commands

node --test test/*.test.cjs test/*.test.mjs
node scripts/zethosphere-monitor.cjs

For a real email delivery test, use the workflow dispatch input rather than committing credentials.
