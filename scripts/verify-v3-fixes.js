// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Fix verification script (public endpoints; no auth needed)
// Usage: node scripts/verify-v3-fixes.js [baseUrl]
import axios from 'axios';

const BASE = process.argv[2] || 'http://localhost:3003';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? '?' : '?'} ${name}${extra ? ` — ${extra}` : ''}`);
    ok ? pass++ : fail++;
};

(async () => {
    try {
        // 1. Health
        const health = await axios.get(`${BASE}/health`, { timeout: 10000 }).catch((e) => e.response);
        check('GET /health responds', !!health && (health.status === 200 || health.status === 404));

        // 2. Priced DEX portfolio (was: tokens had priceUSD 0)
        const bal = await axios.get(`${BASE}/api/portfolio/balances`, { params: { address: VITALIK }, timeout: 30000 }).catch((e) => e.response);
        const tokens = bal?.data?.tokens || [];
        const priced = tokens.filter((t) => t.priceUSD > 0);
        const total = bal?.data?.totalUSD;
        check('GET /api/portfolio/balances', bal?.status === 200);
        check('ERC-20 tokens carry real prices', tokens.length === 0 || priced.length > 0, `${priced.length}/${tokens.length} priced`);
        check('totalUSD is a number', typeof total === 'number', `totalUSD=${total}`);

        // 3. DeFi endpoint (previously 404)
        const defi = await axios.get(`${BASE}/api/portfolio/defi?address=${VITALIK}`, { timeout: 30000 }).catch((e) => e.response);
        check('GET /api/portfolio/defi', defi?.status === 200, `source=${defi?.data?.source || 'n/a'}`);

        // 4. SSE stream emits portfolio data (not just heartbeats)
        const token = process.env.VERIFY_JWT; // optional: set a real JWT to test authed stream
        if (token) {
            const res = await fetch(`${BASE}/api/stream/portfolio?address=${VITALIK}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const text = await res.text();
            check('SSE emits portfolio payload', /"type"\s*:\s*"portfolio"/.test(text));
        } else {
            console.log('? SSE stream check skipped — set VERIFY_JWT=<jwt> to test authed stream');
        }
    } catch (e) {
        console.error('Verification error:', e.message);
        fail++;
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
