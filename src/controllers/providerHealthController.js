import { getProviderHealth, checkProvider } from '../services/providerHealthService.js';

export async function providerHealth(req, res) {
  try {
    const force = req.query.fresh === 'true';
    const data = await getProviderHealth(force);
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to check provider health' });
  }
}

export async function providerHealthByName(req, res) {
  try {
    const name = String(req.params.provider || '').toLowerCase();
    const result = await checkProvider(name);
    res.status(200).json({
      checkedAt: new Date().toISOString(),
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check provider' });
  }
}
