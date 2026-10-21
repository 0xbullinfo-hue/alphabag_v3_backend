// SPDX-License-Identifier: MIT
// AlphaBAG V3 — Model Context Protocol (MCP) Server for AI Agents
// Exposes real-time crypto market data, telemetry, and wallet queries to AI agents.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  getLiveCoins,
  getLiveCoin,
  getGlobalMarketTelemetry,
  getLiveNews,
  getPricesByCoinStats,
  getWalletBalances,
} from '../services/coinstatsService.js';

// Initialize the AlphaBAG MCP Server
const server = new McpServer({
  name: 'alphabag-market-intelligence',
  version: '3.0.0',
});

// Tool 1: Get Live Price & Stats for a Crypto Asset
server.tool(
  'get_live_crypto_price',
  'Get real-time price, 24h change, 24h volume, and market cap for any cryptocurrency by symbol (e.g. BTC, ETH, SOL) or CoinStats ID (e.g. bitcoin, ethereum).',
  {
    symbolOrId: z.string().describe('Crypto symbol (BTC, ETH, SOL) or ID (bitcoin, ethereum)'),
  },
  async ({ symbolOrId }) => {
    try {
      const clean = symbolOrId.trim().toLowerCase();
      // First try top coins
      const coins = await getLiveCoins({ page: 1, limit: 100 });
      const found = coins.find(
        (c) => c.symbol.toLowerCase() === clean || c.id.toLowerCase() === clean
      );

      if (found) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  asset: found.name,
                  symbol: found.symbol.toUpperCase(),
                  priceUsd: found.current_price,
                  change1h: found.price_change_percentage_1h_in_currency,
                  change24h: found.price_change_percentage_24h,
                  change7d: found.price_change_percentage_7d_in_currency,
                  volume24h: found.total_volume,
                  marketCap: found.market_cap,
                  rank: found.market_cap_rank,
                  circulatingSupply: found.circulating_supply,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // If not in top 100, fetch individual coin
      const coin = await getLiveCoin(clean);
      if (coin) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  asset: coin.name,
                  symbol: (coin.symbol || '').toUpperCase(),
                  priceUsd: coin.price,
                  change1h: coin.priceChange1h,
                  change24h: coin.priceChange1d,
                  change7d: coin.priceChange1w,
                  volume24h: coin.volume,
                  marketCap: coin.marketCap,
                  rank: coin.rank,
                  allTimeHigh: coin.allTimeHigh,
                  allTimeLow: coin.allTimeLow,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `No live pricing found for "${symbolOrId}". Please verify the coin symbol or ID.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching live price for ${symbolOrId}: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 2: Global Crypto Market Overview
server.tool(
  'get_market_overview',
  'Get overall global crypto market telemetry including Total Market Cap, 24h Volume, BTC Dominance, and active 24h percentage changes.',
  {},
  async () => {
    try {
      const telemetry = await getGlobalMarketTelemetry();
      if (!telemetry) {
        return {
          content: [
            {
              type: 'text',
              text: 'Global market telemetry temporarily unavailable.',
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(telemetry, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching global market overview: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 3: Top Crypto Market Rankings
server.tool(
  'get_top_market_coins',
  'Get a list of the top cryptocurrency assets ranked by market capitalization with real-time prices and volume.',
  {
    limit: z.number().optional().default(20).describe('Number of top coins to return (max 100)'),
  },
  async ({ limit }) => {
    try {
      const safeLimit = Math.min(Math.max(1, limit || 20), 100);
      const coins = await getLiveCoins({ page: 1, limit: safeLimit });
      const summary = coins.slice(0, safeLimit).map((c) => ({
        rank: c.market_cap_rank,
        name: c.name,
        symbol: c.symbol.toUpperCase(),
        priceUsd: c.current_price,
        change24h: c.price_change_percentage_24h,
        marketCap: c.market_cap,
        volume24h: c.total_volume,
      }));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching top coins: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 4: Latest Crypto News
server.tool(
  'get_crypto_news',
  'Fetch latest breaking cryptocurrency market news and headlines from top crypto publications.',
  {
    limit: z.number().optional().default(10).describe('Number of news headlines to retrieve'),
  },
  async ({ limit }) => {
    try {
      const news = await getLiveNews({ page: 1, limit: limit || 10 });
      const simplified = (news || []).map((n) => ({
        title: n.title,
        source: n.source,
        url: n.shareURL || n.link,
        publishedAt: n.feedDate ? new Date(n.feedDate).toISOString() : null,
      }));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(simplified, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching crypto news: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 5: Multi-Chain Wallet Portfolio Analysis
server.tool(
  'get_wallet_portfolio',
  'Retrieve multi-chain token holdings and live valuations for any public crypto wallet address.',
  {
    address: z.string().describe('Public wallet address (0x... for EVM or base58 for Solana)'),
    connectionType: z.string().optional().default('ethereum').describe('Blockchain connection type (ethereum, solana, etc.)'),
  },
  async ({ address, connectionType }) => {
    try {
      const balances = await getWalletBalances(address, connectionType || 'ethereum');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                address,
                connectionType,
                holdingsCount: balances.length,
                tokens: balances.slice(0, 50).map((t) => ({
                  name: t.name,
                  symbol: t.symbol,
                  amount: t.amount,
                  priceUsd: t.price,
                  valueUsd: t.amount && t.price ? Number((t.amount * t.price).toFixed(2)) : null,
                  chain: t.chain,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching wallet portfolio for ${address}: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Connect and start the server over stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[AlphaBAG MCP] Real-Time Market Intelligence MCP Server running on stdio');
}

main().catch((err) => {
  console.error('[AlphaBAG MCP] Fatal error:', err);
  process.exit(1);
});
