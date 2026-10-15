# AlphaBAG Repository History Purge Guide

> [!CAUTION]
> This runbook is a **human-only operational task**. Never execute force-pushes or credential rotations from automated tooling without explicit administrative confirmation.

This repository historically tracked `backend/data/users.json` and related files containing hashed passwords, admin usernames, and personal data.

Even though these files have now been removed and untracked from the working tree and ignored in `.gitignore`, git history still contains older commits (`6fc0b20`, `affa065`, etc.).

---

## 1. Mandatory Credential Rotations (Before / In Parallel)
Because passwords and keys were committed to git history, treat all of the following as **compromised**:
- [ ] Admin password(s) in Postgres (`admins` table)
- [ ] `JWT_SECRET`
- [ ] `CEX_ENCRYPTION_KEY` *(Note: rotating this requires re-encrypting or asking users to reconnect CEX API keys)*
- [ ] `ADMIN_PORTAL_KEY`
- [ ] Third-party API keys (Alchemy, Moralis, Covalent, CoinGecko, Gemini, Bubblemaps, WalletConnect)

---

## 2. Purging Git History with git-filter-repo

### Prerequisites
Install `git-filter-repo` (Python 3 required):
```bash
pip install git-filter-repo
```

### Execution Steps
1. Make a fresh, clean clone of the repository to an isolated folder:
   ```bash
   git clone --mirror https://github.com/0xbullinfo-hue/alphabag_v3_backend.git backend-purge
   cd backend-purge
   ```

2. Purge sensitive files from all branches, tags, and commits:
   ```bash
   git filter-repo --invert-paths \
     --path data/users.json \
     --path data/t2e_claims.json \
     --path data/t2e_payout_requests.json \
     --path data/t2e_activity.json \
     --path data/activity.json \
     --path data/airdrop.json \
     --path data/user_submitted_pairs.json \
     --path src/scripts/fix-admin-password.js
   ```

3. Verify with `gitleaks` or `git log`:
   ```bash
   git log --all --full-history -- "**/users.json"
   # Should return nothing
   ```

4. Force-push the purged repository:
   ```bash
   git remote add origin https://github.com/0xbullinfo-hue/alphabag_v3_backend.git
   git push origin --force --all
   git push origin --force --tags
   ```

5. Inform team members to re-clone the repository fresh rather than merging old history back in.
