/**
 * ZALO ORACLE PRO
 * FILE: js/utils.js
 * PURPOSE: Shared helper functions used across ALL pages
 * Import this on every HTML page — it powers formatting, digits, time, and UI
 */

const Utils = (() => {

  // ─── NUMBER FORMATTERS ────────────────────────────────────────────────────

  // Format a number to fixed decimal places
  // Utils.formatNumber(1234.5678, 2) → "1,234.57"
  const formatNumber = (num, decimals = 2) => {
    if (isNaN(num)) return '0.00';
    return parseFloat(num).toLocaleString('en-US', {
      minimumFractionDigits : decimals,
      maximumFractionDigits : decimals,
    });
  };

  // Format currency with symbol
  // Utils.formatCurrency(100.5, 'USD') → "USD 100.50"
  const formatCurrency = (amount, currency = 'USD') => {
    return `${currency} ${formatNumber(amount, 2)}`;
  };

  // Format profit/loss with + or - sign and color class
  // Returns { text: "+$10.50", cls: "profit" } or { text: "-$5.00", cls: "loss" }
  const formatPnL = (amount) => {
    const num = parseFloat(amount);
    if (isNaN(num)) return { text: '$0.00', cls: 'neutral' };
    const sign = num >= 0 ? '+' : '';
    return {
      text : `${sign}$${formatNumber(Math.abs(num), 2)}`,
      cls  : num > 0 ? 'profit' : num < 0 ? 'loss' : 'neutral',
    };
  };

  // ─── DIGIT EXTRACTION ─────────────────────────────────────────────────────

  // Get the LAST DIGIT of a tick price
  // Utils.getLastDigit(9605.80, 2) → 0  (uses pip_size for correct trailing zeros)
  // Utils.getLastDigit('9605.80') → 0   (string preserved exactly)
  // Utils.getLastDigit(9605.8)    → 8   (float without pip_size - may be wrong for 0s)
  const getLastDigit = (price, pipSize) => {
    // If already a string, use directly - Deriv sometimes sends as string
    if (typeof price === 'string') {
      const s = price.trim();
      return parseInt(s[s.length - 1]);
    }
    // If pip_size known, format correctly to preserve trailing zeros
    if (pipSize !== undefined && pipSize !== null) {
      const s = price.toFixed(pipSize);
      return parseInt(s[s.length - 1]);
    }
    // Fallback: plain toString (may lose trailing zero)
    const str = price.toString();
    return parseInt(str[str.length - 1]);
  };

  // Check if a digit is EVEN or ODD
  const isEven = (digit) => digit % 2 === 0;
  const isOdd  = (digit) => digit % 2 !== 0;

  // Check if last digit is OVER a barrier
  // Utils.isOver(8, 7) → true (8 > 7)
  const isOver  = (digit, barrier) => digit > barrier;
  const isUnder = (digit, barrier) => digit < barrier;

  // ─── DIGIT STATISTICS ─────────────────────────────────────────────────────

  // Given an array of tick prices, return digit frequency stats
  // Returns: { counts: {0:12, 1:8, ...}, percentages: {0:12.0, 1:8.0, ...} }
  const calcDigitStats = (ticks, pipSize) => {
    const counts = { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0 };
    const total  = ticks.length;

    ticks.forEach(price => {
      const d = getLastDigit(price, pipSize);
      counts[d]++;
    });

    const percentages = {};
    for (let i = 0; i <= 9; i++) {
      percentages[i] = total > 0 ? parseFloat(((counts[i] / total) * 100).toFixed(2)) : 0;
    }

    return { counts, percentages, total };
  };

  // Calculate Even vs Odd distribution from array of prices
  const calcEvenOdd = (ticks, pipSize) => {
    let even = 0, odd = 0;
    ticks.forEach(price => {
      getLastDigit(price, pipSize) % 2 === 0 ? even++ : odd++;
    });
    const total = ticks.length || 1;
    return {
      even        : even,
      odd         : odd,
      evenPercent : parseFloat(((even / total) * 100).toFixed(2)),
      oddPercent  : parseFloat(((odd  / total) * 100).toFixed(2)),
    };
  };

  // Calculate Over/Under distribution for a given barrier
  const calcOverUnder = (ticks, barrier = 5, pipSize) => {
    let over = 0, under = 0, matches = 0;
    ticks.forEach(price => {
      const d = getLastDigit(price, pipSize);
      if (d > barrier)      over++;
      else if (d < barrier) under++;
      else                  matches++;
    });
    const total = ticks.length || 1;
    return {
      over          : over,
      under         : under,
      matches       : matches,
      overPercent   : parseFloat(((over    / total) * 100).toFixed(2)),
      underPercent  : parseFloat(((under   / total) * 100).toFixed(2)),
      matchPercent  : parseFloat(((matches / total) * 100).toFixed(2)),
      barrier,
    };
  };

  // Get the most and least frequent digit from stats
  // FIX: start from i=0 so digit 0 is included in hot/cold comparison
  const getHotColdDigits = (percentages) => {
    let hot = 0, cold = 0;
    for (let i = 0; i <= 9; i++) {
      if (percentages[i] > percentages[hot])  hot  = i;
      if (percentages[i] < percentages[cold]) cold = i;
    }
    return { hot, cold };
  };

  // ─── MARTINGALE CALCULATOR ────────────────────────────────────────────────

  // Generate a Martingale sequence
  // Utils.getMartingaleSequence(0.5, 2, 5)
  // → [0.5, 1.0, 2.0, 4.0, 8.0]
  const getMartingaleSequence = (baseStake, multiplier, steps) => {
    const sequence = [];
    let stake = parseFloat(baseStake);
    for (let i = 0; i < steps; i++) {
      sequence.push(parseFloat(stake.toFixed(2)));
      stake *= multiplier;
    }
    return sequence;
  };

  // Calculate required capital buffer for a Martingale sequence
  const getMartingaleBuffer = (baseStake, multiplier, steps) => {
    const seq = getMartingaleSequence(baseStake, multiplier, steps);
    return parseFloat(seq.reduce((a, b) => a + b, 0).toFixed(2));
  };

  // ─── TIME & DATE HELPERS ──────────────────────────────────────────────────

  // Get current time as formatted string
  // Utils.getTime() → "11:24:35"
  const getTime = () => {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  };

  // Get current date-time string
  const getDateTime = () => {
    return new Date().toLocaleString('en-GB');
  };

  // Format a Unix timestamp to readable time
  const formatTimestamp = (unix) => {
    return new Date(unix * 1000).toLocaleTimeString('en-GB', { hour12: false });
  };

  // ─── DOM HELPERS ──────────────────────────────────────────────────────────

  // Safe querySelector — returns null if not found instead of throwing
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

  // Set text content of an element safely
  const setText = (selector, text) => {
    const el = $(selector);
    if (el) el.textContent = text;
  };

  // Set HTML content of an element safely
  const setHTML = (selector, html) => {
    const el = $(selector);
    if (el) el.innerHTML = html;
  };

  // Add CSS class to element
  const addClass = (selector, cls) => {
    const el = $(selector);
    if (el) el.classList.add(cls);
  };

  // Remove CSS class from element
  const removeClass = (selector, cls) => {
    const el = $(selector);
    if (el) el.classList.remove(cls);
  };

  // Toggle CSS class
  const toggleClass = (selector, cls) => {
    const el = $(selector);
    if (el) el.classList.toggle(cls);
  };

  // Show an element (remove hidden)
  const show = (selector) => {
    const el = $(selector);
    if (el) el.style.display = '';
  };

  // Hide an element
  const hide = (selector) => {
    const el = $(selector);
    if (el) el.style.display = 'none';
  };

  // ─── TOAST NOTIFICATION SYSTEM ────────────────────────────────────────────

  // Creates a floating toast notification
  // Utils.toast('Trade placed!', 'success')
  // types: 'success', 'error', 'warning', 'info'
  const toast = (message, type = 'info', duration = 4000) => {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
      `;
      document.body.appendChild(container);
    }

    const colors = {
      success : { bg: '#00ff88', color: '#0a0e1a' },
      error   : { bg: '#ff4757', color: '#ffffff'  },
      warning : { bg: '#f5a623', color: '#0a0e1a'  },
      info    : { bg: '#00d4ff', color: '#0a0e1a'  },
    };

    const icons = {
      success : '✔',
      error   : '✖',
      warning : '⚠',
      info    : 'ℹ',
    };

    const c = colors[type] || colors.info;
    const toastEl = document.createElement('div');
    toastEl.style.cssText = `
      background    : ${c.bg};
      color         : ${c.color};
      padding       : 12px 20px;
      border-radius : 8px;
      font-family   : 'IBM Plex Mono', monospace;
      font-size     : 13px;
      font-weight   : 600;
      pointer-events: auto;
      box-shadow    : 0 4px 20px rgba(0,0,0,0.4);
      display       : flex;
      align-items   : center;
      gap           : 10px;
      min-width     : 260px;
      animation     : toastIn 0.3s ease;
      cursor        : pointer;
    `;
    toastEl.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
    toastEl.onclick   = () => toastEl.remove();

    container.appendChild(toastEl);

    // Auto remove
    setTimeout(() => {
      toastEl.style.opacity   = '0';
      toastEl.style.transform = 'translateX(100%)';
      toastEl.style.transition = 'all 0.3s ease';
      setTimeout(() => toastEl.remove(), 300);
    }, duration);
  };

  // ─── TERMINAL LOG SYSTEM ──────────────────────────────────────────────────

  // Append a line to a terminal console element (like DBTraders screenshot)
  // Utils.terminalLog('terminal-console', 'Connected to server', 'success')
  const terminalLog = (containerId, message, type = 'info') => {
    const el = document.getElementById(containerId);
    if (!el) return;

    const colors = {
      success : '#00ff88',
      error   : '#ff4757',
      warning : '#f5a623',
      info    : '#00d4ff',
      default : '#aaaaaa',
    };

    const prefixes = {
      success : '[OK]',
      error   : '[ERROR]',
      warning : '[WARNING]',
      info    : '[INFO]',
      default : '[LOG]',
    };

    const color  = colors[type]   || colors.default;
    const prefix = prefixes[type] || prefixes.default;
    const time   = getTime();

    const line = document.createElement('div');
    line.style.cssText = `color: ${color}; font-size: 12px; margin: 2px 0; font-family: 'IBM Plex Mono', monospace;`;
    line.textContent   = `[${time}] ${prefix} ${message}`;

    el.appendChild(line);
    el.scrollTop = el.scrollHeight; // Auto-scroll to bottom
  };

  // ─── MARKET SYMBOL MAP ────────────────────────────────────────────────────
  // Maps human-readable names to Deriv API symbols
  const MARKETS = {
    'Volatility 10 Index'     : 'R_10',
    'Volatility 10 (1s) Index': '1HZ10V',
    'Volatility 25 Index'     : 'R_25',
    'Volatility 25 (1s) Index': '1HZ25V',
    'Volatility 50 Index'     : 'R_50',
    'Volatility 50 (1s) Index': '1HZ50V',
    'Volatility 75 Index'     : 'R_75',
    'Volatility 75 (1s) Index': '1HZ75V',
    'Volatility 100 Index'    : 'R_100',
    'Volatility 100 (1s) Index':'1HZ100V',
    'Boom 300 Index'          : 'BOOM300N',
    'Boom 500 Index'          : 'BOOM500',
    'Boom 1000 Index'         : 'BOOM1000',
    'Crash 300 Index'         : 'CRASH300N',
    'Crash 500 Index'         : 'CRASH500',
    'Crash 1000 Index'        : 'CRASH1000',
    'Step Index'              : 'stpRNG',
    'Range Break 100 Index'   : 'RNGBRNK100',
    'Range Break 200 Index'   : 'RNGBRNK200',
  };

  // Get symbol from market name
  const getSymbol = (marketName) => MARKETS[marketName] || marketName;

  // Get all market names as array
  const getMarketNames = () => Object.keys(MARKETS);

  // ─── CONTRACT TYPE MAP ────────────────────────────────────────────────────
  const CONTRACT_TYPES = {
    'Over'    : 'DIGITOVER',
    'Under'   : 'DIGITUNDER',
    'Even'    : 'DIGITEVEN',
    'Odd'     : 'DIGITODD',
    'Matches' : 'DIGITMATCH',
    'Differs' : 'DIGITDIFF',
    'Rise'    : 'CALL',
    'Fall'    : 'PUT',
  };

  const getContractType = (name) => CONTRACT_TYPES[name] || name;

  // ─── DEBOUNCE ─────────────────────────────────────────────────────────────
  // Prevents a function from firing too many times (e.g. on rapid tick updates)
  const debounce = (fn, delay = 300) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };

  // ─── THROTTLE ─────────────────────────────────────────────────────────────
  // Limits a function to fire at most once per interval
  const throttle = (fn, limit = 100) => {
    let lastCall = 0;
    return (...args) => {
      const now = Date.now();
      if (now - lastCall >= limit) {
        lastCall = now;
        fn(...args);
      }
    };
  };

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return {
    // Formatters
    formatNumber,
    formatCurrency,
    formatPnL,
    // Digit tools
    getLastDigit,
    isEven,
    isOdd,
    isOver,
    isUnder,
    calcDigitStats,
    calcEvenOdd,
    calcOverUnder,
    getHotColdDigits,
    // Martingale
    getMartingaleSequence,
    getMartingaleBuffer,
    // Time
    getTime,
    getDateTime,
    formatTimestamp,
    // DOM
    $,
    $$,
    setText,
    setHTML,
    addClass,
    removeClass,
    toggleClass,
    show,
    hide,
    // Notifications
    toast,
    terminalLog,
    // Markets
    MARKETS,
    CONTRACT_TYPES,
    getSymbol,
    getMarketNames,
    getContractType,
    // Performance
    debounce,
    throttle,
  };

})();
