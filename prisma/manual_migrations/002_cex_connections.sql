-- Secure persistent CEX connections. Apply this migration before deploying
-- the corresponding Prisma schema. Credentials are AES-256-GCM ciphertext
-- produced by the application and must never be written to this table in plaintext.

CREATE TABLE IF NOT EXISTS cex_connections (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "exchangeId" TEXT NOT NULL,
  "encryptedApiKey" TEXT NOT NULL,
  "encryptedSecret" TEXT NOT NULL,
  "encryptedPassphrase" TEXT,
  status TEXT NOT NULL DEFAULT 'CONNECTED',
  "lastSyncedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cex_connections_user_exchange_key UNIQUE ("userId", "exchangeId")
);

CREATE INDEX IF NOT EXISTS cex_connections_user_id_idx ON cex_connections ("userId");