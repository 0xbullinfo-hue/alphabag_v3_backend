-- Replay / double-spend protection for payout approvals (required in production).
-- Idempotent. Rollback: DROP TABLE IF EXISTS "payout_tx_claims";

CREATE TABLE IF NOT EXISTS "payout_tx_claims" (
    "id"              TEXT PRIMARY KEY,
    "txHash"          TEXT NOT NULL,
    "walletAddress"   TEXT NOT NULL,
    "amountWei"       TEXT NOT NULL,
    "payoutRequestId" TEXT NOT NULL,
    "claimedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "payout_tx_claims_payoutRequestId_key" ON "payout_tx_claims" ("payoutRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "payout_tx_claims_txHash_walletAddress_key" ON "payout_tx_claims" ("txHash", "walletAddress");
CREATE INDEX IF NOT EXISTS "payout_tx_claims_txHash_idx" ON "payout_tx_claims" ("txHash");
