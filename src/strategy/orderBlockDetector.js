/**
 * 5m Order Block & Market Structure Detector (Context & Location — "C" & "L" of Carmine's CLC Rule)
 *
 * Strict Institutional Order Block Rules:
 * 1. Swing Pivot Structure (`BOS` / `CHoCH`) + Session VWAP + ATR(14).
 * 2. True Displacement Requirement:
 *    - Impulse candle body must be >= `minDisplacementAtr` (default 1.15x ATR)
 *    - Must either break a confirmed Swing High/Low (`BOS`/`CHoCH`) OR leave a clean Fair Value Gap (`fvgSize >= 0.20 * ATR`).
 *    - Price must actually LEAVE the Order Block zone (clear separation), filtering out sideways range chop.
 * 3. Retest Minimum Separation (`minBarsBeforeRetest: 2`):
 *    - A valid retest only occurs after price has traded completely outside the OB zone and then pulls back into it.
 */

export class OrderBlockDetector {
  constructor(config = {}) {
    this.config = {
      swingLookback: config.swingLookback ?? 4,               // 4 bars left/right = 40m structural swing pivot
      atrPeriod: config.atrPeriod ?? 14,
      volMaPeriod: config.volMaPeriod ?? 20,
      minDisplacementAtr: config.minDisplacementAtr ?? 1.15,  // Strong impulse body >= 1.15x ATR
      minFvgAtr: config.minFvgAtr ?? 0.20,                    // FVG gap size must be at least 0.20x ATR (no 1-tick noise gaps)
      requireFvgOrBos: config.requireFvgOrBos ?? true,
      minBarsBeforeRetest: config.minBarsBeforeRetest ?? 2,   // Price must leave the OB for >=2 bars before retesting
      maxZoneTouches: config.maxZoneTouches ?? 3,             // Max 3 distinct visits before OB is exhausted
      maxZoneAgeBars: config.maxZoneAgeBars ?? 288,          // 288 x 5m bars = 24 hours zone validity
      zonePaddingAtr: config.zonePaddingAtr ?? 0.05,
      ...config,
    };
  }

  analyze(candles) {
    const enriched = candles.map((c, idx) => ({
      ...c,
      index: idx,
      body: Math.abs(c.close - c.open),
      range: Math.max(c.high - c.low, 1e-9),
      isBullish: c.close >= c.open,
      isBearish: c.close < c.open,
      upperWick: c.high - Math.max(c.open, c.close),
      lowerWick: Math.min(c.open, c.close) - c.low,
      atr: 0,
      volSma: 0,
      vwap: c.close,
      trendBias: 0,
      fvg: null,
    }));

    this._computeIndicators(enriched);
    const { allOrderBlocks, structureEvents } = this._detectStructureAndOrderBlocks(enriched);

    return {
      enrichedCandles: enriched,
      allOrderBlocks,
      structureEvents,
    };
  }

  _computeIndicators(candles) {
    const { atrPeriod, volMaPeriod } = this.config;
    let trSum = 0;
    let volSum = 0;
    let currentDay = null;
    let cumTypVol = 0;
    let cumTypSqVol = 0;
    let cumVol = 0;
    let activeNakedPoc = null;
    let activeOrbHigh = null;
    let activeOrbLow = null;
    let activeDailyOpen = null;
    let activeDailyExpectedMove = 0.025;
    let prevDayHigh = null;
    let prevDayLow = null;
    let curDayHigh = -Infinity;
    let curDayLow = Infinity;
    let lowerWallTouchesToday = 0;
    let upperWallTouchesToday = 0;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = i > 0 ? candles[i - 1].close : c.open;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      );
      c.tr = tr;

      if (i < atrPeriod) {
        trSum += tr;
        c.atr = trSum / (i + 1);
      } else {
        c.atr = (candles[i - 1].atr * (atrPeriod - 1) + tr) / atrPeriod;
      }

