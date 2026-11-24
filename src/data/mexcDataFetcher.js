/**
 * Real-Time Hyperliquid (PROPR) & Multi-Exchange Live 5m Kline Fetcher
 *
 * Connects to Hyperliquid Mainnet (`api.hyperliquid.xyz/info`) FIRST for exact
 * PROPR / Hyperliquid perpetual candles, live Mark Price, Open Interest & Funding,
 * enriches with Spot CVD / Perp Taker flow, and keeps Bitget / Gate / Bybit as fallbacks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DIAG_FILE = path.join(DATA_DIR, 'connection_diagnostics.json');
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

const HL_K_PREFIX_COINS = new Set(['PEPE', 'BONK', 'SHIB', 'FLOKI', 'LUNC', 'NEIRO']);

export class MexcDataFetcher {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.lastDiagnostics = {};
    this._hlMetaCache = null;
    this._hlMetaFetchedAt = 0;
  }

  _toHyperliquidCoin(symbol = 'BTC_USDC') {
    const raw = String(symbol || 'BTC_USDC')
      .trim()
      .toUpperCase()
      .replace(/[-/](USDC|USDT|USD)$/i, '')
      .replace(/_(USDC|USDT|USD)$/i, '');
    if (raw.startsWith('1000')) {
      return `k${raw.slice(4)}`;
    }
    if (HL_K_PREFIX_COINS.has(raw)) {
      return `k${raw}`;
    }
    return raw;
  }

  _toHyperliquidInterval(interval = 'Min5') {
    const map = {
      Min1: '1m',
      Min5: '5m',
      Min15: '15m',
      Min30: '30m',
      Min60: '1h',
      Hour1: '1h',
      Hour4: '4h',
      Day1: '1d',
      '1m': '1m',
      '5m': '5m',
      '15m': '15m',
      '1h': '1h',
      '4h': '4h',
    };
    return map[interval] || '5m';
  }

  async _fetchHyperliquidPost(bodyObj, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(HYPERLIQUID_INFO_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(bodyObj),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async getHyperliquidAssetCtx(symbol) {
    const coin = this._toHyperliquidCoin(symbol);
    const now = Date.now();
    if (!this._hlMetaCache || now - this._hlMetaFetchedAt > 8000) {
      try {
        const data = await this._fetchHyperliquidPost({ type: 'metaAndAssetCtxs' }, 4000);
        if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[0]?.universe)) {
          const map = new Map();
          const universe = data[0].universe;
          const ctxs = data[1];
          for (let i = 0; i < universe.length; i++) {
            const name = universe[i]?.name;
            const ctx = ctxs[i];
            if (name && ctx) {
              const markPx = Number(ctx.markPx || ctx.midPx || 0);
              const oiContracts = Number(ctx.openInterest || 0);
              map.set(name, {
                coin: name,
                markPx,
                openInterestContracts: oiContracts,
                openInterestUsd: markPx > 0 ? oiContracts * markPx : 0,
                funding: Number(ctx.funding || 0),
                dayNtlVlm: Number(ctx.dayNtlVlm || 0),
              });
            }
          }
          this._hlMetaCache = map;
          this._hlMetaFetchedAt = now;
        }
      } catch {
        // Keep stale cache if available
      }
    }
    return this._hlMetaCache?.get(coin) || null;
  }

  _saveDiagnostic(symbol, provider, status, detail) {
    this.lastDiagnostics[symbol] = {
      ...this.lastDiagnostics[symbol],
      [provider]: {
        status,
        detail,
        checkedAt: new Date().toISOString(),
      },
    };
    try {
      fs.writeFileSync(DIAG_FILE, JSON.stringify(this.lastDiagnostics, null, 2));
    } catch {
      // Ignore write error
    }
  }

  /**
   * Fetches live 5m candles (prioritizing Hyperliquid Mainnet -> Bitget -> Gate -> Bybit).
   * Returns { candles, source }.
   */
  async fetchLiveCandles(symbol = 'BTC_USDC', interval = 'Min5', totalBars = 350) {
    const baseCoin = symbol.split(/[_-]/)[0].toUpperCase(); // e.g. BTC
    const usdtSymbol = `${baseCoin}_USDT`;
    const cleanSymbol = `${baseCoin}USDT`; // e.g. BTCUSDT
    const hlCoin = this._toHyperliquidCoin(symbol);
    const hlInterval = this._toHyperliquidInterval(interval);
    const intervalMsMap = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
    const stepMs = intervalMsMap[hlInterval] || 300000;

    // 0. PRIMARY: Hyperliquid Mainnet Perpetuals API (exact PROPR chart feed)
    try {
      const endTime = Date.now();
      const startTime = endTime - (totalBars + 5) * stepMs;
      const rows = await this._fetchHyperliquidPost(
        {
          type: 'candleSnapshot',
          req: { coin: hlCoin, interval: hlInterval, startTime, endTime },
        },
        5500
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const candles = rows.slice(-totalBars).map((r) => ({
          timestamp: Number(r.t),
          open: Number(r.o),
          high: Number(r.h),
          low: Number(r.l),
          close: Number(r.c),
          volume: Number(r.v),
        }));
        this._saveDiagnostic(
          symbol,
          'HYPERLIQUID_MAINNET',
          'OK',
          `Loaded ${candles.length} bars (${hlCoin} ${hlInterval}), last=${candles[candles.length - 1]?.close}`
        );
        await this._enrichWithOiSpotPerpFlow(symbol, candles);
        return { candles, source: 'HYPERLIQUID_MAINNET' };
      }
      this._saveDiagnostic(symbol, 'HYPERLIQUID_MAINNET', 'EMPTY', `No candles returned for ${hlCoin}`);
    } catch (err) {
      this._saveDiagnostic(symbol, 'HYPERLIQUID_MAINNET', 'ERROR', `${err.message}`);
    }

    // 1. Fallback: MEXC Futures Contract API
    try {
      const contractUrl = `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(
        usdtSymbol
      )}?interval=${interval}`;
      const json = await this._fetchJsonWithTimeout(contractUrl, 5000);
      if (json?.success && json?.data && Array.isArray(json.data.time) && json.data.time.length > 0) {
        const { time, open, high, low, close, vol } = json.data;
        const startIdx = Math.max(0, time.length - totalBars);
        const candles = [];
        for (let i = startIdx; i < time.length; i++) {
          candles.push({
            timestamp: Number(time[i]) * 1000,
            open: Number(open[i]),
            high: Number(high[i]),
            low: Number(low[i]),
            close: Number(close[i]),
            volume: Number(vol[i]),
          });
        }
        this._saveDiagnostic(symbol, 'MEXC_FUTURES', 'OK', `Loaded ${candles.length} bars, last=${candles[candles.length - 1]?.close}`);
        await this._enrichWithOiSpotPerpFlow(symbol, candles);
        return { candles, source: 'MEXC_FUTURES_LIVE' };
      }
      this._saveDiagnostic(symbol, 'MEXC_FUTURES', 'EMPTY', JSON.stringify(json).slice(0, 200));
    } catch (err) {
      this._saveDiagnostic(symbol, 'MEXC_FUTURES', 'ERROR', `${err.message} (${err.cause?.code || err.cause?.message || 'no-cause'})`);
    }

    // 2. Try MEXC V3 API (includes exact Taker Buy Volume!)
    try {
      const v3Url = `https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(
        cleanSymbol
      )}&interval=5m&limit=${Math.min(1000, totalBars)}`;
      const rows = await this._fetchJsonWithTimeout(v3Url, 5000);
      if (Array.isArray(rows) && rows.length > 0) {
        const candles = rows.slice(-totalBars).map((r) => ({
          timestamp: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
          takerBuyVolume: Number(r[9]),
        }));
        this._saveDiagnostic(symbol, 'MEXC_V3', 'OK', `Loaded ${candles.length} bars, last=${candles[candles.length - 1]?.close}`);
        await this._enrichWithOiSpotPerpFlow(symbol, candles);
        return { candles, source: 'MEXC_LIVE_V3' };
      }
    } catch (err) {
      this._saveDiagnostic(symbol, 'MEXC_V3', 'ERROR', `${err.message} (${err.cause?.code || err.cause?.message || 'no-cause'})`);
    }

    // 3. Try Bitget USDT-M Perpetual Futures (Live 5m Perpetual Klines)
    try {
      const bgUrl = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(
        cleanSymbol
      )}&productType=USDT-FUTURES&granularity=5m&limit=${Math.min(500, totalBars)}`;
      const bgJson = await this._fetchJsonWithTimeout(bgUrl, 5000);
      if (bgJson?.code === '00000' && Array.isArray(bgJson.data) && bgJson.data.length > 0) {
        const sorted = bgJson.data.slice().sort((a, b) => Number(a[0]) - Number(b[0]));
        const candles = sorted.slice(-totalBars).map((r) => ({
          timestamp: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        }));
        this._saveDiagnostic(symbol, 'BITGET_PERP', 'OK', `Loaded ${candles.length} bars, last=${candles[candles.length - 1]?.close}`);
        await this._enrichWithOiSpotPerpFlow(symbol, candles);
        return { candles, source: 'LIVE_PERP_FEED (Bitget)' };
      }
    } catch (err) {
      this._saveDiagnostic(symbol, 'BITGET_PERP', 'ERROR', `${err.message} (${err.cause?.code || err.cause?.message || 'no-cause'})`);
    }

    // 4. Try Gate.io USDT-M Perpetual Futures
    try {
      const gateUrl = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(
        symbol
      )}&interval=5m&limit=${Math.min(500, totalBars)}`;
      const gateRows = await this._fetchJsonWithTimeout(gateUrl, 5000);
      if (Array.isArray(gateRows) && gateRows.length > 0) {
        const candles = gateRows.slice(-totalBars).map((r) => ({
          timestamp: Number(r.t) * 1000,
          open: Number(r.o),
          high: Number(r.h),
          low: Number(r.l),
          close: Number(r.c),
          volume: Number(r.v),
        }));
        this._saveDiagnostic(symbol, 'GATE_PERP', 'OK', `Loaded ${candles.length} bars, last=${candles[candles.length - 1]?.close}`);
        await this._enrichWithOiSpotPerpFlow(symbol, candles);
        return { candles, source: 'LIVE_PERP_FEED (Gate)' };
      }
    } catch (err) {
      this._saveDiagnostic(symbol, 'GATE_PERP', 'ERROR', `${err.message} (${err.cause?.code || err.cause?.message || 'no-cause'})`);
    }

    // 5. Try Bybit USDT Linear Perpetual
    try {
      const bybitUrl = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(
        cleanSymbol
      )}&interval=5&limit=${Math.min(500, totalBars)}`;
      const bybitJson = await this._fetchJsonWithTimeout(bybitUrl, 5000);
      if (bybitJson?.retCode === 0 && Array.isArray(bybitJson.result?.list) && bybitJson.result.list.length > 0) {
        const sorted = bybitJson.result.list.slice().sort((a, b) => Number(a[0]) - Number(b[0]));
        const candles = sorted.slice(-totalBars).map((r) => ({
          timestamp: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        }));
        this._saveDiagnostic(symbol, 'BYBIT_PERP', 'OK', `Loaded ${candles.length} bars, last=${candles[candles.length - 1]?.close}`);
        await this._enrichWithOiSpotPerpFlow(symbol, candles);
        return { candles, source: 'LIVE_PERP_FEED (Bybit)' };
      }
    } catch (err) {
      this._saveDiagnostic(symbol, 'BYBIT_PERP', 'ERROR', `${err.message} (${err.cause?.code || err.cause?.message || 'no-cause'})`);
    }

    // 6. Try CryptoCompare 5m Live Aggregate
    try {
      const ccUrl = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${encodeURIComponent(
        baseCoin
      )}&tsym=USDT&limit=${Math.min(400, totalBars)}&aggregate=5`;
      const ccJson = await this._fetchJsonWithTimeout(ccUrl, 5000);
      const list = ccJson?.Data?.Data;
      if (Array.isArray(list) && list.length > 0) {
        const candles = list.map((r) => ({
          timestamp: Number(r.time) * 1000,
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volumefrom || r.volumeto || 1000),
        }));
        this._saveDiagnostic(symbol, 'CRYPTOCOMPARE', 'OK', `Loaded ${candles.length} bars, last=${candles[candles.length - 1]?.close}`);
        await this._enrichWithOiSpotPerpFlow(symbol, candles);
        return { candles, source: 'LIVE_MARKET_FEED (CC)' };
      }
    } catch (err) {
      this._saveDiagnostic(symbol, 'CRYPTOCOMPARE', 'ERROR', `${err.message} (${err.cause?.code || err.cause?.message || 'no-cause'})`);
    }

    throw new Error('All live market endpoints failed');
  }

  async fetchFromMexcFutures(symbol = 'BTC_USDT', interval = 'Min5', totalBars = 500) {
    const res = await this.fetchLiveCandles(symbol, interval, totalBars);
    return res.candles;
  }

  async loadOrFetch({
    symbol = 'BTC_USDT',
    interval = 'Min5',
    bars = 1000,
    forceRefresh = false,
  } = {}) {
    const cacheFile = path.join(DATA_DIR, `${symbol}_${interval}_real.json`);

    try {
      const live = await this.fetchLiveCandles(symbol, interval, bars);
      if (live && live.candles.length >= 50) {
        const payload = {
          symbol,
          interval,
          source: live.source,
          fetchedAt: new Date().toISOString(),
          candles: live.candles,
        };
        fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2));
        return payload;
      }
    } catch {
      // Fallback to cache or simulation
    }

    if (!forceRefresh && fs.existsSync(cacheFile)) {
      try {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      } catch {
        // Ignore
      }
    }

    const generatedCandles = this.generateMicrostructureDataset({ symbol, bars });
    return {
      symbol,
      interval,
      source: 'MICROSTRUCTURE_SIMULATION_MODEL',
      fetchedAt: new Date().toISOString(),
      candles: generatedCandles,
    };
  }

  async _fetchJsonWithTimeout(url, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Enriches 5m candles in parallel with:
   * 1. Real 5m Open Interest (OI) + 5m Long/Short Liquidations + Perp Taker Buy/Sell Ratio (Gate.io contract_stats & Binance fapi)
   * 2. Real 5m Spot Taker Buy/Sell Volume for true Spot CVD (Binance Vision Spot API & Gate.io Spot API)
   */
  async _enrichWithOiSpotPerpFlow(symbol, candles) {
    if (!Array.isArray(candles) || candles.length === 0) return candles;
    const baseCoin = symbol.split(/[_-]/)[0].toUpperCase();
    const usdtSymbol = `${baseCoin}_USDT`;
    const cleanSymbol = `${baseCoin}USDT`;
    const bucket5m = (ts) => Math.floor(Number(ts) / 300000) * 300000;

    const gateStatsUrl = `https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(
      usdtSymbol
    )}&interval=5m&limit=100`;
    const binanceSpotUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(
      cleanSymbol
    )}&interval=5m&limit=120`;
    const gateSpotUrl = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(
      usdtSymbol
    )}&interval=5m&limit=120`;

    const [hlCtxRes, gateStatsRes, binanceSpotRes, gateSpotRes] = await Promise.allSettled([
      this.getHyperliquidAssetCtx(symbol),
      this._fetchJsonWithTimeout(gateStatsUrl, 3200),
      this._fetchJsonWithTimeout(binanceSpotUrl, 3200),
      this._fetchJsonWithTimeout(gateSpotUrl, 3200),
    ]);
    const hlCtx = hlCtxRes.status === 'fulfilled' ? hlCtxRes.value : null;

    const oiByTs = new Map();
    const perpRatioByTs = new Map();
    const liqByTs = new Map();

    if (gateStatsRes.status === 'fulfilled' && Array.isArray(gateStatsRes.value)) {
      for (const row of gateStatsRes.value) {
        const ts = bucket5m(Number(row.time) * 1000);
        const oiUsd = Number(row.open_interest_usd || row.open_interest || 0);
        if (oiUsd > 0) oiByTs.set(ts, oiUsd);

        const lSize = Number(row.long_taker_size || 0);
        const sSize = Number(row.short_taker_size || 0);
        if (lSize + sSize > 0) {
          perpRatioByTs.set(ts, lSize / (lSize + sSize));
        }
        liqByTs.set(ts, {
          longLiqUsd: Number(row.long_liq_usd || 0),
          shortLiqUsd: Number(row.short_liq_usd || 0),
          fundingRate: Number(row.last_funding_rate || 0),
        });
      }
    }

    const spotByTs = new Map();
    if (binanceSpotRes.status === 'fulfilled' && Array.isArray(binanceSpotRes.value)) {
      for (const r of binanceSpotRes.value) {
        const ts = bucket5m(Number(r[0]));
        const spotVol = Number(r[5] || 0);
        const spotBuyVol = Number(r[9] || 0);
        if (spotVol > 0) {
          spotByTs.set(ts, {
            spotVolume: spotVol,
            spotBuyRatio: Math.max(0.05, Math.min(0.95, spotBuyVol / spotVol)),
            exactTaker: true,
          });
        }
      }
    } else if (gateSpotRes.status === 'fulfilled' && Array.isArray(gateSpotRes.value)) {
      for (const r of gateSpotRes.value) {
        const ts = bucket5m(Number(r[0]) * 1000);
        const close = Number(r[2]);
        const high = Number(r[3]);
        const low = Number(r[4]);
        const open = Number(r[5]);
        const spotVol = Number(r[6] || r[1] || 0);
        const rng = Math.max(high - low, 1e-8);
        const closePos = (close - low) / rng;
        const bodyBias = close >= open ? 0.56 : 0.44;
        const estRatio = Math.max(0.15, Math.min(0.85, 0.35 + 0.30 * closePos + (bodyBias - 0.5) * 0.5));
        if (spotVol > 0) {
          spotByTs.set(ts, {
            spotVolume: spotVol,
            spotBuyRatio: estRatio,
            exactTaker: false,
          });
        }
      }
    }

    let lastKnownOi = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const ts = bucket5m(c.timestamp);

      // 1. Attach Perp Taker Buy Ratio if not already provided
      if (typeof c.takerBuyVolume !== 'number' && perpRatioByTs.has(ts)) {
        const ratio = perpRatioByTs.get(ts);
        c.takerBuyVolume = c.volume * ratio;
        c.hasRealPerpTaker = true;
      }

      // 2. Attach Open Interest & Liquidations
      const rawOi = oiByTs.get(ts) ?? oiByTs.get(ts - 300000) ?? lastKnownOi;
      if (rawOi > 0) lastKnownOi = rawOi;
      c.openInterestUsd = rawOi || 0;

      const prevOi = i > 0 ? candles[i - 1].openInterestUsd || rawOi : rawOi;
      const prev3Oi = i >= 3 ? candles[i - 3].openInterestUsd || prevOi : prevOi;
      const prev12Oi = i >= 12 ? candles[i - 12].openInterestUsd || prev3Oi : (i >= 4 ? candles[i - 4].openInterestUsd || prev3Oi : prev3Oi);
      c.oiChangePct = prevOi > 0 && rawOi > 0 ? ((rawOi - prevOi) / prevOi) * 100 : 0;
      c.oiChange3BarPct = prev3Oi > 0 && rawOi > 0 ? ((rawOi - prev3Oi) / prev3Oi) * 100 : 0;
      c.oiChange4BarPct = prev12Oi > 0 && rawOi > 0 ? ((rawOi - prev12Oi) / prev12Oi) * 100 : 0; // 1-Hour Open Interest change
      c.oiChange12BarPct = c.oiChange4BarPct;

      const liq = liqByTs.get(ts) || { longLiqUsd: 0, shortLiqUsd: 0, fundingRate: 0 };
      c.longLiqUsd = liq.longLiqUsd;
      c.shortLiqUsd = liq.shortLiqUsd;
      c.fundingRate = liq.fundingRate;

      // 3. Attach Spot Volume & Spot Buy Ratio
      const spotInfo = spotByTs.get(ts);
      if (spotInfo) {
        c.spotVolume = spotInfo.spotVolume;
        c.spotBuyRatio = spotInfo.spotBuyRatio;
        c.hasRealSpotFlow = true;
      }
    }

    // 4. Attach Hyperliquid live Mark Price, Open Interest USD & Funding Rate to latest bar
    if (hlCtx && candles.length > 0) {
      const latest = candles[candles.length - 1];
      if (!latest.openInterestUsd && hlCtx.openInterestUsd > 0) {
        latest.openInterestUsd = hlCtx.openInterestUsd;
      }
      if (typeof hlCtx.funding === 'number' && hlCtx.funding !== 0) {
        latest.fundingRate = hlCtx.funding;
      }
      latest.hlOpenInterestUsd = hlCtx.openInterestUsd;
      latest.hlMarkPx = hlCtx.markPx;
    }

    return candles;
  }

  generateMicrostructureDataset({ symbol = 'BTC_USDT', bars = 2000, seed = 42 } = {}) {
    let state = seed + symbol.split('').reduce((acc, ch) => acc + ch.charCodeAt(0) * 31, 0);
    const rand = () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const randNorm = () => {
      const u1 = Math.max(1e-7, rand());
      const u2 = rand();
      return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    };

    const startPrice = symbol.startsWith('BTC')
      ? 76000
      : symbol.startsWith('ETH')
      ? 2230
      : symbol.startsWith('SOL')
      ? 90
      : symbol.startsWith('SUI')
      ? 0.86
      : 10;

    const decimals = startPrice < 2 ? 4 : 2;
    const baseVolatilityPct = symbol.startsWith('BTC') ? 0.0032 : 0.0048;
    const baseVolume = symbol.startsWith('BTC') ? 1250 : 8500;

    const candles = [];
    const intervalMs = 5 * 60 * 1000;
    const startTimestamp = Date.UTC(2026, 2, 1, 0, 0, 0);

    let price = startPrice;
    let i = 0;

    while (i < bars) {
      const unitMove = price * baseVolatilityPct;
      const open = price;
      const change = randNorm() * unitMove * 0.55;
      const close = Math.max(startPrice * 0.3, open + change);
      const high = Math.max(open, close) + Math.abs(randNorm()) * unitMove * 0.45;
      const low = Math.min(open, close) - Math.abs(randNorm()) * unitMove * 0.45;
      const volume = baseVolume * (0.65 + rand() * 0.75);
      candles.push({
        timestamp: startTimestamp + i * intervalMs,
        open: Number(open.toFixed(decimals)),
        high: Number(Math.max(open, close, high).toFixed(decimals)),
        low: Number(Math.min(open, close, low).toFixed(decimals)),
        close: Number(close.toFixed(decimals)),
        volume: Math.round(volume),
        takerBuyVolume: Math.round(volume * (close >= open ? 0.56 : 0.44)),
      });
      price = close;
      i++;
    }
    return candles;
  }
}
