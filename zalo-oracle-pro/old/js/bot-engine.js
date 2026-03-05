/**
 * ZALO ORACLE PRO
 * FILE: js/bot-engine.js
 * PURPOSE: Full automated trading bot engine
 * Handles martingale, take profit, stop loss, trade loop
 */

const BotEngine = (() => {

  // ─── STATE ────────────────────────────────────────────────────────────────
  let isRunning       = false;
  let isPaused        = false;
  let currentStake    = 0;
  let baseStake       = 0;
  let lossStreak      = 0;
  let waitingResult   = false;  // Waiting for contract result
  let currentContract = null;   // Active contract

  // ─── CONFIG (set by user before running) ──────────────────────────────────
  let config = {
    symbol        : '1HZ10V',
    contractType  : 'DIGITOVER',
    barrier       : 5,
    duration      : 1,
    stake         : 0.50,
    martingale    : 1.5,
    takeProfit    : 10,
    stopLoss      : 5,
    maxMartingale : 5,        // Max martingale steps before reset
  };

  // ─── SESSION STATS ────────────────────────────────────────────────────────
  let stats = {
    runs        : 0,
    won         : 0,
    lost        : 0,
    totalStake  : 0,
    totalPayout : 0,
    pnl         : 0,
    startBalance: 0,
  };

  // ─── CALLBACKS ────────────────────────────────────────────────────────────
  const onStartCallbacks  = [];
  const onStopCallbacks   = [];
  const onTradeCallbacks  = [];
  const onResultCallbacks = [];
  const onStatsCallbacks  = [];

  const onStart  = (fn) => onStartCallbacks.push(fn);
  const onStop   = (fn) => onStopCallbacks.push(fn);
  const onTrade  = (fn) => onTradeCallbacks.push(fn);
  const onResult = (fn) => onResultCallbacks.push(fn);
  const onStats  = (fn) => onStatsCallbacks.push(fn);

  // ─── FIRE CALLBACKS ───────────────────────────────────────────────────────
  const emit = (list, data) => list.forEach(fn => fn(data));

  // ─── APPLY CONFIG ─────────────────────────────────────────────────────────
  const setConfig = (newConfig) => {
    config = { ...config, ...newConfig };
    baseStake    = parseFloat(config.stake);
    currentStake = baseStake;
    Utils.terminalLog('bot-terminal',
      `Config set: ${config.contractType} | Stake $${baseStake} | TP $${config.takeProfit} | SL $${config.stopLoss}`, 'info');
  };

  // ─── START BOT ────────────────────────────────────────────────────────────
  const start = () => {
    if (isRunning) return;
    if (!Auth.getToken()) {
      Utils.toast('Not connected to Deriv', 'error');
      return;
    }

    isRunning        = true;
    isPaused         = false;
    lossStreak       = 0;
    currentStake     = parseFloat(config.stake);
    baseStake        = currentStake;
    stats.startBalance = Auth.getBalance();

    Utils.terminalLog('bot-terminal', '▶ Bot started', 'success');
    Utils.terminalLog('bot-terminal', `Market: ${config.symbol} | Type: ${config.contractType}`, 'info');
    Utils.terminalLog('bot-terminal', `Base Stake: $${currentStake} | Martingale: x${config.martingale}`, 'info');
    Utils.terminalLog('bot-terminal', `Take Profit: $${config.takeProfit} | Stop Loss: $${config.stopLoss}`, 'info');
    Utils.toast('Bot started!', 'success');

    emit(onStartCallbacks, { config, stats });
    updateUI();

    // Place first trade
    placeTrade();
  };

  // ─── STOP BOT ─────────────────────────────────────────────────────────────
  const stop = (reason = 'Manual stop') => {
    isRunning    = false;
    isPaused     = false;
    waitingResult = false;

    Utils.terminalLog('bot-terminal', `■ Bot stopped: ${reason}`, 'warning');
    Utils.toast(`Bot stopped: ${reason}`, 'warning');

    emit(onStopCallbacks, { reason, stats });
    updateUI();
  };

  // ─── PLACE A TRADE ────────────────────────────────────────────────────────
  const placeTrade = () => {
    if (!isRunning || waitingResult) return;

    // Check take profit
    if (stats.pnl >= parseFloat(config.takeProfit)) {
      stop(`Take Profit reached: +$${stats.pnl.toFixed(2)}`);
      return;
    }

    // Check stop loss
    if (stats.pnl <= -parseFloat(config.stopLoss)) {
      stop(`Stop Loss hit: -$${Math.abs(stats.pnl).toFixed(2)}`);
      return;
    }

    waitingResult = true;

    Utils.terminalLog('bot-terminal',
      `Placing trade #${stats.runs + 1} | ${config.contractType} | Stake: $${currentStake.toFixed(2)}`, 'info');

    DerivAPI.getProposal({
      symbol       : config.symbol,
      contractType : config.contractType,
      duration     : config.duration,
      durationUnit : 't',
      stake        : currentStake,
      barrier      : config.barrier !== undefined ? String(config.barrier) : undefined,
    });
  };

  // ─── HANDLE PROPOSAL ──────────────────────────────────────────────────────
  const handleProposal = (proposal) => {
    if (!isRunning) return;
    DerivAPI.buyContract(proposal.id, parseFloat(proposal.ask_price));
  };

  // ─── HANDLE BUY CONFIRMATION ──────────────────────────────────────────────
  const handleBuy = (buyData) => {
    if (!isRunning) return;

    stats.runs++;
    stats.totalStake += parseFloat(buyData.buy_price || 0);

    currentContract = {
      contractId : buyData.contract_id,
      buyPrice   : parseFloat(buyData.buy_price || 0),
      payout     : parseFloat(buyData.payout || 0),
      stake      : currentStake,
      time       : Utils.getTime(),
    };

    Utils.terminalLog('bot-terminal',
      `✔ Contract #${buyData.contract_id} | Buy: $${currentContract.buyPrice}`, 'success');

    emit(onTradeCallbacks, currentContract);
    updateStatsUI();
  };

  // ─── HANDLE CONTRACT RESULT ───────────────────────────────────────────────
  // Note: Deriv sends profit_table or portfolio updates for results
  // For now we simulate win/loss detection via proposal/buy cycle
  const handleResult = (isWin, profit) => {
    if (!isRunning) return;

    waitingResult = false;

    if (isWin) {
      stats.won++;
      stats.totalPayout += profit;
      stats.pnl         += (profit - currentStake);
      lossStreak         = 0;
      currentStake       = baseStake; // Reset to base stake on win

      Utils.terminalLog('bot-terminal',
        `✔ WIN! Profit: +$${(profit - currentStake).toFixed(2)} | P/L: $${stats.pnl.toFixed(2)}`, 'success');
      Utils.toast(`Win! +$${(profit - currentStake).toFixed(2)}`, 'success', 2000);

    } else {
      stats.lost++;
      stats.pnl -= currentStake;
      lossStreak++;

      Utils.terminalLog('bot-terminal',
        `✖ LOSS | Streak: ${lossStreak} | P/L: $${stats.pnl.toFixed(2)}`, 'error');

      // Apply martingale
      if (lossStreak < config.maxMartingale) {
        currentStake = parseFloat((currentStake * config.martingale).toFixed(2));
        Utils.terminalLog('bot-terminal',
          `↑ Martingale applied: New stake $${currentStake}`, 'warning');
      } else {
        // Reset after max martingale steps
        currentStake = baseStake;
        lossStreak   = 0;
        Utils.terminalLog('bot-terminal',
          `↺ Max martingale reached — resetting to base stake $${baseStake}`, 'warning');
      }
    }

    emit(onResultCallbacks, { isWin, profit, pnl: stats.pnl, lossStreak });
    updateStatsUI();

    // Check TP/SL before placing next trade
    if (stats.pnl >= parseFloat(config.takeProfit)) {
      stop(`🎯 Take Profit reached: +$${stats.pnl.toFixed(2)}`);
      return;
    }

    if (stats.pnl <= -parseFloat(config.stopLoss)) {
      stop(`🛑 Stop Loss hit: -$${Math.abs(stats.pnl).toFixed(2)}`);
      return;
    }

    // Place next trade after short delay
    if (isRunning) {
      setTimeout(placeTrade, 500);
    }
  };

  // ─── UPDATE UI ────────────────────────────────────────────────────────────
  const updateUI = () => {
    const runBtn  = document.getElementById('bot-run-btn');
    const runIcon = document.getElementById('bot-run-icon');
    const runText = document.getElementById('bot-run-text');
    const statusEl = document.getElementById('bot-status-badge');

    if (runBtn) {
      runBtn.classList.toggle('running', isRunning);
    }
    if (runIcon) runIcon.textContent = isRunning ? '■' : '▶';
    if (runText) runText.textContent = isRunning ? 'STOP BOT' : 'RUN BOT';
    if (statusEl) {
      statusEl.textContent  = isRunning ? '● RUNNING' : '● STOPPED';
      statusEl.className    = `badge ${isRunning ? 'badge-green' : 'badge-red'}`;
    }
  };

  // ─── UPDATE STATS UI ──────────────────────────────────────────────────────
  const updateStatsUI = () => {
    const pnl = Utils.formatPnL(stats.pnl);
    const map = {
      'bot-stat-runs'   : stats.runs,
      'bot-stat-won'    : stats.won,
      'bot-stat-lost'   : stats.lost,
      'bot-stat-stake'  : Utils.formatNumber(stats.totalStake),
      'bot-stat-payout' : Utils.formatNumber(stats.totalPayout),
      'bot-stat-pnl'    : pnl.text,
      'bot-stat-streak' : lossStreak,
      'bot-next-stake'  : `$${currentStake.toFixed(2)}`,
    };

    Object.entries(map).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = val;
      if (id === 'bot-stat-pnl') el.className = `stat-value ${pnl.cls}`;
      if (id === 'bot-stat-streak' && lossStreak > 2) el.style.color = 'var(--red)';
    });

    emit(onStatsCallbacks, stats);
  };

  // ─── INIT — register Deriv event handlers ─────────────────────────────────
  const init = () => {
    DerivAPI.on('proposal', handleProposal);
    DerivAPI.on('buy',      handleBuy);
    DerivAPI.on('error',    (err) => {
      if (isRunning) {
        Utils.terminalLog('bot-terminal', `Error: ${err.message}`, 'error');
        waitingResult = false;
        setTimeout(placeTrade, 2000); // Retry after 2s on error
      }
    });
  };

  // ─── RESET STATS ──────────────────────────────────────────────────────────
  const resetStats = () => {
    stats        = { runs:0, won:0, lost:0, totalStake:0, totalPayout:0, pnl:0, startBalance:0 };
    lossStreak   = 0;
    currentStake = parseFloat(config.stake);
    updateStatsUI();
  };

  // ─── GETTERS ──────────────────────────────────────────────────────────────
  const getIsRunning  = ()  => isRunning;
  const getStats      = ()  => ({ ...stats });
  const getConfig     = ()  => ({ ...config });
  const getLossStreak = ()  => lossStreak;
  const getCurrentStake = () => currentStake;

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return {
    init,
    start,
    stop,
    setConfig,
    resetStats,
    handleResult,
    getIsRunning,
    getStats,
    getConfig,
    getLossStreak,
    getCurrentStake,
    onStart,
    onStop,
    onTrade,
    onResult,
    onStats,
  };

})();
