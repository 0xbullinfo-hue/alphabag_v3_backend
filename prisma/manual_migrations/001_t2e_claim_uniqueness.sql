-- prisma/manual_migrations/001_t2e_claim_uniqueness.sql
-- Run this migration against your PostgreSQL database BEFORE going to production.
-- It creates a unique constraint on (userId, claimWindow) in the T2EClaim table,
-- which is the real guard against double-claim races across multiple server instances.

-- Step 1: Add the claimWindow column if it doesn't exist yet
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'T2EClaim' AND column_name = 'claimWindow'
    ) THEN
        ALTER TABLE "T2EClaim" ADD COLUMN "claimWindow" TEXT;
    END IF;
END $$;

-- Step 2: Backfill existing rows with a computed claimWindow
-- (Run this only if you have existing data that needs migration)
-- UPDATE "T2EClaim"
-- SET "claimWindow" = COALESCE(
--     "missionId" || ':' || TO_CHAR("createdAt", 'YYYY-MM-DD'),
--     "missionId"
-- )
-- WHERE "claimWindow" IS NULL;

-- Step 3: Create the unique index / constraint
-- This is the critical production guard. If two instances race to insert
-- the same (userId, claimWindow), Postgres will reject the second one with
-- error code P2002, which the application code already catches.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 't2e_claims_userid_claimwindow_key'
    ) THEN
        CREATE UNIQUE INDEX "t2e_claims_userid_claimwindow_key"
        ON "T2EClaim" ("userId", "claimWindow");
    END IF;
END $$;

-- Alternative if you prefer a named table constraint instead of an index:
-- ALTER TABLE "T2EClaim"
-- ADD CONSTRAINT "t2e_claims_userid_claimwindow_key"
-- UNIQUE ("userId", "claimWindow");
