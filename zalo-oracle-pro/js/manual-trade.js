/**
 * ZALO ORACLE PRO
 * FILE: js/manual-trade.js
 * PURPOSE: Handles all manual trade execution
 * Buy contracts, get proposals, track open positions
 */

const ManualTrade = (() => {

  // ─── STATE ────────────────────────────────────────────────────────────────
  let activeProposalId  = null;   // Current proposal ID from Deriv
  let activeProposalPrice = null; // Current proposal price
  let isWaitingProposal = false;  // Waiting for proposal response
  let openContracts     = [];     // Currently open contracts
  let tradeHistory      = [];     // All trades this session

  // Session stats
  let stats = {
    runs   : 0,
    won    : 0,
    lost   : 0,
    stake  : 0,
    payout : 0,
    pnl    : 0,
  };

  // ─── CALLBACKS ────────────────────────────────────────────────────────────
  const onTradeCallbacks  = [];
  const onResultCallbacks = [];

  const onTrade  = (fn) => onTradeCallbacks.push(fn);
  const onResult = (fn) => onResultCallbacks.push(fn);

  // ─── GET TRADE PROPOSAL ───────────────────────────────────────────────────
  // Called before buying — gets the price/payout from Deriv
  const getProposal = ({ symbol, contractType, duration, stake, barrier }) => {
    if (isWaitingProposal) return;
    isWaitingProposal = true;

    DerivAPI.getProposal({
      symbol,
      contractType,
      duration     : duration || 1,
      durationUnit : 't',         // ticks
      stake        : parseFloat(stake),
      barrier      : barrier !== undefined ? barrier : undefined,
    });
  };

  // ─── BUY CONTRACT ─────────────────────────────────────────────────────────
  const buy = ({ symbol, contractType, duration, stake, barrier }) => {
    const token = Auth.getToken();
    if (!token) {
      Utils.toast('Not logged in', 'error');
      return;
    }

    if (!stake || parseFloat(stake) <= 0) {
      Utils.toast('Enter a valid stake amount', 'error');
      return;
    }

    Utils.terminalLog('terminal', `Placing ${contractType} trade | Stake: $${stake}`, 'info');
    Utils.toast(`Placing ${contractType} trade...`, 'info', 2000);

    // Send proposal first, then buy on response
    DerivAPI.getProposal({
      symbol,
      contractType,
      duration     : duration || 1,
      durationUnit : 't',
      stake        : parseFloat(stake),
      barrier      : barrier !== undefined ? String(barrier) : undefined,
    });
  };

  // ─── HANDLE PROPOSAL RESPONSE ─────────────────────────────────────────────
  const handleProposal = (proposal) => {
    isWaitingProposal = false;
    activeProposalId  = proposal.id;
    activeProposalPrice = parseFloat(proposal.ask_price);

    Utils.terminalLog('terminal',
      `Proposal received: ID=${proposal.id} | Price=$${activeProposalPrice}`, 'info');

    // Auto-buy immediately after proposal
    DerivAPI.buyContract(activeProposalId, activeProposalPrice);
  };

  // ─── HANDLE BUY RESPONSE ──────────────────────────────────────────────────
  const handleBuy = (buyData) => {
    stats.runs++;
    stats.stake += parseFloat(buyData.buy_price || 0);

    const trade = {
      contractId   : buyData.contract_id,
      type         : buyData.shortcode || 'Contract',
      buyPrice     : parseFloat(buyData.buy_price || 0),
      payout       : parseFloat(buyData.payout || 0),
      time         : Utils.getTime(),
      status       : 'open',
    };

    openContracts.push(trade);
    tradeHistory.push(trade);

    Utils.terminalLog('terminal',
      `✔ Trade placed! Contract ID: ${buyData.contract_id} | Buy Price: $${trade.buyPrice}`, 'success');
    Utils.toast(`Trade placed! Contract #${buyData.contract_id}`, 'success');

    // Fire callbacks
    onTradeCallbacks.forEach(fn => fn(trade));

    // Update UI stats
    updateStatsUI();
  };

  // ─── HANDLE ERROR ─────────────────────────────────────────────────────────
  const handleError = (err) => {
    isWaitingProposal = false;
    Utils.terminalLog('terminal', `✖ Trade error: ${err.message}`, 'error');
    Utils.toast(`Trade failed: ${err.message}`, 'error');
  };

  // ─── UPDATE SESSION STATS UI ──────────────────────────────────────────────
  const updateStatsUI = () => {
    const pnl = Utils.formatPnL(stats.pnl);

    const map = {
      'mt-stat-runs'   : stats.runs,
      'mt-stat-won'    : stats.won,
      'mt-stat-lost'   : stats.lost,
      'mt-stat-stake'  : Utils.formatNumber(stats.stake),
      'mt-stat-payout' : Utils.formatNumber(stats.payout),
      'mt-stat-pnl'    : pnl.text,
    };

    Object.entries(map).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = val;
        if (id === 'mt-stat-pnl') {
          el.className = `stat-value ${pnl.cls}`;
        }
      }
    });
  };

  // ─── REGISTER DERIV EVENT HANDLERS ────────────────────────────────────────
  const init = () => {
    DerivAPI.on('proposal', handleProposal);
    DerivAPI.on('buy',      handleBuy);
    DerivAPI.on('error',    handleError);
  };

  // ─── RESET SESSION STATS ──────────────────────────────────────────────────
  const resetStats = () => {
    stats = { runs:0, won:0, lost:0, stake:0, payout:0, pnl:0 };
    openContracts = [];
    updateStatsUI();
  };

  // ─── GET STATS ────────────────────────────────────────────────────────────
  const getStats    = ()  => ({ ...stats });
  const getHistory  = ()  => [...tradeHistory];

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return {
    init,
    buy,
    getProposal,
    onTrade,
    onResult,
    resetStats,
    getStats,
    getHistory,
  };

})();
