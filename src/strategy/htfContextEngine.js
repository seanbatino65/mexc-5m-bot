/**
 * Higher-Timeframe (HTF) Context Engine — 1H / 4H confluence layer for the 15m CLC strategy.
 * Author: Claude (HTF & Risk Strategist co-agent)
 *
 * Adds four HTF confluence pillars on top of the 15m Order Block + Order Flow pipeline:
 *   1. 4H BIAS FILTER      — 4H market structure (BOS/CHoCH) must agree with the 15m OB direction.
 *                            Counter-trend allowed only at a 4H POI + fresh 1H CHoCH (configurable).
 *   2. HTF POI NESTING     — 15m OB sitting inside an active 1H / 4H Order Block or FVG (score boost).
 *   3. PREMIUM / DISCOUNT  — Longs only below 4H dealing-range equilibrium, shorts only above.
 *   4. HTF LIQUIDITY       — PDH/PDL, PWH/PWL, Asia session range, 1H equal highs/lows:
 *                            sweep-before-entry bonus, TP1 obstacle check, structural TP2 targets.
 *
 * NO LOOKAHEAD: at 15m bar `i` (evaluated at its close) only HTF bars whose closeTime <= bar i close
 * are used. Zone touches / invalidations are recomputed "as of" that HTF bar.
 *
 * Usage:
 *   const htf = new HTFContextEngine().build(candles15m, { h1Candles, h4Candles, nowMs });
 *   const ctx = htf.evaluate({ index, ob });                       // filter + htfScore (0..30)
 *   const path = htf.checkPath({ index, side, entryPrice, tp1Price });
 *   const tgt = htf.suggestTarget({ index, side, entryPrice, riskPerUnit });
 */

import { OrderBlockDetector } from './orderBlockDetector.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const WEEK_OFFSET = 4 * DAY; // Unix epoch is a Thursday -> shift so weeks start Monday 00:00 UTC
const ASIA_SESSION_MS = 8 * HOUR; // 00:00 - 08:00 UTC

/** Median spacing between consecutive candle timestamps (ms). */
export function detectIntervalMs(candles) {
  const diffs = [];
  for (let i = 1; i < Math.min(candles.length, 200); i++) {
    const d = candles[i].timestamp - candles[i - 1].timestamp;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 15 * MIN;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/**
 * Resample lower-timeframe candles into UTC-aligned higher-timeframe candles.
 * Each output bar has { timestamp (open), closeTime, complete, bars }.
 */
export function resampleCandles(candles, tfMs, { ltfMs = detectIntervalMs(candles), offsetMs = 0, dropPartialFirst = true } = {}) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bucket = Math.floor((c.timestamp - offsetMs) / tfMs) * tfMs + offsetMs;
    if (!cur || cur.timestamp !== bucket) {
      if (cur) out.push(cur);
      cur = {
        timestamp: bucket,
        closeTime: bucket + tfMs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
        bars: 1,
      };
      if (c.takerBuyVolume != null) cur.takerBuyVolume = c.takerBuyVolume;
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
      cur.bars += 1;
      if (c.takerBuyVolume != null) cur.takerBuyVolume = (cur.takerBuyVolume || 0) + c.takerBuyVolume;
    }
  }
  if (cur) out.push(cur);

  const expectedBars = Math.round(tfMs / ltfMs);
  if (dropPartialFirst && out.length && out[0].bars < expectedBars) out.shift();

  const lastAvailable = candles.length ? candles[candles.length - 1].timestamp + ltfMs : 0;
  for (const bar of out) bar.complete = lastAvailable >= bar.closeTime;
  return out;
}

