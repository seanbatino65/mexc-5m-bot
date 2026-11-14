/**
 * Headless 24/7 Cloud Scanner for GitHub Actions / Free Cloud Cron Workers.
 * - Loads persistent `data/paper_trading_state.json`
 * - Scans all 10 watched MEXC Futures pairs (`BTC_USDT`, `ETH_USDT`, `SOL_USDT`, `SUI_USDT`, `HYPE_USDT`, `BNB_USDT`, `ZEC_USDT`, `ENA_USDT`, `ONDO_USDT`, `ARB_USDT`)
 * - Dispatches real-time Telegram alerts for new 5m Order Block + Order Flow signals AND TP1/TP2/SL hits
 * - Responds to Telegram `/status`, `/positions`, and `/scan` commands
 * - Saves updated `data/paper_trading_state.json` so GitHub Actions commits the live state back to the repository
 */

import { LivePaperTrader } from '../live/livePaperTrader.js';

const loopMinutes = Number(process.env.CLOUD_LOOP_MINUTES || 4);
const intervalMs = 15000;
const iterations = Math.max(1, Math.floor((loopMinutes * 60 * 1000) / intervalMs));
const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'https://mexc-5m-bot.onrender.com';

const trader = new LivePaperTrader({
  symbols: [
    'BTC_USDT',
    'ETH_USDT',
    'SOL_USDT',
    'SUI_USDT',
    'HYPE_USDT',
    'BNB_USDT',
    'ZEC_USDT',
    'ENA_USDT',
    'ONDO_USDT',
    'ARB_USDT',
  ],
  pollIntervalMs: intervalMs,
});

async function runCloudCycle() {
  console.log(`[24/7 Cloud Runner] Starting ${iterations} scan cycles (${loopMinutes} min window)...`);

  for (let i = 0; i < iterations; i++) {
    try {
      await trader.scanAllSymbols();
      await trader._pollTelegramCommands();

      if (renderUrl) {
        await fetch(`${renderUrl.replace(/\/$/, '')}/api/health`).catch(() => {});
      }

      const snap = trader.getStatusSnapshot();
      console.log(
        `[Cycle ${i + 1}/${iterations}] Equity: $${snap.account.liveEquity} | Open Trades: ${snap.account.openPositionsCount} | Watched: ${snap.watchedSymbols.length}`
      );
    } catch (err) {
      console.error(`[Cycle ${i + 1}] Error:`, err.message);
    }

    if (i < iterations - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  console.log('[24/7 Cloud Runner] Cycle complete. State saved to data/paper_trading_state.json.');
  process.exit(0);
}

runCloudCycle();