      volSum += c.volume;
      if (i >= volMaPeriod) {
        volSum -= candles[i - volMaPeriod].volume;
        c.volSma = volSum / volMaPeriod;
      } else {
        c.volSma = volSum / (i + 1);
      }

      const dayKey = Math.floor(c.timestamp / (86400 * 1000));
      if (dayKey !== currentDay) {
        if (i > 0 && candles[i - 1].vpPoc > 0) {
          activeNakedPoc = candles[i - 1].vpPoc;
        }
        if (curDayHigh > -Infinity && curDayLow < Infinity) {
          prevDayHigh = curDayHigh;
          prevDayLow = curDayLow;
        }
        curDayHigh = c.high;
        curDayLow = c.low;
        lowerWallTouchesToday = 0;
        upperWallTouchesToday = 0;
        currentDay = dayKey;
        cumTypVol = 0;
        cumTypSqVol = 0;
        cumVol = 0;
        activeDailyOpen = c.open;

        // ATrain Trades (@ATrainTrades): Calculate Daily Expected Move (1.0 SD IV Wall) from prior 288 bars (24h realized vol on 5m)
        if (i >= 16) {
          const lookback = Math.min(288, i);
          let sumSqRet = 0;
          for (let k = i - lookback + 1; k <= i; k++) {
            const p0 = candles[k - 1].close;
            const p1 = candles[k].close;
            if (p0 > 0) {
              const r = (p1 - p0) / p0;
              sumSqRet += r * r;
            }
          }
          const barSigma = Math.sqrt(sumSqRet / lookback);
          const dailySigma = barSigma * Math.sqrt(288);
          activeDailyExpectedMove = Math.max(0.014, Math.min(0.075, dailySigma));
        } else {
          activeDailyExpectedMove = Math.max(0.015, Math.min(0.075, ((c.atr || c.tr) / c.open) * 4.2));
        }
      }
      const typicalPrice = (c.high + c.low + c.close) / 3;
      cumTypVol += typicalPrice * c.volume;
      cumTypSqVol += typicalPrice * typicalPrice * c.volume;
      cumVol += c.volume;
      c.vwap = cumVol > 0 ? cumTypVol / cumVol : c.close;

      // Orochi Trading: Session VWAP Standard Deviation Bands (±1.5 SD & ±2.0 SD)
      const vwapVariance = cumVol > 0 ? Math.max(0, cumTypSqVol / cumVol - c.vwap * c.vwap) : 0;
      c.vwapSd = Math.sqrt(vwapVariance);
      c.vwapUpper15 = c.vwap + 1.5 * c.vwapSd;
      c.vwapLower15 = c.vwap - 1.5 * c.vwapSd;
      c.vwapUpper20 = c.vwap + 2.0 * c.vwapSd;
      c.vwapLower20 = c.vwap - 2.0 * c.vwapSd;

      // Trader Neil & Orochi Volume Profile (Rolling 288-bar / 24h Session Profile: POC, VAH, VAL containing 70% volume)
      const vpWindow = candles.slice(Math.max(0, i - 287), i + 1);
      const vp = this._computeVolumeProfile(vpWindow, 24);
      c.vpPoc = vp.poc;
      c.vpVah = vp.vah;
      c.vpVal = vp.val;

      // Orochi Trading: Previous Session Naked POC (nPOC) Tracker
      c.nakedPoc = activeNakedPoc;
      c.tappedNakedPoc = false;
      if (activeNakedPoc !== null && c.low <= activeNakedPoc * 1.0015 && c.high >= activeNakedPoc * 0.9985) {
        c.tappedNakedPoc = true;
        if (c.low <= activeNakedPoc && c.high >= activeNakedPoc) {
          activeNakedPoc = null; // Mitigated after this bar
        }
      }

