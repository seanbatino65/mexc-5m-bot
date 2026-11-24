/**
 * Official PROPR (Hyperliquid) Automated Execution Bridge
 * Base URL: https://api.propr.xyz/v1
 * Auth: X-API-Key: pk_live_...
 *
 * Built-in Prop Firm Guardrails:
 * 1. Defaults to OFF (enabled: false) until explicitly armed by user
 * 2. Strict USD Risk Sizing (default $15/trade for 5K EVAL)
 * 3. Daily Loss Kill-Switch (default -$30/day halts new entries)
 * 4. Automatic Hyperliquid szDecimals rounding so orders never fail precision checks
 * 5. Automatic Exchange-Side Stop Loss + TP1 (50%) + TP2 (50%) orders
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, '../../data/propr_config.json');
const DEFAULT_BASE_URL = 'https://api.propr.xyz/v1';

// Crockford Base32 ULID generator (zero external dependencies)
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function generateUlid() {
  let time = Date.now();
  let timeStr = '';
  for (let i = 0; i < 10; i++) {
    timeStr = ENCODING[time % 32] + timeStr;
    time = Math.floor(time / 32);
  }
  const randBytes = crypto.randomBytes(16);
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    randStr += ENCODING[randBytes[i] % 32];
  }
  return timeStr + randStr;
}

export class ProprAutoTrader {
  constructor(fetcher = null) {
    this.fetcher = fetcher;
    this.config = this._loadConfig();
    this.accountId = null;
    this.userProfile = null;
    this.challengeAttempt = null;
    this.szDecimalsMap = new Map();
    this.executionLog = [];
  }

  _loadConfig() {
    const defaults = {
      enabled: false,
      apiKey: process.env.PROPR_API_KEY || '',
      baseUrl: process.env.PROPR_API_URL || DEFAULT_BASE_URL,
      riskPerTradeUsd: 15,
      dailyLossLimitUsd: 30,
      maxOpenPositions: 2,
      leverage: 2,
      marginMode: 'isolated',
    };
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { ...defaults, ...parsed };
      } catch {
        // Ignore corrupt config
      }
    }
    return defaults;
  }

  saveConfig(updates = {}) {
    if (typeof updates.enabled === 'boolean') this.config.enabled = updates.enabled;
    if (typeof updates.apiKey === 'string' && updates.apiKey.trim() && !updates.apiKey.includes('...')) {
      this.config.apiKey = updates.apiKey.trim();
      this.accountId = null; // Re-detect account on key change
    }
    if (updates.riskPerTradeUsd !== undefined) {
      this.config.riskPerTradeUsd = Math.max(5, Math.min(200, Number(updates.riskPerTradeUsd) || 15));
    }
    if (updates.dailyLossLimitUsd !== undefined) {
      this.config.dailyLossLimitUsd = Math.max(10, Math.min(500, Number(updates.dailyLossLimitUsd) || 30));
    }
    if (updates.maxOpenPositions !== undefined) {
      this.config.maxOpenPositions = Math.max(1, Math.min(5, Number(updates.maxOpenPositions) || 2));
    }
    if (updates.leverage !== undefined) {
      this.config.leverage = Math.max(1, Math.min(10, Number(updates.leverage) || 2));
    }
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    return this.getPublicStatus();
  }

  _maskKey(key) {
    if (!key) return '';
    if (key.length <= 14) return 'pk_live_***';
    return `${key.slice(0, 12)}...${key.slice(-4)}`;
  }

  _log(level, message, meta = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta,
    };
    this.executionLog.unshift(entry);
    if (this.executionLog.length > 50) this.executionLog.pop();
    console.log(`[PROPR ${level}] ${message}`);
  }

  async _request(method, endpoint, { params, body } = {}) {
    if (!this.config.apiKey) {
      throw new Error('PROPR API key not configured');
    }
    let url = `${this.config.baseUrl}${endpoint}`;
    if (params) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) sp.set(k, String(v));
      }
      const qs = sp.toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        throw new Error(`PROPR HTTP ${res.status}: ${data?.message || text.slice(0, 200)}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureSetup() {
    if (this.accountId) return this.accountId;
    const [userRes, attemptsRes] = await Promise.all([
      this._request('GET', '/users/me'),
      this._request('GET', '/challenge-attempts', { params: { status: 'active', limit: 20 } }),
    ]);
    this.userProfile = userRes;
    const attempts = attemptsRes?.data || [];
    if (!attempts.length) {
      throw new Error('No active PROPR challenge account found for this API key');
    }
    this.challengeAttempt = attempts[0];
    this.accountId = attempts[0].accountId;
    return this.accountId;
  }

  async testConnection() {
    this.accountId = null;
    await this.ensureSetup();
    const positions = await this.getOpenPositions();
    const dailyPnl = await this.getTodayRealizedPnl();
    this._log(
      'INFO',
      `Connected to PROPR Account ${this.accountId} (${positions.length} open positions, today PnL: $${dailyPnl.toFixed(2)})`
    );
    return {
      ok: true,
      accountId: this.accountId,
      challengeStatus: this.challengeAttempt?.status || 'active',
      openPositionsCount: positions.length,
      openPositions: positions,
      todayRealizedPnlUsd: Number(dailyPnl.toFixed(2)),
      status: this.getPublicStatus(),
    };
  }

  async getOpenPositions(base = undefined) {
    const accountId = await this.ensureSetup();
    const res = await this._request('GET', `/accounts/${accountId}/positions`, {
      params: { status: 'open', base, limit: 20 },
    });
    const list = res?.data || [];
    return list.filter((p) => parseFloat(p.quantity) > 0);
  }

  async getTodayRealizedPnl() {
    const accountId = await this.ensureSetup();
    const res = await this._request('GET', `/accounts/${accountId}/trades`, {
      params: { limit: 50 },
    });
    const trades = res?.data || [];
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    const cutoff = startOfDayUtc.getTime();
    let pnl = 0;
    for (const t of trades) {
      const ts = new Date(t.executedAt || t.createdAt).getTime();
      if (ts >= cutoff) {
        pnl += parseFloat(t.realizedPnl || 0);
      }
    }
    return pnl;
  }

  async _getSzDecimals(coin) {
    if (this.szDecimalsMap.size === 0) {
      try {
        const res = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'meta' }),
        });
        const data = await res.json();
        if (Array.isArray(data?.universe)) {
          for (const u of data.universe) {
            if (u.name && typeof u.szDecimals === 'number') {
              this.szDecimalsMap.set(u.name, u.szDecimals);
            }
          }
        }
      } catch {
        // Fallback defaults below
      }
    }
    if (this.szDecimalsMap.has(coin)) return this.szDecimalsMap.get(coin);
    if (coin === 'BTC') return 5;
    if (coin === 'ETH') return 4;
    if (coin === 'SOL') return 2;
    return 1;
  }

  _formatPriceStr(price) {
    const num = Number(price);
    if (!Number.isFinite(num) || num <= 0) return '0';
    // Hyperliquid allows up to 5 significant figures
    return String(Number(num.toPrecision(5)));
  }

  /**
   * Executes a V2 Sniper signal on PROPR with hard-coded risk guardrails + exchange SL/TP!
   */
  async executeSignal(sig) {
    if (!this.config.enabled) {
      return { executed: false, reason: 'AUTO_TRADING_DISABLED' };
    }
    if (!this.config.apiKey) {
      return { executed: false, reason: 'NO_API_KEY' };
    }

    try {
      const accountId = await this.ensureSetup();
      const base = this.fetcher
        ? this.fetcher._toHyperliquidCoin(sig.symbol)
        : String(sig.symbol).split(/[_-]/)[0].toUpperCase();

      // 1. Daily Loss Kill-Switch Check
      const todayPnl = await this.getTodayRealizedPnl();
      if (todayPnl <= -Math.abs(this.config.dailyLossLimitUsd)) {
        this._log(
          'WARN',
          `KILL-SWITCH ACTIVE: Skipped ${base} ${sig.side} (Today PnL $${todayPnl.toFixed(2)} <= -$${this.config.dailyLossLimitUsd})`
        );
        return { executed: false, reason: 'DAILY_LOSS_KILL_SWITCH' };
      }

      // 2. Open Positions Cap & Duplicate Coin Check
      const openPositions = await this.getOpenPositions();
      if (openPositions.some((p) => p.base === base || p.asset === base)) {
        this._log('INFO', `Skipped ${base} ${sig.side}: Already open on PROPR`);
        return { executed: false, reason: 'ALREADY_OPEN_ON_PROPR' };
      }
      if (openPositions.length >= this.config.maxOpenPositions) {
        this._log('INFO', `Skipped ${base} ${sig.side}: Max open positions (${this.config.maxOpenPositions}) reached`);
        return { executed: false, reason: 'MAX_OPEN_POSITIONS_REACHED' };
      }

      // 3. Calculate exact FEE-INCLUSIVE position size so (Price Loss + Round-Trip PROPR Fees + Slippage) <= Risk USD!
      // PROPR Taker Fee = 0.045% entry + 0.045% exit (0.09% round-trip) + 0.02% market slippage buffer
      const entryPx = Number(sig.entryPrice);
      const slPx = Number(sig.stopLoss);
      const stopDist = Math.abs(entryPx - slPx);
      if (stopDist <= 0) {
        return { executed: false, reason: 'INVALID_STOP_DISTANCE' };
      }

      const PROPR_TAKER_FEE = 0.00045;
      const SLIPPAGE_BUFFER = 0.0002;
      const feePerUnit = (entryPx + slPx) * PROPR_TAKER_FEE + entryPx * SLIPPAGE_BUFFER;
      const allInRiskPerUnit = stopDist + feePerUnit;

      const isCaution = sig.claudeReview?.verdict === 'CAUTION';
      const effectiveRiskUsd = isCaution ? this.config.riskPerTradeUsd * 0.5 : this.config.riskPerTradeUsd;
      let rawQty = effectiveRiskUsd / allInRiskPerUnit;

      // Cap max notional to safe 2x of $5K ($9,000 max notional)
      const maxNotional = 9000;
      if (rawQty * entryPx > maxNotional) {
        rawQty = maxNotional / entryPx;
      }

      const szDec = await this._getSzDecimals(base);
      const qtyFactor = Math.pow(10, szDec);
      const totalQty = Math.floor(rawQty * qtyFactor) / qtyFactor;
      if (totalQty <= 0) {
        this._log('WARN', `Skipped ${base}: Computed qty rounded to 0 (szDecimals=${szDec})`);
        return { executed: false, reason: 'QTY_TOO_SMALL' };
      }
      const estPriceLoss = totalQty * stopDist;
      const estFeeSlip = totalQty * feePerUnit;

      const tp1Qty = Math.floor((totalQty * 0.5) * qtyFactor) / qtyFactor;
      const tp2Qty = Number((totalQty - tp1Qty).toFixed(szDec));

      const isLong = sig.side === 'LONG';
      const entrySide = isLong ? 'buy' : 'sell';
      const closeSide = isLong ? 'sell' : 'buy';
      const posSide = isLong ? 'long' : 'short';

      // 4. Place Market Entry Order
      const entryOrder = {
        accountId,
        intentId: generateUlid(),
        exchange: 'hyperliquid',
        type: 'market',
        side: entrySide,
        positionSide: posSide,
        productType: 'perp',
        timeInForce: 'IOC',
        asset: base,
        base,
        quote: 'USDC',
        quantity: String(totalQty),
        reduceOnly: false,
        closePosition: false,
      };

      const entryRes = await this._request('POST', `/accounts/${accountId}/orders`, {
        orders: [entryOrder],
      });

      this._log(
        'ORDER',
        `OPENED ${base} ${sig.side} qty=${totalQty} (~$${(totalQty * entryPx).toFixed(0)} notional | Price Risk $${estPriceLoss.toFixed(2)} + Est. Fees/Slip $${estFeeSlip.toFixed(2)} = $${(estPriceLoss + estFeeSlip).toFixed(2)} Total Max Risk)`,
        { orderId: entryRes?.data?.[0]?.orderId }
      );

      // 5. Immediately attach Exchange-Side Stop Loss + TP1 + TP2
      const exitOrders = [
        {
          accountId,
          intentId: generateUlid(),
          exchange: 'hyperliquid',
          type: 'stop_market',
          side: closeSide,
          positionSide: posSide,
          productType: 'perp',
          timeInForce: 'GTC',
          asset: base,
          base,
          quote: 'USDC',
          quantity: String(totalQty),
          triggerPrice: this._formatPriceStr(sig.stopLoss),
          reduceOnly: true,
          closePosition: true,
        },
      ];

      if (tp1Qty > 0 && sig.tp1Price) {
        exitOrders.push({
          accountId,
          intentId: generateUlid(),
          exchange: 'hyperliquid',
          type: 'take_profit_market',
          side: closeSide,
          positionSide: posSide,
          productType: 'perp',
          timeInForce: 'GTC',
          asset: base,
          base,
          quote: 'USDC',
          quantity: String(tp1Qty),
          triggerPrice: this._formatPriceStr(sig.tp1Price),
          reduceOnly: true,
          closePosition: false,
        });
      }

      if (tp2Qty > 0 && sig.tp2Price) {
        exitOrders.push({
          accountId,
          intentId: generateUlid(),
          exchange: 'hyperliquid',
          type: 'take_profit_market',
          side: closeSide,
          positionSide: posSide,
          productType: 'perp',
          timeInForce: 'GTC',
          asset: base,
          base,
          quote: 'USDC',
          quantity: String(tp2Qty),
          triggerPrice: this._formatPriceStr(sig.tp2Price),
          reduceOnly: true,
          closePosition: false,
        });
      }

      await this._request('POST', `/accounts/${accountId}/orders`, { orders: exitOrders });
      this._log(
        'ORDER',
        `ATTACHED SL=${this._formatPriceStr(sig.stopLoss)} | TP1=${this._formatPriceStr(sig.tp1Price)} (50%) | TP2=${this._formatPriceStr(sig.tp2Price)} (50%) for ${base}`
      );

      return { executed: true, base, totalQty, entryRes };
    } catch (err) {
      this._log('ERROR', `PROPR execution failed for ${sig.symbol}: ${err.message}`);
      return { executed: false, error: err.message };
    }
  }

  getPublicStatus() {
    return {
      enabled: Boolean(this.config.enabled),
      hasApiKey: Boolean(this.config.apiKey),
      maskedApiKey: this._maskKey(this.config.apiKey),
      accountId: this.accountId,
      riskPerTradeUsd: this.config.riskPerTradeUsd,
      dailyLossLimitUsd: this.config.dailyLossLimitUsd,
      maxOpenPositions: this.config.maxOpenPositions,
      leverage: this.config.leverage,
      executionLog: this.executionLog.slice(0, 15),
    };
  }
}
