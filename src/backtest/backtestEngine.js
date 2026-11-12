/**
 * MEXC USDT-M Perpetual Futures Backtesting Engine
 *
 * Simulates realistic Futures execution for the 15m Order Block + Carmine Rosato Order Flow (CLC) Strategy:
 * - Risk-based position sizing (% of equity risked per trade, bounded by max leverage)
 * - MEXC Futures taker/maker fees (default 0.02% taker / 0.00% maker) + slippage
 * - Partial Take Profit (TP1 -> lock in partial profit & move SL to Break-Even) + Final Target (TP2)
 * - Intrabar conservative conflict resolution (if both SL and TP are touched in the same candle, SL takes precedence)
 * - Detailed breakdown by Order Flow signal type (Absorption, Delta Divergence, Trapped Traders, POC Defense)
 */

import { CLCFuturesStrategy } from '../strategy/clcFuturesStrategy.js';

export class BacktestEngine {
  constructor(config = {}) {
    this.config = {
      initialEquity: config.initialEquity ?? 10000,   // Starting USDT Futures balance
      riskPerTradePct: config.riskPerTradePct ?? 0.01, // 1.0% account risk per trade
      maxLeverage: config.maxLeverage ?? 10,           // Max allowed futures leverage (10x)
      takerFeeRate: config.takerFeeRate ?? 0.0002,     // MEXC Futures 0.02% taker fee
      makerFeeRate: config.makerFeeRate ?? 0.0000,     // MEXC Futures 0.00% maker fee (limit TP)
      slippageBps: config.slippageBps ?? 1.5,          // 1.5 bps market entry/stop slippage
      moveToBreakEvenOnTp1: config.moveToBreakEvenOnTp1 ?? true,
      maxHoldBars: config.maxHoldBars ?? 192,          // 192 x 5m bars = 16 hours max trade duration
      strategyConfig: config.strategyConfig ?? {},
    };
  }

  /**
   * Executes a full backtest on `rawCandles`.
   *
   * @param {Array<Object>} rawCandles
   * @returns {Object} { summary, trades, equityCurve, signalBreakdown, candles, orderBlocks, structureEvents }
   */
  run(rawCandles) {
    const strategy = new CLCFuturesStrategy(this.config.strategyConfig);
    const { candles, orderBlocks, structureEvents, signals } = strategy.prepareAndScan(rawCandles);

    const signalByBar = new Map();
    for (const sig of signals) {
      signalByBar.set(sig.barIndex, sig);
    }

    let equity = this.config.initialEquity;
    let peakEquity = equity;
    let maxDrawdownUsd = 0;
    let maxDrawdownPct = 0;

    const trades = [];
    const equityCurve = [
      {
        barIndex: 0,
        timestamp: candles[0]?.timestamp || Date.now(),
        equity,
        drawdownPct: 0,
      },
    ];

    let activePosition = null;
    let lastExitBar = -999;
    const cooldownBars = strategy.config.cooldownBars ?? 3;
    const tp1ClosePct = strategy.config.tp1ClosePct ?? 0.5;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];

