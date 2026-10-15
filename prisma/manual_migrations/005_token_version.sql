-- Idempotent manual migration: add tokenVersion to users and admins
-- Rollback:
-- ALTER TABLE "users" DROP COLUMN IF EXISTS "tokenVersion";
-- ALTER TABLE "admins" DROP COLUMN IF EXISTS "tokenVersion";

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