      // Orochi Trading: The 80% Value Area Rule (Outside VA -> Reclaims & Accepts Back Inside VA -> Targets Opposite VA Edge)
      const prevBar = i > 0 ? candles[i - 1] : null;
      c.orochi80PctLong =
        c.vpVal > 0 &&
        (c.low < c.vpVal || (prevBar && prevBar.low < c.vpVal)) &&
        c.close > c.vpVal &&
        c.close < c.vpPoc &&
        c.isBullish;
      c.orochi80PctShort =
        c.vpVah > 0 &&
        (c.high > c.vpVah || (prevBar && prevBar.high > c.vpVah)) &&
        c.close < c.vpVah &&
        c.close > c.vpPoc &&
        c.isBearish;

      // Orochi Trading: Auction Excess vs. Poor High / Poor Low (unfinished auction)
      c.poorLow = c.lowerWick / c.range < 0.08;
      c.poorHigh = c.upperWick / c.range < 0.08;

      // Trader Neil Liquidity Sweep (SFP) Detector:
      // Sweeps the lowest low or highest high of the prior 24 bars (2 hours) and closes back inside
      if (i >= 24) {
        let priorHigh = -Infinity;
        let priorLow = Infinity;
        for (let k = i - 24; k < i; k++) {
          if (candles[k].high > priorHigh) priorHigh = candles[k].high;
          if (candles[k].low < priorLow) priorLow = candles[k].low;
        }
        c.sweptLiquidityLow = c.low < priorLow && c.close > priorLow;
        c.sweptLiquidityHigh = c.high > priorHigh && c.close < priorHigh;
      } else {
        c.sweptLiquidityLow = false;
        c.sweptLiquidityHigh = false;
      }

      // Kenneth Baggett (@KennySB2015 / STS4x):
      // 1. 15-Minute Session Opening Range (ORB) at Asia (00:00 UTC), London (08:00 UTC), and NY (13:30 UTC)
      // Formed across the 3 opening 5m bars of each session (0m, 5m, 10m)
      const dt = new Date(c.timestamp);
      const hr = dt.getUTCHours();
      const mn = dt.getUTCMinutes();
      const isSessionOpenBar =
        (hr === 0 && mn === 0) || (hr === 8 && mn === 0) || (hr === 13 && mn === 30);
      const isSessionOrbBar =
        (hr === 0 && mn <= 10) || (hr === 8 && mn <= 10) || (hr === 13 && mn >= 30 && mn <= 40);

      if (isSessionOpenBar) {
        activeOrbHigh = c.high;
        activeOrbLow = c.low;
      } else if (isSessionOrbBar && activeOrbHigh !== null) {
        activeOrbHigh = Math.max(activeOrbHigh, c.high);
        activeOrbLow = Math.min(activeOrbLow, c.low);
      }
      c.kennyOrbHigh = activeOrbHigh;
      c.kennyOrbLow = activeOrbLow;
      c.kennyOrbSupport =
        activeOrbHigh !== null &&
        activeOrbLow !== null &&
        ((c.low <= activeOrbLow * 1.0015 && c.close > activeOrbLow) ||
          (c.low <= activeOrbHigh * 1.0015 && c.close > activeOrbHigh && prevBar && prevBar.close > activeOrbHigh));
      c.kennyOrbResistance =
        activeOrbHigh !== null &&
        activeOrbLow !== null &&
        ((c.high >= activeOrbHigh * 0.9985 && c.close < activeOrbHigh) ||
          (c.high >= activeOrbLow * 0.9985 && c.close < activeOrbLow && prevBar && prevBar.close < activeOrbLow));

