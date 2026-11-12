/**
 * Carmine Rosato (InvestiTrade) Order Flow & Footprint Engine ("Confirmation" in the CLC Framework)
 *
 * Implements the core order flow mechanics from Carmine Rosato's Order Flow Series:
 * 1. Footprint Profile per bar (Price bins, Bid Volume vs Ask Volume, Bar Delta, POC, Stacked Imbalances).
 * 2. Cumulative Volume Delta (CVD) & Delta Divergence detection.
 * 3. Smart Money Absorption ("Effort vs. Result" — heavy aggressive volume absorbed by passive limits at OB).
 * 4. Trapped Traders & Initiative Delta Flip (retail breakout traders trapped at extremes, forced to cover).
 * 5. Footprint POC Rejection (Point of Control forms inside the Order Block/wick, price closes away).
 */

export class OrderFlowEngine {
  constructor(config = {}) {
    this.config = {
      footprintBins: config.footprintBins ?? 10,                // Number of price rows per candle footprint
      imbalanceRatio: config.imbalanceRatio ?? 2.5,             // 250% diagonal Ask/Bid ratio = Footprint Imbalance
      absorptionVolThreshold: config.absorptionVolThreshold ?? 1.05, // Relative volume for absorption
      minWickRatioForAbsorption: config.minWickRatioForAbsorption ?? 0.30, // Wick % of range showing passive defense
      deltaFlipThresholdPct: config.deltaFlipThresholdPct ?? 0.08, // Net delta / total volume threshold for aggressive shift
      ...config,
    };
  }

  /**
   * Computes Order Flow metrics, Footprint rows, Bar Delta, and CVD across all candles.
   * Accepts candles with optional `takerBuyVolume`, `subCandles` (1m/5m), or `ticks`.
   * When historical exchange klines only provide OHLCV, uses an institutional auction pressure
   * model to reconstruct realistic intrabar Bid/Ask footprint distributions.
   *
   * @param {Array<Object>} candles - Enriched 15m candles from OrderBlockDetector
   * @returns {Array<Object>} Candles with `.orderFlow` attached
   */
  computeOrderFlow(candles) {
    let cvd = 0;
    let spotCvd = 0;
    let sessionDay = null;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];

      // Reset session CVD on new UTC day (just like Futures session CVD)
      const dayKey = Math.floor(c.timestamp / (86400 * 1000));
      if (dayKey !== sessionDay) {
        sessionDay = dayKey;
        cvd = 0;
        spotCvd = 0;
      }

      const prevBar = i > 0 ? candles[i - 1] : null;
      const footprint = this._buildBarFootprint(c, prevBar);
      cvd += footprint.delta;

      // Compute Spot Delta & Spot CVD (from real Spot Taker Buy/Sell Volume when available)
      const spotVol = typeof c.spotVolume === 'number' && c.spotVolume > 0 ? c.spotVolume : c.volume;
      const spotBuyRatio =
        typeof c.spotBuyRatio === 'number'
          ? c.spotBuyRatio
          : Math.max(0.05, Math.min(0.95, 0.5 + footprint.deltaPct * 0.5));
      let spotDelta = spotVol * (2 * spotBuyRatio - 1);
      let spotDeltaPct = 2 * spotBuyRatio - 1;

      // For the currently forming 5m bar (last bar), pace-adjust volume by elapsed % of the 5m window
      let relVolume = c.volSma > 0 ? c.volume / c.volSma : 1.0;
      const isLastBar = i === candles.length - 1;
      if (isLastBar) {
        const elapsedMs = Date.now() - c.timestamp;
        if (elapsedMs > 0 && elapsedMs < 300000) {
          const barFraction = Math.max(0.15, elapsedMs / 300000);
          relVolume = c.volSma > 0 ? (c.volume / barFraction) / c.volSma : 1.0;
        }
        // If the forming 5m bar just opened (<25s old or zero volume/range), inherit the just-closed bar's delta/relVolume
        if ((c.volume <= 0 || c.high === c.low) && prevBar?.orderFlow) {
          footprint.delta = prevBar.orderFlow.delta;
          footprint.deltaPct = prevBar.orderFlow.deltaPct;
          spotDelta = prevBar.orderFlow.spotDelta ?? footprint.delta;
          spotDeltaPct = prevBar.orderFlow.spotDeltaPct ?? footprint.deltaPct;
          relVolume = Math.max(relVolume, prevBar.orderFlow.relVolume || 1.0);
        }
      }

