/**
 * Unified Web Server for:
 * 1. Live MEXC 5m Chart + Auto-Drawn Order Blocks + Footprint / Delta / CVD Visualizer
 * 2. Real-Time Multi-Pair Signal Scanner & Alert Dispatcher (Web + Audio + Telegram/Discord)
 * 3. Persistent 7-Day Paper Trading Forward-Tester
 * 4. Historical Strategy Backtester
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MexcDataFetcher } from './data/mexcDataFetcher.js';
import { BacktestEngine } from './backtest/backtestEngine.js';
import { LivePaperTrader } from './live/livePaperTrader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const REPORT_PATH = path.resolve(__dirname, '../data/latest_backtest_report.json');
const PORT = process.env.PORT || 3470;

// Ensure any previous server instance on PORT is stopped before loading/repairing state (Windows local dev)
if (process.platform === 'win32') {
  try {
    const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).filter((l) => l.includes('LISTENING'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid);
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // No existing listener on PORT
  }
}

const fetcher = new MexcDataFetcher();
const liveTrader = new LivePaperTrader({
  symbols: ['BTC_USDC', 'ETH_USDC', 'SOL_USDC', 'SUI_USDC', 'HYPE_USDC', 'PUMP_USDC', 'DOGE_USDC'],
  pollIntervalMs: 8000,
});

// Start live scanner + 7-day paper trading engine
liveTrader
  .start()
  .then(() => {
    return liveTrader.sendTestTelegramAlert().catch((e) => console.error('Telegram test error:', e.message));
  })
  .catch((err) => console.error('Initial live scan error:', err));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // 0. Cloud 24/7 Keep-Alive & Health Check Endpoint (Render / Koyeb / UptimeRobot / Cron)
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const snap = liveTrader.getStatusSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptimeSeconds: Math.round(process.uptime()),
          watchedSymbolsCount: snap.watchedSymbols.length,
          openPositionsCount: snap.account.openPositionsCount,
          liveEquity: snap.account.liveEquity,
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // 1. Live 7-Day Paper Trading & Signals Snapshot
    if (req.method === 'GET' && url.pathname === '/api/live/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(liveTrader.getStatusSnapshot()));
      return;
    }

    // 2. Live Hyperliquid 5m / 15m Chart + Order Blocks + Footprint Data for a Symbol
    if (req.method === 'GET' && url.pathname === '/api/live/chart') {
      const symbol = liveTrader.normalizeSymbol(url.searchParams.get('symbol') || 'BTC_USDC');
      const tf = url.searchParams.get('tf') === '15m' ? '15m' : '5m';
      const cache = tf === '15m' ? liveTrader.marketCache15m : liveTrader.marketCache;
      if (!cache[symbol]) {
        await liveTrader.scanSymbol(symbol);
      }
      const chartData = cache[symbol] || liveTrader.marketCache[symbol] || { error: 'No chart data available' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(chartData));
      return;
    }

    // 3. Trigger an Immediate Scan / Step Forward
    if (req.method === 'POST' && url.pathname === '/api/live/scan-now') {
      await liveTrader.scanAllSymbols();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(liveTrader.getStatusSnapshot()));
      return;
    }

    // 3b. Add or Remove Watched MEXC Tokens
    if (req.method === 'POST' && url.pathname === '/api/live/symbols') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { action, symbol } = body ? JSON.parse(body) : {};
      if (action === 'add' && symbol) {
        const added = await liveTrader.addSymbol(symbol);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, symbol: added, status: liveTrader.getStatusSnapshot() }));
        return;
      }
      if (action === 'remove' && symbol) {
        liveTrader.removeSymbol(symbol);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: liveTrader.getStatusSnapshot() }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid action or symbol' }));
      return;
    }

    // 3b-2. Update Minimum Confluence Score Threshold
    if (req.method === 'POST' && url.pathname === '/api/live/score-threshold') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { minScore } = body ? JSON.parse(body) : {};
      const updated = await liveTrader.setMinScoreThreshold(minScore);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, minScoreThreshold: updated, status: liveTrader.getStatusSnapshot() }));
      return;
    }

    // 3c. Multi-Agent Signal Bridge (Gemini <-> Claude Communication Bus)
    if (req.method === 'GET' && url.pathname === '/api/agent-bus') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(liveTrader.getAgentBusSnapshot(), null, 2));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent-bus') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = body ? JSON.parse(body) : {};
      const snapshot = liveTrader.handleAgentBusAction(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agentBus: snapshot }, null, 2));
      return;
    }

    // 4. Configure Telegram / Discord Push Alerts
    if (req.method === 'POST' && url.pathname === '/api/live/alerts') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const cfg = body ? JSON.parse(body) : {};
      const updated = liveTrader.saveAlertConfig(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, alertConfig: updated }));
      return;
    }

    // 4b. Send a Live Test Message to Telegram
    if (req.method === 'POST' && url.pathname === '/api/live/test-telegram') {
      const tgRes = await liveTrader.sendTestTelegramAlert();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, telegramResponse: tgRes }));
      return;
    }

    // 5. Reset 7-Day Paper Trading Account (PROPR 5K Mode)
    if (req.method === 'POST' && url.pathname === '/api/live/reset') {
      liveTrader.resetPaperAccount(5000);
      await liveTrader.scanAllSymbols();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(liveTrader.getStatusSnapshot()));
      return;
    }

    // 5b. PROPR Auto-Trader Status, Config & Connection Test
    if (req.method === 'GET' && url.pathname === '/api/propr/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(liveTrader.proprTrader.getPublicStatus()));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/propr/config') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const cfg = body ? JSON.parse(body) : {};
      const status = liveTrader.proprTrader.saveConfig(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, propr: status }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/propr/test') {
      const testRes = await liveTrader.proprTrader.testConnection();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(testRes));
      return;
    }

    // 6. Historical Backtest Report & Custom Runner
    if (req.method === 'GET' && url.pathname === '/api/report') {
      if (fs.existsSync(REPORT_PATH)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(fs.readFileSync(REPORT_PATH, 'utf8'));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Report not found.' }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run-backtest') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = body ? JSON.parse(body) : {};

      const symbol = params.symbol || 'BTC_USDT';
      const bars = Number(params.bars || 2000);
      const dataset = await fetcher.loadOrFetch({ symbol, interval: 'Min15', bars });

      const engine = new BacktestEngine({
        initialEquity: Number(params.initialEquity ?? 10000),
        riskPerTradePct: Number(params.riskPerTradePct ?? 0.01),
        maxLeverage: Number(params.maxLeverage ?? 10),
        moveToBreakEvenOnTp1: params.moveToBreakEvenOnTp1 ?? true,
        strategyConfig: {
          requireOrderFlowConfirmation: params.requireOrderFlowConfirmation ?? true,
          minOrderFlowSignals: Number(params.minOrderFlowSignals ?? 2),
          minTotalConfluenceScore: Number(params.minTotalConfluenceScore ?? 58),
          tp1RR: Number(params.tp1RR ?? 1.5),
          tp2RR: Number(params.tp2RR ?? 3.0),
          trendAlignmentFilter: Boolean(params.trendAlignmentFilter ?? false),
        },
      });

      const result = engine.run(dataset.candles);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          symbol,
          source: dataset.source,
          summary: result.summary,
          signalBreakdown: result.signalBreakdown,
          trades: result.trades,
          equityCurve: result.equityCurve,
        })
      );
      return;
    }

    // Serve static files from public/
    const filePath =
      url.pathname === '/'
        ? path.join(PUBLIC_DIR, 'index.html')
        : path.join(PUBLIC_DIR, url.pathname);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      res.end(fs.readFileSync(filePath));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && process.platform === 'win32') {
    try {
      const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' });
      const lines = out.split(/\r?\n/).filter((l) => l.includes('LISTENING'));
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (pid && pid !== process.pid) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // Ignore
          }
        }
      }
      setTimeout(() => {
        server.listen(PORT);
      }, 600);
      return;
    } catch {
      // Fall through
    }
  }
  console.error('Server error:', err.message);
});

server.listen(PORT, () => {
  console.log(`Hyperliquid (PROPR) 5m Order Block + Order Flow Live Command Center running at http://localhost:${PORT}`);

  // 24/7 Cloud Keep-Alive Self-Ping (prevents Render / Koyeb free tier from sleeping after 15m)
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (externalUrl) {
    const cleanUrl = externalUrl.replace(/\/$/, '');
    console.log(`[24/7 Cloud Keep-Alive] Active for ${cleanUrl}/api/health (every 10m)`);
    setInterval(() => {
      fetch(`${cleanUrl}/api/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }
});