      // 1. Manage Open Position on Bar `i`
      if (activePosition) {
        const pos = activePosition;
        const barsHeld = i - pos.entryBarIndex;

        if (pos.side === 'LONG') {
          // Conservative intrabar check: Check Stop Loss first
          if (c.low <= pos.currentStopLoss) {
            const exitPrice = this._applySlippage(pos.currentStopLoss, 'SELL');
            const pnl = (exitPrice - pos.entryPrice) * pos.remainingQty;
            const fee = exitPrice * pos.remainingQty * this.config.takerFeeRate;
            pos.realizedPnlUsd += pnl - fee;
            pos.feesPaidUsd += fee;
            pos.exitBarIndex = i;
            pos.exitTimestamp = c.timestamp;
            pos.exitPrice = exitPrice;
            pos.exitReason = pos.tp1Hit ? 'TP1_THEN_BREAKEVEN' : 'STOP_LOSS';
            pos.remainingQty = 0;
          } else {
            // Check TP1 if not yet hit
            if (!pos.tp1Hit && c.high >= pos.tp1Price) {
              const tp1Qty = pos.initialQty * tp1ClosePct;
              const pnl1 = (pos.tp1Price - pos.entryPrice) * tp1Qty;
              const fee1 = pos.tp1Price * tp1Qty * this.config.makerFeeRate;
              pos.realizedPnlUsd += pnl1 - fee1;
              pos.feesPaidUsd += fee1;
              pos.remainingQty = pos.initialQty - tp1Qty;
              pos.tp1Hit = true;
              pos.tp1BarIndex = i;

              if (this.config.moveToBreakEvenOnTp1) {
                // Move SL to Break-Even + tiny buffer for fees
                pos.currentStopLoss = pos.entryPrice * (1 + this.config.takerFeeRate * 2);
              }
            }

            // Check TP2 on remaining quantity
            if (pos.remainingQty > 0 && c.high >= pos.tp2Price) {
              const pnl2 = (pos.tp2Price - pos.entryPrice) * pos.remainingQty;
              const fee2 = pos.tp2Price * pos.remainingQty * this.config.makerFeeRate;
              pos.realizedPnlUsd += pnl2 - fee2;
              pos.feesPaidUsd += fee2;
              pos.exitBarIndex = i;
              pos.exitTimestamp = c.timestamp;
              pos.exitPrice = pos.tp2Price;
              pos.exitReason = 'TP2_TARGET_HIT';
              pos.remainingQty = 0;
            }
          }
        } else {
          // SHORT Position Management
          if (c.high >= pos.currentStopLoss) {
            const exitPrice = this._applySlippage(pos.currentStopLoss, 'BUY');
            const pnl = (pos.entryPrice - exitPrice) * pos.remainingQty;
            const fee = exitPrice * pos.remainingQty * this.config.takerFeeRate;
            pos.realizedPnlUsd += pnl - fee;
            pos.feesPaidUsd += fee;
            pos.exitBarIndex = i;
            pos.exitTimestamp = c.timestamp;
            pos.exitPrice = exitPrice;
            pos.exitReason = pos.tp1Hit ? 'TP1_THEN_BREAKEVEN' : 'STOP_LOSS';
            pos.remainingQty = 0;
          } else {
            // Check TP1
            if (!pos.tp1Hit && c.low <= pos.tp1Price) {
              const tp1Qty = pos.initialQty * tp1ClosePct;
              const pnl1 = (pos.entryPrice - pos.tp1Price) * tp1Qty;
              const fee1 = pos.tp1Price * tp1Qty * this.config.makerFeeRate;
              pos.realizedPnlUsd += pnl1 - fee1;
              pos.feesPaidUsd += fee1;
              pos.remainingQty = pos.initialQty - tp1Qty;
              pos.tp1Hit = true;
              pos.tp1BarIndex = i;

              if (this.config.moveToBreakEvenOnTp1) {
                pos.currentStopLoss = pos.entryPrice * (1 - this.config.takerFeeRate * 2);
              }
            }

            // Check TP2
            if (pos.remainingQty > 0 && c.low <= pos.tp2Price) {
              const pnl2 = (pos.entryPrice - pos.tp2Price) * pos.remainingQty;
              const fee2 = pos.tp2Price * pos.remainingQty * this.config.makerFeeRate;
              pos.realizedPnlUsd += pnl2 - fee2;
              pos.feesPaidUsd += fee2;
              pos.exitBarIndex = i;
              pos.exitTimestamp = c.timestamp;
              pos.exitPrice = pos.tp2Price;
              pos.exitReason = 'TP2_TARGET_HIT';
              pos.remainingQty = 0;
            }
          }
        }

        // Check Time Stop (maxHoldBars) or End of Dataset
        if (pos.remainingQty > 0 && (barsHeld >= this.config.maxHoldBars || i === candles.length - 1)) {
          const exitSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
          const exitPrice = this._applySlippage(c.close, exitSide);
          const pnl =
            pos.side === 'LONG'
              ? (exitPrice - pos.entryPrice) * pos.remainingQty
              : (pos.entryPrice - exitPrice) * pos.remainingQty;
          const fee = exitPrice * pos.remainingQty * this.config.takerFeeRate;
          pos.realizedPnlUsd += pnl - fee;
          pos.feesPaidUsd += fee;
          pos.exitBarIndex = i;
          pos.exitTimestamp = c.timestamp;
          pos.exitPrice = exitPrice;
          pos.exitReason = i === candles.length - 1 ? 'END_OF_DATA' : 'TIME_EXIT';
          pos.remainingQty = 0;
        }

        // Finalize closed position
        if (pos.remainingQty === 0) {
          pos.barsHeld = pos.exitBarIndex - pos.entryBarIndex;
          pos.rMultiple = Number((pos.realizedPnlUsd / pos.initialRiskUsd).toFixed(2));
          pos.realizedPnlUsd = Number(pos.realizedPnlUsd.toFixed(2));
          pos.feesPaidUsd = Number(pos.feesPaidUsd.toFixed(2));
          equity = Number((equity + pos.realizedPnlUsd).toFixed(2));
          pos.equityAfter = equity;

          if (equity > peakEquity) peakEquity = equity;
          const ddUsd = peakEquity - equity;
          const ddPct = peakEquity > 0 ? (ddUsd / peakEquity) * 100 : 0;
          if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
          if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

          trades.push(pos);
          equityCurve.push({
            barIndex: i,
            timestamp: c.timestamp,
            equity,
            drawdownPct: Number(ddPct.toFixed(2)),
          });

          lastExitBar = i;
          activePosition = null;
        }
      }