      // 2. Kenneth Baggett Positive vs. Negative Gamma Regime ("Range & Fade" vs. "Trend & Extend")
      const prev2Bar = i >= 2 ? candles[i - 2] : null;
      const bullExpansion =
        c.vpVah > 0 &&
        c.close > c.vpVah &&
        prevBar &&
        prevBar.close > prevBar.vpVah &&
        (!prev2Bar || c.close > prev2Bar.close) &&
        c.close > c.vwapUpper15 &&
        c.tr >= c.atr * 1.15;
      const bearExpansion =
        c.vpVal > 0 &&
        c.close < c.vpVal &&
        prevBar &&
        prevBar.close < prevBar.vpVal &&
        (!prev2Bar || c.close < prev2Bar.close) &&
        c.close < c.vwapLower15 &&
        c.tr >= c.atr * 1.15;

      if (bullExpansion) {
        c.kennyRegime = 'NEGATIVE_GAMMA_BULL';
      } else if (bearExpansion) {
        c.kennyRegime = 'NEGATIVE_GAMMA_BEAR';
      } else {
        c.kennyRegime = 'POSITIVE_GAMMA_FADE';
      }

      // 3. Kenneth Baggett VWAP Chop Stand-Down Rule (5+ VWAP crosses in the last 18 bars / 90m)
      let vwapCrosses = 0;
      if (i >= 18) {
        for (let k = i - 17; k <= i; k++) {
          const b0 = candles[k - 1];
          const b1 = candles[k];
          const above0 = b0.close >= b0.vwap;
          const above1 = b1.close >= b1.vwap;
          if (above0 !== above1) vwapCrosses++;
        }
      }
      c.kennyVwapChop = vwapCrosses >= 5;

      // 4. ATrain Trades (@ATrainTrades): Daily IV Walls (±1.0 SD Primary IV Wall & ±1.5 SD Outer IV Wall)
      const dOpen = activeDailyOpen || c.open;
      const expMove = activeDailyExpectedMove || 0.025;
      c.dailyOpen = dOpen;
      c.ivWallUpper10 = dOpen * (1 + expMove);
      c.ivWallLower10 = dOpen * (1 - expMove);
      c.ivWallUpper15 = dOpen * (1 + 1.5 * expMove);
      c.ivWallLower15 = dOpen * (1 - 1.5 * expMove);

      // Reversal reaction at Lower IV Wall (for LONG) or Upper IV Wall (for SHORT)
      c.atrainAtLowerIvWall =
        c.low <= c.ivWallLower10 * 1.0025 && c.close >= c.ivWallLower15 * 0.996;
      c.atrainAtUpperIvWall =
        c.high >= c.ivWallUpper10 * 0.9975 && c.close <= c.ivWallUpper15 * 1.004;

      // Track running session high/low and Kenny SB Prior Day High/Low (PDH/PDL) Sweep & Reclaim
      if (c.high > curDayHigh) curDayHigh = c.high;
      if (c.low < curDayLow) curDayLow = c.low;
      c.pdh = prevDayHigh;
      c.pdl = prevDayLow;
      c.kennyPdlSweep =
        prevDayLow !== null &&
        (c.low < prevDayLow || (prevBar && prevBar.low < prevDayLow)) &&
        c.close > prevDayLow;
      c.kennyPdhSweep =
        prevDayHigh !== null &&
        (c.high > prevDayHigh || (prevBar && prevBar.high > prevDayHigh)) &&
        c.close < prevDayHigh;

      // Kenny SB First-Touch Wall Rule ("First touch carries freshest hedging response; second break is information, not a discount")
      const newLowerWallTouch =
        c.low <= c.ivWallLower10 * 1.0025 && (!prevBar || prevBar.low > prevBar.ivWallLower10 * 1.0025);
      const newUpperWallTouch =
        c.high >= c.ivWallUpper10 * 0.9975 && (!prevBar || prevBar.high < prevBar.ivWallUpper10 * 0.9975);
      if (newLowerWallTouch) lowerWallTouchesToday++;
      if (newUpperWallTouch) upperWallTouchesToday++;
      c.kennyLowerWallTouches = lowerWallTouchesToday;
      c.kennyUpperWallTouches = upperWallTouchesToday;
      c.kennyFirstTouchLowerWall = c.atrainAtLowerIvWall && lowerWallTouchesToday === 1;
      c.kennyFirstTouchUpperWall = c.atrainAtUpperIvWall && upperWallTouchesToday === 1;
      c.kennyBrokenLowerWall = lowerWallTouchesToday >= 2 && c.close < c.ivWallLower10 * 0.997;
      c.kennyBrokenUpperWall = upperWallTouchesToday >= 2 && c.close > c.ivWallUpper10 * 1.003;

