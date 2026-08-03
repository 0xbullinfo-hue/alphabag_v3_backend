-- ═══════════════════════════════════════════════════════════════════════
-- Fix: T2E claim double-claim race condition (database-level enforcement)
--
-- Run this manually against your Postgres database BEFORE deploying the
-- schema.prisma change (which adds `claimWindow` + the unique constraint)
-- via `npx prisma db push`. This project doesn't use `prisma migrate`
-- (no prisma/migrations folder exists), so this is a plain SQL script,
-- not a generated migration.
--
-- IMPORTANT: run this in a transaction, on a backup, or during a low-
-- traffic window. Step 1 below finds and reports any duplicate claims
-- that the race condition may have already created — REVIEW that output
-- before proceeding to step 3, since it tells you the real financial
-- exposure this bug already caused (each duplicate row represents an
-- over-paid mission reward or an inflated payout request).
-- ═══════════════════════════════════════════════════════════════════════

-- STEP 1 — Find existing duplicate claims (run this first, read the
-- output, decide what to do about any already-over-paid users before
-- proceeding — this script does NOT claw back rewards automatically).
-- IMPORTANT: duplicates are detected per computed claimWindow, not just
-- (userId, missionId), so legitimate DAILY/WEEKLY claims in different
-- windows are not falsely reported.
WITH computed_windows AS (
  SELECT
    c.id,
    c."userId",
    c."missionId",
    c."rewardTokens",
    c."createdAt",
    CASE
      WHEN COALESCE(m.frequency, 'ONCE') = 'DAILY'
        THEN c."missionId" || ':' || to_char(c."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      WHEN COALESCE(m.frequency, 'ONCE') = 'WEEKLY'
        THEN c."missionId" || ':' || to_char(c."createdAt" AT TIME ZONE 'UTC', 'IYYY-"W"IW')
      ELSE c."missionId"
    END AS computed_claim_window
  FROM t2e_claims c
  LEFT JOIN t2e_missions m ON m.id = c."missionId"
)
SELECT
  "userId",
  computed_claim_window AS claim_window,
  COUNT(*) AS duplicate_count,
  SUM("rewardTokens") AS total_awarded,
  array_agg(id ORDER BY "createdAt" ASC) AS claim_ids
FROM computed_windows
GROUP BY "userId", computed_claim_window
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- STEP 2 — Backfill the new claimWindow column for existing rows, so the
-- unique constraint in step 3 has something to check against. Only the
-- earliest claim per (userId, computed-claimWindow) keeps the "real"
-- claimWindow value; later duplicates in that same window get a
-- placeholder that won't collide, so the constraint can apply going
-- forward without failing on historical data. This does NOT undo any
-- already-issued duplicate rewards (see step 1).
ALTER TABLE t2e_claims ADD COLUMN IF NOT EXISTS "claimWindow" TEXT NOT NULL DEFAULT '';

WITH computed_windows AS (
  SELECT
    c.id,
    c."userId",
    c."missionId",
    c."createdAt",
    CASE
      WHEN COALESCE(m.frequency, 'ONCE') = 'DAILY'
        THEN c."missionId" || ':' || to_char(c."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      WHEN COALESCE(m.frequency, 'ONCE') = 'WEEKLY'
        THEN c."missionId" || ':' || to_char(c."createdAt" AT TIME ZONE 'UTC', 'IYYY-"W"IW')
      ELSE c."missionId"
    END AS computed_claim_window
  FROM t2e_claims c
  LEFT JOIN t2e_missions m ON m.id = c."missionId"
), ranked AS (
  SELECT
    id,
    computed_claim_window,
    ROW_NUMBER() OVER (
      PARTITION BY "userId", computed_claim_window
      ORDER BY "createdAt" ASC, id ASC
    ) AS rn
  FROM computed_windows
)
UPDATE t2e_claims c
SET "claimWindow" = CASE
    WHEN r.rn = 1 THEN r.computed_claim_window
    ELSE r.computed_claim_window || ':dup:' || c.id
END
FROM ranked r
WHERE c.id = r.id;

-- STEP 3 — Add the actual constraint. From this point on, Postgres
-- itself rejects a second insert with the same (userId, claimWindow),
-- regardless of how many application server instances are running or
-- how many concurrent requests race each other.
ALTER TABLE t2e_claims
  ADD CONSTRAINT t2e_claims_userid_claimwindow_key UNIQUE ("userId", "claimWindow");

-- Verify:
-- SELECT conname FROM pg_constraint WHERE conname = 't2e_claims_userid_claimwindow_key';
