# AlphaBAG Backend — Dependency Audit & Security Exceptions

This document records the security assessment, threat modeling, and risk acceptance rationale for remaining transitive dependencies flagged by `npm audit` in the AlphaBAG backend application.

---

## 1. Summary of Transitive Advisories

| Package | Severity | Upstream Source | Primary Risk | Mitigation & Sandbox Status |
| :--- | :--- | :--- | :--- | :--- |
| `mysql2` | High | `prisma` CLI | Credential leak on auth downgrade / zlib DoS | **Zero runtime exposure**: Backend uses PostgreSQL exclusively via `@prisma/adapter-pg`. `mysql2` is never loaded. |
| `deepmerge-ts` | High | `@prisma/config` | Recursive object merge stack exhaustion | **Zero network exposure**: Only evaluated at startup reading local static `prisma.config.ts`. |
| `elliptic` | High / Critical | `alchemy-sdk` > `@ethersproject/*` | Risky cryptographic implementation | **Zero private key usage**: Alchemy SDK is used exclusively for read-only RPC balance checks; never signs transactions. |
| `ws` | High | `alchemy-sdk` > `@ethersproject/providers` | Uninitialized memory disclosure / header DoS | **Outbound only**: Backend acts as client or uses REST HTTPS. Inbound client WebSockets are handled by external reverse proxy / gateway. |
| `stream-json` | Moderate | `@solana/web3.js` > `jayson` | Quadratic complexity on deep JSON | **Bounded input**: Backend Solana RPC calls are outbound to trusted nodes. Inbound API requests are bounded to 100kb by Express body parser. |
| `uuid` | Moderate | `@solana/web3.js` > `jayson` | Buffer bounds check in v3/v5/v6 | **No custom buffers**: UUID generation uses standard random v4 without buffer allocation. |

---

## 2. In-Depth Threat Model & Runtime Exposure Analysis

### Exception 1: `mysql2`
- **Path**: `prisma` > `mysql2`
- **Advisories**: [GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr), [GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3)
- **Severity**: High
- **Vulnerability**: Auth plugin downgrade to plaintext credentials; unbounded zlib inflate decompression DoS.
- **Threat & Exposure Analysis**:
  - AlphaBAG's relational database layer is PostgreSQL 16+.
  - The runtime Prisma client is configured with `@prisma/adapter-pg` using a PostgreSQL connection pool (`pg.Pool`).
  - `mysql2` is bundled by Prisma CLI tools as an optional database driver; it is never imported, initialized, or invoked anywhere in backend source code (`src/`).
- **Sandbox & Runtime Boundaries**:
  - Inactive at runtime. Verified: `grep -r "mysql" src/` returns zero occurrences.
- **Migration Roadmap**:
  - Tracked upstream in Prisma engine releases.

---

### Exception 2: `deepmerge-ts`
- **Path**: `prisma` > `@prisma/config` > `deepmerge-ts`
- **Advisory**: [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)
- **Severity**: High
- **Vulnerability**: Stack exhaustion when merging recursive object graphs.
- **Threat & Exposure Analysis**:
  - `deepmerge-ts` is an internal utility used by `@prisma/config` to merge configuration files during CLI commands (e.g., `prisma generate`).
  - No user-supplied data or network payloads ever reach `@prisma/config` or `deepmerge-ts`.
  - The configuration object parsed is static and locally defined in `prisma.config.ts`.
- **Sandbox & Runtime Boundaries**:
  - Build/startup time only. No exposure to external network requests.
- **Migration Roadmap**:
  - Tracked upstream in `@prisma/config` minor updates.

---

### Exception 3: `elliptic` & `ws` (via `alchemy-sdk`)
- **Path**: `alchemy-sdk` > `@ethersproject/signing-key` > `elliptic`; `alchemy-sdk` > `@ethersproject/providers` > `ws`
- **Advisories**: [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84), [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx), [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p)
- **Severity**: High
- **Vulnerability**: Elliptic curve calculation edge cases; WebSocket memory disclosure.
- **Threat & Exposure Analysis**:
  - `alchemy-sdk` is used in AlphaBAG strictly as a read-only token balance query client (`blockchainService.js`).
  - AlphaBAG does not manage server-side private keys or sign Ethereum transactions via Ethers v5 / `elliptic`.
  - AlphaBAG does not run an `@ethersproject` WebSocket listener server; all interactions with Alchemy are outbound HTTPS requests (`getTokenBalances`, `getBalance`).
  - Payout transaction verification is handled by Viem (`payoutVerifier.js`), which utilizes standard native crypto primitives.
- **Sandbox & Runtime Boundaries**:
  - Read-only outbound REST calls. No key signing or WebSocket server listeners.
- **Migration Roadmap**:
  - Upgrade `alchemy-sdk` when upstream releases support for Ethers v6 or pure Viem transports.

---

### Exception 4: `stream-json` & `uuid` (via `@solana/web3.js`)
- **Path**: `@solana/web3.js` > `jayson` > `stream-json` / `uuid`
- **Advisories**: [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x), [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x), [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
- **Severity**: Moderate
- **Vulnerability**: Deep JSON parsing complexity in stream filter; buffer bounds in UUID.
- **Threat & Exposure Analysis**:
  - `stream-json` is used within `jayson` for streaming RPC responses from Solana RPC nodes.
  - The responses parsed are structured JSON from trusted Solana cluster endpoints (`https://api.mainnet-beta.solana.com`).
  - Inbound HTTP payloads sent to AlphaBAG are parsed exclusively by Express `express.json({ limit: '100kb' })`, which immediately rejects oversized or excessively nested payloads before hitting business logic.
- **Sandbox & Runtime Boundaries**:
  - Outbound response parsing only from configured RPC URLs. Strict 100kb body limit on all incoming Express routes.
- **Migration Roadmap**:
  - Plan `@solana/web3.js` v2 migration when the Solana web3 ecosystem library reaches full parity.
