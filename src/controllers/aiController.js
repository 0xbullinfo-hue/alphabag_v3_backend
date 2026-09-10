// SPDX-License-Identifier: MIT
// AlphaBAG V3 — AI Controller (fixed)
// Fixes vs. previous version:
//   1. Removed VITE_GEMINI_API_KEY usage — server-side keys only (config.geminiApiKey
//      || process.env.GEMINI_API_KEY). Browser keys must never reach the server.
//   2. Model name configurable via GEMINI_MODEL (no hardcoded deprecated model).
//   3. Robust JSON extraction (regex fallback) + one retry instead of raw JSON.parse.
//   4. Cache is keyed on a portfolio hash — analysis invalidates when holdings change
//      (previously a stale 24h analysis was served regardless of portfolio changes).

import axios from 'axios';
import crypto from 'crypto';
import NodeCache from 'node-cache';
import { config } from '../config/env.js';

const analysisCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 600, useClones: false });

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const geminiKey = () => config.geminiApiKey || process.env.GEMINI_API_KEY || '';

const buildPrompt = (portfolioData) => `You are AlphaBAG AI, a sharp crypto portfolio analyst...

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

/** Extract the first balanced {...} block and parse it; return null on failure. */
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

async function callGemini(prompt) {
    const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey()}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } },
        { timeout: 30000 }
    );
    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function generateWithRetry(prompt, maxRetries = 1) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const raw = await callGemini(prompt);
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

            const portfolioData = req.body;
            if (!portfolioData || typeof portfolioData !== 'object') {
                return res.status(400).json({ error: 'Portfolio data required' });
            }

            const hash = portfolioHash(portfolioData);
            const cacheKey = `analysis_${hash}`;
            const cached = analysisCache.get(cacheKey);
            if (cached) return res.json({ ...cached, cached: true });

            const analysis = await generateWithRetry(buildPrompt(portfolioData));
            analysisCache.set(cacheKey, analysis);
            res.json(analysis);
        } catch (error) {
            console.error('[AI] Analysis error:', error.message);
            res.status(500).json({ error: 'Failed to generate analysis' });
        }
    },

    async generateBriefing(req, res) {
        try {
            if (!geminiKey()) return res.status(503).json({ error: 'AI briefing not configured' });
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

            const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
            const userMessage = messages.filter((m) => m.role === 'user').pop()?.content || '';
            if (!userMessage) return res.status(400).json({ error: 'No user message provided' });

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            if (res.flushHeaders) res.flushHeaders();

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${geminiKey()}`,
                { contents: [{ role: 'user', parts: [{ text: userMessage }] }] },
                { responseType: 'stream', timeout: 60000 }
            );

            let closed = false;
            req.on('close', () => { closed = true; response.data.destroy(); });
            response.data.on('data', (chunk) => {
                if (closed) return;
                const lines = chunk.toString().split('\n').filter((l) => l.startsWith('data: '));
                for (const line of lines) {
                    try {
                        const json = JSON.parse(line.slice(6));
                        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
                    } catch { /* keepalive / partial lines — ignore */ }
                }
            });
            response.data.on('end', () => { if (!closed) res.end(); });
            response.data.on('error', () => { if (!closed) res.end(); });
        } catch (error) {
            console.error('[AI] Neural core error:', error.message);
            if (!res.headersSent) res.status(500).json({ error: 'Neural core error' });
            else res.end();
        }
    },
};

export default aiController;