      // Exhaustion check: buying >=88% into the Upper IV Wall or shorting >=88% into the Lower IV Wall
      c.atrainIntoUpperIvWall =
        c.close >= dOpen + 0.88 * (c.ivWallUpper10 - dOpen) && !c.atrainAtLowerIvWall;
      c.atrainIntoLowerIvWall =
        c.close <= dOpen - 0.88 * (dOpen - c.ivWallLower10) && !c.atrainAtUpperIvWall;
    }
  }

  /**
   * Computes Trader Neil's Volume Profile (POC, VAH, VAL — 70% Value Area) over a window of candles.
   */
  _computeVolumeProfile(windowCandles, numBins = 24) {
    if (!windowCandles || windowCandles.length === 0) {
      return { poc: 0, vah: 0, val: 0 };
    }
    let minP = Infinity;
    let maxP = -Infinity;
    let totalVol = 0;

    for (const c of windowCandles) {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
      totalVol += c.volume;
    }

    if (maxP <= minP || totalVol <= 0) {
      const p = windowCandles[windowCandles.length - 1].close;
      return { poc: p, vah: p, val: p };
    }

    const step = (maxP - minP) / numBins;
    const bins = new Array(numBins).fill(0);

    for (const c of windowCandles) {
      const typ = (c.high + c.low + c.close) / 3;
      const idx = Math.min(numBins - 1, Math.max(0, Math.floor((typ - minP) / step)));
      bins[idx] += c.volume;
    }

    let pocIdx = 0;
    for (let b = 1; b < numBins; b++) {
      if (bins[b] > bins[pocIdx]) pocIdx = b;
    }

    // Expand outward from POC until 70% of total volume is captured (standard Value Area)
    const targetVol = totalVol * 0.70;
    let capturedVol = bins[pocIdx];
    let lowIdx = pocIdx;
    let highIdx = pocIdx;

    while (capturedVol < targetVol && (lowIdx > 0 || highIdx < numBins - 1)) {
      const nextLowVol = lowIdx > 0 ? bins[lowIdx - 1] : -1;
      const nextHighVol = highIdx < numBins - 1 ? bins[highIdx + 1] : -1;

      if (nextHighVol >= nextLowVol && highIdx < numBins - 1) {
        highIdx++;
        capturedVol += bins[highIdx];
      } else if (lowIdx > 0) {
        lowIdx--;
        capturedVol += bins[lowIdx];
      } else {
        break;
      }
    }

    return {
      poc: minP + (pocIdx + 0.5) * step,
      vah: minP + (highIdx + 1) * step,
      val: minP + lowIdx * step,
    };
  }

  _detectStructureAndOrderBlocks(candles) {
    const {
      swingLookback,
      minDisplacementAtr,
      minFvgAtr,
      requireFvgOrBos,
      minBarsBeforeRetest,
      maxZoneTouches,
      maxZoneAgeBars,
      zonePaddingAtr,
    } = this.config;

    const allOrderBlocks = [];
    const structureEvents = [];

    let lastSwingHigh = null;
    let lastSwingLow = null;
    let currentTrend = 0;
    let obIdCounter = 1;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];

      // 1. Confirm Swing Pivot at `i - swingLookback`
      const pivotIdx = i - swingLookback;
      if (pivotIdx >= swingLookback) {
        let isSwingHigh = true;
        let isSwingLow = true;
        const candidate = candles[pivotIdx];

        for (let k = pivotIdx - swingLookback; k <= pivotIdx + swingLookback; k++) {
          if (k === pivotIdx) continue;
          if (candles[k].high > candidate.high) isSwingHigh = false;
          if (candles[k].low < candidate.low) isSwingLow = false;
        }

        if (isSwingHigh) lastSwingHigh = { index: pivotIdx, price: candidate.high };
        if (isSwingLow) lastSwingLow = { index: pivotIdx, price: candidate.low };
      }

      // 2. Detect meaningful 3-bar Fair Value Gap (FVG >= minFvgAtr * ATR)
      let hasBullishFvg = false;
      let hasBearishFvg = false;
      let fvgSize = 0;

      if (i >= 2) {
        const c0 = candles[i - 2];
        const c1 = candles[i - 1];
        const c2 = candles[i];
        const minGap = (c1.atr || c.atr) * minFvgAtr;

        if (c2.low - c0.high >= minGap && c1.isBullish) {
          hasBullishFvg = true;
          fvgSize = c2.low - c0.high;
          c1.fvg = { type: 'BULLISH', top: c2.low, bottom: c0.high, size: fvgSize };
        } else if (c0.low - c2.high >= minGap && c1.isBearish) {
          hasBearishFvg = true;
          fvgSize = c0.low - c2.high;
          c1.fvg = { type: 'BEARISH', top: c0.low, bottom: c2.high, size: fvgSize };
        }
      }

      // 3. Detect Structural Break (BOS / CHoCH)
      let brokeSwingHigh = false;
      let brokeSwingLow = false;
      let structureType = null;

      if (lastSwingHigh && c.close > lastSwingHigh.price && candles[i - 1]?.close <= lastSwingHigh.price) {
        brokeSwingHigh = true;
        structureType = currentTrend === -1 ? 'CHoCH_BULL' : 'BOS_BULL';
        currentTrend = 1;
        structureEvents.push({
          index: i,
          timestamp: c.timestamp,
          type: structureType,
          level: lastSwingHigh.price,
          pivotIndex: lastSwingHigh.index,
        });
      }

      if (lastSwingLow && c.close < lastSwingLow.price && candles[i - 1]?.close >= lastSwingLow.price) {
        brokeSwingLow = true;
        structureType = currentTrend === 1 ? 'CHoCH_BEAR' : 'BOS_BEAR';
        currentTrend = -1;
        structureEvents.push({
          index: i,
          timestamp: c.timestamp,
          type: structureType,
          level: lastSwingLow.price,
          pivotIndex: lastSwingLow.index,
        });
      }

      c.trendBias = currentTrend;

      // 4. Form New 15m Bullish Order Block (Demand Zone)
      const dispCandlesBull =
        (c.isBullish && c.body >= c.atr * minDisplacementAtr) ||
        (i >= 1 && candles[i - 1].isBullish && candles[i - 1].body >= candles[i - 1].atr * minDisplacementAtr);

      if (dispCandlesBull && (!requireFvgOrBos || hasBullishFvg || brokeSwingHigh)) {
        const baseCandle = this._findOrderBlockCandle(candles, i, 'BULLISH', 6);
        if (baseCandle) {
          const pad = baseCandle.atr * zonePaddingAtr;
          const zoneHigh = Math.min(Math.max(baseCandle.open, baseCandle.close) + pad, baseCandle.high);
          const zoneLow = baseCandle.low - pad;

          // Ensure current bar `c.close` has actually displaced ABOVE `zoneHigh` by at least 0.5x ATR (not stuck in chop)
          const hasClearedZone = c.close > zoneHigh + c.atr * 0.45;
          const alreadyExists = allOrderBlocks.some(
            (ob) => ob.type === 'BULLISH' && Math.abs(ob.baseIndex - baseCandle.index) <= 2
          );

          if (hasClearedZone && !alreadyExists) {
            allOrderBlocks.push({
              id: `OB_BULL_${obIdCounter++}`,
              type: 'BULLISH',
              baseIndex: baseCandle.index,
              createdAtIndex: i,
              createdAtTimestamp: c.timestamp,
              zoneHigh,
              zoneLow,
              rawHigh: baseCandle.high,
              rawLow: baseCandle.low,
              midpoint: (zoneHigh + zoneLow) / 2,
              hasFvg: hasBullishFvg,
              fvgSize,
              hasBos: brokeSwingHigh,
              structureType: structureType || (hasBullishFvg ? 'FVG_DISPLACEMENT' : 'IMPULSE'),
              displacementRatio: Number((Math.max(c.body, candles[i - 1]?.body || 0) / (c.atr || 1)).toFixed(2)),
              volumeRatio: Number((Math.max(c.volume, candles[i - 1]?.volume || 0) / (c.volSma || 1)).toFixed(2)),
              hasLeftZone: c.low > zoneHigh, // True once a bar trades completely outside the OB
              touches: 0,
              lastTouchIndex: -1,
              status: 'FRESH',
              invalidatedAtIndex: null,
            });
          }
        }
      }

      // 5. Form New 15m Bearish Order Block (Supply Zone)
      const dispCandlesBear =
        (c.isBearish && c.body >= c.atr * minDisplacementAtr) ||
        (i >= 1 && candles[i - 1].isBearish && candles[i - 1].body >= candles[i - 1].atr * minDisplacementAtr);

      if (dispCandlesBear && (!requireFvgOrBos || hasBearishFvg || brokeSwingLow)) {
        const baseCandle = this._findOrderBlockCandle(candles, i, 'BEARISH', 6);
        if (baseCandle) {
          const pad = baseCandle.atr * zonePaddingAtr;
          const zoneHigh = baseCandle.high + pad;
          const zoneLow = Math.max(Math.min(baseCandle.open, baseCandle.close) - pad, baseCandle.low);

          // Ensure current bar `c.close` has actually displaced BELOW `zoneLow` by at least 0.5x ATR
          const hasClearedZone = c.close < zoneLow - c.atr * 0.45;
          const alreadyExists = allOrderBlocks.some(
            (ob) => ob.type === 'BEARISH' && Math.abs(ob.baseIndex - baseCandle.index) <= 2
          );

          if (hasClearedZone && !alreadyExists) {
            allOrderBlocks.push({
              id: `OB_BEAR_${obIdCounter++}`,
              type: 'BEARISH',
              baseIndex: baseCandle.index,
              createdAtIndex: i,
              createdAtTimestamp: c.timestamp,
              zoneHigh,
              zoneLow,
              rawHigh: baseCandle.high,
              rawLow: baseCandle.low,
              midpoint: (zoneHigh + zoneLow) / 2,
              hasFvg: hasBearishFvg,
              fvgSize,
              hasBos: brokeSwingLow,
              structureType: structureType || (hasBearishFvg ? 'FVG_DISPLACEMENT' : 'IMPULSE'),
              displacementRatio: Number((Math.max(c.body, candles[i - 1]?.body || 0) / (c.atr || 1)).toFixed(2)),
              volumeRatio: Number((Math.max(c.volume, candles[i - 1]?.volume || 0) / (c.volSma || 1)).toFixed(2)),
              hasLeftZone: c.high < zoneLow,
              touches: 0,
              lastTouchIndex: -1,
              status: 'FRESH',
              invalidatedAtIndex: null,
            });
          }
        }
      }

      // 6. Update Lifecycle of Existing Order Blocks on Bar `i`
      for (const ob of allOrderBlocks) {
        if (ob.createdAtIndex >= i) continue;
        if (ob.status === 'INVALIDATED' || ob.status === 'EXPIRED') continue;

        if (i - ob.createdAtIndex > maxZoneAgeBars) {
          ob.status = 'EXPIRED';
          ob.invalidatedAtIndex = i;
          continue;
        }

        if (ob.type === 'BULLISH') {
          if (c.close < ob.zoneLow) {
            ob.status = 'INVALIDATED';
            ob.invalidatedAtIndex = i;
            continue;
          }
          // Track when price has cleanly left the zone above `zoneHigh`
          if (c.low > ob.zoneHigh) {
            ob.hasLeftZone = true;
          }
          // Only count a valid test once price has left the zone and at least `minBarsBeforeRetest` have elapsed
          if (ob.hasLeftZone && i - ob.createdAtIndex >= minBarsBeforeRetest && c.low <= ob.zoneHigh && c.high >= ob.zoneLow) {
            if (ob.lastTouchIndex === -1 || i - ob.lastTouchIndex >= 4) {
              ob.touches += 1;
            }
            ob.lastTouchIndex = i;
            if (ob.touches > maxZoneTouches) {
              ob.status = 'EXPIRED';
              ob.invalidatedAtIndex = i;
            } else {
              ob.status = 'TESTED';
            }
          }
        } else if (ob.type === 'BEARISH') {
          if (c.close > ob.zoneHigh) {
            ob.status = 'INVALIDATED';
            ob.invalidatedAtIndex = i;
            continue;
          }
          if (c.high < ob.zoneLow) {
            ob.hasLeftZone = true;
          }
          if (ob.hasLeftZone && i - ob.createdAtIndex >= minBarsBeforeRetest && c.high >= ob.zoneLow && c.low <= ob.zoneHigh) {
            if (ob.lastTouchIndex === -1 || i - ob.lastTouchIndex >= 4) {
              ob.touches += 1;
            }
            ob.lastTouchIndex = i;
            if (ob.touches > maxZoneTouches) {
              ob.status = 'EXPIRED';
              ob.invalidatedAtIndex = i;
            } else {
              ob.status = 'TESTED';
            }
          }
        }
      }
    }

    return { allOrderBlocks, structureEvents };
  }

  _findOrderBlockCandle(candles, currentIndex, direction, maxLookback = 6) {
    const startIdx = Math.max(0, currentIndex - maxLookback);
    let candidate = null;

    if (direction === 'BULLISH') {
      for (let j = currentIndex - 1; j >= startIdx; j--) {
        if (candles[j].isBearish) {
          candidate = candles[j];
          if (j - 1 >= startIdx && candles[j - 1].low < candidate.low && candles[j - 1].isBearish) {
            candidate = candles[j - 1];
          }
          break;
        }
      }
      if (!candidate && currentIndex >= 2) candidate = candles[currentIndex - 2];
    } else {
      for (let j = currentIndex - 1; j >= startIdx; j--) {
        if (candles[j].isBullish) {
          candidate = candles[j];
          if (j - 1 >= startIdx && candles[j - 1].high > candidate.high && candles[j - 1].isBullish) {
            candidate = candles[j - 1];
          }
          break;
        }
      }
      if (!candidate && currentIndex >= 2) candidate = candles[currentIndex - 2];
    }

    return candidate;
  }

  getTappedOrderBlocksAtBar(allOrderBlocks, candle, barIndex) {
    const { minBarsBeforeRetest, maxZoneTouches } = this.config;
    return allOrderBlocks.filter((ob) => {
      if (ob.createdAtIndex >= barIndex) return false;
      if (barIndex - ob.createdAtIndex < minBarsBeforeRetest) return false;
      if (!ob.hasLeftZone) return false;
      if (ob.invalidatedAtIndex !== null && ob.invalidatedAtIndex < barIndex) return false;
      if (ob.touches > maxZoneTouches) return false;

      if (ob.type === 'BULLISH') {
        return candle.low <= ob.zoneHigh && candle.close >= ob.zoneLow;
      } else {
        return candle.high >= ob.zoneLow && candle.close <= ob.zoneHigh;
      }
    });
  }
}
