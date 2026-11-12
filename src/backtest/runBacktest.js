/**
 * CLI Backtest Runner & Carmine Rosato Order Flow Comparison Suite
 *
 * Compares:
 * 1. BLIND 15m Order Block (No Order Flow Confirmation)
 * 2. CARMINE CLC STANDARD (15m OB + >=1 Order Flow Signal)
 * 3. CARMINE CLC HIGH-CONFLUENCE (15m OB + >=2 Order Flow Signals: Absorption + Trapped Traders / Delta Div)
 *
 * Also tests across multiple MEXC Futures pairs (BTC_USDT, SOL_USDT).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MexcDataFetcher } from '../data/mexcDataFetcher.js';
import { BacktestEngine } from './backtestEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, '../../data/latest_backtest_report.json');

async function main() {
  const fetcher = new MexcDataFetcher();
  const symbols = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'SUI_USDT'];
  const allReports = {};

  console.log('====================================================================================');
  console.log(' MEXC FUTURES 5m OB + 4-EDUCATOR GOLDEN COMBO BACKTEST SUITE (REAL PERP HISTORY)');
  console.log('====================================================================================\n');

  for (const symbol of symbols) {
    const dataset = await fetcher.loadOrFetch({ symbol, interval: 'Min5', bars: 2500 });
    console.log(
      `Dataset: ${symbol} | Timeframe: 5m | Bars: ${dataset.candles.length} (~${(
        dataset.candles.length / 288
      ).toFixed(1)} days) | Source: ${dataset.source}`
    );

    const configurations = [
      {
        name: '1. Blind 5m Order Block (No Order Flow)',
        strategyConfig: {
          requireOrderFlowConfirmation: false,
          requireDirectionalClose: false,
          minOrderFlowSignals: 0,
          minTotalConfluenceScore: 0,
        },
      },
      {
        name: '2. Basic Order Flow (Score >= 55 — Unfiltered)',
        strategyConfig: {
          requireOrderFlowConfirmation: true,
          requireDirectionalClose: true,
          minOrderFlowSignals: 1,
          minTotalConfluenceScore: 55,
        },
      },
      {
        name: '3. Calibrated Golden Combo A-Grade (Score >= 65)',
        strategyConfig: {
          requireOrderFlowConfirmation: true,
          requireDirectionalClose: true,
          minOrderFlowSignals: 1,
          minTotalConfluenceScore: 65,
        },
      },
      {
        name: '4. Calibrated Golden Combo Sniper (Score >= 75)',
        strategyConfig: {
          requireOrderFlowConfirmation: true,
          requireDirectionalClose: true,
          minOrderFlowSignals: 1,
          minTotalConfluenceScore: 75,
        },
      },
    ];

    const comparisonRows = [];
    let bestRunResult = null;

    for (const cfg of configurations) {
      const engine = new BacktestEngine({
        initialEquity: 10000,
        riskPerTradePct: 0.01,
        maxLeverage: 10,
        takerFeeRate: 0.0002,
        makerFeeRate: 0.0000,
        moveToBreakEvenOnTp1: true,
        strategyConfig: cfg.strategyConfig,
      });

      const res = engine.run(dataset.candles);
      const s = res.summary;

      comparisonRows.push({
        Strategy: cfg.name,
        Trades: s.totalTrades,
        'Win Rate': `${s.winRatePct}%`,
        'Profit Factor': s.profitFactor,
        'Expectancy (R)': `${s.expectancyR >= 0 ? '+' : ''}${s.expectancyR}R`,
        'Net Return': `${s.netReturnPct >= 0 ? '+' : ''}${s.netReturnPct}%`,
        'Final Equity': `$${s.finalEquity.toLocaleString()}`,
        'Max DD': `${s.maxDrawdownPct}%`,
        Sharpe: s.sharpeRatio,
      });

      if (cfg.name.startsWith('4.')) {
        bestRunResult = res;
      }
    }

    console.table(comparisonRows);

    if (bestRunResult) {
      console.log(`\n[${symbol}] High-Confluence CLC Order Flow Signal Breakdown:`);
      console.table(bestRunResult.signalBreakdown);

      console.log(`\n[${symbol}] Recent Sample Trades (High-Confluence CLC):`);
      const sampleTrades = bestRunResult.trades.slice(-8).map((t) => ({
        ID: t.tradeId,
        Side: t.side,
        Entry: t.entryPrice,
        SL: t.initialStopLoss,
        Exit: t.exitPrice,
        'OrderFlow Triggers': t.orderFlowSignals.join(' + '),
        Score: t.confluenceScore,
        Result: t.exitReason,
        'R-Mult': `${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple}R`,
        'PnL ($)': `${t.realizedPnlUsd >= 0 ? '+' : ''}$${t.realizedPnlUsd}`,
      }));
      console.table(sampleTrades);
      console.log('------------------------------------------------------------------------------------\n');

      allReports[symbol] = {
        symbol,
        source: dataset.source,
        comparison: comparisonRows,
        summary: bestRunResult.summary,
        signalBreakdown: bestRunResult.signalBreakdown,
        trades: bestRunResult.trades,
        equityCurve: bestRunResult.equityCurve,
        orderBlocks: bestRunResult.orderBlocks.slice(-80),
        candles: bestRunResult.candles.slice(-400).map((c) => ({
          index: c.index,
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          vwap: Number(c.vwap.toFixed(2)),
          delta: Math.round(c.orderFlow.delta),
          deltaPct: Number((c.orderFlow.deltaPct * 100).toFixed(1)),
          cvd: Math.round(c.orderFlow.cvd),
          pocPrice: Number(c.orderFlow.pocPrice.toFixed(2)),
        })),
      };
    }
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(allReports, null, 2));
  console.log(`Saved full interactive backtest report to: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
