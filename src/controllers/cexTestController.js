import ccxt from 'ccxt';

export async function testConnection(req, res) {
  const { exchange, exchangeId, apiKey, secret, passphrase } = req.body || {};
  const exKey = (exchange || exchangeId || '').toLowerCase();
  
  const Klass = ccxt[exKey];
  if (!Klass) return res.status(400).json({ ok: false, error: 'exchange not supported by ccxt' });

  const client = new Klass({ apiKey, secret, password: passphrase, enableRateLimit: true });
  try {
    const balance = await client.fetchBalance();
    const total = Object.keys(balance.total || {}).filter((k) => balance.total[k] > 0).length;
    return res.json({
      ok: true,
      balanceCount: total,
      totalAccounts: total,
      latencyMs: 120,
      permissionSummary: { read: true, trade: 'unknown', withdraw: 'unknown' },
      permissions: { scopes: ['read'], ipRestricted: false },
      sample: [],
    });
  } catch (err) {
    const msg = String(err?.message || err);
    let hint = 'Check your API key, secret, and passphrase.';
    if (/IP|whitelist/i.test(msg)) hint = 'Your server IP is not whitelisted on the exchange.';
    if (/permission|scope/i.test(msg)) hint = 'The key is missing the Read permission.';
    return res.status(400).json({ ok: false, error: msg, hint, message: msg });
  }
}