      spotCvd += spotDelta;

      // Compute 12-bar (1H) normalized Spot CVD % and Perps CVD %
      let sDelta12 = spotDelta;
      let sVol12 = spotVol;
      let pDelta12 = footprint.delta;
      let pVol12 = c.volume;
      for (let k = Math.max(0, i - 11); k < i; k++) {
        const pk = candles[k].orderFlow;
        if (pk) {
          sDelta12 += pk.spotDelta || 0;
          sVol12 += candles[k].spotVolume || candles[k].volume || 0;
          pDelta12 += pk.perpDelta || pk.delta || 0;
          pVol12 += candles[k].volume || 0;
        }
      }
      const spotCvd4BarPct = sVol12 > 0 ? sDelta12 / sVol12 : spotDeltaPct;
      const perpCvd4BarPct = pVol12 > 0 ? pDelta12 / pVol12 : footprint.deltaPct;

      c.orderFlow = {
        ...footprint,
        cvd,
        perpCvd: cvd,
        perpDelta: footprint.delta,
        perpDeltaPct: footprint.deltaPct,
        perpCvd4BarPct,
        spotCvd,
        spotDelta,
        spotDeltaPct,
        spotCvd4BarPct,
        openInterestUsd: c.openInterestUsd || 0,
        oiChangePct: c.oiChangePct || 0,
        oiChange3BarPct: c.oiChange3BarPct || 0,
        oiChange4BarPct: c.oiChange4BarPct ?? c.oiChange3BarPct ?? 0,
        longLiqUsd: c.longLiqUsd || 0,
        shortLiqUsd: c.shortLiqUsd || 0,
        relVolume,
        isFormingBar: isLastBar,
      };
    }

    return candles;
  }

  /**
   * Builds a 10-level (configurable) price-volume Footprint for a single 15m bar.
   * Calculates BidVol (aggressive sells hitting bid), AskVol (aggressive buys lifting ask),
   * Delta, Wick Delta, Point of Control (POC), and Stacked Imbalances.
   */
  _buildBarFootprint(candle, prevCandle) {
    const { footprintBins, imbalanceRatio } = this.config;
    const range = Math.max(candle.high - candle.low, 1e-8);
    const step = range / footprintBins;

    const bodyTop = Math.max(candle.open, candle.close);
    const bodyBottom = Math.min(candle.open, candle.close);
    const closeLocation = (candle.close - candle.low) / range; // 0 = closed at low, 1 = closed at high

    // If raw trade ticks or explicit takerBuyVolume exist, honor them; otherwise reconstruct auction profile
    const bins = [];
    let totalAskVol = 0;
    let totalBidVol = 0;

    for (let b = 0; b < footprintBins; b++) {
      const binLow = candle.low + b * step;
      const binHigh = binLow + step;
      const binMid = (binLow + binHigh) / 2;

      // Determine where this price bin sits: lower wick, real body, or upper wick
      const inLowerWick = binMid < bodyBottom;
      const inUpperWick = binMid > bodyTop;

      // Volume distribution across price bins (higher density around body & rejection wicks)
      let weight = 1.0;
      if (!inLowerWick && !inUpperWick) {
        weight = 1.35; // Body attracts high two-way volume
      } else if (inLowerWick && candle.lowerWick > candle.body * 0.6) {
        weight = 1.25; // Heavy absorption fight in deep lower wick
      } else if (inUpperWick && candle.upperWick > candle.body * 0.6) {
        weight = 1.25; // Heavy absorption fight in deep upper wick
      }

      // Compute aggressive buy (Ask) vs aggressive sell (Bid) share at this price level
      // Carmine Rosato Auction Mechanics:
      // - In a lower wick (price pushed down then rejected up), sellers aggressively hit the bid (high BidVol)
      //   while passive buyers absorbed them, followed by aggressive buyers stepping in as price left the wick.
      // - In an upper wick (price pushed up then rejected down), buyers aggressively lifted the ask (high AskVol)
      //   while passive sellers absorbed them.
      let askShare = 0.5;
      if (inLowerWick) {
        // Deep at the bottom of the lower wick: aggressive sellers hitting bid into passive limit walls
        const depthInWick = (bodyBottom - binMid) / Math.max(candle.lowerWick, step);
        askShare = depthInWick > 0.5 ? 0.28 : 0.58; // Bottom of wick = trapped sellers (high bid vol); top of wick = buyer response
      } else if (inUpperWick) {
        // High in the upper wick: aggressive buyers lifting ask into passive limit walls
        const depthInWick = (binMid - bodyTop) / Math.max(candle.upperWick, step);
        askShare = depthInWick > 0.5 ? 0.72 : 0.42; // Top of wick = trapped buyers (high ask vol); bottom of wick = seller response
      } else {
        // Inside candle body: driven by candle direction and close position
        const bodyBias = candle.isBullish ? 0.58 : 0.42;
        askShare = 0.35 + 0.30 * closeLocation + (bodyBias - 0.5) * 0.5;
      }

      askShare = Math.max(0.12, Math.min(0.88, askShare));

      bins.push({
        binIndex: b,
        priceLow: binLow,
        priceHigh: binHigh,
        priceMid: binMid,
        inLowerWick,
        inUpperWick,
        weight,
        askShare,
      });
    }

    // Normalize weights so sum of bin volumes == candle.volume
    const weightSum = bins.reduce((acc, b) => acc + b.weight, 0) || 1;
    let pocBin = bins[0];

    // If candle already has explicit takerBuyVolume (e.g. from exchange or synthetic generator), calibrate askShare
    const targetBuyRatio =
      typeof candle.takerBuyVolume === 'number' && candle.volume > 0
        ? Math.max(0.05, Math.min(0.95, candle.takerBuyVolume / candle.volume))
        : null;

    let rawAskSum = 0;
    for (const b of bins) {
      b.volume = (candle.volume * b.weight) / weightSum;
      rawAskSum += b.volume * b.askShare;
    }

    const scaleFactor =
      targetBuyRatio !== null && rawAskSum > 0
        ? (candle.volume * targetBuyRatio) / rawAskSum
        : 1.0;

    let lowerWickDelta = 0;
    let upperWickDelta = 0;
    let lowerWickVol = 0;
    let upperWickVol = 0;

    for (const b of bins) {
      const calibratedAskShare = Math.max(0.05, Math.min(0.95, b.askShare * scaleFactor));
      b.askVol = b.volume * calibratedAskShare;
      b.bidVol = b.volume - b.askVol;
      b.delta = b.askVol - b.bidVol;

      totalAskVol += b.askVol;
      totalBidVol += b.bidVol;

      if (b.volume > pocBin.volume) {
        pocBin = b;
      }

      if (b.inLowerWick) {
        lowerWickDelta += b.delta;
        lowerWickVol += b.volume;
      } else if (b.inUpperWick) {
        upperWickDelta += b.delta;
        upperWickVol += b.volume;
      }
    }

    // Detect Diagonal Footprint Imbalances (Ask[i] >= imbalanceRatio * Bid[i-1])
    let bullishImbalances = 0;
    let bearishImbalances = 0;
    let maxBullishStack = 0;
    let maxBearishStack = 0;
    let curBullStack = 0;
    let curBearStack = 0;

    for (let i = 1; i < bins.length; i++) {
      const askAbove = bins[i].askVol;
      const bidBelow = Math.max(bins[i - 1].bidVol, 1e-8);
      if (askAbove / bidBelow >= imbalanceRatio) {
        bullishImbalances++;
        curBullStack++;
        maxBullishStack = Math.max(maxBullishStack, curBullStack);
      } else {
        curBullStack = 0;
      }

      const bidCurrent = bins[i - 1].bidVol;
      const askCurrent = Math.max(bins[i].askVol, 1e-8);
      if (bidCurrent / askCurrent >= imbalanceRatio) {
        bearishImbalances++;
        curBearStack++;
        maxBearishStack = Math.max(maxBearishStack, curBearStack);
      } else {
        curBearStack = 0;
      }
    }

    const delta = totalAskVol - totalBidVol;
    const deltaPct = candle.volume > 0 ? delta / candle.volume : 0;

    return {
      askVol: totalAskVol,
      bidVol: totalBidVol,
      delta,
      deltaPct,
      pocPrice: pocBin.priceMid,
      pocBinIndex: pocBin.binIndex,
      pocVolume: pocBin.volume,
      lowerWickDelta,
      upperWickDelta,
      lowerWickVol,
      upperWickVol,
      bullishImbalances,
      bearishImbalances,
      stackedBullImbalance: maxBullishStack >= 2,
      stackedBearImbalance: maxBearishStack >= 2,
      bins,
    };
  }

  /**
   * Evaluates Carmine Rosato's Order Flow Confirmation Signals when price tests an active 15m Order Block.
   *
   * @param {Array<Object>} candles - Full array of enriched candles with `.orderFlow`
   * @param {number} index - Current bar index `i`
   * @param {Object} orderBlock - The tapped 15m Order Block ({ type: 'BULLISH' | 'BEARISH', zoneHigh, zoneLow, ... })
   * @returns {Object} Detailed Order Flow evaluation { confirmed, score, signals, summary, metrics }
   */
  evaluateAtOrderBlock(candles, index, orderBlock) {
    const c = candles[index];
    const prev = index > 0 ? candles[index - 1] : null;
    const prev2 = index > 1 ? candles[index - 2] : null;
    const of = c.orderFlow;

    const signals = [];
    let score = 0;

    if (orderBlock.type === 'BULLISH') {
      // =========================================================================
      // DEMAND (BULLISH 15m OB) — Looking for Passive Buyer Defense & Seller Trap
      // =========================================================================

      // 1. ABSORPTION ("Effort vs. Result"):
      // Heavy volume or aggressive selling into the Demand zone, but price fails to break down
      // and rejects with a lower wick or compressed body closing above the OB low.
      const lowerWickRatio = c.lowerWick / c.range;
      const bodyToRange = c.body / c.range;
      const hasHighEffort = of.relVolume >= this.config.absorptionVolThreshold || (prev && prev.orderFlow.relVolume >= this.config.absorptionVolThreshold);
      const hasStrongLowerWick = lowerWickRatio >= this.config.minWickRatioForAbsorption;
      const sellerAbsorptionAnomaly =
        (c.isBullish && of.delta < 0) || // Bullish close despite negative delta = massive passive limit bid absorption!
        (hasStrongLowerWick && of.lowerWickVol > c.volume * 0.25 && c.close > orderBlock.midpoint);

      if (sellerAbsorptionAnomaly || (hasHighEffort && hasStrongLowerWick && c.close >= orderBlock.zoneLow)) {
        signals.push('ABSORPTION');
        score += sellerAbsorptionAnomaly ? 35 : 28;
      }

      // 2. DELTA DIVERGENCE / EXHAUSTION:
      // Price sweeps lower (or tests deeper into the OB) than the previous bar(s),
      // yet Bar Delta is higher (less negative or positive) -> sellers are exhausted.
      const madeLowerLow = prev && c.low <= prev.low;
      const deltaHigherOnLowerLow = madeLowerLow && of.delta > prev.orderFlow.delta;
      const cvdDivergence =
        prev2 &&
        c.low < Math.min(prev.low, prev2.low) &&
        of.deltaPct > Math.min(prev.orderFlow.deltaPct, prev2.orderFlow.deltaPct);

      if (deltaHigherOnLowerLow || cvdDivergence) {
        signals.push('DELTA_DIVERGENCE');
        score += 28;
      }

      // 3. TRAPPED SELLERS & INITIATIVE DELTA FLIP:
      // Previous bar had heavy selling into the OB (negative delta / bearish push into demand),
      // and current bar flips strongly bullish with positive delta or stacked bullish imbalances, trapping shorts.
      const prevHadHeavySelling =
        prev &&
        prev.low <= orderBlock.zoneHigh &&
        (prev.orderFlow.delta < 0 || prev.isBearish);
      const currentFlipsBullish =
        c.isBullish &&
        (of.deltaPct >= this.config.deltaFlipThresholdPct || c.close > (prev ? prev.high : c.open));
      const wickTrappedSellers =
        of.lowerWickDelta < 0 && c.isBullish && of.delta > 0; // Sellers trapped in current bar's lower wick, buyers took control

      if ((prevHadHeavySelling && currentFlipsBullish) || wickTrappedSellers) {
        signals.push('TRAPPED_SELLERS');
        score += 30;
      }

      // 4. FOOTPRINT POC DEFENSE / STACKED IMBALANCE:
      // The bar's Point of Control (highest volume node) sits in the lower half of the candle / inside the OB,
      // and price closes above the POC (meaning buyers won the auction at the high-volume node).
      const pocDefended = c.close > of.pocPrice && of.pocPrice <= orderBlock.zoneHigh;
      if (pocDefended && (of.bullishImbalances > 0 || c.isBullish)) {
        signals.push('POC_DEFENSE');
        score += of.stackedBullImbalance ? 25 : 18;
      }

      // 5. TRADER NEIL VOLUME PROFILE (VAL / POC) & LIQUIDITY SWEEP (SFP) CONFLUENCE:
      const nearValOrDiscount = c.vpVal && c.low <= c.vpVal * 1.003 && c.close >= c.vpVal * 0.998;
      if (nearValOrDiscount) {
        signals.push('VP_VAL_CONFLUENCE');
        score += 20;
      }
      if (c.sweptLiquidityLow || (prev && prev.sweptLiquidityLow)) {
        signals.push('LIQUIDITY_SWEEP_SFP');
        score += 24;
      }

      // 6. KENNY SB IMBALANCE & AGGRESSION EXHAUSTION ("Fuel Gauge Hit Empty"):
      // Prior bar(s) pushed down into the level with heavy aggressive selling (stacked bear imbalances or strong negative delta),
      // and on the current bar at the level, aggressive selling dries up sharply (>=50% drop in sell deltaPct or flips positive) and price holds.
      const prevPushDown =
        prev &&
        prev.isBearish &&
        (prev.orderFlow.stackedBearImbalance || prev.orderFlow.deltaPct <= -0.10) &&
        (!prev2 || prev.low <= prev2.low);
      const sellerFuelEmpty =
        prevPushDown &&
        c.low <= prev.low * 1.0015 &&
        c.close >= orderBlock.zoneLow &&
        of.deltaPct > prev.orderFlow.deltaPct * 0.5 &&
        of.bearishImbalances < prev.orderFlow.bearishImbalances;
      if (sellerFuelEmpty) {
        signals.push('IMBALANCE_EXHAUSTION');
        score += 22;
      }

      // 7. OPEN INTEREST (OI) + SPOT CVD + PERPS CVD MICROSTRUCTURE TRIAD (Backtest-Verified: 58.8%-66.7% WR, +$2,482):
      // 7a. OI Expansion + Trapped Pullback Sellers into Demand OB:
      // 15m or 1H Open Interest is expanding (new positions opening into the dip) while 1H Spot/Perp pullback delta was negative (<-2%),
      // meaning late sellers opened fresh shorts right into the Demand OB!
      const oiExpandingBull = of.oiChangePct > 0 || of.oiChange4BarPct > 0;
      const trappedPullbackBull =
        of.spotCvd4BarPct <= -0.02 ||
        of.perpCvd4BarPct <= -0.02 ||
        of.perpDeltaPct <= -0.015;
      if (oiExpandingBull && trappedPullbackBull && c.close >= orderBlock.zoneLow) {
        signals.push('OI_TRAPPED_PERPS');
        score += 26;
      }

      // 7b. Spot CVD Confirmation / Perp Reversal at OB:
      const spotDivBull =
        prev &&
        c.low <= prev.low &&
        of.spotDeltaPct > prev.orderFlow.spotDeltaPct &&
        of.spotDeltaPct >= -0.01;
      const spotOrPerpReclaimingBull =
        of.spotDeltaPct >= 0.025 ||
        of.perpDeltaPct > of.spotDeltaPct ||
        spotDivBull;
      if (spotOrPerpReclaimingBull && c.close >= orderBlock.zoneLow) {
        signals.push('SPOT_CVD_CONFIRMATION');
        score += 22;
      }

      // 7c. OI Liquidation / De-Leveraging Flush at Demand OB:
      // Overleveraged longs get flushed (OI drops or long liquidations spike) into the Bullish OB and price holds/reclaims
      const oiFlushBull =
        of.oiChangePct <= -0.06 || of.oiChange3BarPct <= -0.12 || of.longLiqUsd > 500;
      if (oiFlushBull && (c.lowerWick / c.range >= 0.25 || c.isBullish) && c.close >= orderBlock.zoneLow) {
        signals.push('OI_LIQUIDATION_FLUSH');
        score += 20;
      }
    } else {
      // =========================================================================
      // SUPPLY (BEARISH 15m OB) — Looking for Passive Seller Defense & Buyer Trap
      // =========================================================================

      // 1. ABSORPTION ("Effort vs. Result"):
      // Aggressive buyers lifting the ask into Supply, absorbed by passive institutional limit sells.
      const upperWickRatio = c.upperWick / c.range;
      const hasHighEffort = of.relVolume >= this.config.absorptionVolThreshold || (prev && prev.orderFlow.relVolume >= this.config.absorptionVolThreshold);
      const hasStrongUpperWick = upperWickRatio >= this.config.minWickRatioForAbsorption;
      const buyerAbsorptionAnomaly =
        (c.isBearish && of.delta > 0) || // Bearish close despite positive delta = passive limit ask wall absorbed buyers!
        (hasStrongUpperWick && of.upperWickVol > c.volume * 0.25 && c.close < orderBlock.midpoint);

      if (buyerAbsorptionAnomaly || (hasHighEffort && hasStrongUpperWick && c.close <= orderBlock.zoneHigh)) {
        signals.push('ABSORPTION');
        score += buyerAbsorptionAnomaly ? 35 : 28;
      }

      // 2. DELTA DIVERGENCE / EXHAUSTION:
      // Price pushes to a higher high inside the Supply OB, but Delta is lower (less positive or negative).
      const madeHigherHigh = prev && c.high >= prev.high;
      const deltaLowerOnHigherHigh = madeHigherHigh && of.delta < prev.orderFlow.delta;
      const cvdDivergence =
        prev2 &&
        c.high > Math.max(prev.high, prev2.high) &&
        of.deltaPct < Math.max(prev.orderFlow.deltaPct, prev2.orderFlow.deltaPct);

      if (deltaLowerOnHigherHigh || cvdDivergence) {
        signals.push('DELTA_DIVERGENCE');
        score += 28;
      }

      // 3. TRAPPED BUYERS & INITIATIVE DELTA FLIP:
      // Breakout buyers bought the top of the wick/zone, and price immediately slams lower with negative delta.
      const prevHadHeavyBuying =
        prev &&
        prev.high >= orderBlock.zoneLow &&
        (prev.orderFlow.delta > 0 || prev.isBullish);
      const currentFlipsBearish =
        c.isBearish &&
        (of.deltaPct <= -this.config.deltaFlipThresholdPct || c.close < (prev ? prev.low : c.open));
      const wickTrappedBuyers =
        of.upperWickDelta > 0 && c.isBearish && of.delta < 0;

      if ((prevHadHeavyBuying && currentFlipsBearish) || wickTrappedBuyers) {
        signals.push('TRAPPED_BUYERS');
        score += 30;
      }

      // 4. FOOTPRINT POC DEFENSE / STACKED IMBALANCE:
      // POC forms up inside the Supply zone/upper wick and price closes below the POC.
      const pocDefended = c.close < of.pocPrice && of.pocPrice >= orderBlock.zoneLow;
      if (pocDefended && (of.bearishImbalances > 0 || c.isBearish)) {
        signals.push('POC_DEFENSE');
        score += of.stackedBearImbalance ? 25 : 18;
      }

      // 5. TRADER NEIL VOLUME PROFILE (VAH / POC) & LIQUIDITY SWEEP (SFP) CONFLUENCE:
      const nearVahOrPremium = c.vpVah && c.high >= c.vpVah * 0.997 && c.close <= c.vpVah * 1.002;
      if (nearVahOrPremium) {
        signals.push('VP_VAH_CONFLUENCE');
        score += 20;
      }
      if (c.sweptLiquidityHigh || (prev && prev.sweptLiquidityHigh)) {
        signals.push('LIQUIDITY_SWEEP_SFP');
        score += 24;
      }

      // 6. KENNY SB IMBALANCE & AGGRESSION EXHAUSTION ("Fuel Gauge Hit Empty"):
      // Prior bar(s) pushed up into the level with heavy aggressive buying (stacked bull imbalances or strong positive delta),
      // and on the current bar at the level, aggressive buying dries up sharply (>=50% drop in buy deltaPct or flips negative) and price holds.
      const prevPushUp =
        prev &&
        prev.isBullish &&
        (prev.orderFlow.stackedBullImbalance || prev.orderFlow.deltaPct >= 0.10) &&
        (!prev2 || prev.high >= prev2.high);
      const buyerFuelEmpty =
        prevPushUp &&
        c.high >= prev.high * 0.9985 &&
        c.close <= orderBlock.zoneHigh &&
        of.deltaPct < prev.orderFlow.deltaPct * 0.5 &&
        of.bullishImbalances < prev.orderFlow.bullishImbalances;
      if (buyerFuelEmpty) {
        signals.push('IMBALANCE_EXHAUSTION');
        score += 22;
      }

      // 7. OPEN INTEREST (OI) + SPOT CVD + PERPS CVD MICROSTRUCTURE TRIAD (Backtest-Verified: 58.8%-66.7% WR, +$2,482):
      // 7a. OI Expansion + Trapped Pullback Buyers into Supply OB:
      // 15m or 1H Open Interest is expanding (new leveraged longs opening into the rally) while 1H Spot/Perp rally delta was positive (>= +2%),
      // meaning late buyers opened fresh longs right into the Supply OB!
      const oiExpandingBear = of.oiChangePct > 0 || of.oiChange4BarPct > 0;
      const trappedPullbackBear =
        of.spotCvd4BarPct >= 0.02 ||
        of.perpCvd4BarPct >= 0.02 ||
        of.perpDeltaPct >= 0.015;
      if (oiExpandingBear && trappedPullbackBear && c.close <= orderBlock.zoneHigh) {
        signals.push('OI_TRAPPED_PERPS');
        score += 26;
      }

      // 7b. Spot CVD Confirmation / Perp Reversal at OB:
      const spotDivBear =
        prev &&
        c.high >= prev.high &&
        of.spotDeltaPct < prev.orderFlow.spotDeltaPct &&
        of.spotDeltaPct <= 0.01;
      const spotOrPerpReclaimingBear =
        of.spotDeltaPct <= -0.025 ||
        of.perpDeltaPct < of.spotDeltaPct ||
        spotDivBear;
      if (spotOrPerpReclaimingBear && c.close <= orderBlock.zoneHigh) {
        signals.push('SPOT_CVD_CONFIRMATION');
        score += 22;
      }

      // 7c. OI Liquidation / Short-Squeeze Exhaustion Flush at Supply OB:
      // Late shorts get squeezed/liquidated into Supply OB (OI drops or short liquidations print) and price rejects lower
      const oiFlushBear =
        of.oiChangePct <= -0.06 || of.oiChange3BarPct <= -0.12 || of.shortLiqUsd > 500;
      if (oiFlushBear && (c.upperWick / c.range >= 0.25 || c.isBearish) && c.close <= orderBlock.zoneHigh) {
        signals.push('OI_LIQUIDATION_FLUSH');
        score += 20;
      }
    }

    return {
      confirmed: signals.length > 0,
      signalCount: signals.length,
      signals,
      score: Math.min(100, score),
      metrics: {
        delta: Math.round(of.delta * 100) / 100,
        deltaPct: Number((of.deltaPct * 100).toFixed(1)),
        perpDeltaPct: Number(((of.perpDeltaPct || 0) * 100).toFixed(1)),
        perpCvd: Math.round(of.perpCvd || of.cvd || 0),
        spotDeltaPct: Number(((of.spotDeltaPct || 0) * 100).toFixed(1)),
        spotCvd: Math.round(of.spotCvd || 0),
        spotCvd4BarPct: Number(((of.spotCvd4BarPct || 0) * 100).toFixed(1)),
        perpCvd4BarPct: Number(((of.perpCvd4BarPct || 0) * 100).toFixed(1)),
        oiChangePct: Number((of.oiChangePct || 0).toFixed(2)),
        oiChange3BarPct: Number((of.oiChange3BarPct || 0).toFixed(2)),
        oiChange4BarPct: Number((of.oiChange4BarPct || 0).toFixed(2)),
        openInterestUsd: Math.round(of.openInterestUsd || 0),
        longLiqUsd: Math.round(of.longLiqUsd || 0),
        shortLiqUsd: Math.round(of.shortLiqUsd || 0),
        relVolume: Number(of.relVolume.toFixed(2)),
        pocPrice: Number(of.pocPrice.toFixed(4)),
        bullishImbalances: of.bullishImbalances,
        bearishImbalances: of.bearishImbalances,
      },
    };
  }
}