const DEFAULT_CONFIG = {
  h4Detector: {
    swingLookback: 3,
    minDisplacementAtr: 1.0,
    minFvgAtr: 0.15,
    maxZoneTouches: 3,
    maxZoneAgeBars: 120, // 20 days of 4H bars
    minBarsBeforeRetest: 2,
  },
  h1Detector: {
    swingLookback: 3,
    minDisplacementAtr: 1.05,
    minFvgAtr: 0.2,
    maxZoneTouches: 3,
    maxZoneAgeBars: 168, // 7 days of 1H bars
    minBarsBeforeRetest: 3,
  },
  minHtfBars: 10, // HTF bars required before a timeframe is considered "ready"

  // Filters
  biasFilter: true, // Block 15m OBs against 4H structure
  allowCounterTrendAtHtfPoi: true, // ...unless nested in a 4H POI AND a fresh 1H CHoCH confirms
  structureLookbackH1: 8, // 1H bars to look back for CHoCH/BOS confirmation
  premiumDiscountFilter: true, // Longs only in discount, shorts only in premium of 4H range
  blockTp1Obstacles: true, // checkPath() returns clear=false if HTF liquidity/zone sits before TP1
  obstacleLevels: ['PDH', 'PDL', 'PWH', 'PWL'], // Which liquidity levels count as TP1 obstacles
  obstacleZoneTfs: ['H4'], // Opposing HTF zones that count as TP1 obstacles

  // Scoring
  deepZonePct: 0.3, // <=30% of range for longs (>=70% for shorts) = deep discount/premium
  nestMinOverlapPct: 0.5, // 15m OB must overlap HTF zone by >=50% of its height (or midpoint inside)
  sweepLookbackBars: 16, // 15m bars (4h) to look back for a liquidity sweep
  eqTolAtr: 0.1, // Equal highs/lows tolerance as fraction of 1H ATR
  eqSwingsLookback: 10, // Recent 1H swings checked for equal highs/lows
  maxHtfScore: 30,
  weights: {
    nested4h: 18,
    nested1h: 12,
    untestedPoi: 8,
    deepZone: 6,
    sweep: 10,
    chochH1: 6,
    bosH1: 3,
  },
};

const LEVEL_PRIORITY = { PWH: 5, PWL: 5, PDH: 4, PDL: 4, EQH: 3, EQL: 3, ASIA_HIGH: 2, ASIA_LOW: 2 };

