/**
 * ZALO ORACLE PRO
 * FILE: js/ticks.js
 * PURPOSE: Manages live tick streaming, history, digit extraction
 * and feeds data to all analysis tools and charts
 */

const Ticks = (() => {

  // ─── STATE ────────────────────────────────────────────────────────────────
  let currentSymbol  = '1HZ10V';     // Active market symbol
  let tickHistory    = [];           // Array of last N tick prices (floats)
  let tickTimes      = [];           // Matching timestamps (epoch seconds)
  let maxHistory     = 1000;         // Max ticks to keep in memory
  let lastPrice      = null;         // Most recent price
  let lastDigit      = null;         // Last digit of most recent price
  let isSubscribed   = false;        // Whether we're currently subscribed
  let currentPipSize = 2;            // Decimal places for current market (from pip_size)

  // Callbacks registered by other modules
  const onTickCallbacks    = [];
  const onHistoryCallbacks = [];
  const onDigitCallbacks   = [];

  // ─── REGISTER LISTENERS ───────────────────────────────────────────────────
  const onTick    = (fn) => onTickCallbacks.push(fn);
  const onHistory = (fn) => onHistoryCallbacks.push(fn);
  const onDigit   = (fn) => onDigitCallbacks.push(fn);

  // ─── SUBSCRIBE TO A MARKET ────────────────────────────────────────────────
  const subscribe = (symbol) => {
    currentSymbol = symbol || currentSymbol;
    tickHistory   = [];
    tickTimes     = [];
    isSubscribed  = false;

    Utils.terminalLog('terminal', `Subscribing to ${currentSymbol}...`, 'info');

    // First get tick history (last 500 ticks)
    DerivAPI.getTickHistory(currentSymbol, 500);

    // Also subscribe to live ticks
    DerivAPI.subscribeTicks(currentSymbol);

    // Handle incoming tick history
    DerivAPI.on('history', (data) => {
      if (!data || !data.prices) return;

      tickHistory = data.prices.slice(-maxHistory);
      tickTimes   = (data.times || []).slice(-maxHistory);
      // Capture pip_size from history response for accurate digit extraction
      if (data.pip_size) currentPipSize = data.pip_size;
      Utils.terminalLog('terminal', `Loaded ${tickHistory.length} ticks for ${currentSymbol} (dp:${currentPipSize})`, 'success');

      // Fire history callbacks — pass {prices, times} object
      onHistoryCallbacks.forEach(fn => fn({ prices: [...tickHistory], times: [...tickTimes] }));

      isSubscribed = true;
    });

    // Handle live ticks
    DerivAPI.on('tick', (data) => {
      if (!data || data.symbol !== currentSymbol) return;

      // Preserve pip_size for correct digit extraction (trailing zero fix)
      if (data.pip_size) currentPipSize = data.pip_size;
      const price = parseFloat(data.quote);
      const digit = Utils.getLastDigit(price, currentPipSize);
      const prev  = lastPrice;

      lastPrice  = price;
      lastDigit  = digit;

      // Add to history, remove oldest if over limit
      tickHistory.push(price);
      tickTimes.push(data.epoch || Math.floor(Date.now() / 1000));
      if (tickHistory.length > maxHistory) {
        tickHistory.shift();
        tickTimes.shift();
      }

      // Build tick object with all useful data
      const tickData = {
        price      : price,
        digit      : digit,
        prev       : prev,
        direction  : prev === null ? 'neutral' : price > prev ? 'up' : price < prev ? 'down' : 'neutral',
        isEven     : Utils.isEven(digit),
        isOdd      : Utils.isOdd(digit),
        symbol     : data.symbol,
        epoch      : data.epoch,
        time       : Utils.formatTimestamp(data.epoch),
        historyLen : tickHistory.length,
      };

      // Update all price display elements on page
      updatePriceDisplays(tickData);

      // Fire callbacks
      onTickCallbacks.forEach(fn => fn(tickData));
      onDigitCallbacks.forEach(fn => fn(digit, tickData));
    });
  };

  // ─── CHANGE MARKET ────────────────────────────────────────────────────────
  const changeMarket = (symbol) => {
    DerivAPI.unsubscribeTicks();
    setTimeout(() => subscribe(symbol), 500);
  };

  // ─── UPDATE ALL PRICE DISPLAYS ON PAGE ────────────────────────────────────
  const updatePriceDisplays = (tickData) => {
    // Update elements with data-price attribute
    const priceEls = document.querySelectorAll('[data-price]');
    priceEls.forEach(el => {
      el.textContent = tickData.price.toFixed(getDecimalPlaces(tickData.price));
      el.className   = el.className.replace(/\bup\b|\bdown\b/g, '').trim();
      el.classList.add(tickData.direction);
    });

    // Update last digit displays
    const digitEls = document.querySelectorAll('[data-last-digit]');
    digitEls.forEach(el => {
      el.textContent = tickData.digit;
    });

    // Update parity displays
    const parityEls = document.querySelectorAll('[data-parity]');
    parityEls.forEach(el => {
      el.textContent = tickData.isEven ? 'EVEN' : 'ODD';
      el.className   = el.className.replace(/\beven\b|\bodd\b/g, '').trim();
      el.classList.add(tickData.isEven ? 'even' : 'odd');
    });
  };

  // ─── GET DECIMAL PLACES FROM PRICE ────────────────────────────────────────
  const getDecimalPlaces = (price) => {
    const str = price.toString();
    const dec = str.indexOf('.');
    return dec >= 0 ? str.length - dec - 1 : 0;
  };

  // ─── GETTERS ──────────────────────────────────────────────────────────────
  const getHistory    = ()  => [...tickHistory];
  const getLastPrice  = ()  => lastPrice;
  const getLastDigit  = ()  => lastDigit;
  const getSymbol     = ()  => currentSymbol;
  const getCount      = ()  => tickHistory.length;

  // Get last N ticks
  const getLastN = (n = 100) => tickHistory.slice(-n);

  // Get current pip size
  const getPipSize = () => currentPipSize;

  // Get digit stats for last N ticks
  const getDigitStats = (n = 100) => {
    return Utils.calcDigitStats(getLastN(n), currentPipSize);
  };

  // Get even/odd stats for last N ticks
  const getEvenOdd = (n = 100) => {
    return Utils.calcEvenOdd(getLastN(n));
  };

  // Get over/under stats for last N ticks
  const getOverUnder = (barrier = 5, n = 100) => {
    return Utils.calcOverUnder(getLastN(n), barrier);
  };

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return {
    subscribe,
    changeMarket,
    onTick,
    onHistory,
    onDigit,
    getHistory,
    getLastPrice,
    getLastDigit,
    getSymbol,
    getCount,
    getLastN,
    getDigitStats,
    getEvenOdd,
    getOverUnder,
    getPipSize,
  };

})();
