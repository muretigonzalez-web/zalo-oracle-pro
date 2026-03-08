/**
 * ZALO ORACLE PRO
 * FILE: js/hl-engine.js
 * PURPOSE: Higher/Lower Dynamic Barrier Bot Engine
 *
 * TWO BOTS share this engine — only the MODE_PROFILE differs:
 *
 *   HLEngine.start(config)
 *     → Ticks feed prices into the analysis buffer
 *     → Every tick: classify market state (trend/reversal/breakout/SR)
 *     → If signal found: barrier scan for best EV
 *     → Place proposal → buy → wait for settlement
 *     → On loss: adaptive recovery (barrier compress → contract switch)
 *
 * BARRIER NOTE: Deriv Higher/Lower uses SIGNED string barriers:
 *   "+0.20" = price must go ABOVE entry + 0.20 (Higher)
 *   "-0.20" = price must stay BELOW entry - 0.20 (Lower)
 *
 * CONTRACT TYPES: CALL (Higher), PUT (Lower)
 * Duration unit: 't' (ticks) — 3 to 15 ticks
 */

const HLEngine = (() => {

  // ── STATE ──────────────────────────────────────────────────────────────────
  let isRunning        = false;
  let waitingForResult = false;
  let activeContractId = null;
  let cooldown         = 0;
  let tickCount        = 0;

  // Analysis buffer
  const BUFFER_SIZE = 150;
  let priceBuffer    = [];
  let returnBuffer   = [];
  let ema8           = 0;
  let ema21          = 0;
  let ema8Init       = false;
  let ema21Init      = false;

  // Recovery state
  let lossStreak         = 0;
  let recoveryTier       = 0;
  let cumChainLoss       = 0.0;
  let currentStake       = 0.35;
  let lastBarrierDist    = 0;
  let lastDirection      = null;
  let lastDuration       = 5;
  let lastEntryPrice     = 0;
  let lastBarrierPrice   = 0;

  // ── CONFIG ─────────────────────────────────────────────────────────────────
  let config = {
    symbol          : '1HZ10V',
    baseStake       : 0.35,
    takeProfit      : 3.00,
    stopLoss        : 2.50,
    minConfidence   : 6.0,    // out of 10 — skip below this
    enablePinch     : true,   // pinch hedge mode in low volatility
    maxRecoveryTier : 4,      // 0-4 (4 = OVER_0 emergency)
    modeProfile     : 'sniper', // 'sniper' | 'elite'
    disabledModes   : [],     // e.g. ['REVERSAL'] to disable risky modes
  };

  // ── STATS ──────────────────────────────────────────────────────────────────
  let stats = {
    runs : 0, won : 0, lost : 0,
    pnl  : 0, startBalance : 0,
  };

  // ── CALLBACKS ──────────────────────────────────────────────────────────────
  const onTradeCallbacks = [];
  const onStatsCallbacks = [];
  const onLogCallbacks   = [];
  const onTrade  = (fn) => onTradeCallbacks.push(fn);
  const onStats  = (fn) => onStatsCallbacks.push(fn);
  const onLog    = (fn) => onLogCallbacks.push(fn);
  const emitCb   = (list, data) => list.forEach(fn => { try { fn(data); } catch(e){} });

  const log = (msg, type = 'info') => {
    console.log(`[HLEngine] [${type.toUpperCase()}] ${msg}`);
    emitCb(onLogCallbacks, { msg, type, time: Utils.getTime() });
  };

  // ── MATHS HELPERS ──────────────────────────────────────────────────────────
  const mean    = (arr) => arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;
  const stddev  = (arr) => {
    if (arr.length < 2) return 0.0001;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x-m)**2, 0) / arr.length);
  };
  // Standard normal CDF approximation (Abramowitz & Stegun)
  const normalCDF = (z) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const poly = t * (0.319381530
      + t * (-0.356563782
      + t * (1.781477937
      + t * (-1.821255978
      + t * 1.330274429))));
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const cdf = 1 - pdf * poly;
    return z >= 0 ? cdf : 1 - cdf;
  };

  // ── EMA UPDATE ─────────────────────────────────────────────────────────────
  const updateEMAs = (price) => {
    const k8  = 2 / (8  + 1);
    const k21 = 2 / (21 + 1);
    if (!ema8Init)  { ema8  = price; ema8Init  = true; }
    else             { ema8  = price * k8  + ema8  * (1 - k8); }
    if (!ema21Init) { ema21 = price; ema21Init = true; }
    else             { ema21 = price * k21 + ema21 * (1 - k21); }
  };

  // ── COMPUTE ALL INDICATORS ─────────────────────────────────────────────────
  const computeIndicators = () => {
    const n   = priceBuffer.length;
    const ret = returnBuffer;

    // Volatility
    const MV_short = stddev(ret.slice(-10));
    const MV_long  = stddev(ret.slice(-50));
    const VR       = MV_long > 0 ? MV_short / MV_long : 1.0;

    // Cross distance (EMA8 vs EMA21 normalised)
    const CrossDist = MV_long > 0 ? (ema8 - ema21) / MV_long : 0;

    // DMI-style: up/down ratio over last 14 ticks
    const ret14   = ret.slice(-14);
    const upMoves = ret14.filter(r => r > 0).length;
    const dnMoves = ret14.filter(r => r < 0).length;
    const DMI     = (upMoves - dnMoves) / 14;

    // Velocity (normalised)
    const V5  = (n >= 6  && MV_long > 0) ? (priceBuffer[n-1] - priceBuffer[n-6])  / (5  * MV_long) : 0;
    const V20 = (n >= 21 && MV_long > 0) ? (priceBuffer[n-1] - priceBuffer[n-21]) / (20 * MV_long) : 0;
    const V5p = (n >= 11 && MV_long > 0) ? (priceBuffer[n-6] - priceBuffer[n-11]) / (5  * MV_long) : 0;
    const Accel = V5 - V5p;

    // Bollinger position
    const SMA20    = mean(priceBuffer.slice(-20));
    const BB_upper = SMA20 + 2 * MV_long;
    const BB_lower = SMA20 - 2 * MV_long;
    const BB_range = BB_upper - BB_lower;
    const BB_pos   = BB_range > 0 ? (priceBuffer[n-1] - BB_lower) / BB_range : 0.5;

    // Consecutive ticks same direction
    let consecUp = 0, consecDn = 0;
    for (let i = ret.length - 1; i >= 0; i--) {
      if (ret[i] > 0) consecUp++; else break;
    }
    for (let i = ret.length - 1; i >= 0; i--) {
      if (ret[i] < 0) consecDn++; else break;
    }

    // Support / Resistance (price levels touched 4+ times in last 150)
    const levelMap = {};
    priceBuffer.forEach(p => {
      const key = Math.round(p * 10) / 10; // round to 1dp
      levelMap[key] = (levelMap[key] || 0) + 1;
    });
    const curP    = priceBuffer[n - 1];
    const supports    = Object.entries(levelMap)
      .filter(([lv, ct]) => ct >= 4 && parseFloat(lv) < curP)
      .map(([lv]) => parseFloat(lv));
    const resistances = Object.entries(levelMap)
      .filter(([lv, ct]) => ct >= 4 && parseFloat(lv) > curP)
      .map(([lv]) => parseFloat(lv));
    const nearSupport    = supports.length    ? Math.max(...supports)    : curP - 5 * MV_long;
    const nearResistance = resistances.length ? Math.min(...resistances) : curP + 5 * MV_long;

    // EAI — Energy Accumulation Index (compression detector)
    const EAI = MV_long > 0 ? Math.max(0, (MV_long**2 - MV_short**2) / MV_long**2 * 100) : 0;

    return {
      MV_short, MV_long, VR, CrossDist, DMI,
      V5, V20, Accel, BB_pos,
      consecUp, consecDn,
      nearSupport, nearResistance, levelMap, curP,
      EAI, SMA20,
    };
  };

  // ── MODE SELECTION ─────────────────────────────────────────────────────────
  const selectMode = (ind) => {
    const { CrossDist, DMI, V5, V20, Accel, VR, BB_pos, consecUp, consecDn, EAI, returnBuffer: rb, curP, nearSupport, nearResistance, MV_long } = ind;
    const ret = returnBuffer;

    // MODE 1: TREND MOMENTUM
    if (!config.disabledModes.includes('TREND')) {
      if (Math.abs(CrossDist) > 0.8
          && Math.abs(DMI)     > 0.25
          && ((V5 > 0 && V20 > 0) || (V5 < 0 && V20 < 0))
          && Accel >= -0.3
          && VR > 0.7 && VR < 1.8) {
        const dir  = CrossDist > 0 ? 'HIGHER' : 'LOWER';
        const conf = Math.abs(CrossDist) + Math.abs(DMI) * 3 + Math.abs(V5) * 2;
        if (conf >= 3.0) return { mode: 'TREND', direction: dir, rawConf: conf };
      }
    }

    // MODE 2: MEAN REVERSION (disabled by default in sniper profile)
    if (!config.disabledModes.includes('REVERSAL')) {
      if ((BB_pos > 0.92 || BB_pos < 0.08)
          && (consecUp >= 5 || consecDn >= 5)
          && Math.abs(V5) > 2.0
          && Accel < 0) {
        const dir  = BB_pos > 0.92 ? 'LOWER' : 'HIGHER';
        const conf = Math.abs(BB_pos - 0.5) * 4 + Math.abs(V5) + Math.abs(Accel) * 3;
        return { mode: 'REVERSAL', direction: dir, rawConf: conf };
      }
    }

    // MODE 3: BREAKOUT
    if (!config.disabledModes.includes('BREAKOUT')) {
      if (EAI > 50 && ret.length > 0 && Math.abs(ret[ret.length - 1]) > 2.5 * ind.MV_long) {
        const lastRet = ret[ret.length - 1];
        const dir     = lastRet > 0 ? 'HIGHER' : 'LOWER';
        const conf    = Math.abs(lastRet) / ind.MV_long + 1 / (ind.VR || 1) + Math.abs(V20) * 2;
        return { mode: 'BREAKOUT', direction: dir, rawConf: conf };
      }
    }

    // MODE 4: S/R BOUNCE
    if (!config.disabledModes.includes('SR_BOUNCE')) {
      const distSup = Math.abs(curP - nearSupport);
      const distRes = Math.abs(curP - nearResistance);
      const thresh  = 0.3 * MV_long;
      if (distSup < thresh && Accel > 0) {
        const key   = Math.round(nearSupport * 10) / 10;
        const tc    = ind.levelMap[key] || 0;
        const conf  = tc * 0.5 + Math.abs(Accel) * 2;
        return { mode: 'SR_BOUNCE', direction: 'HIGHER', rawConf: conf };
      }
      if (distRes < thresh && Accel < 0) {
        const key   = Math.round(nearResistance * 10) / 10;
        const tc    = ind.levelMap[key] || 0;
        const conf  = tc * 0.5 + Math.abs(Accel) * 2;
        return { mode: 'SR_BOUNCE', direction: 'LOWER', rawConf: conf };
      }
    }

    return null; // no trade
  };

  // ── BARRIER SCAN ───────────────────────────────────────────────────────────
  const scanBarrier = (mode, direction, ind) => {
    const { MV_long, MV_short, VR, nearSupport, nearResistance, curP } = ind;
    const ret = returnBuffer;

    // Adaptive drift estimate (weighted recent returns)
    const rBar5  = mean(ret.slice(-5));
    const rBar10 = mean(ret.slice(-10));
    const rBar20 = mean(ret.slice(-20));
    const rBar50 = mean(ret.slice(-50));
    let muAdj = 0.4 * rBar5 + 0.3 * rBar10 + 0.2 * rBar20 + 0.1 * rBar50;
    if (direction === 'LOWER') muAdj = -muAdj;
    muAdj = Math.abs(muAdj);

    const sigAdj = MV_short * (1 + 0.2 * (VR - 1));

    // Candidate barriers (absolute distance)
    const candidates = {
      TREND     : [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40],
      REVERSAL  : [0.03, 0.05, 0.08, 0.10, 0.15],
      BREAKOUT  : [0.15, 0.20, 0.30, 0.40, 0.50, 0.60],
      SR_BOUNCE : [0.03, 0.05, 0.08, 0.10],
    };
    let dList = candidates[mode] || candidates.TREND;

    // Recovery tier compresses barriers
    if (recoveryTier === 1) dList = dList.filter(d => d <= 0.20);
    if (recoveryTier >= 2)  dList = [0.03, 0.05, 0.08, 0.10];

    let bestSR = -999, bestD = dList[0], bestT = 5, bestP = 0.5;

    for (const d of dList) {
      // Optimal duration for this barrier distance
      let T = 5;
      if (muAdj > 0.001) {
        T = Math.round(Math.pow((d * sigAdj) / (muAdj * muAdj), 2/3));
      }
      T = Math.max(3, Math.min(15, T));
      if (mode === 'REVERSAL')  T = Math.min(T, 5);
      if (mode === 'SR_BOUNCE') T = Math.min(T, 4);
      if (mode === 'BREAKOUT')  T = Math.min(T, 8);
      if (recoveryTier >= 2)    T = Math.min(T, 5);

      // Probability estimate (Gaussian drift model)
      const driftT = muAdj * T;
      const noiseT = sigAdj * Math.sqrt(T) || 0.0001;
      const z      = (driftT - d) / noiseT;
      const Pcond  = normalCDF(z);

      // Implied payout estimate (Deriv ~2.4% house edge)
      const zBase  = -d / noiseT;
      let   Pbase  = normalCDF(zBase);
      Pbase        = Math.max(0.05, Math.min(0.95, Pbase));
      const payout = Math.max(0.05, (1 - 0.024) / Pbase - 1);

      // Expected value
      const ev  = Pcond * payout - (1 - Pcond);
      const vrn = Pcond * (1 - Pcond) * Math.pow(1 + payout, 2);
      const sr  = vrn > 0 ? ev / Math.sqrt(vrn) : 0;

      if (sr > bestSR && ev > 0.02) {
        bestSR = sr; bestD = d; bestT = T; bestP = Pcond;
      }
    }

    if (bestSR <= 0) return null; // no positive EV found

    // S/R adjustment — avoid placing barrier through a wall
    let barrierDist = bestD;
    if (direction === 'HIGHER' && nearResistance) {
      const distToRes = nearResistance - curP;
      if (barrierDist > distToRes && distToRes > 0) barrierDist = distToRes * 0.9;
    }
    if (direction === 'LOWER' && nearSupport) {
      const distToSup = curP - nearSupport;
      if (barrierDist > distToSup && distToSup > 0) barrierDist = distToSup * 0.9;
    }
    barrierDist = Math.max(0.01, barrierDist);

    return {
      dist     : barrierDist,
      duration : bestT,
      Pcond    : bestP,
      sigAdj,
    };
  };

  // ── CONFIDENCE SCORE (0–10) ────────────────────────────────────────────────
  const computeConfidence = (mode, rawConf, ind) => {
    // normalise rawConf per mode
    const maxByMode = { TREND: 12, REVERSAL: 10, BREAKOUT: 14, SR_BOUNCE: 8 };
    const norm = Math.min(rawConf / (maxByMode[mode] || 10), 1.0);
    // Scale to 6–10 so only strong signals pass (base = 6 for valid entry)
    return 4 + norm * 6; // 4..10
  };

  // ── STAKE CALCULATION ──────────────────────────────────────────────────────
  const calcStake = (conf, mode, Pcond, payout) => {
    const bal  = Auth.getBalance() || stats.startBalance || 10;
    const mods = { TREND: 1.0, REVERSAL: 0.7, BREAKOUT: 0.8, SR_BOUNCE: 0.9 };

    // Health modifier
    let health = 1.0;
    const sb = stats.startBalance || bal;
    if (bal > sb * 0.95)      health = 1.1;
    else if (bal < sb * 0.60) health = 0.4;
    else if (bal < sb * 0.80) health = 0.7;

    // Quarter-Kelly
    const kellyF = payout > 0 ? (Pcond * (1 + payout) - 1) / payout : 0;
    if (kellyF <= 0) return config.baseStake;

    const stake = bal * (kellyF / 4) * (mods[mode] || 1.0) * health;
    return Math.max(0.35, Math.min(bal * 0.05, stake));
  };

  // ── PINCH HEDGE — both sides near-50/50 in compression ────────────────────
  const tryPinchTrade = (ind) => {
    if (!config.enablePinch) return;
    const { VR, MV_long } = ind;
    if (VR >= 0.5) return; // only in strong compression

    // Barrier just inside current price on both sides
    const d   = Math.max(0.05, MV_long * 0.8);
    const dur = 4;
    const stake = Math.max(0.35, config.baseStake * 0.5);

    log(`⬡ PINCH HEDGE | VR:${VR.toFixed(2)} | barrier:±${d.toFixed(3)} | dur:${dur}t`, 'info');

    // Place HIGHER side
    placeTrade_HL('CALL', d, dur, stake, 'pinch-higher');
    // Place LOWER side (2s offset to avoid race on same tick)
    setTimeout(() => {
      if (isRunning) placeTrade_HL('PUT', -d, dur, stake, 'pinch-lower');
    }, 1500);
  };

  // ── PLACE TRADE ────────────────────────────────────────────────────────────
  const placeTrade_HL = (contract, barrierDist, duration, stake, label = '') => {
    if (!isRunning || waitingForResult) return;
    if (!DerivAPI.isAuthorized) return;

    waitingForResult = true;
    const signedBarrier = barrierDist >= 0
      ? `+${Math.abs(barrierDist).toFixed(3)}`
      : `-${Math.abs(barrierDist).toFixed(3)}`;

    log(`📤 Trade | ${contract} | barrier:${signedBarrier} | ${duration}t | $${stake.toFixed(2)} ${label}`, 'info');

    lastEntryPrice = priceBuffer[priceBuffer.length - 1] || 0;
    lastBarrierPrice = lastEntryPrice + barrierDist;

    DerivAPI.getProposal({
      symbol       : config.symbol,
      contractType : contract,
      duration     : duration,
      durationUnit : 't',
      stake        : parseFloat(stake.toFixed(2)),
      barrier      : signedBarrier,
    });
  };

  // ── RECOVERY LOGIC ─────────────────────────────────────────────────────────
  const executeRecovery = (ind) => {
    // Diagnose why last trade lost
    const finalP = priceBuffer[priceBuffer.length - 1] || lastEntryPrice;
    let diagnosis = 'WRONG_DIRECTION';
    if (lastDirection === 'HIGHER') {
      if (finalP > lastEntryPrice && finalP < lastBarrierPrice) diagnosis = 'BARRIER_TOO_FAR';
      else if (finalP <= lastEntryPrice) diagnosis = 'WRONG_DIRECTION';
      else diagnosis = 'VOLATILITY_SURPRISE';
    } else if (lastDirection === 'LOWER') {
      if (finalP < lastEntryPrice && finalP > lastBarrierPrice) diagnosis = 'BARRIER_TOO_FAR';
      else if (finalP >= lastEntryPrice) diagnosis = 'WRONG_DIRECTION';
      else diagnosis = 'VOLATILITY_SURPRISE';
    }

    log(`↺ Recovery T${recoveryTier} | ${diagnosis} | losses:${lossStreak}`, 'warning');

    if (recoveryTier === 0) return; // shouldn't happen

    // Tiers 3–4: switch to digit contracts
    if (recoveryTier >= 3) {
      const recoverStake = (cumChainLoss + config.baseStake) / (recoveryTier === 3 ? 0.35 : 0.105);
      const type         = recoveryTier === 3 ? 'DIGITOVER' : 'DIGITOVER';
      const barrier      = recoveryTier === 3 ? '2' : '0';
      log(`🔄 Contract switch: OVER ${barrier} | stake:$${recoverStake.toFixed(2)}`, 'warning');

      waitingForResult = true;
      DerivAPI.getProposal({
        symbol       : config.symbol,
        contractType : type,
        duration     : 1,
        durationUnit : 't',
        stake        : Math.max(0.35, parseFloat(recoverStake.toFixed(2))),
        barrier      : barrier,
      });
      return;
    }

    // Tiers 1–2: barrier-compressed H/L recovery
    const barriers = recoveryTier === 1 ? [0.03, 0.05, 0.08, 0.10, 0.15, 0.20] : [0.03, 0.05, 0.08];
    const dur = Math.max(3, lastDuration - 1);

    // Use best signal or fall back to last direction
    const sig = selectMode(ind);
    const dir = sig ? sig.direction : (lastDirection || 'HIGHER');
    const d   = barriers[Math.min(recoveryTier, barriers.length - 1)];
    const recStake = recoveryTier === 1
      ? Math.min(currentStake * 1.4, Auth.getBalance() * 0.15)
      : Math.max(0.35, (cumChainLoss + config.baseStake) / Math.max(0.10, 0.50));

    currentStake = recStake;
    const contract = dir === 'HIGHER' ? 'CALL' : 'PUT';
    const distSigned = dir === 'HIGHER' ? d : -d;
    placeTrade_HL(contract, distSigned, dur, recStake, `recovery-T${recoveryTier}`);
  };

  // ── MAIN ANALYSIS TICK HANDLER ─────────────────────────────────────────────
  const onNewTick = (tickData) => {
    if (!isRunning) return;

    const price = typeof tickData === 'number' ? tickData : parseFloat(tickData.price || tickData.quote || tickData);
    if (!isFinite(price)) return;

    // Update buffers
    if (priceBuffer.length > 0) {
      returnBuffer.push(price - priceBuffer[priceBuffer.length - 1]);
      if (returnBuffer.length > BUFFER_SIZE - 1) returnBuffer.shift();
    }
    priceBuffer.push(price);
    if (priceBuffer.length > BUFFER_SIZE) priceBuffer.shift();

    updateEMAs(price);
    tickCount++;

    // Need at least 50 ticks before trading
    if (priceBuffer.length < 50) return;
    if (waitingForResult) return;

    // Session limits
    if (stats.pnl >= config.takeProfit) { stop('🎯 Take Profit hit'); return; }
    if (stats.pnl <= -config.stopLoss)  { stop('🛑 Stop Loss hit');   return; }

    // Cooldown
    if (cooldown > 0) { cooldown--; return; }

    const ind = computeIndicators();

    // Recovery path
    if (recoveryTier > 0) {
      executeRecovery(ind);
      return;
    }

    // Pinch hedge check first (low volatility special case)
    if (config.enablePinch && ind.VR < 0.45 && !config.disabledModes.includes('PINCH')) {
      tryPinchTrade(ind);
      return;
    }

    // Normal mode selection
    const signal = selectMode(ind);
    if (!signal) return; // no setup

    const confidence = computeConfidence(signal.mode, signal.rawConf, ind);
    if (confidence < config.minConfidence) {
      log(`⬜ Skip | ${signal.mode} | conf:${confidence.toFixed(1)} < ${config.minConfidence}`, 'info');
      return;
    }

    // Barrier scan
    const scan = scanBarrier(signal.mode, signal.direction, ind);
    if (!scan) {
      log(`⬜ Skip | No positive EV barrier found`, 'info');
      return;
    }

    // Re-estimate payout for Kelly stake
    const sigAdj  = scan.sigAdj || 0.01;
    const zBase   = -scan.dist / (sigAdj * Math.sqrt(scan.duration));
    const Pbase   = Math.max(0.05, Math.min(0.95, normalCDF(zBase)));
    const payout  = Math.max(0.05, (1 - 0.024) / Pbase - 1);

    currentStake = calcStake(confidence, signal.mode, scan.Pcond, payout);

    const contract   = signal.direction === 'HIGHER' ? 'CALL' : 'PUT';
    const distSigned = signal.direction === 'HIGHER' ? scan.dist : -scan.dist;

    lastDirection  = signal.direction;
    lastBarrierDist = scan.dist;
    lastDuration   = scan.duration;

    log(`🔷 ${signal.mode} | ${signal.direction} | conf:${confidence.toFixed(1)}/10 | barrier:${distSigned >= 0 ? '+' : ''}${distSigned.toFixed(3)} | ${scan.duration}t | $${currentStake.toFixed(2)}`, 'success');

    placeTrade_HL(contract, distSigned, scan.duration, currentStake);
  };

  // ── DERIV EVENT HANDLERS ───────────────────────────────────────────────────
  const handleProposal = (proposal) => {
    if (!isRunning || !waitingForResult) return;
    if (!proposal?.id) {
      log('Invalid proposal', 'error');
      waitingForResult = false;
      return;
    }
    log(`Got proposal ${proposal.id} | ask:$${proposal.ask_price}`, 'info');
    DerivAPI.buyContract(proposal.id, proposal.ask_price);
  };

  const handleBuy = (buyData) => {
    if (!isRunning) return;
    stats.runs++;
    activeContractId = buyData.contract_id;
    log(`✔ Bought #${buyData.contract_id} | $${buyData.buy_price} → payout $${buyData.payout}`, 'success');
    emitCb(onTradeCallbacks, {
      contract_id : buyData.contract_id,
      buy_price   : buyData.buy_price,
      payout      : buyData.payout,
      stake       : currentStake,
      direction   : lastDirection,
      symbol      : config.symbol,
    });
    DerivAPI.subscribeOpenContract(buyData.contract_id);
    if (buyData.balance_after) Auth.updateBalance(buyData.balance_after);
    emitStats_();
  };

  const handleSettled = (result) => {
    if (!isRunning) return;
    if (result.contract_id !== activeContractId) return;

    waitingForResult = false;
    activeContractId = null;

    const profit = parseFloat(result.profit || 0);
    const isWon  = result.is_won;

    if (isWon) {
      stats.won++;
      stats.pnl += profit;
      lossStreak        = 0;
      recoveryTier      = 0;
      cumChainLoss      = 0;
      currentStake      = config.baseStake;
      cooldown          = 2;
      log(`✔ WIN +$${profit.toFixed(2)} | P&L:$${stats.pnl.toFixed(2)}`, 'success');
      Utils.toast(`WIN +$${profit.toFixed(2)}`, 'success', 3000);
    } else {
      stats.lost++;
      const lost = parseFloat(result.buy_price || currentStake);
      stats.pnl  -= lost;
      cumChainLoss += lost;
      lossStreak++;

      log(`✖ LOSS | streak:${lossStreak} | chain:$${cumChainLoss.toFixed(2)} | P&L:$${stats.pnl.toFixed(2)}`, 'error');
      Utils.toast(`LOSS | P&L:$${stats.pnl.toFixed(2)}`, 'error', 3000);

      // Advance recovery tier
      if (lossStreak <= 2)      recoveryTier = 1;
      else if (lossStreak <= 4) recoveryTier = 2;
      else if (lossStreak <= 6) recoveryTier = 3;
      else if (lossStreak <= 8) recoveryTier = 4;
      else {
        // Hard stop — full reset
        log('⛔ Hard stop: too many consecutive losses', 'error');
        stop('Consecutive loss limit reached');
        return;
      }

      if (recoveryTier > config.maxRecoveryTier) {
        stop(`Recovery tier ${recoveryTier} exceeds limit`);
        return;
      }
    }

    emitStats_();

    // TP/SL check
    if (stats.pnl >= config.takeProfit) { stop('🎯 Take Profit hit'); return; }
    if (stats.pnl <= -config.stopLoss)  { stop('🛑 Stop Loss hit');   return; }
  };

  const handleError = (err) => {
    if (!isRunning) return;
    log(`Error [${err.code}]: ${err.message}`, 'error');
    if (err.code === 'AuthorizationRequired' || err.code === 'InvalidToken') {
      stop('Authorization lost'); return;
    }
    if (err.code === 'InsufficientBalance') {
      stop('Insufficient balance'); return;
    }
    // Proposal/buy failure — unlock and retry next tick
    if (err.type === 'proposal' || err.type === 'buy') {
      waitingForResult = false;
    }
  };

  // ── START / STOP ────────────────────────────────────────────────────────────
  const start = (newConfig) => {
    if (isRunning) { log('Already running', 'warning'); return; }
    if (!DerivAPI.isAuthorized) {
      Utils.toast('Not connected to Deriv', 'error');
      return;
    }

    config           = { ...config, ...newConfig };
    isRunning        = true;
    waitingForResult = false;
    lossStreak       = 0;
    recoveryTier     = 0;
    cumChainLoss     = 0;
    currentStake     = parseFloat(config.baseStake);
    cooldown         = 0;
    tickCount        = 0;
    priceBuffer      = [];
    returnBuffer     = [];
    ema8Init         = false;
    ema21Init        = false;
    stats            = { runs:0, won:0, lost:0, pnl:0, startBalance: Auth.getBalance() || 0 };

    log(`▶ H/L Engine started | ${config.symbol} | profile:${config.modeProfile}`, 'success');
    log(`Stake:$${config.baseStake} | TP:$${config.takeProfit} | SL:$${config.stopLoss} | minConf:${config.minConfidence}`, 'info');
    log(`Disabled modes: ${config.disabledModes.join(',') || 'none'}`, 'info');
    log('Collecting 50 ticks before first trade...', 'info');

    Utils.toast('H/L Bot started!', 'success');
    emitStats_();

    // Subscribe to ticks for analysis
    Ticks.subscribe(config.symbol);
  };

  const stop = (reason = 'Manual stop') => {
    if (!isRunning) return;
    isRunning        = false;
    waitingForResult = false;
    activeContractId = null;
    DerivAPI.forgetAll('proposal');
    log(`■ Stopped: ${reason}`, 'warning');
    Utils.toast(`H/L Bot stopped: ${reason}`, 'warning');
    emitStats_();
  };

  // ── EMIT STATS ──────────────────────────────────────────────────────────────
  const emitStats_ = () => {
    emitCb(onStatsCallbacks, {
      ...stats, isRunning, lossStreak, recoveryTier,
      currentStake, baseStake: config.baseStake,
      ticksCollected: priceBuffer.length,
    });
  };

  // ── INIT ────────────────────────────────────────────────────────────────────
  const init = () => {
    DerivAPI.on('proposal',         handleProposal);
    DerivAPI.on('buy',              handleBuy);
    DerivAPI.on('contract_settled', handleSettled);
    DerivAPI.on('error',            handleError);

    // Wire to live tick stream
    Ticks.onTick((td) => onNewTick(td));

    log('HLEngine initialized', 'info');
  };

  return {
    init, start, stop,
    onTrade, onStats, onLog,
    getIsRunning    : () => isRunning,
    getStats        : () => ({ ...stats }),
    getConfig       : () => ({ ...config }),
    getLossStreak   : () => lossStreak,
    getRecoveryTier : () => recoveryTier,
    getCurrentStake : () => currentStake,
  };

})();
