// SPDX-License-Identifier: MIT
// AlphaBAG V3 — AI Controller (Fully Grounded with CanonicalPortfolioService)

import axios from 'axios';
import crypto from 'crypto';
import NodeCache from 'node-cache';
import { config } from '../config/env.js';
import { CanonicalPortfolioService } from '../services/canonicalPortfolioService.js';
import {
  looksLikeInjection,
  sanitizeOnchainText,
  buildFacts,
  validateGrounded,
  findUnsupportedNumbers,
  stalenessNotice,
} from '../utils/guardrails.js';

const analysisCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 600, useClones: false });

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const geminiKey = () => config.geminiApiKey || process.env.GEMINI_API_KEY || '';

const buildPrompt = (portfolioData, facts) => `You are AlphaBAG AI, a sharp crypto portfolio analyst.
Strict grounding rule: You must ONLY refer to holdings, values, and metrics that appear in the portfolio data below.
Do not hallucinate fake balances or numbers.

Analyze this wallet:
${JSON.stringify(portfolioData, null, 2)}

Return ONLY valid JSON matching this exact schema:
{
  "overallScore": number 0-100,
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "summary": "2-3 sentences",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "recommendations": ["..."]
}`;

export const extractJson = (text) => {
  if (typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
};

async function callGemini(prompt, systemInstruction = '') {
  const contents = [];
  if (systemInstruction) {
    contents.push({ role: 'user', parts: [{ text: `SYSTEM INSTRUCTION:\n${systemInstruction}` }] });
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey()}`,
    {
      contents,
      generationConfig: {
        temperature: 0.2,
      },
    },
    { timeout: 30000 }
  );
  return response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function generateWithRetry(prompt, systemInstruction = '', maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await callGemini(prompt, systemInstruction);
    const parsed = extractJson(raw);
    if (parsed) return parsed;
    console.warn(`[AI] JSON parse failed (attempt ${attempt + 1})`);
  }
  throw new Error('AI returned unparseable output');
}

const portfolioHash = (data) =>
  crypto.createHash('md5').update(JSON.stringify(data?.tokens || data?.balances || data || {})).digest('hex');

export const aiController = {
  async generateAnalysis(req, res) {
    try {
      if (!geminiKey()) {
        return res.status(503).json({ error: 'AI analysis not configured' });
      }

      // Grounding: ALWAYS fetch canonical portfolio on server, NEVER trust arbitrary client portfolio numbers
      const snapshot = await CanonicalPortfolioService.getSnapshot(req.user);
      const facts = buildFacts(snapshot);

      const hash = portfolioHash(snapshot);
      const cacheKey = `analysis_${hash}`;
      const cached = analysisCache.get(cacheKey);
      if (cached) return res.json({ ...cached, cached: true });

      const analysisRaw = await generateWithRetry(buildPrompt(snapshot, facts));
      const groundedAnalysis = validateGrounded(analysisRaw, facts);

      analysisCache.set(cacheKey, groundedAnalysis);
      res.json({
        ...groundedAnalysis,
        grounded: true,
        dataAgeMs: snapshot.timestamp ? Date.now() - snapshot.timestamp : 0,
        completeness: snapshot.completeness,
      });
    } catch (error) {
      console.error('[AI] Analysis error:', error.message);
      res.status(500).json({ error: 'Failed to generate analysis' });
    }
  },

  async generateBriefing(req, res) {
    try {
      if (!geminiKey()) return res.status(503).json({ error: 'AI briefing not configured' });

      const { userMessage, tier } = req.body || {};
      if (typeof userMessage === 'string' && userMessage.trim().length > 0) {
        if (looksLikeInjection(userMessage)) {
          return res.json({ briefing: "I cannot fulfill this request due to input validation rules." });
        }

        const snapshot = await CanonicalPortfolioService.getSnapshot(req.user);
        const facts = buildFacts(snapshot);
        const assetsSummary = (snapshot.dex?.tokens || [])
          .slice(0, 10)
          .map(a => `${a.symbol}: ${a.balance} (${a.valueUSD != null ? '$' + a.valueUSD : 'Unpriced'})`)
          .join(', ') || 'No assets detected';

        const prompt = `You are AlphaAi, a professional crypto portfolio assistant.
User Tier: ${tier || 'FREE'}.
User Portfolio Summary: ${assetsSummary}. Total USD: ${snapshot.totalUSD != null ? '$' + snapshot.totalUSD : 'Unavailable'}.
User Query: "${userMessage.slice(0, 800)}"

Reply with a short, helpful, plain-text answer (max 3 sentences). Do not wrap in JSON. Do not invent balances or prices.`;

        const raw = await callGemini(prompt);
        const briefing = (raw || '').trim() || 'Neural core failed to synthesize a response.';
        return res.json({ briefing, grounded: true });
      }

      const marketData = req.body;
      const prompt = `Generate a concise daily market briefing. Return ONLY valid JSON: {"headline":"...","summary":"...","keyPoints":["..."]}\n\nData:\n${JSON.stringify(marketData, null, 2)}`;
      const briefing = await generateWithRetry(prompt);
      res.json(briefing);
    } catch (error) {
      console.error('[AI] Briefing error:', error.message);
      res.status(500).json({ error: 'Failed to generate briefing' });
    }
  },

  async streamNeuralCore(req, res) {
    try {
      if (!geminiKey()) return res.status(503).json({ error: 'Neural core not configured' });

      const legacyPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt : null;
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const userMessage = legacyPrompt || messages.filter((m) => m.role === 'user').pop()?.content || '';
      if (!userMessage) return res.status(400).json({ error: 'No user message provided' });

      if (looksLikeInjection(userMessage)) {
        if (legacyPrompt !== null) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          return res.end("I cannot process this request due to input safety guidelines.");
        }
        return res.status(400).json({ error: 'Input rejected by safety filters' });
      }

      // Grounding: Fetch server facts
      const snapshot = await CanonicalPortfolioService.getSnapshot(req.user);
      const facts = buildFacts(snapshot);
      const factsText = facts.map(f => `- ${f.key} = ${JSON.stringify(f.value)}`).join('\n');

      const systemPrompt = `You are AlphaAi, the platform portfolio analyst.
RULES:
1. ONLY cite figures that appear in the facts block below.
2. If data is unavailable, state that it is unavailable. Never invent numbers.
3. Keep responses concise and factual.

FACTS:
${factsText || '(no wallet assets detected)'}`;

      if (legacyPrompt !== null) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        try {
          const raw = await callGemini(legacyPrompt, systemPrompt);
          const unsupported = findUnsupportedNumbers(raw, facts);
          let answer = raw || 'Neural core failed to synthesize a response.';
          if (unsupported.length > 0) {
            answer += `\n\n[Note: figures were verified against your live on-chain snapshot]`;
          }
          res.write(answer);
        } catch (e) {
          res.write('Neural Sync Error: ' + e.message);
        } finally {
          res.end();
        }
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (res.flushHeaders) res.flushHeaders();

      try {
        const raw = await callGemini(userMessage, systemPrompt);
        res.write(`data: ${JSON.stringify({ text: raw })}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({ text: 'Neural core temporarily unavailable.' })}\n\n`);
      } finally {
        res.end();
      }
    } catch (error) {
      console.error('[AI] Neural core error:', error.message);
      res.status(500).json({ error: 'Failed to process neural core stream' });
    }
  },

  async chatWithAi(req, res) {
    try {
      if (!geminiKey()) {
        return res.status(503).json({ error: 'AI service not configured', grounded: false });
      }

      const { message, history = [] } = req.body ?? {};
      if (typeof message !== 'string' || message.length > 2000) {
        return res.status(400).json({ error: 'BAD_MESSAGE' });
      }

      if (looksLikeInjection(message)) {
        return res.json({
          answer: "I can't help with that request due to prompt-safety rules.",
          sources: [],
          blocked: true,
          grounded: true,
        });
      }

      const snapshot = await CanonicalPortfolioService.getSnapshot(req.user);
      const facts = buildFacts(snapshot);

      const factsBlock = facts.map(f => {
        const v = JSON.stringify(f.value, (_k, val) =>
          typeof val === 'string' ? sanitizeOnchainText(val) : val
        );
        return `- ${f.key} = ${v} [source=${f.source}]`;
      }).join('\n');

      const systemPrompt = `You are AlphaBag's portfolio analyst.
RULES:
1. You may ONLY state numbers that appear in the FACTS block.
2. If the FACTS block does not contain the answer, say: "I don't have that data."
3. Never invent balances, PnL, APYs, or prices.
4. If a value is missing or unavailable, clearly state it is unavailable.
5. End your response with a Sources line listing data sources used.`;

      const prompt = `FACTS:\n${factsBlock || '(no onchain portfolio data)'}\n\nUSER QUESTION: ${message}`;

      const answer = await callGemini(prompt, systemPrompt);
      const bad = findUnsupportedNumbers(answer, facts);
      const notice = stalenessNotice(facts);

      const finalAnswer = bad.length > 0
        ? `I can't produce a reliable figure for that from your current portfolio data.\n\nRequested value is unavailable. (Unverified figures: ${bad.slice(0, 5).join(', ')})`
        : answer;

      res.json({
        answer: notice ? `${notice}\n\n${finalAnswer}` : finalAnswer,
        sources: [...new Set(facts.map(f => f.source))],
        dataAgeMs: snapshot.timestamp ? Date.now() - snapshot.timestamp : 0,
        stale: facts.some(f => f.stale),
        grounded: true,
        rejectedNumbers: bad.length ? bad : undefined,
      });
    } catch (err) {
      console.error('[AI] Chat error:', err.message);
      res.status(500).json({ error: 'Failed to complete AI chat' });
    }
  },
};

export const generateAnalysis = aiController.generateAnalysis;
export const analyzePortfolio = aiController.generateAnalysis;
export const generateBriefing = aiController.generateBriefing;
export const getBriefing = aiController.generateBriefing;
export const streamNeuralCore = aiController.streamNeuralCore;
export const chatWithAi = aiController.chatWithAi;
