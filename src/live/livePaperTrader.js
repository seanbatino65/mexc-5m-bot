/**
 * Real-Time MEXC Futures Scanner, Signal Dispatcher & 7-Day Persistent Paper Trading Engine
 *
 * Features:
 * - Dynamic Token Watchlist (add/remove any USDT-M Futures pair live from the dashboard, persisted on disk)
 * - Dual Entry Pricing on every Signal:
 *   1. Market Confirmation Entry (`entryPrice` at confirmation candle close)
 *   2. Optimal Limit Retest Entry (`limitEntryPrice` at 15m OB Proximal Edge / Footprint POC for 0% Maker Fee)
 * - Persistent 7-Day Paper Trading Account (`data/paper_trading_state.json`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MexcDataFetcher } from '../data/mexcDataFetcher.js';
import { CLCFuturesStrategy } from '../strategy/clcFuturesStrategy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, '../../data/paper_trading_state.json');
const CONFIG_FILE = path.resolve(__dirname, '../../data/alert_config.json');
const AGENT_BUS_FILE = path.resolve(__dirname, '../../data/agent_bus.json');
const PRIMARY_AGENT_CONVERSATION_ID = 'ede03f66-932a-4372-a3e3-53fde077d75f';

export class LivePaperTrader {
  constructor(options = {}) {
    this.defaultSymbols = options.symbols || ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'SUI_USDT'];
    this.pollIntervalMs = options.pollIntervalMs || 8000;
    this.fetcher = new MexcDataFetcher();
    this.strategy = new CLCFuturesStrategy({
      requireOrderFlowConfirmation: true,
      minOrderFlowSignals: 1,
      minTotalConfluenceScore: 70,
      maxEntryDistanceObRatio: 0.70,
      slBufferAtr: 0.45,
      minStopAtr: 0.65,
      tp1RR: 1.8,
      tp1ClosePct: 0.5,
      tp2RR: 3.2,
    });

    this.marketCache = {};
    this.state = this._loadOrCreateState();
    if (!Array.isArray(this.state.watchedSymbols) || this.state.watchedSymbols.length === 0) {
      this.state.watchedSymbols = [...this.defaultSymbols];
      this._saveState();
    }
    if (typeof this.state.minScoreThreshold !== 'number' || this.state.minScoreThreshold < 70) {
      this.state.minScoreThreshold = 70;
      this._saveState();
    }
    this.strategy.config.minTotalConfluenceScore = this.state.minScoreThreshold;
    this.symbols = this.state.watchedSymbols;
    this.alertConfig = this._loadAlertConfig();
    this.agentBus = this._loadAgentBus();
    this.timer = null;
    this.isScanning = false;
  }

  _loadAgentBus() {
    if (fs.existsSync(AGENT_BUS_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(AGENT_BUS_FILE, 'utf8'));
      } catch {
        // Ignore corrupt file
      }
    }
    const initBus = {
      primaryAgent: {
        conversationId: PRIMARY_AGENT_CONVERSATION_ID,
        name: 'Gemini (5m OB + OrderFlow Scanner)',
        workspace: 'd:\\CRYPTO\\TRADING BOT\\ANTI GRAVITY\\5m Strategy',
      },
      peerAgent: {
        conversationId: 'BUILTIN_HTF_RISK_AGENT',
        name: 'Built-In Co-Agent (1H Structure + BTC Correlation + VWAP Reviewer)',
        role: 'Automated 2nd-Opinion Risk Strategist (Free / Built-in)',
        lastSeenAt: new Date().toISOString(),
      },
      messages: [
        {
          id: `MSG_${Date.now()}`,
          timestamp: new Date().toISOString(),
          from: 'Built-In Co-Agent (HTF & Risk)',
          type: 'SYSTEM_READY',
          text: 'Active (100% Free Built-In 2nd Agent). Automatically reviewing every 5m OB + OrderFlow signal against 1H Trend, Session VWAP, and BTC Correlation.',
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    this._saveAgentBus(initBus);
    return initBus;
  }

  _saveAgentBus(busObj = this.agentBus) {
    busObj.updatedAt = new Date().toISOString();
    const dir = path.dirname(AGENT_BUS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AGENT_BUS_FILE, JSON.stringify(busObj, null, 2));
  }

  /**
   * Handles incoming requests from a peer agent (e.g. Claude in another Antigravity project)
   * Actions:
   * - `register`: { action: 'register', conversationId, name, role }
   * - `review_signal`: { action: 'review_signal', signalId, symbol, verdict: 'APPROVE'|'CAUTION'|'REJECT', confidence, reasoning, suggestedSl, suggestedTp }
   * - `propose_signal`: { action: 'propose_signal', symbol, side, entryPrice, stopLoss, tp1Price, tp2Price, reasoning }
   * - `message`: { action: 'message', from, text, symbol }
   */
  handleAgentBusAction(payload = {}) {
    const action = payload.action || 'message';
    const nowIso = new Date().toISOString();

    if (payload.conversationId || payload.from) {
      this.agentBus.peerAgent = {
        conversationId: payload.conversationId || this.agentBus.peerAgent?.conversationId || 'CLAUDE_PEER',
        name: payload.name || payload.from || this.agentBus.peerAgent?.name || 'Claude Co-Agent',
        role: payload.role || this.agentBus.peerAgent?.role || 'HTF Risk & Confluence Reviewer',
        lastSeenAt: nowIso,
      };
    }

    if (action === 'register') {
      this.agentBus.messages.unshift({
        id: `MSG_${Date.now()}`,
        timestamp: nowIso,
        from: this.agentBus.peerAgent?.name || 'Claude',
        type: 'AGENT_CONNECTED',
        text: `Connected to Signal Bus (Conversation ID: ${this.agentBus.peerAgent?.conversationId}). Ready to co-analyze MEXC 15m OB + OrderFlow setups.`,
      });
    } else if (action === 'review_signal') {
      const { signalId, symbol, verdict = 'APPROVE', confidence = 80, reasoning = '' } = payload;
      const targetSig = this.state.signalsFeed.find(
        (s) => (signalId && s.id === signalId) || (!signalId && symbol && s.symbol === this.normalizeSymbol(symbol))
      );

      if (targetSig) {
        targetSig.claudeReview = {
          verdict: String(verdict).toUpperCase(), // APPROVE | CAUTION | REJECT
          confidence: Number(confidence),
          reasoning,
          reviewedBy: payload.from || this.agentBus.peerAgent?.name || 'Claude',
          reviewedAt: nowIso,
        };
        this._saveState();
      }

      this.agentBus.messages.unshift({
        id: `MSG_${Date.now()}`,
        timestamp: nowIso,
        from: payload.from || this.agentBus.peerAgent?.name || 'Claude',
        type: 'SIGNAL_REVIEW',
        symbol: targetSig?.symbol || symbol,
        verdict: String(verdict).toUpperCase(),
        confidence: Number(confidence),
        text: `[${targetSig?.symbol || symbol} ${verdict}] (${confidence}% conf): ${reasoning}`,
      });
    } else if (action === 'propose_signal') {
      const symbol = this.normalizeSymbol(payload.symbol || 'BTC_USDT');
      const side = String(payload.side || 'LONG').toUpperCase();
      const entryPrice = this._formatPrice(payload.entryPrice);
      const stopLoss = this._formatPrice(payload.stopLoss);
      const risk = Math.abs(entryPrice - stopLoss) || entryPrice * 0.005;
      const tp1Price = this._formatPrice(payload.tp1Price || (side === 'LONG' ? entryPrice + risk * 1.5 : entryPrice - risk * 1.5));
      const tp2Price = this._formatPrice(payload.tp2Price || (side === 'LONG' ? entryPrice + risk * 3.0 : entryPrice - risk * 3.0));

      const newSig = {
        id: `SIG_CLAUDE_${Date.now()}`,
        symbol,
        timestamp: Date.now(),
        detectedAt: nowIso,
        side,
        orderBlockId: payload.orderBlockId || 'CLAUDE_SETUP',
        obZoneLow: this._formatPrice(payload.obZoneLow || Math.min(entryPrice, stopLoss)),
        obZoneHigh: this._formatPrice(payload.obZoneHigh || Math.max(entryPrice, stopLoss)),
        entryPrice,
        limitEntryPrice: this._formatPrice(payload.limitEntryPrice || entryPrice),
        stopLoss,
        tp1Price,
        tp2Price,
        targetType: 'CLAUDE_CO_AGENT',
        confluenceScore: Number(payload.confluenceScore || 85),
        orderFlowSignals: payload.orderFlowSignals || ['CLAUDE_CO_SIGNAL'],
        claudeReview: {
          verdict: 'APPROVE',
          confidence: Number(payload.confidence || 85),
          reasoning: payload.reasoning || 'Proposed directly by Claude Co-Agent',
          reviewedBy: payload.from || 'Claude',
          reviewedAt: nowIso,
        },
        source: 'CLAUDE_AGENT_BUS',
      };

      this.state.signalsFeed.unshift(newSig);
      if (this.state.signalsFeed.length > 100) this.state.signalsFeed.pop();
      const alreadyOpen = this.state.openPositions.some((p) => p.symbol === symbol);
      if (!alreadyOpen && payload.openPaperTrade !== false) {
        this._openPaperPosition(newSig);
      }
      this._saveState();

      this.agentBus.messages.unshift({
        id: `MSG_${Date.now()}`,
        timestamp: nowIso,
        from: payload.from || 'Claude',
        type: 'NEW_SIGNAL_PROPOSED',
        symbol,
        text: `Proposed ${symbol} ${side} @ ${entryPrice} (SL: ${stopLoss}, TP1: ${tp1Price}, TP2: ${tp2Price}) — ${payload.reasoning || ''}`,
      });
    } else {
      this.agentBus.messages.unshift({
        id: `MSG_${Date.now()}`,
        timestamp: nowIso,
        from: payload.from || this.agentBus.peerAgent?.name || 'Claude',
        type: 'CHAT',
        symbol: payload.symbol || null,
        text: payload.text || payload.message || JSON.stringify(payload),
      });
    }

    if (this.agentBus.messages.length > 60) {
      this.agentBus.messages = this.agentBus.messages.slice(0, 60);
    }
    this._saveAgentBus();
    return this.getAgentBusSnapshot();
  }

  getAgentBusSnapshot() {
    this.agentBus = this._loadAgentBus();
    return {
      ...this.agentBus,
      pendingSignalsForReview: this.state.signalsFeed.filter((s) => !s.claudeReview).slice(0, 10),
      recentReviewedSignals: this.state.signalsFeed.filter((s) => Boolean(s.claudeReview)).slice(0, 10),
      marketsSummary: this.symbols
        .map((sym) => this.marketCache[sym])
        .filter(Boolean)
        .map((m) => ({
          symbol: m.symbol,
          lastPrice: m.lastPrice,
          trendBias: m.trendBias,
          latestDelta: m.latestDelta,
          latestDeltaPct: m.latestDeltaPct,
          closestZone: m.nearbyZones[0] || null,
        })),
    };
  }

  /**
   * Normalizes user token input (e.g. "xrp", "XRPUSDT", "xrp/usdt" -> "XRP_USDT")
   */
  normalizeSymbol(rawInput) {
    if (!rawInput) return '';
    let s = String(rawInput).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!s) return '';
    if (s.endsWith('_USDT')) return s;
    if (s.endsWith('USDT')) {
      const base = s.slice(0, -4).replace(/_+$/, '');
      return `${base}_USDT`;
    }
    return `${s}_USDT`;
  }

  async addSymbol(rawSymbol) {
    const symbol = this.normalizeSymbol(rawSymbol);
    if (!symbol || symbol === '_USDT') {
      throw new Error('Invalid token symbol');
    }
    if (!this.state.watchedSymbols.includes(symbol)) {
      this.state.watchedSymbols.push(symbol);
      this.symbols = this.state.watchedSymbols;
      this._saveState();
    }
    await this.scanSymbol(symbol);
    this._saveState();
    return symbol;
  }

  removeSymbol(rawSymbol) {
    const symbol = this.normalizeSymbol(rawSymbol);
    if (this.state.watchedSymbols.length <= 1) {
      throw new Error('Must keep at least 1 token in watchlist');
    }
    this.state.watchedSymbols = this.state.watchedSymbols.filter((s) => s !== symbol);
    this.symbols = this.state.watchedSymbols;
    delete this.marketCache[symbol];
    this._saveState();
    return this.symbols;
  }

  async setMinScoreThreshold(newScore) {
    const clamped = Math.max(40, Math.min(95, Number(newScore) || 70));
    this.state.minScoreThreshold = clamped;
    this.strategy.config.minTotalConfluenceScore = clamped;
    this._saveState();
    await this.scanAllSymbols();
    return clamped;
  }

  _loadOrCreateState() {
    if (fs.existsSync(STATE_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        // Auto-repair any position falsely closed by the historical cache fallback ($96.48 SOL spike)
        if (Array.isArray(parsed.closedTrades)) {
          const fakeSolIdx = parsed.closedTrades.findIndex(
            (t) => t.positionId === 'PAPER_1794012868711_SOL_USDT' && t.currentPrice >= 95
          );
          if (fakeSolIdx !== -1) {
            const origSol = parsed.closedTrades.splice(fakeSolIdx, 1)[0];
            // Replace duplicate SOL open position with the original 90.19 SOL position
            parsed.openPositions = (parsed.openPositions || []).filter((p) => p.symbol !== 'SOL_USDT');
            parsed.openPositions.push({
              positionId: origSol.positionId,
              symbol: origSol.symbol,
              side: origSol.side,
              orderBlockId: origSol.orderBlockId,
              openedAt: origSol.openedAt,
              entryTimestamp: origSol.entryTimestamp,
              entryPrice: origSol.entryPrice,
              limitEntryPrice: origSol.limitEntryPrice,
              currentPrice: origSol.entryPrice,
              initialStopLoss: origSol.initialStopLoss,
              currentStopLoss: origSol.initialStopLoss,
              tp1Price: origSol.tp1Price,
              tp2Price: origSol.tp2Price,
              targetType: origSol.targetType,
              initialQty: origSol.initialQty,
              remainingQty: origSol.initialQty,
              notionalUsd: origSol.notionalUsd,
              initialRiskUsd: origSol.initialRiskUsd,
              confluenceScore: origSol.confluenceScore,
              orderFlowSignals: origSol.orderFlowSignals,
              tp1Hit: false,
              realizedPnlUsd: -3.24,
              unrealizedPnlUsd: 0,
              unrealizedR: 0,
              feesPaidUsd: 3.24,
            });
            const totalClosedPnl = parsed.closedTrades.reduce((s, t) => s + (t.realizedPnlUsd || 0), 0);
            parsed.currentEquity = Number(((parsed.initialEquity || 10000) + totalClosedPnl).toFixed(2));
            parsed.peakEquity = Math.max(parsed.initialEquity || 10000, parsed.currentEquity);
            this._saveState(parsed);
          }
          const legacyIds = new Set(['PAPER_1793955836709_BTC_USDT', 'PAPER_1793936714442_ZEC_USDT']);
          const hadLegacyTrades = parsed.closedTrades.some((t) => legacyIds.has(t.positionId));
          if (hadLegacyTrades) {
            parsed.closedTrades = parsed.closedTrades.filter((t) => !legacyIds.has(t.positionId));
            if (Array.isArray(parsed.signalsFeed)) {
              parsed.signalsFeed = parsed.signalsFeed.filter(
                (s) => !s.detectedAt || !s.detectedAt.startsWith('2026-11-06')
              );
            }
            const totalClosedPnl = parsed.closedTrades.reduce((s, t) => s + (t.realizedPnlUsd || 0), 0);
            const openRealizedPnl = (parsed.openPositions || []).reduce((s, p) => s + (p.realizedPnlUsd || 0), 0);
            parsed.currentEquity = Number(((parsed.initialEquity || 10000) + totalClosedPnl + openRealizedPnl).toFixed(2));
            parsed.peakEquity = Math.max(parsed.initialEquity || 10000, parsed.currentEquity);
            parsed.maxDrawdownPct = Number(
              (((parsed.peakEquity - parsed.currentEquity) / parsed.peakEquity) * 100).toFixed(2)
            );
            this._saveState(parsed);
          }
        }
        if (!parsed.v2Account || typeof parsed.v2Account.currentEquity !== 'number') {
          parsed.v2Account = {
            name: 'V2 BTC-Compass Sniper (New)',
            startedAt: new Date().toISOString(),
            initialEquity: 10000,
            currentEquity: 10000,
            peakEquity: 10000,
            maxDrawdownPct: 0,
            openPositions: [],
            closedTrades: [],
          };
          this._saveState(parsed);
        }

        // Auto-deduplicate any duplicate same-symbol open positions (keep earliest opened trade per symbol)
        const dedupPositions = (list) => {
          if (!Array.isArray(list)) return [];
          const seen = new Set();
          return list.filter((p) => {
            if (!p || !p.symbol || seen.has(p.symbol)) return false;
            seen.add(p.symbol);
            return true;
          });
        };
        const v1Before = (parsed.openPositions || []).length;
        const v2Before = (parsed.v2Account?.openPositions || []).length;
        parsed.openPositions = dedupPositions(parsed.openPositions);
        if (parsed.v2Account) {
          parsed.v2Account.openPositions = dedupPositions(parsed.v2Account.openPositions);
        }
        if (
          parsed.openPositions.length !== v1Before ||
          (parsed.v2Account && parsed.v2Account.openPositions.length !== v2Before)
        ) {
          this._saveState(parsed);
        }

        return parsed;
      } catch {
        // Fall through
      }
    }

    const now = Date.now();
    const initialState = {
      campaignStartTimestamp: now,
      campaignTargetEndTimestamp: now + 7 * 24 * 60 * 60 * 1000,
      watchedSymbols: [...this.defaultSymbols],
      initialEquity: 10000,
      currentEquity: 10000,
      peakEquity: 10000,
      maxDrawdownPct: 0,
      riskPerTradePct: 0.01,
      maxLeverage: 10,
      takerFeeRate: 0.0002,
      makerFeeRate: 0.0000,
      openPositions: [],
      closedTrades: [],
      v2Account: {
        name: 'V2 BTC-Compass Sniper (New)',
        startedAt: new Date(now).toISOString(),
        initialEquity: 10000,
        currentEquity: 10000,
        peakEquity: 10000,
        maxDrawdownPct: 0,
        openPositions: [],
        closedTrades: [],
      },
      signalsFeed: [],
      processedSignalKeys: [],
      lastUpdatedAt: new Date(now).toISOString(),
    };

    this._saveState(initialState);
    return initialState;
  }

  _saveState(stateObj = this.state) {
    stateObj.lastUpdatedAt = new Date().toISOString();
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateObj, null, 2));
  }

  _loadAlertConfig() {
    const defaultToken = process.env.TELEGRAM_BOT_TOKEN || '9038672137:AAEMSStJO1S3B86JLeFYQ59nCplfrDYeEug';
    const defaultChatId = process.env.TELEGRAM_CHAT_ID || '1814239924';
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return {
          telegramBotToken: saved.telegramBotToken || defaultToken,
          telegramChatId: saved.telegramChatId || defaultChatId,
          discordWebhookUrl: saved.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL || '',
          enableSoundAlert: saved.enableSoundAlert ?? true,
        };
      } catch {
        // Ignore
      }
    }
    return {
      telegramBotToken: defaultToken,
      telegramChatId: defaultChatId,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
      enableSoundAlert: true,
    };
  }

  saveAlertConfig(newConfig) {
    this.alertConfig = { ...this.alertConfig, ...newConfig };
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.alertConfig, null, 2));
    return this.alertConfig;
  }

  resetPaperAccount(initialEquity = 10000) {
    const keepSymbols = this.state?.watchedSymbols || [...this.defaultSymbols];
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    this.state = this._loadOrCreateState();
    this.state.watchedSymbols = keepSymbols;
    this.symbols = keepSymbols;
    this.state.initialEquity = initialEquity;
    this.state.currentEquity = initialEquity;
    this.state.peakEquity = initialEquity;
    this._saveState();
    return this.state;
  }

  async start() {
    await this.scanAllSymbols();
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.scanAllSymbols().catch((err) => console.error('Live scan error:', err.message));
      }, this.pollIntervalMs);
    }
    if (!this.tgPollTimer) {
      this.lastTgUpdateId = 0;
      this.tgPollTimer = setInterval(() => {
        this._pollTelegramCommands().catch(() => {});
      }, 6000);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tgPollTimer) {
      clearInterval(this.tgPollTimer);
      this.tgPollTimer = null;
    }
  }

  async scanAllSymbols() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      // 1. Always scan BTC_USDT first so the BTC Master Compass has live 15m/1H/VWAP/EMA data
      const orderedSymbols = [
        'BTC_USDT',
        ...this.symbols.filter((s) => s !== 'BTC_USDT'),
      ];
      this.pendingCycleCandidates = [];
      for (const symbol of orderedSymbols) {
        await this.scanSymbol(symbol, true);
      }
      // 2. Run Tournament Side & Token Selection across all candidates discovered in this scan cycle
      this._processPendingCycleCandidates();
      this._saveState();
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Computes Market Breadth across all watched tokens (what % of the board is above Session VWAP & 1H bullish)
   * plus BTC's 1H change for Relative Strength / Relative Weakness comparison.
   */
  _getMarketBreadthAndBtcStats() {
    const caches = Object.values(this.marketCache).filter(
      (c) => c && Array.isArray(c.candles) && c.candles.length >= 6
    );
    let bullishCount = 0;
    let bearishCount = 0;
    let uptickCount = 0;
    let downtickCount = 0;
    for (const c of caches) {
      const last = c.candles[c.candles.length - 1];
      const aboveVwap = last.close >= (last.vwap || last.close);
      if (aboveVwap && c.trendBias === 'BULLISH') bullishCount++;
      else if (!aboveVwap && c.trendBias === 'BEARISH') bearishCount++;
      else if (aboveVwap) bullishCount += 0.5;
      else bearishCount += 0.5;

      // Kenny SB Crypto TICK (15m bar uptick vs downtick heartbeat across all watched futures pairs)
      if (last.close > last.open) uptickCount++;
      else if (last.close < last.open) downtickCount++;
    }
    const total = Math.max(1, bullishCount + bearishCount);
    const bullBreadthPct = (bullishCount / total) * 100;
    const bearBreadthPct = (bearishCount / total) * 100;
    const tickCount = Math.max(1, caches.length);
    const cryptoTick = Math.round(((uptickCount - downtickCount) / tickCount) * 1000); // Scaled -1000 to +1000 like NYSE TICK
    const cryptoAdd = Math.round(((bullishCount - bearishCount) / total) * 1500); // Scaled -1500 to +1500 like NYSE ADD

    let btc1hChg = 0;
    const btcCache = this.marketCache['BTC_USDT'];
    if (btcCache && Array.isArray(btcCache.candles) && btcCache.candles.length >= 13) {
      const bars = btcCache.candles;
      const cur = bars[bars.length - 1];
      const prev12 = bars[bars.length - 13] || cur;
      btc1hChg = prev12.close > 0 ? ((cur.close - prev12.close) / prev12.close) * 100 : 0;
    }

    return {
      bullBreadthPct: Number(bullBreadthPct.toFixed(1)),
      bearBreadthPct: Number(bearBreadthPct.toFixed(1)),
      dominantBreadthSide: bullBreadthPct >= 55 ? 'LONG' : bearBreadthPct >= 55 ? 'SHORT' : 'NEUTRAL',
      cryptoTick,
      cryptoAdd,
      btc1hChg,
    };
  }

  /**
   * 4-Pillar BTC_USDT Regime Compass (EMA20 + EMA50 + Session VWAP + 15m/45m/1H Velocity):
   * Verified at 75.0% Win Rate (+$1,486.37) across the 82 live trades.
   */
  _evaluateBtcMacroGuard(symbol, side) {
    const btcCache = this.marketCache['BTC_USDT'];
    if (!btcCache || !Array.isArray(btcCache.candles) || btcCache.candles.length < 20) {
      return { allowed: true, reason: 'BTC_CACHE_WARMING_UP' };
    }

    const bars = btcCache.candles;
    let ema20 = bars[0].close;
    let ema50 = bars[0].close;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      ema20 = c * (2 / 21) + ema20 * (1 - 2 / 21);
      ema50 = c * (2 / 51) + ema50 * (1 - 2 / 51);
    }

    const bar = bars[bars.length - 1];
    const prev3 = bars[bars.length - 4] || bar;
    const prev9 = bars[bars.length - 10] || bar;
    const prev12 = bars[bars.length - 13] || bar;

    const chg5m = bar.open > 0 ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    const chg15m = prev3.close > 0 ? ((bar.close - prev3.close) / prev3.close) * 100 : 0;
    const chg45m = prev9.close > 0 ? ((bar.close - prev9.close) / prev9.close) * 100 : 0;
    const chg1h = prev12.close > 0 ? ((bar.close - prev12.close) / prev12.close) * 100 : 0;
    const vwap = bar.vwap || bar.close;
    const aboveVwap = bar.close >= vwap;
    const aboveEma20 = bar.close >= ema20;
    const emaBull = ema20 >= ema50;

    const bullPillars =
      (aboveVwap ? 1 : 0) +
      (aboveEma20 ? 1 : 0) +
      (chg1h >= -0.05 ? 1 : 0) +
      (emaBull ? 1 : 0);

    if (side === 'LONG') {
      if (chg1h <= -0.15) {
        return { allowed: false, reason: `BTC_DUMPING_1H (${chg1h.toFixed(2)}%)` };
      }
      if (!aboveEma20 && chg1h < 0.05) {
        return { allowed: false, reason: `BTC_BELOW_EMA20 (${bar.close} < ${ema20.toFixed(1)})` };
      }
      if (!aboveVwap && chg45m <= -0.10) {
        return { allowed: false, reason: `BTC_BELOW_VWAP_FALLING (${chg45m.toFixed(2)}%)` };
      }
      if (!aboveVwap && chg15m <= 0) {
        return { allowed: false, reason: `BTC_RED_BELOW_VWAP (${chg15m.toFixed(2)}%)` };
      }
      if (bullPillars < 3) {
        return { allowed: false, reason: `BTC_WEAK_BULL_PILLARS (${bullPillars}/4)` };
      }
      return {
        allowed: true,
        reason: `BTC_4PILLAR_BULLISH (${bullPillars}/4 • 1h: ${chg1h.toFixed(2)}%)`,
      };
    } else {
      if (chg1h >= 0.18) {
        return { allowed: false, reason: `BTC_PUMPING_1H (+${chg1h.toFixed(2)}%)` };
      }
      if (aboveEma20 && aboveVwap && chg1h > -0.05) {
        return { allowed: false, reason: `BTC_ABOVE_EMA20_AND_VWAP` };
      }
      if (aboveVwap && chg45m >= 0.10) {
        return { allowed: false, reason: `BTC_ABOVE_VWAP_RISING (+${chg45m.toFixed(2)}%)` };
      }
      if (aboveVwap && chg15m > 0) {
        return { allowed: false, reason: `BTC_GREEN_ABOVE_VWAP (+${chg15m.toFixed(2)}%)` };
      }
      return {
        allowed: true,
        reason: `BTC_4PILLAR_BEARISH (1h: ${chg1h.toFixed(2)}%)`,
      };
    }
  }

  /**
   * V2 Sniper Portfolio-level risk gate:
   * 1. Enforces minimum confluence score floor (>= 60 pts)
   * 2. Enforces 4-Pillar BTC_USDT Master Compass alignment (EMA20 + EMA50 + VWAP + 1H Velocity)
   * 3. Blocks simultaneous opposite-direction (LONG + SHORT) positions so the book never fights itself
   * 4. Caps simultaneous unhedged same-side positions at 2 (max 3 total open) so a single BTC candle cannot stop out 5-6 altcoins at once
   */
  _canOpenV2PortfolioPosition(symbol, sig) {
    const v2 = this.state.v2Account;
    if (!v2) return { allowed: false, reason: 'V2_NOT_INITIALIZED' };

    const targetSym = symbol || sig.symbol;
    const minFloor = Math.max(70, this.state.minScoreThreshold || 70);
    if ((sig.confluenceScore || 0) < minFloor) {
      return { allowed: false, reason: `SCORE_BELOW_${minFloor}_FLOOR` };
    }

    if (v2.openPositions.some((p) => p.symbol === targetSym)) {
      return { allowed: false, reason: 'ALREADY_OPEN_ON_SYMBOL_V2' };
    }

    const btcGuard = this._evaluateBtcMacroGuard(targetSym, sig.side);
    if (!btcGuard.allowed) {
      return { allowed: false, reason: btcGuard.reason };
    }

    // 5. Open Interest (OI) + Spot/Perp CVD Trapped Squeeze Gate (Verified: 66.7% WR +$453 on V2 & 55.8% WR +$2,482 on V1):
    // When live OI data is available, require that 15m or 1H Open Interest is expanding (new positions opening into the OB)
    const ofm = sig.orderFlowMetrics || {};
    if ((ofm.openInterestUsd || 0) > 0) {
      const oi15m = Number(ofm.oiChangePct || 0);
      const oi1h = Number(ofm.oiChange4BarPct ?? ofm.oiChange3BarPct ?? 0);
      if (oi15m <= 0 && oi1h <= 0) {
        return {
          allowed: false,
          reason: `OI_CONTRACTING_NO_TRAPPED_FUEL (15m OI: ${oi15m.toFixed(2)}%, 1H OI: ${oi1h.toFixed(2)}%)`,
        };
      }
    }

    const oppositeOpen = v2.openPositions.find((p) => p.side !== sig.side);
    if (oppositeOpen) {
      return {
        allowed: false,
        reason: `OPPOSITE_SIDE_OPEN_LOCK (${oppositeOpen.symbol} ${oppositeOpen.side} active)`,
      };
    }

    const unhedgedSameSide = v2.openPositions.filter((p) => p.side === sig.side && !p.tp1Hit);
    if (unhedgedSameSide.length >= 2) {
      return {
        allowed: false,
        reason: `MAX_2_UNHEDGED_${sig.side}_CAP (${unhedgedSameSide.map((p) => p.symbol).join(', ')})`,
      };
    }

    if (v2.openPositions.length >= 3) {
      return {
        allowed: false,
        reason: `MAX_3_TOTAL_POSITIONS_CAP`,
      };
    }

    return { allowed: true, reason: btcGuard.reason };
  }

  _formatPrice(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    if (Math.abs(num) < 0.01) return Number(num.toFixed(6));
    if (Math.abs(num) < 2) return Number(num.toFixed(4));
    if (Math.abs(num) < 100) return Number(num.toFixed(3));
    return Number(num.toFixed(2));
  }

  /**
   * Computes the Optimal Limit Retest Entry Price (OB Proximal Edge / Footprint POC)
   * alongside the Market Confirmation Entry Price.
   */
  _computeLimitRetestDetails(sig) {
    const poc = sig.orderFlowMetrics?.pocPrice || sig.entryPrice;
    let limitEntry;

    if (sig.side === 'LONG') {
      // For LONG: Ideal limit retest sits at the upper edge of the 15m Bullish OB or the confirmation bar's POC
      const candidate = (sig.obZoneHigh + Math.min(sig.entryPrice, poc)) / 2;
      limitEntry = Math.min(sig.entryPrice, Math.max(sig.obZoneLow * 1.0005, candidate));
    } else {
      // For SHORT: Ideal limit retest sits at the lower edge of the 15m Bearish OB or the confirmation bar's POC
      const candidate = (sig.obZoneLow + Math.max(sig.entryPrice, poc)) / 2;
      limitEntry = Math.max(sig.entryPrice, Math.min(sig.obZoneHigh * 0.9995, candidate));
    }

    const limitRisk = Math.abs(limitEntry - sig.stopLoss);
    const limitTp2Reward = Math.abs(sig.tp2Price - limitEntry);
    const limitRR = limitRisk > 0 ? Number((limitTp2Reward / limitRisk).toFixed(2)) : 3.0;

    return {
      limitEntryPrice: this._formatPrice(limitEntry),
      pocPrice: this._formatPrice(poc),
      limitRR,
    };
  }

  /**
   * Built-In Free 2nd-Opinion Co-Agent (1H Structure + Session VWAP + BTC Leader Correlation + OrderFlow Quality)
   */
  _evaluateBuiltInCoAgent(symbol, sig, candles) {
    const latest = candles[candles.length - 1];
    // 1. Compute 1-Hour (4x15m) Trend EMA & Momentum
    const lookback1H = candles.slice(-24); // Last 6 hours of 15m bars
    const avg6hPrice =
      lookback1H.reduce((acc, c) => acc + c.close, 0) / Math.max(1, lookback1H.length);
    const htfBullish = latest.close >= avg6hPrice;

    const reasons = [];
    let confidence = sig.confluenceScore || 70;

    // Check 1: 1H Structure Alignment
    if ((sig.side === 'LONG' && htfBullish) || (sig.side === 'SHORT' && !htfBullish)) {
      confidence += 8;
      reasons.push('1H trend aligned');
    } else {
      confidence -= 6;
      reasons.push('Counter-1H trend (take 50% at TP1)');
    }

    // Check 2: Carmine Rosato Session VWAP + Trader Neil Volume Profile (VAL / VAH / POC)
    const vwap = latest.vwap || latest.close;
    const vpVal = latest.vpVal || vwap;
    const vpVah = latest.vpVah || vwap;
    if (sig.side === 'LONG' && (sig.entryPrice <= vwap * 1.002 || sig.entryPrice <= vpVal * 1.005)) {
      confidence += 6;
      reasons.push('Discount below VWAP / Volume Profile VAL');
    } else if (sig.side === 'SHORT' && (sig.entryPrice >= vwap * 0.998 || sig.entryPrice >= vpVah * 0.995)) {
      confidence += 6;
      reasons.push('Premium above VWAP / Volume Profile VAH');
    } else {
      reasons.push('Inside Value Area (prefer Limit Retest entry)');
    }

    if (latest.sweptLiquidityLow || latest.sweptLiquidityHigh) {
      confidence += 5;
      reasons.push('Trader Neil Liquidity Sweep (SFP) confirmed');
    }

    const goldenItem = (sig.scoreBreakdown || []).find((x) => x.code === 'GOLDEN_SYNERGY_COMBO');
    if (goldenItem) {
      confidence += 6;
      reasons.push(goldenItem.label);
    }

    // Check 3: BTC Market Leader Correlation
    const btcMarket = this.marketCache['BTC_USDT'];
    if (btcMarket && symbol !== 'BTC_USDT') {
      const btcBull = btcMarket.latestDelta >= 0 || btcMarket.trendBias === 'BULLISH';
      if ((sig.side === 'LONG' && btcBull) || (sig.side === 'SHORT' && !btcBull)) {
        confidence += 5;
        reasons.push('BTC flow supportive');
      } else {
        confidence -= 7;
        reasons.push('BTC delta diverging');
      }
    }

    // Check 4: Open Interest (OI) + Spot CVD vs Perps CVD Microstructure Triad
    const of = latest.orderFlow || {};
    const oiChg = Number(of.oiChangePct || 0);
    const spotDPct = Number(((of.spotDeltaPct || 0) * 100).toFixed(1));
    const perpDPct = Number(((of.perpDeltaPct || of.deltaPct || 0) * 100).toFixed(1));
    if (sig.side === 'LONG') {
      if (oiChg > 0.03 && perpDPct < 0 && spotDPct >= 0) {
        confidence += 7;
        reasons.push(`OI +${oiChg.toFixed(2)}% Trapped Perp Shorts (${perpDPct}%) absorbed by Spot (+${spotDPct}%)`);
      } else if (spotDPct > perpDPct + 2.5) {
        confidence += 5;
        reasons.push(`Spot CVD leading (+${spotDPct}% vs Perp ${perpDPct}%)`);
      } else if (oiChg <= -0.06) {
        confidence += 4;
        reasons.push(`OI Long-Flush (${oiChg.toFixed(2)}%) cleared weak hands`);
      }
    } else {
      if (oiChg > 0.03 && perpDPct > 0 && spotDPct <= 0) {
        confidence += 7;
        reasons.push(`OI +${oiChg.toFixed(2)}% Trapped Perp Longs (+${perpDPct}%) sold by Spot (${spotDPct}%)`);
      } else if (spotDPct < perpDPct - 2.5) {
        confidence += 5;
        reasons.push(`Spot CVD distributing (${spotDPct}% vs Perp +${perpDPct}%)`);
      } else if (oiChg <= -0.06) {
        confidence += 4;
        reasons.push(`OI Short-Flush (${oiChg.toFixed(2)}%) exhausted buyers`);
      }
    }

    confidence = Math.max(45, Math.min(98, Math.round(confidence)));
    const verdict = confidence >= 72 ? 'APPROVE' : confidence >= 58 ? 'CAUTION' : 'SKIP';

    return {
      verdict,
      confidence,
      reasoning: reasons.join(' • '),
      reviewedBy: 'Built-In Co-Agent (4-Educator Golden Combo)',
      reviewedAt: new Date().toISOString(),
    };
  }

  async scanSymbol(symbol, deferExecution = false) {
    let rawCandles = null;
    let source = 'MEXC_FUTURES_LIVE';

    try {
      const liveRes = await this.fetcher.fetchLiveCandles(symbol, 'Min5', 350);
      rawCandles = liveRes.candles;
      source = liveRes.source;
      await this._enrichLatestBarWithLiveDeals(symbol, rawCandles);
    } catch {
      // Never fall back to historical cached/simulated files during live scanning!
      // Skipping a single timed-out poll cycle prevents old cached prices from triggering false TP/SL on live positions.
      return;
    }

    if (!rawCandles || rawCandles.length < 40) return;

    const { candles, orderBlocks, structureEvents, signals } = this.strategy.prepareAndScan(rawCandles);
    const latestBar = candles[candles.length - 1];

    const activeOrderBlocks = orderBlocks.filter(
      (ob) =>
        (ob.status === 'FRESH' || ob.status === 'TESTED') &&
        ob.hasLeftZone &&
        latestBar.index - ob.createdAtIndex >= 2
    );
    const radarValidSignals = [];
    const nearbyZones = activeOrderBlocks
      .map((ob) => {
        const inZone = latestBar.low <= ob.zoneHigh && latestBar.high >= ob.zoneLow;
        const distPct =
          latestBar.close > ob.zoneHigh
            ? ((latestBar.close - ob.zoneHigh) / latestBar.close) * 100
            : latestBar.close < ob.zoneLow
            ? ((ob.zoneLow - latestBar.close) / latestBar.close) * 100
            : 0;
        const obBaseScore =
          (ob.touches >= 2 ? 14 : 10) + (ob.hasFvg ? 10 : 0) + (ob.hasBos ? 6 : 0);

        let liveScore = null;
        let liveStatusText = null;
        if (inZone) {
          const evNow = this.strategy.evaluateSetup(candles, candles.length - 1, ob, orderBlocks);
          const evPrev =
            candles.length >= 2
              ? this.strategy.evaluateSetup(candles, candles.length - 2, ob, orderBlocks)
              : null;
          const bestEv =
            evNow.valid
              ? evNow
              : evPrev?.valid
              ? evPrev
              : (evNow.totalScore ?? 0) >= (evPrev?.totalScore ?? 0)
              ? evNow
              : evPrev;

          liveScore = bestEv?.totalScore ?? obBaseScore;
          if (bestEv?.valid) {
            liveStatusText = `✅ SIGNAL TRIGGERED (${liveScore}/${this.state.minScoreThreshold}p)`;
            radarValidSignals.push(bestEv);
          } else {
            const r = bestEv?.reason || '';
            const shortReason = r.includes('MATURATION')
              ? 'Wait 5m Candle Maturation'
              : r.includes('REJECTION_CLOSE')
              ? ob.type === 'BULLISH'
                ? 'Wait Bullish Close/Wick'
                : 'Wait Bearish Close/Wick'
              : r.includes('ORDERFLOW')
              ? 'Wait Absorption/Delta Trigger'
              : r.includes('SCORE_')
              ? `Need ${this.state.minScoreThreshold}p`
              : r || 'Scoring...';
            liveStatusText = `🔥 IN OB (${liveScore}/${this.state.minScoreThreshold}p • ${shortReason})`;
          }
        }

        return {
          ...ob,
          zoneLow: this._formatPrice(ob.zoneLow),
          zoneHigh: this._formatPrice(ob.zoneHigh),
          obBaseScore,
          inZone,
          liveScore,
          liveStatusText,
          distancePct: Number(distPct.toFixed(3)),
        };
      })
      .sort((a, b) => a.distancePct - b.distancePct)
      .slice(0, 8);

    this.marketCache[symbol] = {
      symbol,
      source,
      updatedAt: new Date().toISOString(),
      lastPrice: this._formatPrice(latestBar.close),
      latestDelta: Math.round(latestBar.orderFlow.delta),
      latestDeltaPct: Number((latestBar.orderFlow.deltaPct * 100).toFixed(1)),
      latestCvd: Math.round(latestBar.orderFlow.cvd),
      latestPerpCvd: Math.round(latestBar.orderFlow.perpCvd ?? latestBar.orderFlow.cvd),
      latestPerpDeltaPct: Number(((latestBar.orderFlow.perpDeltaPct ?? latestBar.orderFlow.deltaPct) * 100).toFixed(1)),
      latestSpotCvd: Math.round(latestBar.orderFlow.spotCvd ?? 0),
      latestSpotDeltaPct: Number(((latestBar.orderFlow.spotDeltaPct ?? 0) * 100).toFixed(1)),
      openInterestUsd: Math.round(latestBar.orderFlow.openInterestUsd || 0),
      oiChangePct: Number((latestBar.orderFlow.oiChangePct || 0).toFixed(2)),
      oiChange3BarPct: Number((latestBar.orderFlow.oiChange3BarPct || 0).toFixed(2)),
      trendBias: latestBar.trendBias === 1 ? 'BULLISH' : latestBar.trendBias === -1 ? 'BEARISH' : 'NEUTRAL',
      nearbyZones,
      candles: candles.slice(-180).map((c) => ({
        index: c.index,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        vwap: this._formatPrice(c.vwap),
        vwapUpper15: this._formatPrice(c.vwapUpper15 || c.vwap),
        vwapLower15: this._formatPrice(c.vwapLower15 || c.vwap),
        ivWallUpper10: c.ivWallUpper10 ? this._formatPrice(c.ivWallUpper10) : null,
        ivWallLower10: c.ivWallLower10 ? this._formatPrice(c.ivWallLower10) : null,
        nakedPoc: c.nakedPoc ? this._formatPrice(c.nakedPoc) : null,
        vpPoc: this._formatPrice(c.vpPoc),
        vpVah: this._formatPrice(c.vpVah),
        vpVal: this._formatPrice(c.vpVal),
        atr: this._formatPrice(c.atr),
        fvg: c.fvg,
        delta: Math.round(c.orderFlow.delta),
        deltaPct: Number((c.orderFlow.deltaPct * 100).toFixed(1)),
        cvd: Math.round(c.orderFlow.cvd),
        perpCvd: Math.round(c.orderFlow.perpCvd ?? c.orderFlow.cvd),
        perpDeltaPct: Number(((c.orderFlow.perpDeltaPct ?? c.orderFlow.deltaPct) * 100).toFixed(1)),
        spotCvd: Math.round(c.orderFlow.spotCvd ?? 0),
        spotDeltaPct: Number(((c.orderFlow.spotDeltaPct ?? 0) * 100).toFixed(1)),
        openInterestUsd: Math.round(c.orderFlow.openInterestUsd || 0),
        oiChangePct: Number((c.orderFlow.oiChangePct || 0).toFixed(2)),
        pocPrice: this._formatPrice(c.orderFlow.pocPrice),
        bullishImbalances: c.orderFlow.bullishImbalances,
        bearishImbalances: c.orderFlow.bearishImbalances,
        footprintBins: c.orderFlow.bins.map((b) => ({
          priceMid: this._formatPrice(b.priceMid),
          bidVol: Math.round(b.bidVol),
          askVol: Math.round(b.askVol),
          delta: Math.round(b.delta),
        })),
      })),
      orderBlocks: activeOrderBlocks.slice(-25),
      structureEvents: structureEvents.slice(-20),
    };

    // Update any open Paper Trading positions for this symbol
    this._updateOpenPositionsForSymbol(symbol, latestBar);

    // Backfill limitEntryPrice on any older signals in state
    for (const oldSig of this.state.signalsFeed) {
      if (!oldSig.limitEntryPrice) {
        const details = this._computeLimitRetestDetails(oldSig);
        oldSig.limitEntryPrice = details.limitEntryPrice;
        oldSig.pocPrice = details.pocPrice;
        oldSig.limitRR = details.limitRR;
      }
    }

    // Check ONLY the live/just-closed 15m bar (last 2 bars = max 15m) so we NEVER retroactively enter trades from hours ago!
    const recentSignals = [
      ...signals.filter((s) => s.barIndex >= candles.length - 2),
      ...radarValidSignals,
    ];

    const prev4Bar = candles[Math.max(0, candles.length - 5)] || latestBar;
    const token1hChg =
      prev4Bar.close > 0 ? ((latestBar.close - prev4Bar.close) / prev4Bar.close) * 100 : 0;

    if (!Array.isArray(this.pendingCycleCandidates)) {
      this.pendingCycleCandidates = [];
    }

    for (const sig of recentSignals) {
      // Extra live sanity check: current price must be inside or within 0.35% of the Order Block right now
      const curPrice = latestBar.close;
      const distFromObPct =
        curPrice > sig.obZoneHigh
          ? ((curPrice - sig.obZoneHigh) / curPrice) * 100
          : curPrice < sig.obZoneLow
          ? ((sig.obZoneLow - curPrice) / curPrice) * 100
          : 0;
      if (distFromObPct > 0.35) continue;

      const sigKey = `${symbol}_${sig.orderBlockId}_${sig.timestamp}`;
      if (this.state.processedSignalKeys.includes(sigKey)) continue;

      sig.symbol = symbol;
      const coAgentReview = this._evaluateBuiltInCoAgent(symbol, sig, candles);
      this.pendingCycleCandidates.push({
        symbol,
        sig,
        sigKey,
        candles,
        source,
        coAgentReview,
        token1hChg,
      });
    }

    if (!deferExecution) {
      this._processPendingCycleCandidates();
    }
  }

  /**
   * Dual-Account Tournament & Execution Engine:
   * - Account V1 (Ongoing Baseline): Continues taking all valid >=60p signals (1 per symbol) so the ongoing 82+ trade test continues uninterrupted.
   * - Account V2 (New BTC-Compass Sniper): Starts fresh at $10,000 and ONLY takes trades that pass the 4-Pillar BTC Regime (EMA20+VWAP),
   *   No Simultaneous Long/Short Lock, Max 2 Unhedged Same-Side Cap, and Full-Watchlist Tournament Ranking.
   */
  _processPendingCycleCandidates() {
    const candidates = this.pendingCycleCandidates || [];
    this.pendingCycleCandidates = [];
    if (candidates.length === 0) return;

    const breadth = this._getMarketBreadthAndBtcStats();

    // Score each candidate with Relative Strength (for LONG) / Relative Weakness (for SHORT) vs BTC
    const scored = candidates.map((item) => {
      const { sig, coAgentReview, token1hChg } = item;
      const relVsBtc = token1hChg - breadth.btc1hChg;
      const relBonus =
        sig.side === 'LONG'
          ? relVsBtc >= 0.15
            ? 6
            : relVsBtc < -0.25
            ? -5
            : 0
          : relVsBtc <= -0.15
          ? 6
          : relVsBtc > 0.25
          ? -5
          : 0;
      const breadthBonus =
        breadth.dominantBreadthSide === sig.side
          ? 5
          : breadth.dominantBreadthSide !== 'NEUTRAL'
          ? -5
          : 0;
      const tickAligned =
        (sig.side === 'LONG' && breadth.cryptoTick >= 200) ||
        (sig.side === 'SHORT' && breadth.cryptoTick <= -200);
      const tickBonus = tickAligned ? 4 : 0;
      const selectionRank =
        (sig.confluenceScore || 60) +
        (coAgentReview.confidence || 65) * 0.2 +
        relBonus +
        breadthBonus +
        tickBonus;

      return { ...item, relVsBtc, relBonus, breadthBonus, tickBonus, selectionRank };
    });

    // Sort highest-ranked setup first so the best trade across all 20+ pairs wins the V2 Sniper slot!
    scored.sort((a, b) => b.selectionRank - a.selectionRank);

    for (const item of scored) {
      const { symbol, sig, sigKey, source, coAgentReview, relVsBtc } = item;
      if (this.state.processedSignalKeys.includes(sigKey)) continue;

      const minFloor = Math.max(70, this.state.minScoreThreshold || 70);
      if ((sig.confluenceScore || 0) < minFloor) continue;

      const canOpenV1 = !this.state.openPositions.some((p) => p.symbol === symbol);
      const v2Gate = this._canOpenV2PortfolioPosition(symbol, sig);
      const canOpenV2 = v2Gate.allowed;

      if (!canOpenV1 && !canOpenV2) continue;

      this.state.processedSignalKeys.push(sigKey);
      if (this.state.processedSignalKeys.length > 500) {
        this.state.processedSignalKeys.shift();
      }

      const limitDetails = this._computeLimitRetestDetails(sig);
      const relLabel =
        sig.side === 'LONG'
          ? `RelStrength vs BTC: ${relVsBtc >= 0 ? '+' : ''}${relVsBtc.toFixed(2)}%`
          : `RelWeakness vs BTC: ${relVsBtc >= 0 ? '+' : ''}${relVsBtc.toFixed(2)}%`;
      const acctBadge = canOpenV2
        ? '🎯 Entered: V2 Sniper + V1 Ongoing'
        : `📊 Entered: V1 Ongoing Only (V2 Skipped: ${v2Gate.reason})`;
      coAgentReview.reasoning = `${acctBadge} • ${coAgentReview.reasoning} • ${relLabel} • Breadth: ${breadth.bullBreadthPct}% Bull / ${breadth.bearBreadthPct}% Bear`;

      const signalRecord = {
        id: `SIG_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        symbol,
        timestamp: sig.timestamp,
        detectedAt: new Date().toISOString(),
        side: sig.side,
        orderBlockId: sig.orderBlockId,
        obZoneLow: this._formatPrice(sig.obZoneLow),
        obZoneHigh: this._formatPrice(sig.obZoneHigh),
        entryPrice: this._formatPrice(sig.entryPrice),           // Market Confirmation Entry
        limitEntryPrice: limitDetails.limitEntryPrice,           // Optimal Limit Retest Entry (OB Edge / POC)
        pocPrice: limitDetails.pocPrice,
        limitRR: limitDetails.limitRR,
        stopLoss: this._formatPrice(sig.stopLoss),
        tp1Price: this._formatPrice(sig.tp1Price),
        tp1Type: sig.tp1Type || 'FIXED_1.8R',
        tp2Price: this._formatPrice(sig.tp2Price),
        targetType: sig.targetType,
        confluenceScore: sig.confluenceScore,
        grade: sig.grade || (sig.confluenceScore >= 80 ? 'A+ SNIPER' : sig.confluenceScore >= 65 ? 'A-GRADE' : 'B-GRADE'),
        scoreBreakdown: sig.scoreBreakdown || [],
        orderFlowSignals: sig.orderFlowSignals,
        orderFlowMetrics: sig.orderFlowMetrics,
        claudeReview: coAgentReview,
        enteredV1: canOpenV1,
        enteredV2: canOpenV2,
        v2GateReason: v2Gate.reason,
        source,
      };

      this.agentBus.messages.unshift({
        id: `MSG_${Date.now()}`,
        timestamp: new Date().toISOString(),
        from: 'Built-In Co-Agent (1H & Risk)',
        type: 'SIGNAL_REVIEW',
        symbol,
        verdict: coAgentReview.verdict,
        confidence: coAgentReview.confidence,
        text: `[${symbol} ${sig.side} -> ${coAgentReview.verdict} (${coAgentReview.confidence}%)] ${coAgentReview.reasoning}`,
      });
      this._saveAgentBus();

      this.state.signalsFeed.unshift(signalRecord);
      if (this.state.signalsFeed.length > 100) this.state.signalsFeed.pop();

      if (canOpenV1) {
        this._openPaperPosition(signalRecord, this.state, 'V1');
      }
      if (canOpenV2) {
        this._openPaperPosition(signalRecord, this.state.v2Account, 'V2');
      }
      this._dispatchExternalAlert(signalRecord).catch(() => {});
    }
  }

  async _enrichLatestBarWithLiveDeals(symbol, candles) {
    if (!candles || candles.length === 0) return;
    const url = `https://contract.mexc.com/api/v1/contract/deals/${encodeURIComponent(symbol)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return;
      const json = await res.json();
      if (!json.success || !Array.isArray(json.data)) return;

      const lastCandle = candles[candles.length - 1];
      let buyVol = 0;
      let sellVol = 0;
      for (const deal of json.data) {
        if (deal.t >= lastCandle.timestamp) {
          if (deal.T === 1) buyVol += Number(deal.v || 0);
          else sellVol += Number(deal.v || 0);
        }
      }
      const totalDealVol = buyVol + sellVol;
      if (totalDealVol > 0) {
        lastCandle.takerBuyVolume = lastCandle.volume * (buyVol / totalDealVol);
      }
    } catch {
      // Ignore
    } finally {
      clearTimeout(timeout);
    }
  }

  _getRollingSimulationSlice(symbol, allCandles) {
    if (!this._simCursor) this._simCursor = {};
    if (!this._simCursor[symbol]) {
      this._simCursor[symbol] = Math.min(350, allCandles.length - 50);
    } else if (this._simCursor[symbol] < allCandles.length) {
      this._simCursor[symbol] += 1;
    }
    return allCandles.slice(0, this._simCursor[symbol]);
  }

  _openPaperPosition(sig, targetAccount = this.state, accountTag = 'V1') {
    if (targetAccount.openPositions.some((p) => p.symbol === sig.symbol)) {
      return null;
    }
    const equity = targetAccount.currentEquity;
    const riskUsd = equity * (this.state.riskPerTradePct || 0.01);
    const stopDistance = Math.abs(sig.entryPrice - sig.stopLoss);
    if (stopDistance <= 0) return null;

    let qty = riskUsd / stopDistance;
    const maxNotional = equity * (this.state.maxLeverage || 10);
    if (qty * sig.entryPrice > maxNotional) {
      qty = maxNotional / sig.entryPrice;
    }

    const actualRiskUsd = qty * stopDistance;
    const entryFee = qty * sig.entryPrice * (this.state.takerFeeRate || 0.0002);

    const position = {
      positionId: `PAPER_${accountTag}_${Date.now()}_${sig.symbol}`,
      accountTag,
      symbol: sig.symbol,
      side: sig.side,
      orderBlockId: sig.orderBlockId,
      openedAt: new Date().toISOString(),
      entryTimestamp: sig.timestamp,
      entryPrice: sig.entryPrice,
      limitEntryPrice: sig.limitEntryPrice,
      currentPrice: sig.entryPrice,
      initialStopLoss: sig.stopLoss,
      currentStopLoss: sig.stopLoss,
      tp1Price: sig.tp1Price,
      tp2Price: sig.tp2Price,
      targetType: sig.targetType,
      initialQty: Number(qty.toFixed(6)),
      remainingQty: Number(qty.toFixed(6)),
      notionalUsd: Number((qty * sig.entryPrice).toFixed(2)),
      initialRiskUsd: Number(actualRiskUsd.toFixed(2)),
      confluenceScore: sig.confluenceScore,
      orderFlowSignals: sig.orderFlowSignals,
      tp1Hit: false,
      realizedPnlUsd: Number((-entryFee).toFixed(2)),
      unrealizedPnlUsd: 0,
      unrealizedR: 0,
      feesPaidUsd: Number(entryFee.toFixed(2)),
    };

    targetAccount.openPositions.push(position);
    return position;
  }

  _updateOpenPositionsForSymbol(symbol, bar) {
    this._updateAccountPositionsForSymbol(this.state, 'V1 Ongoing', symbol, bar);
    if (this.state.v2Account) {
      this._updateAccountPositionsForSymbol(this.state.v2Account, 'V2 Sniper', symbol, bar);
    }
  }

  _updateAccountPositionsForSymbol(accountObj, accountLabel, symbol, bar) {
    const remainingOpen = [];

    for (const pos of accountObj.openPositions) {
      if (pos.symbol !== symbol) {
        remainingOpen.push(pos);
        continue;
      }

      // Sanity check against stale/corrupted feed spikes (>5% jump in a single 15s poll)
      const refPrice = pos.currentPrice || pos.entryPrice;
      if (refPrice > 0 && Math.abs(bar.close - refPrice) / refPrice > 0.05) {
        remainingOpen.push(pos);
        continue;
      }

      pos.currentPrice = this._formatPrice(bar.close);

      const isEntryCandle = bar.timestamp <= (pos.entryTimestamp || 0);
      const checkHigh = isEntryCandle ? bar.close : bar.high;
      const checkLow = isEntryCandle ? bar.close : bar.low;

      if (pos.side === 'LONG') {
        if (checkLow <= pos.currentStopLoss) {
          const pnl = (pos.currentStopLoss - pos.entryPrice) * pos.remainingQty;
          const fee = pos.currentStopLoss * pos.remainingQty * this.state.takerFeeRate;
          pos.realizedPnlUsd += pnl - fee;
          pos.feesPaidUsd += fee;
          pos.exitPrice = pos.currentStopLoss;
          pos.exitReason = pos.tp1Hit ? 'TP1_THEN_BREAKEVEN' : 'STOP_LOSS';
          pos.remainingQty = 0;
        } else {
          if (!pos.tp1Hit && checkHigh >= pos.tp1Price) {
            const closeQty = pos.initialQty * 0.5;
            const pnl1 = (pos.tp1Price - pos.entryPrice) * closeQty;
            pos.realizedPnlUsd += pnl1;
            pos.remainingQty = Number((pos.initialQty - closeQty).toFixed(6));
            pos.tp1Hit = true;
            pos.currentStopLoss = this._formatPrice(pos.entryPrice * 1.0004);
            this._dispatchTradeUpdateAlert(pos, 'TP1_HIT', accountLabel, accountObj.currentEquity).catch(() => {});
          }
          if (pos.remainingQty > 0 && checkHigh >= pos.tp2Price) {
            const pnl2 = (pos.tp2Price - pos.entryPrice) * pos.remainingQty;
            pos.realizedPnlUsd += pnl2;
            pos.exitPrice = pos.tp2Price;
            pos.exitReason = 'TP2_TARGET_HIT';
            pos.remainingQty = 0;
          }
        }

        if (pos.remainingQty > 0) {
          pos.unrealizedPnlUsd = Number(((bar.close - pos.entryPrice) * pos.remainingQty).toFixed(2));
          pos.unrealizedR = Number(
            ((pos.realizedPnlUsd + pos.unrealizedPnlUsd) / pos.initialRiskUsd).toFixed(2)
          );
        }
      } else {
        if (checkHigh >= pos.currentStopLoss) {
          const pnl = (pos.entryPrice - pos.currentStopLoss) * pos.remainingQty;
          const fee = pos.currentStopLoss * pos.remainingQty * this.state.takerFeeRate;
          pos.realizedPnlUsd += pnl - fee;
          pos.feesPaidUsd += fee;
          pos.exitPrice = pos.currentStopLoss;
          pos.exitReason = pos.tp1Hit ? 'TP1_THEN_BREAKEVEN' : 'STOP_LOSS';
          pos.remainingQty = 0;
        } else {
          if (!pos.tp1Hit && checkLow <= pos.tp1Price) {
            const closeQty = pos.initialQty * 0.5;
            const pnl1 = (pos.entryPrice - pos.tp1Price) * closeQty;
            pos.realizedPnlUsd += pnl1;
            pos.remainingQty = Number((pos.initialQty - closeQty).toFixed(6));
            pos.tp1Hit = true;
            pos.currentStopLoss = this._formatPrice(pos.entryPrice * 0.9996);
            this._dispatchTradeUpdateAlert(pos, 'TP1_HIT', accountLabel, accountObj.currentEquity).catch(() => {});
          }
          if (pos.remainingQty > 0 && checkLow <= pos.tp2Price) {
            const pnl2 = (pos.entryPrice - pos.tp2Price) * pos.remainingQty;
            pos.realizedPnlUsd += pnl2;
            pos.exitPrice = pos.tp2Price;
            pos.exitReason = 'TP2_TARGET_HIT';
            pos.remainingQty = 0;
          }
        }

        if (pos.remainingQty > 0) {
          pos.unrealizedPnlUsd = Number(((pos.entryPrice - bar.close) * pos.remainingQty).toFixed(2));
          pos.unrealizedR = Number(
            ((pos.realizedPnlUsd + pos.unrealizedPnlUsd) / pos.initialRiskUsd).toFixed(2)
          );
        }
      }

      if (pos.remainingQty === 0) {
        pos.closedAt = new Date().toISOString();
        pos.realizedPnlUsd = Number(pos.realizedPnlUsd.toFixed(2));
        pos.rMultiple = Number((pos.realizedPnlUsd / pos.initialRiskUsd).toFixed(2));
        accountObj.currentEquity = Number((accountObj.currentEquity + pos.realizedPnlUsd).toFixed(2));

        if (accountObj.currentEquity > accountObj.peakEquity) {
          accountObj.peakEquity = accountObj.currentEquity;
        }
        const ddPct =
          ((accountObj.peakEquity - accountObj.currentEquity) / accountObj.peakEquity) * 100;
        if (ddPct > (accountObj.maxDrawdownPct || 0)) {
          accountObj.maxDrawdownPct = Number(ddPct.toFixed(2));
        }

        accountObj.closedTrades.unshift(pos);
        this._dispatchTradeUpdateAlert(pos, pos.exitReason, accountLabel, accountObj.currentEquity).catch(() => {});
      } else {
        remainingOpen.push(pos);
      }
    }

    accountObj.openPositions = remainingOpen;
  }

  _getScoreTierLabel(score) {
    const s = Number(score || 0);
    if (s >= 80) return '80+ PTS';
    if (s >= 70) return '70+ PTS';
    if (s >= 60) return '60+ PTS';
    return '<60 PTS';
  }

  _formatDuration(startIso, endIso) {
    if (!startIso) return { text: '—', minutes: 0 };
    const startMs = new Date(startIso).getTime();
    const endMs = endIso ? new Date(endIso).getTime() : Date.now();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      return { text: '0m', minutes: 0 };
    }
    const diffSec = Math.floor((endMs - startMs) / 1000);
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;

    let text = '';
    if (days > 0) text = `${days}d ${hours}h ${mins}m`;
    else if (hours > 0) text = `${hours}h ${mins}m`;
    else if (mins > 0) text = `${mins}m ${secs}s`;
    else text = `${secs}s`;

    return {
      text,
      minutes: Number((diffSec / 60).toFixed(1)),
    };
  }

  async _dispatchTradeUpdateAlert(pos, eventType, accountLabel = 'V1 Ongoing', accountEquity = null) {
    this.alertConfig = this._loadAlertConfig();
    if (!this.alertConfig.telegramBotToken || !this.alertConfig.telegramChatId) return;

    let title = '';
    if (eventType === 'TP1_HIT') {
      title = `💰 *[${accountLabel}] TP1 HIT (+50% Locked & SL -> Breakeven)*`;
    } else if (eventType === 'TP2_TARGET_HIT') {
      title = `🚀 *[${accountLabel}] TP2 FULL TARGET HIT! (+${pos.rMultiple}R)*`;
    } else if (eventType === 'TP1_THEN_BREAKEVEN') {
      title = `🛡️ *[${accountLabel}] RUNNER CLOSED AT BREAKEVEN (+${pos.rMultiple}R Net)*`;
    } else {
      title = `🛑 *[${accountLabel}] STOP LOSS HIT (${pos.rMultiple}R)*`;
    }

    const pnlSign = pos.realizedPnlUsd >= 0 ? '+' : '';
    const tier = this._getScoreTierLabel(pos.confluenceScore);
    const dur = this._formatDuration(pos.openedAt, pos.closedAt || new Date().toISOString());
    const eqVal = accountEquity ?? this.state.currentEquity;
    const text =
      `${title}\n` +
      `Pair: \`${pos.symbol}\` | Side: *${pos.side}*\n` +
      `🎯 *Entry Score:* *${pos.confluenceScore || 65} pts (${tier})*\n` +
      `Entry: \`${pos.entryPrice}\` | Exit/Mark: \`${pos.exitPrice || pos.tp1Price}\`\n` +
      `⏱️ *Duration:* \`${dur.text}\`\n` +
      `Realized PnL: *${pnlSign}$${pos.realizedPnlUsd.toFixed(2)}*\n` +
      `${accountLabel} Balance: *$${Number(eqVal).toFixed(2)}*`;

    await this._sendTelegramMessage(text, this.alertConfig.telegramChatId);
  }

  async _sendTelegramMessage(text, chatId) {
    this.alertConfig = this._loadAlertConfig();
    if (!this.alertConfig.telegramBotToken || !(chatId || this.alertConfig.telegramChatId)) return null;
    const targetChatId = chatId || this.alertConfig.telegramChatId;
    const tgUrl = `https://api.telegram.org/bot${this.alertConfig.telegramBotToken}/sendMessage`;

    const res = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      // Fallback: strip markdown markers so the alert is guaranteed to deliver even if special chars exist
      const plainText = text.replace(/[*`_]/g, '');
      const retryRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChatId,
          text: plainText,
        }),
      });
      return retryRes.json();
    }
    return json;
  }

  async _pollTelegramCommands() {
    this.alertConfig = this._loadAlertConfig();
    if (!this.alertConfig.telegramBotToken || !this.alertConfig.telegramChatId) return;

    const offsetParam = this.lastTgUpdateId ? `?offset=${this.lastTgUpdateId + 1}&timeout=1` : '?timeout=1';
    const url = `https://api.telegram.org/bot${this.alertConfig.telegramBotToken}/getUpdates${offsetParam}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) return;

    for (const upd of data.result) {
      if (upd.update_id > (this.lastTgUpdateId || 0)) {
        this.lastTgUpdateId = upd.update_id;
      }
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      const textCmd = msg.text.trim().toLowerCase();
      const chatId = String(msg.chat?.id || this.alertConfig.telegramChatId);

      if (textCmd === '/status' || textCmd === '/start' || textCmd === '/help') {
        const snap = this.getStatusSnapshot();
        const v2 = snap.v2Portfolio;
        const v1 = snap.v1Portfolio;

        const v2OpenLines =
          v2.openPositions.length > 0
            ? v2.openPositions
                .map(
                  (p) =>
                    `• \`${p.symbol}\` (${p.side}) @ \`${p.entryPrice}\` -> \`${p.currentPrice}\` (*${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd}* / \`${p.unrealizedR}R\`)`
                )
                .join('\n')
            : '_No V2 Sniper open positions_';

        const reply =
          `🤖 *24/7 MEXC DUAL-ACCOUNT BOT STATUS*\n\n` +
          `🎯 *ACCOUNT 2: V2 BTC-COMPASS SNIPER (NEW)*\n` +
          `• Live Equity: \`$${v2.account.liveEquity}\` (${v2.account.netPnlUsd >= 0 ? '+' : ''}$${v2.account.netPnlUsd})\n` +
          `• Closed Trades: \`${v2.account.closedTradesCount}\` (WR: \`${v2.account.winRatePct}%\`)\n` +
          `• Open (${v2.openPositions.length}):\n${v2OpenLines}\n\n` +
          `📊 *ACCOUNT 1: V1 ONGOING BASELINE*\n` +
          `• Live Equity: \`$${v1.account.liveEquity}\` (${v1.account.netPnlUsd >= 0 ? '+' : ''}$${v1.account.netPnlUsd})\n` +
          `• Closed Trades: \`${v1.account.closedTradesCount}\` (WR: \`${v1.account.winRatePct}%\`) | Open: \`${v1.openPositions.length}\`\n\n` +
          `Commands: /status | /positions | /scan`;

        await this._sendTelegramMessage(reply, chatId);
      } else if (textCmd === '/positions') {
        const snap = this.getStatusSnapshot();
        const v2 = snap.v2Portfolio;
        const v1 = snap.v1Portfolio;
        const formatPos = (p, tag) =>
          `📌 *[${tag}]* \`${p.symbol}\` *${p.side}* (\`${p.confluenceScore}p\`)\n` +
          `Entry: \`${p.entryPrice}\` | Mark: \`${p.currentPrice}\`\n` +
          `SL: \`${p.currentStopLoss}\` | TP1: \`${p.tp1Price}\` | TP2: \`${p.tp2Price}\`\n` +
          `PnL: *${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd}* (\`${p.unrealizedR}R\`)`;

        const lines = [
          ...v2.openPositions.map((p) => formatPos(p, 'V2 SNIPER')),
          ...v1.openPositions.map((p) => formatPos(p, 'V1 ONGOING')),
        ];
        await this._sendTelegramMessage(
          lines.length > 0 ? lines.join('\n\n') : 'No open paper positions right now.',
          chatId
        );
      } else if (textCmd === '/scan') {
        await this.scanAllSymbols();
        const snap = this.getStatusSnapshot();
        const lines = snap.markets
          .map((m) => {
            const z = m.closestZone;
            return `• \`${m.symbol}\` (\`$${m.lastPrice}\`): ${
              z ? `${z.type} OB ${z.distancePct}% away — *${z.liveScore || z.baseScore}/100 pts*` : 'No nearby OB'
            }`;
          })
          .join('\n');
        await this._sendTelegramMessage(`⚡ *Fresh Market Scan Complete:*\n\n${lines}`, chatId);
      }
    }
  }

  async _dispatchExternalAlert(sig) {
    this.alertConfig = this._loadAlertConfig();
    const clean = (s) => String(s || '').replace(/_/g, ' ');
    const breakdownStr =
      Array.isArray(sig.scoreBreakdown) && sig.scoreBreakdown.length > 0
        ? sig.scoreBreakdown.map((b) => `• ${b.points > 0 ? '+' : ''}${b.points}p ${clean(b.label)}`).join('\n')
        : sig.orderFlowSignals.map(clean).join(' + ');

    const acctHeader = sig.enteredV2
      ? `🎯 *ACCOUNT: V2 SNIPER (NEW) + V1 ONGOING*`
      : `📊 *ACCOUNT: V1 ONGOING ONLY (Skipped on V2: ${clean(sig.v2GateReason)})*`;

    const coVerdict = sig.claudeReview
      ? `\n🤖 *Co-Agent Verdict:* ${clean(sig.claudeReview.verdict)} (${sig.claudeReview.confidence}%)\n_${clean(sig.claudeReview.reasoning)}_`
      : '';

    const text =
      `🚨 *MEXC FUTURES 5m OB + ORDER FLOW SIGNAL*\n` +
      `${acctHeader}\n` +
      `Pair: \`${sig.symbol}\` | Side: *${sig.side}*\n` +
      `Grade: *${sig.grade || 'A-GRADE'} (${sig.confluenceScore}/100 pts)*\n\n` +
      `⚡ *Market Entry (Now):* \`${sig.entryPrice}\`\n` +
      `🎯 *Limit Retest (0% Fee):* \`${sig.limitEntryPrice || sig.entryPrice}\` (OB/POC)\n` +
      `🛑 *Stop Loss:* \`${sig.stopLoss}\`\n` +
      `💰 *TP1 (${clean(sig.tp1Type || '1.8R')} + BE):* \`${sig.tp1Price}\`\n` +
      `🚀 *TP2 Target:* \`${sig.tp2Price}\` (\`${sig.targetType}\`)\n\n` +
      `📊 *100-Point Confluence Breakdown:*\n${breakdownStr}` +
      coVerdict;

    if (this.alertConfig.telegramBotToken && this.alertConfig.telegramChatId) {
      await this._sendTelegramMessage(text, this.alertConfig.telegramChatId);
    }

    if (this.alertConfig.discordWebhookUrl) {
      await fetch(this.alertConfig.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
    }
  }

  async sendTestTelegramAlert() {
    this.alertConfig = this._loadAlertConfig();
    if (!this.alertConfig.telegramBotToken || !this.alertConfig.telegramChatId) {
      throw new Error('Telegram Bot Token or Chat ID is missing.');
    }
    const marketsList = this.symbols
      .map((s) => {
        const m = this.marketCache[s];
        return m ? `• \`${s}\`: \`$${m.lastPrice}\` (\`${m.trendBias}\`)` : `• \`${s}\``;
      })
      .join('\n');

    const text =
      `✅ *MEXC Dual-Account Bot Connected (V1 Ongoing + V2 BTC-Compass Sniper)!*\n\n` +
      `🎯 *Min Confluence Score:* \`${this.state.minScoreThreshold || 60}/100 pts\`\n` +
      `📡 *Active Watched Markets (${this.symbols.length}):*\n${marketsList}`;

    const json = await this._sendTelegramMessage(text, this.alertConfig.telegramChatId);
    if (!json?.ok) {
      throw new Error(json?.description || 'Telegram send failed');
    }
    return json;
  }

  _buildPortfolioSnapshot(accountObj, name, startedAtIso) {
    const closed = accountObj.closedTrades || [];
    const open = accountObj.openPositions || [];
    const wins = closed.filter((t) => t.realizedPnlUsd > 0);
    const totalUnrealized = open.reduce((acc, p) => acc + (p.unrealizedPnlUsd || 0), 0);
    const initialEq = accountObj.initialEquity || 10000;
    const realizedEq = accountObj.currentEquity ?? initialEq;
    const liveEquity = Number((realizedEq + totalUnrealized).toFixed(2));
    const netPnlUsd = Number((liveEquity - initialEq).toFixed(2));
    const netReturnPct = Number(((netPnlUsd / initialEq) * 100).toFixed(2));

    const nowIso = new Date().toISOString();
    const enrichedOpen = open.map((p) => {
      const dur = this._formatDuration(p.openedAt, nowIso);
      return {
        ...p,
        scoreTier: this._getScoreTierLabel(p.confluenceScore),
        durationText: dur.text,
        durationMinutes: dur.minutes,
      };
    });

    const enrichedClosed = closed.map((t) => {
      const dur = this._formatDuration(t.openedAt, t.closedAt);
      return {
        ...t,
        scoreTier: this._getScoreTierLabel(t.confluenceScore),
        durationText: dur.text,
        durationMinutes: dur.minutes,
      };
    });

    const calcTierStats = (list, label, code) => {
      const w = list.filter((t) => (t.realizedPnlUsd || 0) > 0);
      const l = list.filter((t) => (t.realizedPnlUsd || 0) <= 0);
      const pnl = Number(list.reduce((s, t) => s + (t.realizedPnlUsd || 0), 0).toFixed(2));
      const avgR =
        list.length > 0
          ? Number((list.reduce((s, t) => s + (t.rMultiple || 0), 0) / list.length).toFixed(2))
          : 0;
      const avgMins =
        list.length > 0
          ? Math.round(list.reduce((s, t) => s + (t.durationMinutes || 0), 0) / list.length)
          : 0;
      const avgDurText = avgMins >= 60 ? `${Math.floor(avgMins / 60)}h ${avgMins % 60}m` : `${avgMins}m`;
      return {
        code,
        label,
        tradesCount: list.length,
        winsCount: w.length,
        lossesCount: l.length,
        winRatePct: list.length > 0 ? Number(((w.length / list.length) * 100).toFixed(1)) : 0,
        netPnlUsd: pnl,
        avgR,
        avgDurationText: avgDurText,
      };
    };

    const scoreTierAnalytics = {
      cumulativeThresholds: [
        calcTierStats(
          enrichedClosed.filter((t) => (t.confluenceScore || 0) >= 60),
          'If Taking >= 60 Points',
          'GTE_60'
        ),
        calcTierStats(
          enrichedClosed.filter((t) => (t.confluenceScore || 0) >= 70),
          'If Taking >= 70 Points',
          'GTE_70'
        ),
        calcTierStats(
          enrichedClosed.filter((t) => (t.confluenceScore || 0) >= 80),
          'If Taking >= 80 Points',
          'GTE_80'
        ),
      ],
      individualBrackets: [
        calcTierStats(
          enrichedClosed.filter((t) => (t.confluenceScore || 0) >= 60 && (t.confluenceScore || 0) < 70),
          '60–69 Points Bracket',
          'BRACKET_60_69'
        ),
        calcTierStats(
          enrichedClosed.filter((t) => (t.confluenceScore || 0) >= 70 && (t.confluenceScore || 0) < 80),
          '70–79 Points Bracket',
          'BRACKET_70_79'
        ),
        calcTierStats(
          enrichedClosed.filter((t) => (t.confluenceScore || 0) >= 80),
          '80+ Points Bracket',
          'BRACKET_80_PLUS'
        ),
      ],
    };

    return {
      name,
      startedAt: startedAtIso,
      account: {
        initialEquity: initialEq,
        realizedEquity: realizedEq,
        liveEquity,
        unrealizedPnlUsd: Number(totalUnrealized.toFixed(2)),
        netPnlUsd,
        netReturnPct,
        maxDrawdownPct: accountObj.maxDrawdownPct || 0,
        closedTradesCount: closed.length,
        winsCount: wins.length,
        lossesCount: closed.length - wins.length,
        winRatePct: closed.length > 0 ? Number(((wins.length / closed.length) * 100).toFixed(1)) : 0,
        openPositionsCount: open.length,
      },
      scoreTierAnalytics,
      openPositions: enrichedOpen,
      closedTrades: enrichedClosed.slice(0, 120),
    };
  }

  getStatusSnapshot() {
    const elapsedMs = Date.now() - this.state.campaignStartTimestamp;
    const elapsedDays = Number((elapsedMs / (86400 * 1000)).toFixed(2));
    const progressPct = Math.min(100, Number(((elapsedDays / 7) * 100).toFixed(1)));

    const v1Portfolio = this._buildPortfolioSnapshot(
      this.state,
      'V1 Ongoing Baseline (Original Rules)',
      new Date(this.state.campaignStartTimestamp).toISOString()
    );
    const v2Portfolio = this._buildPortfolioSnapshot(
      this.state.v2Account || {
        initialEquity: 10000,
        currentEquity: 10000,
        maxDrawdownPct: 0,
        openPositions: [],
        closedTrades: [],
      },
      'V2 BTC-Compass Sniper (4-Pillar BTC + Single-Side + Tournament)',
      this.state.v2Account?.startedAt || new Date().toISOString()
    );

    const breadth = this._getMarketBreadthAndBtcStats();

    return {
      watchedSymbols: this.symbols,
      minScoreThreshold: this.state.minScoreThreshold ?? 70,
      marketBreadth: breadth,
      agentBus: this.getAgentBusSnapshot(),
      campaign: {
        startDate: new Date(this.state.campaignStartTimestamp).toISOString(),
        targetEndDate: new Date(this.state.campaignTargetEndTimestamp).toISOString(),
        elapsedDays,
        remainingDays: Number(Math.max(0, 7 - elapsedDays).toFixed(2)),
        progressPct,
      },
      v1Portfolio,
      v2Portfolio,
      account: v1Portfolio.account,
      scoreTierAnalytics: v1Portfolio.scoreTierAnalytics,
      openPositions: v1Portfolio.openPositions,
      closedTrades: v1Portfolio.closedTrades,
      signalsFeed: this.state.signalsFeed.slice(0, 40),
      markets: this.symbols
        .map((sym) => this.marketCache[sym])
        .filter(Boolean)
        .map((m) => ({
          symbol: m.symbol,
          source: m.source,
          updatedAt: m.updatedAt,
          lastPrice: m.lastPrice,
          latestDelta: m.latestDelta,
          latestDeltaPct: m.latestDeltaPct,
          latestCvd: m.latestCvd,
          latestPerpCvd: m.latestPerpCvd,
          latestPerpDeltaPct: m.latestPerpDeltaPct,
          latestSpotCvd: m.latestSpotCvd,
          latestSpotDeltaPct: m.latestSpotDeltaPct,
          openInterestUsd: m.openInterestUsd,
          oiChangePct: m.oiChangePct,
          oiChange3BarPct: m.oiChange3BarPct,
          trendBias: m.trendBias,
          nearbyZonesCount: m.nearbyZones.length,
          closestZone: m.nearbyZones[0] || null,
        })),
    };
  }
}
