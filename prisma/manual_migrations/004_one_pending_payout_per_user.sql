-- Idempotent manual migration: create partial unique index on t2e_payout_requests for pending payouts
-- Rollback: DROP INDEX IF EXISTS idx_t2e_payout_one_pending_per_user;

CREATE UNIQUE INDEX IF NOT EXISTS idx_t2e_payout_one_pending_per_user
ON "t2e_payout_requests" ("userId")
WHERE status = 'PENDING';