      // 2. Check for New Entry Signal at Bar `i` Close (only if flat and past cooldown)
      if (!activePosition && i - lastExitBar >= cooldownBars && i < candles.length - 2) {
        const sig = signalByBar.get(i);
        if (sig) {
          const entrySide = sig.side === 'LONG' ? 'BUY' : 'SELL';
          const fillPrice = this._applySlippage(sig.entryPrice, entrySide);
          const stopDistance = Math.abs(fillPrice - sig.stopLoss);

          if (stopDistance > 0) {
            const desiredRiskUsd = equity * this.config.riskPerTradePct;
            let qty = desiredRiskUsd / stopDistance;

            // Cap position notional by maxLeverage * equity
            const maxNotional = equity * this.config.maxLeverage;
            if (qty * fillPrice > maxNotional) {
              qty = maxNotional / fillPrice;
            }

            const actualRiskUsd = qty * stopDistance;
            const entryFee = qty * fillPrice * this.config.takerFeeRate;

            activePosition = {
              tradeId: trades.length + 1,
              side: sig.side,
              orderBlockId: sig.orderBlockId,
              orderBlockType: sig.orderBlockType,
              obZoneLow: sig.obZoneLow,
              obZoneHigh: sig.obZoneHigh,
              entryBarIndex: i,
              entryTimestamp: c.timestamp,
              entryPrice: Number(fillPrice.toFixed(4)),
              initialStopLoss: Number(sig.stopLoss.toFixed(4)),
              currentStopLoss: Number(sig.stopLoss.toFixed(4)),
              tp1Price: Number(sig.tp1Price.toFixed(4)),
              tp2Price: Number(sig.tp2Price.toFixed(4)),
              targetType: sig.targetType,
              initialQty: qty,
              remainingQty: qty,
              notionalUsd: Number((qty * fillPrice).toFixed(2)),
              initialRiskUsd: actualRiskUsd,
              confluenceScore: sig.confluenceScore,
              grade: sig.grade,
              scoreBreakdown: sig.scoreBreakdown || [],
              orderFlowSignals: sig.orderFlowSignals,
              orderFlowMetrics: sig.orderFlowMetrics,
              tp1Hit: false,
              tp1BarIndex: null,
              realizedPnlUsd: -entryFee,
              feesPaidUsd: entryFee,
            };
          }
        }
      }
    }

    const summary = this._computeSummary(trades, equity, maxDrawdownUsd, maxDrawdownPct, candles);
    const signalBreakdown = this._computeSignalBreakdown(trades);

    return {
      summary,
      signalBreakdown,
      trades,
      equityCurve,
      candles,
      orderBlocks,
      structureEvents,
    };
  }

  _applySlippage(price, orderSide) {
    const slip = (this.config.slippageBps / 10000) * price;
    return orderSide === 'BUY' ? price + slip : price - slip;
  }

  _computeSummary(trades, finalEquity, maxDrawdownUsd, maxDrawdownPct, candles) {
    const totalTrades = trades.length;
    const wins = trades.filter((t) => t.realizedPnlUsd > 0);
    const losses = trades.filter((t) => t.realizedPnlUsd <= 0);
    const fullTp2Wins = trades.filter((t) => t.exitReason === 'TP2_TARGET_HIT');
    const tp1BeWins = trades.filter((t) => t.exitReason === 'TP1_THEN_BREAKEVEN');

    const grossProfit = wins.reduce((acc, t) => acc + t.realizedPnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.realizedPnlUsd, 0));
    const netPnlUsd = finalEquity - this.config.initialEquity;
    const netReturnPct = (netPnlUsd / this.config.initialEquity) * 100;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

    const avgR =
      totalTrades > 0 ? trades.reduce((acc, t) => acc + t.rMultiple, 0) / totalTrades : 0;
    const avgWinR =
      wins.length > 0 ? wins.reduce((acc, t) => acc + t.rMultiple, 0) / wins.length : 0;
    const avgLossR =
      losses.length > 0 ? losses.reduce((acc, t) => acc + t.rMultiple, 0) / losses.length : 0;

    // Trade-level Sharpe estimate
    let sharpe = 0;
    if (totalTrades > 1) {
      const rList = trades.map((t) => t.rMultiple);
      const meanR = avgR;
      const variance = rList.reduce((acc, r) => acc + (r - meanR) ** 2, 0) / (totalTrades - 1);
      const stdR = Math.sqrt(variance);
      sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(totalTrades) : 0;
    }

    const longTrades = trades.filter((t) => t.side === 'LONG');
    const shortTrades = trades.filter((t) => t.side === 'SHORT');
    const longWins = longTrades.filter((t) => t.realizedPnlUsd > 0).length;
    const shortWins = shortTrades.filter((t) => t.realizedPnlUsd > 0).length;

    const totalDays =
      candles.length > 1
        ? (candles[candles.length - 1].timestamp - candles[0].timestamp) / (86400 * 1000)
        : 0;

    return {
      initialEquity: this.config.initialEquity,
      finalEquity: Number(finalEquity.toFixed(2)),
      netPnlUsd: Number(netPnlUsd.toFixed(2)),
      netReturnPct: Number(netReturnPct.toFixed(2)),
      totalTrades,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRatePct: totalTrades > 0 ? Number(((wins.length / totalTrades) * 100).toFixed(2)) : 0,
      tp2FullHits: fullTp2Wins.length,
      tp1PlusBreakEvenHits: tp1BeWins.length,
      profitFactor: Number(profitFactor.toFixed(2)),
      expectancyR: Number(avgR.toFixed(2)),
      avgWinR: Number(avgWinR.toFixed(2)),
      avgLossR: Number(avgLossR.toFixed(2)),
      maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      sharpeRatio: Number(sharpe.toFixed(2)),
      longStats: {
        trades: longTrades.length,
        winRatePct: longTrades.length > 0 ? Number(((longWins / longTrades.length) * 100).toFixed(1)) : 0,
      },
      shortStats: {
        trades: shortTrades.length,
        winRatePct: shortTrades.length > 0 ? Number(((shortWins / shortTrades.length) * 100).toFixed(1)) : 0,
      },
      totalBars: candles.length,
      periodDays: Number(totalDays.toFixed(1)),
    };
  }

  _computeSignalBreakdown(trades) {
    const categories = ['ABSORPTION', 'DELTA_DIVERGENCE', 'TRAPPED_SELLERS', 'TRAPPED_BUYERS', 'POC_DEFENSE'];
    const breakdown = {};

    for (const cat of categories) {
      const subset = trades.filter((t) => t.orderFlowSignals.includes(cat));
      if (subset.length === 0) continue;
      const wins = subset.filter((t) => t.realizedPnlUsd > 0);
      const netPnl = subset.reduce((acc, t) => acc + t.realizedPnlUsd, 0);
      const avgR = subset.reduce((acc, t) => acc + t.rMultiple, 0) / subset.length;
      breakdown[cat] = {
        trades: subset.length,
        winRatePct: Number(((wins.length / subset.length) * 100).toFixed(1)),
        netPnlUsd: Number(netPnl.toFixed(2)),
        expectancyR: Number(avgR.toFixed(2)),
      };
    }

    return breakdown;
  }
}
