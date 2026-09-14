/**
 * Backend AI guardrails.
 */
const NUM_RE = /-?\$?\d[\d,]*(?:\.\d+)?%?/g;

function normalize(n) {
  return String(n).replace(/[$,%]/g, '').replace(/,/g, '');
}

export function findUnsupportedNumbers(answer, facts) {
  const allowed = new Set();
  const walk = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      allowed.add(String(v));
      allowed.add(v.toFixed(2));
      allowed.add(v.toFixed(4));
    } else if (typeof v === 'string') {
      const n = normalize(v);
      if (n !== '' && !Number.isNaN(Number(n))) allowed.add(n);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  facts.forEach((f) => walk(f.value));

  const found = String(answer).match(NUM_RE) ?? [];
  return found
    .map(normalize)
    .filter((n) => n !== '' && !allowed.has(n))
    .filter((n) => !(Number.isInteger(Number(n)) && Math.abs(Number(n)) <= 10));
}

export function stalenessNotice(facts) {
  const stale = facts.filter((f) => f.stale);
  if (!stale.length) return null;
  const worst = stale.reduce((a, b) => (a.ageMs > b.ageMs ? a : b));
  const secs = Math.round(worst.ageMs / 1000);
  return `⚠️ Some data is ${secs}s old (source: ${worst.source}). Figures may not reflect the current market.`;
}

const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|above) (instructions|prompts)/i,
  /reveal (your )?(system prompt|instructions)/i,
  /you are now/i,
  /disregard .* (rules|guidelines)/i,
  /\bsystem\s*:/i,
  /<\s*\|.*?\|\s*>/,
];

export function looksLikeInjection(text) {
  if (!text) return false;
  return INJECTION_PATTERNS.some((r) => r.test(String(text)));
}

export function sanitizeOnchainText(s, max = 64) {
  return String(s ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/<\|/g, '')
    .replace(/\|>/g, '')
    .replace(/###/g, '')
    .replace(/system\s*:/gi, 'system_')
    .slice(0, max);
}

export function buildFacts(portfolioData, sources = {}) {
  const now = Date.now();
  const facts = [];

  const walk = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        facts.push({
          key: `${prefix}${k}`,
          value: v,
          source: sources[prefix.replace(/\.$/, '')] || 'portfolio',
          fetchedAt: new Date(now).toISOString(),
          ageMs: 0,
          stale: false,
        });
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => {
          if (item && typeof item === 'object') walk(item, `${prefix}${k}[${i}].`);
        });
      } else if (v && typeof v === 'object') {
        walk(v, `${prefix}${k}.`);
      }
    }
  };

  walk(portfolioData);
  return facts;
}

export function validateGrounded(analysis, facts) {
  const fields = [
    analysis.summary,
    ...(analysis.strengths || []),
    ...(analysis.weaknesses || []),
    ...(analysis.recommendations || []),
  ];
  const unsupported = fields.flatMap((f) => findUnsupportedNumbers(f || '', facts));

  if (unsupported.length) {
    console.warn('[AI] Unsupported numbers detected:', unsupported);
    const bad = new Set(unsupported);
    const strip = (s) =>
      String(s).replace(NUM_RE, (m) => (bad.has(normalize(m)) ? '[unverified]' : m));
    analysis.summary = strip(analysis.summary || '');
    analysis.strengths = (analysis.strengths || []).map(strip);
    analysis.weaknesses = (analysis.weaknesses || []).map(strip);
    analysis.recommendations = (analysis.recommendations || []).map(strip);
  }

  const stale = stalenessNotice(facts);
  if (stale) analysis.summary = `${stale}\n\n${analysis.summary}`;
  return analysis;
}
