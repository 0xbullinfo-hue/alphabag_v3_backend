CREATE TABLE "communities" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "communities_slug_key" ON "communities"("slug");
INSERT INTO "communities" ("id", "slug", "name", "description") VALUES
  ('general', 'general', 'General', 'Open crypto conversations and community questions.'),
  ('tokenomics', 'tokenomics', 'Tokenomics', 'Supply, vesting, emissions, and token design.'),
  ('utility-yield', 'utility-yield', 'Utility & Yield', 'Protocols, use cases, and yield opportunities.'),
  ('project-reviews', 'project-reviews', 'Project Reviews', 'Community-led project research and reviews.'),
  ('alpha-calls', 'alpha-calls', 'Alpha Calls', 'Trade ideas and due diligence.'),
  ('security-audits', 'security-audits', 'Security & Audits', 'Contract safety, audits, and risk discussion.')
ON CONFLICT ("slug") DO NOTHING;

CREATE TABLE "community_memberships" (
  "id" TEXT NOT NULL,
  "communityId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "community_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "community_memberships_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "community_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "community_memberships_communityId_userId_key" ON "community_memberships"("communityId", "userId");
CREATE INDEX "community_memberships_userId_createdAt_idx" ON "community_memberships"("userId", "createdAt");

CREATE TABLE "community_discussions" (
  "id" TEXT NOT NULL,
  "communityId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "ticker" TEXT,
  "category" TEXT,
  "sentiment" TEXT,
  "content" TEXT NOT NULL,
  "upvotes" INTEGER NOT NULL DEFAULT 0,
  "downvotes" INTEGER NOT NULL DEFAULT 0,
  "isPinned" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "community_discussions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "community_discussions_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "community_discussions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "community_discussions_communityId_createdAt_idx" ON "community_discussions"("communityId", "createdAt");

CREATE TABLE "community_comments" (
  "id" TEXT NOT NULL,
  "discussionId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "parentId" TEXT,
  "content" TEXT NOT NULL,
  "displayMode" TEXT NOT NULL DEFAULT 'VISIBLE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "community_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "community_comments_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "community_discussions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "community_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "community_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "community_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "community_comments_discussionId_createdAt_idx" ON "community_comments"("discussionId", "createdAt");
CREATE INDEX "community_comments_authorId_discussionId_idx" ON "community_comments"("authorId", "discussionId");

CREATE TABLE "community_votes" (
  "id" TEXT NOT NULL,
  "discussionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "community_votes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "community_votes_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "community_discussions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "community_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "community_votes_discussionId_userId_key" ON "community_votes"("discussionId", "userId");