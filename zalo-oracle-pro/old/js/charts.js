/**
 * ZALO ORACLE PRO
 * FILE: js/charts.js
 * PURPOSE: TradingView Lightweight Charts integration
 * Handles price chart rendering and live tick updates
 */

const Charts = (() => {

  let chart     = null;   // Chart instance
  let lineSeries = null;  // Line series
  let tickBuffer = [];    // Buffer of tick data points

  // ─── INIT LINE CHART ──────────────────────────────────────────────────────
  const initLineChart = (containerId) => {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Destroy existing chart if any
    if (chart) { chart.remove(); chart = null; }

    chart = LightweightCharts.createChart(container, {
      width           : container.clientWidth,
      height          : 400,
      layout: {
        background    : { color: '#0d1117' },
        textColor     : '#8899aa',
      },
      grid: {
        vertLines   : { color: '#1e2d40' },
        horzLines   : { color: '#1e2d40' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor : '#1e2d40',
        textColor   : '#8899aa',
      },
      timeScale: {
        borderColor     : '#1e2d40',
        timeVisible     : true,
        secondsVisible  : true,
      },
    });

    lineSeries = chart.addLineSeries({
      color           : '#00d4ff',
      lineWidth       : 2,
      crosshairMarkerVisible : true,
      crosshairMarkerRadius  : 4,
      lastValueVisible       : true,
      priceLineVisible       : true,
      priceLineColor         : '#f5a623',
      priceLineWidth         : 1,
      priceLineStyle         : LightweightCharts.LineStyle.Dashed,
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (chart && container) {
        chart.applyOptions({ width: container.clientWidth });
      }
    });
    resizeObserver.observe(container);

    return chart;
  };

  // ─── LOAD HISTORY ─────────────────────────────────────────────────────────
  const loadHistory = (prices) => {
    if (!lineSeries || !prices || prices.length === 0) return;

    // We need timestamps — generate fake sequential ones if needed
    // Deriv history gives prices array; we estimate time going backwards from now
    const now    = Math.floor(Date.now() / 1000);
    const data   = prices.map((price, i) => ({
      time  : now - (prices.length - i),
      value : parseFloat(price),
    }));

    tickBuffer = data;
    lineSeries.setData(data);
  };

  // ─── ADD LIVE TICK ────────────────────────────────────────────────────────
  const addTick = (price, epoch) => {
    if (!lineSeries) return;

    const point = {
      time  : epoch || Math.floor(Date.now() / 1000),
      value : parseFloat(price),
    };

    tickBuffer.push(point);

    // Keep buffer manageable
    if (tickBuffer.length > 2000) tickBuffer.shift();

    lineSeries.update(point);
  };

  // ─── RESET CHART ──────────────────────────────────────────────────────────
  const reset = () => {
    tickBuffer = [];
    if (lineSeries) lineSeries.setData([]);
  };

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return { initLineChart, loadHistory, addTick, reset };

})();
