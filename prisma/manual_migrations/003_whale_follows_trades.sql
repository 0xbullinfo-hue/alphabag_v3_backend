-- AlphaBAG V3 — Migration 003: whale_follows + trades
-- Run BEFORE `prisma db push` / `prisma migrate dev` for schema.prisma v3-fixes.
-- (mirrors the pattern of 001_t2e_claim_uniqueness.sql — dedupe first, then push)

BEGIN;

CREATE TABLE IF NOT EXISTS whale_follows (
    id            TEXT PRIMARY KEY,
    "userId"      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address       TEXT NOT NULL,
    chain         TEXT NOT NULL DEFAULT 'eth',
    label         TEXT,
    threshold     DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "lastSeenTx"  TEXT,
    "lastSeenBlock" BIGINT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS whale_follows_userId_address_key ON whale_follows("userId", address);
CREATE INDEX IF NOT EXISTS whale_follows_isActive_idx ON whale_follows("isActive");

CREATE TABLE IF NOT EXISTS trades (
    id            TEXT PRIMARY KEY,
    "userId"      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "exchangeId"  TEXT,
    chain         TEXT,
    symbol        TEXT NOT NULL,
    side          TEXT NOT NULL,
    price         DOUBLE PRECISION NOT NULL,
    amount        DOUBLE PRECISION NOT NULL,
    cost          DOUBLE PRECISION NOT NULL,
    fee           DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feeCurrency" TEXT,
    "timestamp"   TIMESTAMP(3) NOT NULL,
    "tradeId"     TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS trades_userId_idx ON trades("userId");
CREATE INDEX IF NOT EXISTS trades_userId_symbol_idx ON trades("userId", symbol);

COMMIT;
