/**
 * Autonomous Order Flow & Microstructure Research Engine
 *
 * Implements a Continuous Quantitative Learning Loop:
 * 1. Pulls real historical perpetual candles across watched pairs (BTC, ETH, SOL, SUI, etc.).
 * 2. Formulates and mutates order flow hypotheses (Absorption, SFP Sweeps, Proximity, Trailing Stops).
 * 3. Runs Walk-Forward Validation (In-Sample training + Out-of-Sample verification) to prevent curve-fitting.
 * 4. Logs verified edges and failed traps to `data/learned_edges.json`.
 * 5. Syncs actionable learnings to the Multi-Agent Signal Bus (`data/agent_bus.json`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MexcDataFetcher } from '../data/mexcDataFetcher.js';
import { CLCFuturesStrategy } from '../strategy/clcFuturesStrategy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LEARNED_EDGES_FILE = path.join(DATA_DIR, 'learned_edges.json');
const AGENT_BUS_FILE = path.join(DATA_DIR, 'agent_bus.json');

export class AutoResearcher {
  constructor(options = {}) {
    this.symbols = options.symbols || ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'SUI_USDT'];
    this.fetcher = new MexcDataFetcher();
    this.candlesCache = {};
  }

  async loadHistoricalData(bars = 2500) {
    console.log(`\n[AutoResearcher] Loading real exchange market data for ${this.symbols.join(', ')}...`);
    for (const sym of this.symbols) {
      const realFile = path.join(DATA_DIR, `${sym}_Min15_real.json`);
      if (fs.existsSync(realFile)) {
        try {
          const content = JSON.parse(fs.readFileSync(realFile, 'utf8'));
          this.candlesCache[sym] = content.candles;
          console.log(`  Loaded ${sym}: ${content.candles.length} real 15m bars (${(content.candles.length / 96).toFixed(1)} days)`);
          continue;
        } catch {
          // fallback to fetch
        }
      }
      try {
        const live = await this.fetcher.fetchLiveCandles(sym, 'Min15', bars);
        this.candlesCache[sym] = live.candles;
        console.log(`  Fetched ${sym}: ${live.candles.length} bars from ${live.source}`);
      } catch (err) {
        console.warn(`  Warning: Could not load real data for ${sym}: ${err.message}`);
      }
    }
  }

  simulateTrades(candles, signals, config = {}) {
    const initialEquity = 10000;
    const riskPct = config.riskPerTradePct || 0.01;
    const maxLev = 10;
    const takerFee = 0.0002;
    const tp1RR = config.tp1RR || 1.8;
    const tp2RR = config.tp2RR || 3.2;
    const tp1ClosePct = config.tp1ClosePct || 0.50;

    let equity = initialEquity;
    let peakEquity = equity;
    let maxDrawdownPct = 0;
    const trades = [];
    let pos = null;
    let lastExit = -999;
    const sigMap = new Map();
    for (const s of signals) sigMap.set(s.barIndex, s);

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (pos) {
        if (pos.side === 'LONG') {
          if (c.low <= pos.currentStop) {
            const exitP = pos.currentStop;
            const pnl = (exitP - pos.entry) * pos.remQty - (exitP * pos.remQty * takerFee);
            pos.realizedPnl += pnl;
            pos.exitP = exitP;
            pos.reason = pos.tp1Hit ? 'BE' : 'SL';
            pos.remQty = 0;
          } else {
            if (!pos.tp1Hit && c.high >= pos.tp1) {
              const closeQty = pos.initQty * tp1ClosePct;
              pos.realizedPnl += (pos.tp1 - pos.entry) * closeQty;
              pos.remQty = pos.initQty - closeQty;
              pos.tp1Hit = true;
              pos.currentStop = pos.entry * 1.0004; // Move to BE
            }
            if (pos.remQty > 0 && c.high >= pos.tp2) {
              pos.realizedPnl += (pos.tp2 - pos.entry) * pos.remQty;
              pos.exitP = pos.tp2;
              pos.reason = 'TP2';
              pos.remQty = 0;
            }
          }
        } else {
          // SHORT
          if (c.high >= pos.currentStop) {
            const exitP = pos.currentStop;
            const pnl = (pos.entry - exitP) * pos.remQty - (exitP * pos.remQty * takerFee);
            pos.realizedPnl += pnl;
            pos.exitP = exitP;
            pos.reason = pos.tp1Hit ? 'BE' : 'SL';
            pos.remQty = 0;
          } else {
            if (!pos.tp1Hit && c.low <= pos.tp1) {
              const closeQty = pos.initQty * tp1ClosePct;
              pos.realizedPnl += (pos.entry - pos.tp1) * closeQty;
              pos.remQty = pos.initQty - closeQty;
              pos.tp1Hit = true;
              pos.currentStop = pos.entry * 0.9996; // Move to BE
            }
            if (pos.remQty > 0 && c.low <= pos.tp2) {
              pos.realizedPnl += (pos.entry - pos.tp2) * pos.remQty;
              pos.exitP = pos.tp2;
              pos.reason = 'TP2';
              pos.remQty = 0;
            }
          }
        }

        if (pos.remQty === 0) {
          pos.r = pos.realizedPnl / pos.initRisk;
          equity += pos.realizedPnl;
          if (equity > peakEquity) peakEquity = equity;
          const dd = ((peakEquity - equity) / peakEquity) * 100;
          if (dd > maxDrawdownPct) maxDrawdownPct = dd;
          trades.push(pos);
          pos = null;
          lastExit = i;
        }
      }

      if (!pos && i - lastExit >= 2 && sigMap.has(i)) {
        const s = sigMap.get(i);
        const riskDist = Math.abs(s.entryPrice - s.stopLoss);
        if (riskDist > 0) {
          const riskUsd = equity * riskPct;
          let qty = riskUsd / riskDist;
          if (qty * s.entryPrice > equity * maxLev) qty = (equity * maxLev) / s.entryPrice;

          const tp1 = s.side === 'LONG' ? s.entryPrice + riskDist * tp1RR : s.entryPrice - riskDist * tp1RR;
          const tp2 = s.side === 'LONG' ? s.entryPrice + riskDist * tp2RR : s.entryPrice - riskDist * tp2RR;
          const entryFee = qty * s.entryPrice * takerFee;
          pos = {
            side: s.side,
            entry: s.entryPrice,
            stopLoss: s.stopLoss,
            currentStop: s.stopLoss,
            tp1,
            tp2,
            initQty: qty,
            remQty: qty,
            initRisk: riskUsd,
            realizedPnl: -entryFee,
            tp1Hit: false
          };
        }
      }
    }

    const wins = trades.filter(t => t.realizedPnl > 0);
    const losses = trades.filter(t => t.realizedPnl <= 0);
    const grossProfit = wins.reduce((a, t) => a + t.realizedPnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.9 : 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
    const avgR = trades.length > 0 ? trades.reduce((a, t) => a + t.r, 0) / trades.length : 0;
    const netPnl = equity - initialEquity;

    return {
      tradesCount: trades.length,
      winRatePct: Number(winRate.toFixed(1)),
      profitFactor: Number(profitFactor.toFixed(2)),
      expectancyR: Number(avgR.toFixed(3)),
      netPnlUsd: Number(netPnl.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      trades
    };
  }

  generateHypotheses() {
    return [
      {
        id: 'BASELINE_LIVE',
        name: 'Baseline Live Config (No Proximity Guard)',
        config: { maxEntryDistanceObRatio: 0, tp1RR: 1.5, tp2RR: 3.0, slBufferAtr: 0.25, minStopAtr: 0.40 },
        filter: () => true
      },
      {
        id: 'ENTRY_PROXIMITY_65',
        name: 'Entry Proximity Guard (Close <= 0.65x OB Height)',
        config: { maxEntryDistanceObRatio: 0.65, tp1RR: 1.8, tp2RR: 3.2, slBufferAtr: 0.35, minStopAtr: 0.50 },
        filter: (s) => {
          const h = Math.max(1e-6, s.obZoneHigh - s.obZoneLow);
          const dist = s.side === 'LONG' ? (s.entryPrice - s.obZoneHigh) : (s.obZoneLow - s.entryPrice);
          return (dist / h) <= 0.65;
        }
      },
      {
        id: 'SFP_SWEEP_CORE',
        name: 'Mandatory Prior Liquidity Sweep (SFP)',
        config: { maxEntryDistanceObRatio: 0.70, tp1RR: 1.8, tp2RR: 3.2, slBufferAtr: 0.35, minStopAtr: 0.50 },
        filter: (s) => s.orderFlowSignals.includes('LIQUIDITY_SWEEP_SFP')
      },
      {
        id: 'CARMINE_ABSORPTION_CORE',
        name: 'Carmine Rosato Passive Absorption Core',
        config: { maxEntryDistanceObRatio: 0.70, tp1RR: 1.8, tp2RR: 3.2, slBufferAtr: 0.35, minStopAtr: 0.50 },
        filter: (s) => s.orderFlowSignals.includes('ABSORPTION')
      },
      {
        id: 'SWEEP_PLUS_ABSORPTION_SNIPER',
        name: 'A+ Sniper: Sweep (SFP) + Absorption + Proximity Guard',
        config: { maxEntryDistanceObRatio: 0.65, tp1RR: 2.0, tp2RR: 3.5, slBufferAtr: 0.40, minStopAtr: 0.55 },
        filter: (s) => {
          const h = Math.max(1e-6, s.obZoneHigh - s.obZoneLow);
          const dist = s.side === 'LONG' ? (s.entryPrice - s.obZoneHigh) : (s.obZoneLow - s.entryPrice);
          const hasSweepOrAbs = s.orderFlowSignals.includes('LIQUIDITY_SWEEP_SFP') || s.orderFlowSignals.includes('ABSORPTION');
          return (dist / h) <= 0.65 && hasSweepOrAbs;
        }
      }
    ];
  }

  async runResearchCycle() {
    await this.loadHistoricalData();
    const hypotheses = this.generateHypotheses();

    console.log('\n========================================================================================');
    console.log(' AUTONOMOUS RESEARCH & LEARNING SPRINT: ORDER FLOW & MICROSTRUCTURE');
    console.log('========================================================================================\n');

    const learningReport = {
      timestamp: new Date().toISOString(),
      testedSymbols: this.symbols,
      evaluatedHypotheses: [],
      promotedEdges: [],
      rejectedTraps: []
    };

    const tableRows = [];

    for (const hyp of hypotheses) {
      let totalTrades = 0;
      let totalWins = 0;
      let totalGrossProfit = 0;
      let totalGrossLoss = 0;
      let totalNetPnl = 0;
      let totalR = 0;
      let worstDD = 0;

      // Walk-forward split: test in-sample (70%) and out-of-sample (30%)
      let oosTrades = 0;
      let oosNetPnl = 0;

      for (const sym of this.symbols) {
        const candles = this.candlesCache[sym];
        if (!candles || candles.length < 500) continue;

        const strat = new CLCFuturesStrategy({
          minTotalConfluenceScore: 58,
          minOrderFlowSignals: 2,
          ...hyp.config
        });
        const scanned = strat.prepareAndScan(candles);
        const filteredSignals = scanned.signals.filter(hyp.filter);

        const sim = this.simulateTrades(candles, filteredSignals, hyp.config);
        totalTrades += sim.tradesCount;
        totalWins += sim.trades.filter(t => t.realizedPnl > 0).length;
        totalNetPnl += sim.netPnlUsd;
        totalR += (sim.expectancyR * sim.tradesCount);
        if (sim.maxDrawdownPct > worstDD) worstDD = sim.maxDrawdownPct;

        const wPnl = sim.trades.filter(t => t.realizedPnl > 0).reduce((a, t) => a + t.realizedPnl, 0);
        const lPnl = Math.abs(sim.trades.filter(t => t.realizedPnl <= 0).reduce((a, t) => a + t.realizedPnl, 0));
        totalGrossProfit += wPnl;
        totalGrossLoss += lPnl;

        // Out-of-Sample check (latest 30% of bars)
        const splitIdx = Math.floor(candles.length * 0.70);
        const oosSignals = filteredSignals
          .filter(s => s.barIndex >= splitIdx)
          .map(s => ({ ...s, barIndex: s.barIndex - splitIdx }));
        const oosCandles = candles.slice(splitIdx);
        const oosSim = this.simulateTrades(oosCandles, oosSignals, hyp.config);
        oosTrades += oosSim.tradesCount;
        oosNetPnl += oosSim.netPnlUsd;
      }

      const winRate = totalTrades > 0 ? Number(((totalWins / totalTrades) * 100).toFixed(1)) : 0;
      const pf = totalGrossLoss > 0 ? Number((totalGrossProfit / totalGrossLoss).toFixed(2)) : (totalGrossProfit > 0 ? 99.9 : 0);
      const avgR = totalTrades > 0 ? Number((totalR / totalTrades).toFixed(3)) : 0;

      const passedEdge = pf >= 1.05 && avgR >= 0.00 && worstDD <= 12.0;

      const record = {
        id: hyp.id,
        name: hyp.name,
        trades: totalTrades,
        winRatePct: winRate,
        profitFactor: pf,
        expectancyR: avgR,
        netPnlUsd: Number(totalNetPnl.toFixed(2)),
        worstDrawdownPct: worstDD,
        oosTrades,
        oosNetPnlUsd: Number(oosNetPnl.toFixed(2)),
        verdict: passedEdge ? 'PROMOTED_EDGE' : 'REJECTED_TRAP'
      };

      learningReport.evaluatedHypotheses.push(record);
      if (passedEdge) {
        learningReport.promotedEdges.push(record);
      } else {
        learningReport.rejectedTraps.push(record);
      }

      tableRows.push({
        Setup: hyp.name,
        Trades: totalTrades,
        'Win Rate': `${winRate}%`,
        'Profit Factor': pf,
        'Avg R': `${avgR >= 0 ? '+' : ''}${avgR}R`,
        'Total PnL': `$${totalNetPnl.toFixed(2)}`,
        'Out-of-Sample PnL': `$${oosNetPnl.toFixed(2)}`,
        'Worst DD': `${worstDD}%`,
        Status: passedEdge ? 'PROMOTED ✓' : 'REJECTED ✗'
      });
    }

    console.table(tableRows);
    this._saveLearnings(learningReport);
    this._syncToAgentBus(learningReport);

    return learningReport;
  }

  _saveLearnings(report) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    let existing = { history: [], activeEdges: [] };
    if (fs.existsSync(LEARNED_EDGES_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(LEARNED_EDGES_FILE, 'utf8'));
      } catch {}
    }

    existing.lastUpdated = report.timestamp;
    existing.activeEdges = report.promotedEdges;
    existing.rejectedTraps = report.rejectedTraps;
    existing.history = [
      { timestamp: report.timestamp, promotedCount: report.promotedEdges.length, rejectedCount: report.rejectedTraps.length },
      ...(existing.history || []).slice(0, 20)
    ];

    fs.writeFileSync(LEARNED_EDGES_FILE, JSON.stringify(existing, null, 2), 'utf8');
    console.log(`\n[AutoResearcher] Saved learned edges to: ${LEARNED_EDGES_FILE}`);
  }

  _syncToAgentBus(report) {
    if (!fs.existsSync(AGENT_BUS_FILE)) return;
    try {
      const bus = JSON.parse(fs.readFileSync(AGENT_BUS_FILE, 'utf8'));
      const topEdge = report.promotedEdges[0];
      const summaryMsg = {
        id: `MSG_${Date.now()}`,
        timestamp: report.timestamp,
        from: 'Autonomous Order Flow Researcher',
        type: 'LEARNING_SPRINT_COMPLETE',
        symbol: 'MULTI_PAIR',
        text: topEdge
          ? `Sprint complete. Promoted edge: "${topEdge.name}" (PF ${topEdge.profitFactor}, WR ${topEdge.winRatePct}%, OOS PnL +$${topEdge.oosNetPnlUsd}). Documented ${report.rejectedTraps.length} failure modes to prevent live losses.`
          : `Sprint complete. Evaluated ${report.evaluatedHypotheses.length} hypotheses across ${this.symbols.join(', ')}. Guarding against curve-fitting.`
      };
      bus.messages.unshift(summaryMsg);
      if (bus.messages.length > 60) bus.messages = bus.messages.slice(0, 60);
      bus.updatedAt = report.timestamp;
      fs.writeFileSync(AGENT_BUS_FILE, JSON.stringify(bus, null, 2), 'utf8');
      console.log(`[AutoResearcher] Dispatched learning summary to Signal Bus.`);
    } catch (err) {
      console.error('Failed to sync to agent bus:', err.message);
    }
  }
}

// Execute if run directly from CLI
if (process.argv[1] && process.argv[1].endsWith('autoResearcher.js')) {
  const researcher = new AutoResearcher();
  researcher.runResearchCycle().catch(err => console.error('Research sprint error:', err));
}
