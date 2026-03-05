/**
 * ZALO ORACLE PRO
 * FILE: js/bot-engine.js
 *
 * REAL TRADING FLOW (matches Deriv API exactly):
 *
 *   placeTrade()
 *     → getProposal()
 *     → DerivAPI emits 'proposal' → buyContract()
 *     → DerivAPI emits 'buy'      → subscribeOpenContract(contract_id)
 *     → DerivAPI emits 'contract_settled' (is_sold=1)
 *     → handleResult(isWon, profit)
 *     → if running: placeTrade() again
 *
 * The key fix: we ALWAYS wait for contract_settled before placing next trade.
 * Without this, the bot was firing trades back-to-back with no result tracking.
 */

const BotEngine = (() => {

  // ── STATE ──────────────────────────────────────────────────────────────
  let isRunning       = false;
  let waitingForResult= false;  // Locked until current contract settles
  let currentStake    = 0;
  let baseStake       = 0;
  let lossStreak      = 0;
  let activeContractId= null;   // Contract we're waiting on
  let proposalSubId   = null;   // Subscription ID of current proposal

  // ── CONFIG ─────────────────────────────────────────────────────────────
  let config = {
    symbol        : '1HZ10V',
    contractType  : 'DIGITOVER',
    barrier       : 5,
    duration      : 1,
    stake         : 0.35,
    multiplier    : 2.2,
    maxSteps      : 4,
    takeProfit    : 2.00,
    stopLoss      : 3.00,
    maxLosses     : 4,
  };

  // ── STATS ──────────────────────────────────────────────────────────────
  let stats = {
    runs        : 0,
    won         : 0,
    lost        : 0,
    totalStake  : 0,
    totalPayout : 0,
    pnl         : 0,
    startBalance: 0,
  };

  // ── CALLBACKS ──────────────────────────────────────────────────────────
  const onTradeCallbacks  = [];
  const onStatsCallbacks  = [];
  const onLogCallbacks    = [];

  const onTrade  = (fn) => onTradeCallbacks.push(fn);
  const onStats  = (fn) => onStatsCallbacks.push(fn);
  const onLog    = (fn) => onLogCallbacks.push(fn);

  const emit = (list, data) => list.forEach(fn => { try { fn(data); } catch(e){} });

  // ── LOGGING ────────────────────────────────────────────────────────────
  const log = (msg, type = 'info') => {
    console.log(`[BotEngine] [${type.toUpperCase()}] ${msg}`);
    emit(onLogCallbacks, { msg, type, time: Utils.getTime() });
    // Also write to bot-terminal if on the page
    Utils.terminalLog?.('bot-terminal', msg, type);
  };

  // ── SET CONFIG ─────────────────────────────────────────────────────────
  const setConfig = (newConfig) => {
    config       = { ...config, ...newConfig };
    baseStake    = parseFloat(config.stake);
    currentStake = baseStake;
    log(`Config: ${config.contractType} | Market:${config.symbol} | Stake:$${baseStake} | TP:$${config.takeProfit} | SL:$${config.stopLoss}`, 'info');
  };

  // ── START ──────────────────────────────────────────────────────────────
  const start = () => {
    if (isRunning) { log('Already running', 'warning'); return; }
    if (!DerivAPI.isAuthorized) {
      Utils.toast('Not connected to Deriv — please reconnect', 'error');
      log('Cannot start: not authorized', 'error');
      return;
    }

    isRunning         = true;
    waitingForResult  = false;
    lossStreak        = 0;
    currentStake      = parseFloat(config.stake);
    baseStake         = currentStake;
    stats.startBalance= Auth.getBalance();
    stats.pnl         = 0;

    log(`▶ Bot started — ${config.symbol} | ${config.contractType}`, 'success');
    log(`Stake: $${currentStake} | Martingale: x${config.multiplier} (max ${config.maxSteps} steps)`, 'info');
    log(`Take Profit: $${config.takeProfit} | Stop Loss: $${config.stopLoss}`, 'info');
    Utils.toast('Bot started!', 'success');

    emitStats();
    placeTrade();
  };

  // ── STOP ───────────────────────────────────────────────────────────────
  const stop = (reason = 'Manual stop') => {
    if (!isRunning) return;
    isRunning        = false;
    waitingForResult = false;
    activeContractId = null;

    // Clean up any open proposal subscriptions
    DerivAPI.forgetAll('proposal');

    log(`■ Bot stopped: ${reason}`, 'warning');
    Utils.toast(`Bot stopped: ${reason}`, 'warning');
    emitStats();
  };

  // ── PLACE TRADE ────────────────────────────────────────────────────────
  const placeTrade = () => {
    if (!isRunning || waitingForResult) return;

    // TP / SL check BEFORE placing
    if (stats.pnl >= parseFloat(config.takeProfit)) {
      stop(`🎯 Take Profit hit: +$${stats.pnl.toFixed(2)}`);
      return;
    }
    if (stats.pnl <= -parseFloat(config.stopLoss)) {
      stop(`🛑 Stop Loss hit: -$${Math.abs(stats.pnl).toFixed(2)}`);
      return;
    }

    waitingForResult = true;
    log(`Placing trade #${stats.runs + 1} | ${config.contractType} | Stake: $${currentStake.toFixed(2)}`, 'info');

    DerivAPI.getProposal({
      symbol       : config.symbol,
      contractType : config.contractType,
      duration     : config.duration || 1,
      durationUnit : 't',
      stake        : currentStake,
      barrier      : config.barrier !== undefined ? String(config.barrier) : undefined,
    });
  };

  // ── HANDLE PROPOSAL → BUY ──────────────────────────────────────────────
  const handleProposal = (proposal) => {
    if (!isRunning || !waitingForResult) return;
    if (!proposal?.id) {
      log('Got invalid proposal', 'error');
      waitingForResult = false;
      setTimeout(placeTrade, 1000);
      return;
    }
    log(`Got proposal ${proposal.id} | Ask: $${proposal.ask_price} | Payout: $${proposal.payout}`, 'info');
    DerivAPI.buyContract(proposal.id, proposal.ask_price);
  };

  // ── HANDLE BUY CONFIRMATION ────────────────────────────────────────────
  const handleBuy = (buyData) => {
    if (!isRunning) return;

    stats.runs++;
    stats.totalStake += parseFloat(buyData.buy_price || 0);
    activeContractId  = buyData.contract_id;

    log(`✔ Contract #${buyData.contract_id} purchased | Buy: $${buyData.buy_price} | Payout: $${buyData.payout}`, 'success');

    emit(onTradeCallbacks, {
      contract_id : buyData.contract_id,
      buy_price   : buyData.buy_price,
      payout      : buyData.payout,
      stake       : currentStake,
      type        : config.contractType,
      symbol      : config.symbol,
    });

    // NOW subscribe to get the result — this is the critical step
    DerivAPI.subscribeOpenContract(buyData.contract_id);

    // Update balance display immediately with balance_after
    if (buyData.balance_after) {
      Auth.updateBalance(buyData.balance_after);
    }

    emitStats();
  };

  // ── HANDLE CONTRACT RESULT (the money event) ──────────────────────────
  const handleSettled = (result) => {
    if (!isRunning) return;
    if (result.contract_id !== activeContractId) return; // Not our contract

    waitingForResult = false;
    activeContractId = null;

    const profit  = parseFloat(result.profit);
    const isWon   = result.is_won;

    if (isWon) {
      // ── WIN ──────────────────────────────────────────────────────────
      stats.won++;
      stats.pnl      += profit;
      stats.totalPayout += parseFloat(result.payout || 0);
      lossStreak      = 0;
      currentStake    = baseStake; // Reset to base stake after win

      log(`✔ WIN! Profit: +$${profit.toFixed(2)} | P&L: $${stats.pnl.toFixed(2)}`, 'success');
      Utils.toast(`WIN +$${profit.toFixed(2)}`, 'success', 3000);

    } else {
      // ── LOSS ─────────────────────────────────────────────────────────
      stats.lost++;
      stats.pnl  -= parseFloat(result.buy_price || currentStake);
      lossStreak++;

      log(`✖ LOSS | Streak: ${lossStreak} | P&L: $${stats.pnl.toFixed(2)}`, 'error');
      Utils.toast(`LOSS | P&L: $${stats.pnl.toFixed(2)}`, 'error', 3000);

      // Apply martingale if under max steps
      if (lossStreak < parseInt(config.maxSteps)) {
        currentStake = parseFloat((currentStake * parseFloat(config.multiplier)).toFixed(2));
        // Safety: don't exceed a reasonable max
        const maxAllowed = baseStake * Math.pow(parseFloat(config.multiplier), parseInt(config.maxSteps));
        if (currentStake > maxAllowed) currentStake = maxAllowed;
        log(`↑ Martingale step ${lossStreak}: New stake $${currentStake.toFixed(2)}`, 'warning');
      } else {
        // Max steps hit — reset and pause or stop
        currentStake = baseStake;
        lossStreak   = 0;
        log(`↺ Max martingale steps (${config.maxSteps}) reached — resetting stake to $${baseStake}`, 'warning');
      }
    }

    emitStats();

    // TP/SL check AFTER result
    if (stats.pnl >= parseFloat(config.takeProfit)) {
      stop(`🎯 Take Profit hit: +$${stats.pnl.toFixed(2)}`);
      return;
    }
    if (stats.pnl <= -parseFloat(config.stopLoss)) {
      stop(`🛑 Stop Loss hit: -$${Math.abs(stats.pnl).toFixed(2)}`);
      return;
    }

    // Place next trade after a short delay to avoid API spam
    if (isRunning) {
      setTimeout(placeTrade, 600);
    }
  };

  // ── HANDLE ERRORS ──────────────────────────────────────────────────────
  const handleError = (err) => {
    if (!isRunning) return;

    log(`Error: [${err.code}] ${err.message}`, 'error');

    // If proposal failed (e.g. invalid barrier), retry after delay
    if (err.type === 'proposal' || err.code === 'ContractCreationFailure'
        || err.code === 'InputValidationFailed') {
      waitingForResult = false;
      log('Retrying trade in 3s...', 'warning');
      setTimeout(placeTrade, 3000);
      return;
    }

    // If buy failed
    if (err.type === 'buy') {
      waitingForResult = false;
      log('Buy failed — retrying in 2s...', 'warning');
      setTimeout(placeTrade, 2000);
      return;
    }

    // Auth error — stop the bot
    if (err.code === 'AuthorizationRequired' || err.code === 'InvalidToken') {
      stop('Authorization lost');
      return;
    }

    // InsufficientBalance — stop
    if (err.code === 'InsufficientBalance') {
      stop('Insufficient balance');
      return;
    }
  };

  // ── EMIT STATS ─────────────────────────────────────────────────────────
  const emitStats = () => {
    emit(onStatsCallbacks, {
      ...stats,
      isRunning,
      lossStreak,
      currentStake,
      baseStake,
    });
  };

  // ── INIT — register all DerivAPI event listeners ───────────────────────
  const init = () => {
    DerivAPI.on('proposal',          handleProposal);
    DerivAPI.on('buy',               handleBuy);
    DerivAPI.on('contract_settled',  handleSettled);
    DerivAPI.on('error',             handleError);
    log('BotEngine initialized', 'info');
  };

  // ── RESET STATS ────────────────────────────────────────────────────────
  const resetStats = () => {
    if (isRunning) stop('Reset');
    stats        = { runs:0, won:0, lost:0, totalStake:0, totalPayout:0, pnl:0, startBalance:0 };
    lossStreak   = 0;
    currentStake = parseFloat(config.stake);
    emitStats();
    log('Stats reset', 'info');
  };

  // ── GETTERS ────────────────────────────────────────────────────────────
  const getIsRunning    = () => isRunning;
  const getStats        = () => ({ ...stats });
  const getConfig       = () => ({ ...config });
  const getLossStreak   = () => lossStreak;
  const getCurrentStake = () => currentStake;

  return {
    init,
    start,
    stop,
    setConfig,
    resetStats,
    getIsRunning,
    getStats,
    getConfig,
    getLossStreak,
    getCurrentStake,
    onTrade,
    onStats,
    onLog,
  };

})();