export class HTFContextEngine {
  constructor(config = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      h4Detector: { ...DEFAULT_CONFIG.h4Detector, ...(config.h4Detector || {}) },
      h1Detector: { ...DEFAULT_CONFIG.h1Detector, ...(config.h1Detector || {}) },
      weights: { ...DEFAULT_CONFIG.weights, ...(config.weights || {}) },
    };
    this.warnings = [];
  }

  /**
   * @param {Array<Object>} ltfCandles 15m candles (raw or enriched) — the SAME array whose indices you pass to evaluate().
   * @param {Object} [opts]
   * @param {Array<Object>} [opts.h1Candles] Optional native 1H candles (more history). Spacing is validated.
   * @param {Array<Object>} [opts.h4Candles] Optional native 4H candles (more history). Spacing is validated.
   * @param {number} [opts.nowMs] Live mode: wall-clock time, so a still-forming HTF bar is never used.
   */
  build(ltfCandles, { h1Candles = null, h4Candles = null, nowMs = null } = {}) {
    if (!Array.isArray(ltfCandles) || ltfCandles.length < 2) throw new Error('HTFContextEngine.build: need 15m candles');
    this.warnings = [];
    this.ltf = ltfCandles;
    this.ltfMs = detectIntervalMs(ltfCandles);
    this.ltfTimes = ltfCandles.map((c) => c.timestamp);

    let lastAvailable = ltfCandles[ltfCandles.length - 1].timestamp + this.ltfMs;
    if (nowMs != null) lastAvailable = Math.min(lastAvailable, nowMs);
    this.lastAvailable = lastAvailable;

    this.h1 = this._buildSeries('H1', HOUR, h1Candles, this.config.h1Detector);
    this.h4 = this._buildSeries('H4', 4 * HOUR, h4Candles, this.config.h4Detector);
    this.daily = resampleCandles(ltfCandles, DAY, { ltfMs: this.ltfMs });
    this.weekly = resampleCandles(ltfCandles, WEEK, { ltfMs: this.ltfMs, offsetMs: WEEK_OFFSET });

    if (this.h4.candles.length < this.config.minHtfBars * 3) {
      this.warnings.push(
        `H4: only ${this.h4.candles.length} closed bars (${this.h4.source}). Supply native 4H candles or >=1500 15m bars for reliable 4H structure.`
      );
    }
    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Evaluate HTF context for a 15m Order Block tapped at ltf bar `index`.
   * @returns {{allowed:boolean, reason:string|null, htfScore:number, components:Object, bias:Object,
   *            premiumDiscount:Object|null, nested:Object|null, sweep:Object|null, h1Structure:Object|null,
   *            counterTrend:boolean, dataQuality:Object}}
   */
  evaluate({ index, ob }) {
    const cfg = this.config;
    const w = cfg.weights;
    const dir = ob.type === 'BULLISH' ? 1 : -1;
    const price = this.ltf[index].close;

    const k4 = this._htfIndexAt(this.h4, index);
    const k1 = this._htfIndexAt(this.h1, index);
    const h4Ready = k4 >= cfg.minHtfBars;
    const h1Ready = k1 >= cfg.minHtfBars;

    const bias = {
      h4: h4Ready ? this.h4.candles[k4].trendBias : 0,
      h1: h1Ready ? this.h1.candles[k1].trendBias : 0,
    };

    // --- HTF POI nesting (4H first, then 1H)
    let nested = null;
    if (h4Ready) nested = this._findNestingZone(this.h4, k4, ob);
    if (!nested && h1Ready) nested = this._findNestingZone(this.h1, k1, ob);

    // --- 1H structure confirmation in trade direction
    const h1Structure = h1Ready ? this._recentStructure(this.h1, k1, dir, cfg.structureLookbackH1) : null;

    // --- 4H dealing range premium / discount
    const range = h4Ready ? this._dealingRange(this.h4, k4) : null;
    let premiumDiscount = null;
    if (range) {
      const pct = (price - range.low) / (range.high - range.low);
      premiumDiscount = {
        rangeHigh: range.high,
        rangeLow: range.low,
        equilibrium: (range.high + range.low) / 2,
        pct: Number(pct.toFixed(3)),
        zone: pct > 0.5 ? 'PREMIUM' : 'DISCOUNT',
      };
    }

    // --- Liquidity sweep before entry
    const sweep = this._detectSweep(index, dir);

    // --- Filters
    let allowed = true;
    let reason = null;
    let counterTrend = false;

    if (cfg.biasFilter && h4Ready && bias.h4 === -dir) {
      const counterOk = cfg.allowCounterTrendAtHtfPoi && nested?.tf === 'H4' && h1Structure?.type?.startsWith('CHoCH');
      if (counterOk) counterTrend = true;
      else {
        allowed = false;
        reason = 'HTF_4H_COUNTER_BIAS';
      }
    }
    if (allowed && cfg.premiumDiscountFilter && premiumDiscount) {
      if (dir === 1 && premiumDiscount.pct > 0.5) {
        allowed = false;
        reason = 'HTF_PREMIUM_NO_LONGS';
      } else if (dir === -1 && premiumDiscount.pct < 0.5) {
        allowed = false;
        reason = 'HTF_DISCOUNT_NO_SHORTS';
      }
    }

    // --- Score
    const components = {};
    if (nested) {
      components[nested.tf === 'H4' ? 'nested4h' : 'nested1h'] = nested.tf === 'H4' ? w.nested4h : w.nested1h;
      if (nested.touches === 0) components.untestedPoi = w.untestedPoi;
    }
    if (premiumDiscount) {
      const deep = dir === 1 ? premiumDiscount.pct <= cfg.deepZonePct : premiumDiscount.pct >= 1 - cfg.deepZonePct;
      if (deep) components.deepZone = w.deepZone;
    }
    if (sweep) components.sweep = w.sweep;
    if (h1Structure) components[h1Structure.type.startsWith('CHoCH') ? 'chochH1' : 'bosH1'] = h1Structure.type.startsWith('CHoCH') ? w.chochH1 : w.bosH1;

    const rawScore = Object.values(components).reduce((a, b) => a + b, 0);
    const htfScore = Math.min(cfg.maxHtfScore, rawScore);

    return {
      allowed,
      reason,
      htfScore,
      rawScore,
      components,
      bias,
      premiumDiscount,
      nested,
      sweep,
      h1Structure,
      counterTrend,
      dataQuality: { h4Ready, h1Ready, h4Bars: k4 + 1, h1Bars: k1 + 1, h4Source: this.h4.source, h1Source: this.h1.source },
    };
  }

  /** Check for HTF liquidity levels / opposing HTF zones between entry and TP1. */
  checkPath({ index, side, entryPrice, tp1Price }) {
    const cfg = this.config;
    const isLong = side === 'LONG';
    const lo = Math.min(entryPrice, tp1Price);
    const hi = Math.max(entryPrice, tp1Price);
    const obstacles = [];

    for (const lvl of this.liquidityLevels(index)) {
      if (!cfg.obstacleLevels.includes(lvl.name)) continue;
      const relevant = isLong ? lvl.side === 'BUY_SIDE' : lvl.side === 'SELL_SIDE';
      if (relevant && lvl.price > lo && lvl.price < hi) obstacles.push({ kind: 'LEVEL', name: lvl.name, price: lvl.price });
    }

    const opposingType = isLong ? 'BEARISH' : 'BULLISH';
    for (const tf of cfg.obstacleZoneTfs) {
      const series = tf === 'H4' ? this.h4 : this.h1;
      const k = this._htfIndexAt(series, index);
      if (k < cfg.minHtfBars) continue;
      for (const z of this._activeZones(series, k, opposingType)) {
        const nearEdge = isLong ? z.low : z.high;
        if (nearEdge > lo && nearEdge < hi) obstacles.push({ kind: `${tf}_${z.kind}`, id: z.id, price: nearEdge });
      }
    }

    return { clear: !cfg.blockTp1Obstacles || obstacles.length === 0, obstacles };
  }

  /** Nearest HTF liquidity level / opposing HTF zone giving R:R in [minRR, maxRR]. */
  suggestTarget({ index, side, entryPrice, riskPerUnit, minRR = 2.0, maxRR = 4.5 }) {
    const isLong = side === 'LONG';
    const candidates = [];

    for (const lvl of this.liquidityLevels(index)) {
      if (isLong ? lvl.side === 'BUY_SIDE' && lvl.price > entryPrice : lvl.side === 'SELL_SIDE' && lvl.price < entryPrice) {
        candidates.push({ source: lvl.name, price: lvl.price });
      }
    }
    const opposingType = isLong ? 'BEARISH' : 'BULLISH';
    for (const series of [this.h1, this.h4]) {
      const k = this._htfIndexAt(series, index);
      if (k < this.config.minHtfBars) continue;
      for (const z of this._activeZones(series, k, opposingType)) {
        const edge = isLong ? z.low : z.high;
        if (isLong ? edge > entryPrice : edge < entryPrice) candidates.push({ source: `${series.name}_${z.kind}:${z.id}`, price: edge });
      }
    }

    const scored = candidates
      .map((c) => ({ ...c, rr: Math.abs(c.price - entryPrice) / riskPerUnit }))
      .filter((c) => c.rr >= minRR && c.rr <= maxRR)
      .sort((a, b) => a.rr - b.rr);

    return scored[0] || null;
  }

  /** HTF liquidity levels known at the close of ltf bar `index`. */
  liquidityLevels(index) {
    const avail = this.ltf[index].timestamp + this.ltfMs;
    const levels = [];

    const pd = this._lastClosed(this.daily, avail);
    if (pd) levels.push({ name: 'PDH', price: pd.high, side: 'BUY_SIDE' }, { name: 'PDL', price: pd.low, side: 'SELL_SIDE' });

    const pw = this._lastClosed(this.weekly, avail);
    if (pw) levels.push({ name: 'PWH', price: pw.high, side: 'BUY_SIDE' }, { name: 'PWL', price: pw.low, side: 'SELL_SIDE' });

    const asia = this._asiaRange(index);
    if (asia) levels.push({ name: 'ASIA_HIGH', price: asia.high, side: 'BUY_SIDE' }, { name: 'ASIA_LOW', price: asia.low, side: 'SELL_SIDE' });

    const k1 = this._htfIndexAt(this.h1, index);
    if (k1 >= this.config.minHtfBars) levels.push(...this._equalLevels(this.h1, k1, this.ltf[index].close));

    return levels;
  }

  /** Compact HTF snapshot for the agent bus / UI. */
  summaryAt(index = this.ltf.length - 1) {
    const k4 = this._htfIndexAt(this.h4, index);
    const k1 = this._htfIndexAt(this.h1, index);
    const price = this.ltf[index].close;
    const range = k4 >= this.config.minHtfBars ? this._dealingRange(this.h4, k4) : null;
    const zones = (series, k) =>
      k >= this.config.minHtfBars
        ? [...this._activeZones(series, k, 'BULLISH'), ...this._activeZones(series, k, 'BEARISH')].map((z) => ({
            tf: series.name,
            kind: z.kind,
            type: z.type,
            id: z.id,
            low: z.low,
            high: z.high,
            touches: z.touches,
            distancePct: Number(((Math.abs((z.low + z.high) / 2 - price) / price) * 100).toFixed(2)),
          }))
        : [];
    return {
      price,
      bias4h: k4 >= this.config.minHtfBars ? this.h4.candles[k4].trendBias : 0,
      bias1h: k1 >= this.config.minHtfBars ? this.h1.candles[k1].trendBias : 0,
      dealingRange: range ? { ...range, pct: Number(((price - range.low) / (range.high - range.low)).toFixed(3)) } : null,
      liquidity: this.liquidityLevels(index),
      zones: [...zones(this.h4, k4), ...zones(this.h1, k1)].sort((a, b) => a.distancePct - b.distancePct).slice(0, 8),
      warnings: this.warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _buildSeries(name, tfMs, supplied, detCfg) {
    let bars = null;
    let source = 'RESAMPLED_15M';

    if (Array.isArray(supplied) && supplied.length) {
      const spacing = detectIntervalMs(supplied);
      if (spacing === tfMs) {
        bars = supplied.map((c) => ({ ...c, closeTime: c.timestamp + tfMs })).filter((c) => c.closeTime <= this.lastAvailable);
        source = 'NATIVE';
      } else {
        // Guards against fetchers that silently fall back to 15m data when asked for 1H/4H.
        this.warnings.push(`${name}: supplied candle spacing ${spacing / MIN}m != ${tfMs / MIN}m — ignored, using resampled 15m.`);
      }
    }
    if (!bars) {
      bars = resampleCandles(this.ltf, tfMs, { ltfMs: this.ltfMs }).filter((c) => c.closeTime <= this.lastAvailable);
    }

    const detector = new OrderBlockDetector(detCfg);
    const { enrichedCandles, allOrderBlocks, structureEvents } = detector.analyze(bars);

    return {
      name,
      tfMs,
      source,
      detCfg: detector.config,
      candles: enrichedCandles,
      closeTimes: enrichedCandles.map((c) => c.closeTime ?? c.timestamp + tfMs),
      orderBlocks: allOrderBlocks,
      structureEvents,
      swings: this._findSwings(enrichedCandles, detector.config.swingLookback),
      fvgs: this._collectFvgs(enrichedCandles, detector.config.maxZoneAgeBars),
    };
  }

  /** Last HTF bar index that is fully closed at the close of ltf bar `ltfIndex` (-1 if none). */
  _htfIndexAt(series, ltfIndex) {
    const t = this.ltf[ltfIndex].timestamp + this.ltfMs;
    const arr = series.closeTimes;
    let lo = 0;
    let hi = arr.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  _findSwings(candles, L) {
    const highs = [];
    const lows = [];
    for (let p = L; p < candles.length - L; p++) {
      let isHigh = true;
      let isLow = true;
      for (let k = p - L; k <= p + L; k++) {
        if (k === p) continue;
        if (candles[k].high > candles[p].high) isHigh = false;
        if (candles[k].low < candles[p].low) isLow = false;
      }
      if (isHigh) highs.push({ index: p, price: candles[p].high, confirmIndex: p + L });
      if (isLow) lows.push({ index: p, price: candles[p].low, confirmIndex: p + L });
    }
    return { highs, lows };
  }

  _collectFvgs(candles, maxAge) {
    const fvgs = [];
    for (let i = 0; i < candles.length; i++) {
      const f = candles[i].fvg;
      if (!f) continue;
      const knownAt = i + 1; // FVG is confirmed when the 3rd candle closes
      let invalidatedAt = null;
      for (let j = knownAt + 1; j < candles.length; j++) {
        if (j - i > maxAge) {
          invalidatedAt = j;
          break;
        }
        if ((f.type === 'BULLISH' && candles[j].close < f.bottom) || (f.type === 'BEARISH' && candles[j].close > f.top)) {
          invalidatedAt = j;
          break;
        }
      }
      fvgs.push({ id: `FVG_${f.type === 'BULLISH' ? 'BULL' : 'BEAR'}_${i}`, type: f.type, top: f.top, bottom: f.bottom, index: i, knownAt, invalidatedAt });
    }
    return fvgs;
  }

  /** Active OBs + FVGs of `type` on `series` as of HTF bar k (touch counts recomputed causally). */
  _activeZones(series, k, type) {
    const { maxZoneAgeBars, maxZoneTouches } = series.detCfg;
    const zones = [];

    for (const ob of series.orderBlocks) {
      if (ob.type !== type || ob.createdAtIndex > k) continue;
      if (ob.invalidatedAtIndex !== null && ob.invalidatedAtIndex <= k) continue;
      if (k - ob.createdAtIndex > maxZoneAgeBars) continue;
      const touches = this._obTouchesUpTo(series, ob, k);
      if (touches > maxZoneTouches) continue;
      zones.push({ kind: 'OB', type, id: ob.id, low: ob.zoneLow, high: ob.zoneHigh, touches });
    }

    for (const f of series.fvgs) {
      if (f.type !== type || f.knownAt > k) continue;
      if (f.invalidatedAt !== null && f.invalidatedAt <= k) continue;
      let touches = 0;
      for (let j = f.knownAt + 1; j <= k; j++) {
        const c = series.candles[j];
        if (c.low <= f.top && c.high >= f.bottom) touches++;
      }
      zones.push({ kind: 'FVG', type, id: f.id, low: f.bottom, high: f.top, touches });
    }
    return zones;
  }

  /** Replicates OrderBlockDetector touch logic, but only up to HTF bar k. */
  _obTouchesUpTo(series, ob, k) {
    const minBars = series.detCfg.minBarsBeforeRetest;
    let hasLeft = false;
    let touches = 0;
    let last = -1;
    for (let i = ob.createdAtIndex; i <= k; i++) {
      const c = series.candles[i];
      if (ob.type === 'BULLISH') {
        if (c.low > ob.zoneHigh) hasLeft = true;
        else if (hasLeft && i - ob.createdAtIndex >= minBars && c.low <= ob.zoneHigh && c.high >= ob.zoneLow) {
          if (last === -1 || i - last >= 2) touches++;
          last = i;
        }
      } else {
        if (c.high < ob.zoneLow) hasLeft = true;
        else if (hasLeft && i - ob.createdAtIndex >= minBars && c.high >= ob.zoneLow && c.low <= ob.zoneHigh) {
          if (last === -1 || i - last >= 2) touches++;
          last = i;
        }
      }
    }
    return touches;
  }

  _findNestingZone(series, k, ob) {
    const obHeight = Math.max(ob.zoneHigh - ob.zoneLow, 1e-12);
    const mid = (ob.zoneHigh + ob.zoneLow) / 2;
    let best = null;
    for (const z of this._activeZones(series, k, ob.type)) {
      const overlap = Math.min(z.high, ob.zoneHigh) - Math.max(z.low, ob.zoneLow);
      const midInside = mid >= z.low && mid <= z.high;
      if (!(midInside || overlap >= this.config.nestMinOverlapPct * obHeight)) continue;
      // Prefer untested zones, then OB over FVG
      const rank = (z.touches === 0 ? 2 : 0) + (z.kind === 'OB' ? 1 : 0);
      if (!best || rank > best.rank) best = { ...z, tf: series.name, rank };
    }
    if (best) delete best.rank;
    return best;
  }

  _recentStructure(series, k, dir, lookback) {
    const wanted = dir === 1 ? ['CHoCH_BULL', 'BOS_BULL'] : ['CHoCH_BEAR', 'BOS_BEAR'];
    let found = null;
    for (const ev of series.structureEvents) {
      if (ev.index > k) break;
      if (ev.index > k - lookback && wanted.includes(ev.type)) {
        // Latest CHoCH wins; a BOS only replaces a previous BOS (never a CHoCH)
        if (!found || ev.type.startsWith('CHoCH') || !found.type.startsWith('CHoCH')) found = ev;
      }
    }
    return found ? { type: found.type, level: found.level, barsAgo: k - found.index } : null;
  }

  _dealingRange(series, k) {
    const lastConfirmed = (arr) => {
      let res = null;
      for (const s of arr) {
        if (s.confirmIndex > k) break;
        res = s;
      }
      return res;
    };
    const sh = lastConfirmed(series.swings.highs);
    const sl = lastConfirmed(series.swings.lows);
    if (!sh || !sl) return null;

    let high = sh.price;
    let low = sl.price;
    for (let i = sh.index + 1; i <= k; i++) high = Math.max(high, series.candles[i].high);
    for (let i = sl.index + 1; i <= k; i++) low = Math.min(low, series.candles[i].low);
    if (high <= low) return null;
    return { high, low };
  }

  _lastClosed(bars, avail) {
    let res = null;
    for (const b of bars) {
      if (b.closeTime > avail) break;
      res = b;
    }
    return res;
  }

  _asiaRange(index) {
    const t = this.ltf[index].timestamp;
    const avail = t + this.ltfMs;
    let start = Math.floor(t / DAY) * DAY;
    if (avail < start + ASIA_SESSION_MS) start -= DAY; // Today's Asia session not finished -> use yesterday's
    const end = start + ASIA_SESSION_MS;

    let i = this._ltfLowerBound(start);
    let high = -Infinity;
    let low = Infinity;
    let count = 0;
    for (; i < this.ltf.length && this.ltf[i].timestamp < end; i++) {
      high = Math.max(high, this.ltf[i].high);
      low = Math.min(low, this.ltf[i].low);
      count++;
    }
    const expected = ASIA_SESSION_MS / this.ltfMs;
    return count >= expected * 0.8 ? { high, low } : null;
  }

  /** Equal highs/lows from recent 1H swings. Broken pools (price already beyond them) are dropped. */
  _equalLevels(series, k, price) {
    const atr = series.candles[k].atr || 0;
    const tol = atr * this.config.eqTolAtr;
    const out = [];
    const scan = (swings, name, side, pick) => {
      const recent = swings.filter((s) => s.confirmIndex <= k).slice(-this.config.eqSwingsLookback);
      for (let a = 0; a < recent.length; a++) {
        for (let b = a + 1; b < recent.length; b++) {
          if (Math.abs(recent[a].price - recent[b].price) > tol) continue;
          const lvl = pick(recent[a].price, recent[b].price);
          if (side === 'BUY_SIDE' ? lvl <= price : lvl >= price) continue; // stale / broken pool
          if (!out.some((l) => l.name === name && Math.abs(l.price - lvl) <= tol)) out.push({ name, price: lvl, side });
        }
      }
    };
    scan(series.swings.highs, 'EQH', 'BUY_SIDE', Math.max);
    scan(series.swings.lows, 'EQL', 'SELL_SIDE', Math.min);
    return out;
  }

  /** Sell-side sweep (for longs) / buy-side sweep (for shorts) within the last N 15m bars, reclaimed by bar `index`. */
  _detectSweep(index, dir) {
    const start = Math.max(0, index - this.config.sweepLookbackBars);
    const close = this.ltf[index].close;
    let extreme = dir === 1 ? Infinity : -Infinity;
    for (let i = start; i <= index; i++) {
      extreme = dir === 1 ? Math.min(extreme, this.ltf[i].low) : Math.max(extreme, this.ltf[i].high);
    }
    const wantedSide = dir === 1 ? 'SELL_SIDE' : 'BUY_SIDE';
    let best = null;
    for (const lvl of this.liquidityLevels(index)) {
      if (lvl.side !== wantedSide) continue;
      const swept = dir === 1 ? extreme < lvl.price && close > lvl.price : extreme > lvl.price && close < lvl.price;
      if (swept && (!best || LEVEL_PRIORITY[lvl.name] > LEVEL_PRIORITY[best.name])) best = { name: lvl.name, price: lvl.price, extreme };
    }
    return best;
  }

  _ltfLowerBound(ts) {
    let lo = 0;
    let hi = this.ltfTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ltfTimes[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
