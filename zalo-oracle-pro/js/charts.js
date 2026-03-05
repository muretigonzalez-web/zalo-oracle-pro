/**
 * ZALO ORACLE PRO — charts.js
 * TradingView Lightweight Charts v3.8 — area chart with real timestamps
 * Includes canvas fallback if library fails to load
 */

const Charts = (() => {

  let chart       = null;
  let areaSeries  = null;
  let container   = null;
  let resizeObs   = null;
  let lastTime    = 0;
  let allData     = [];
  let usingCanvas = false;

  // ─── INIT ─────────────────────────────────────────────────────────────────
  const initLineChart = (containerId) => {
    container = document.getElementById(containerId);
    if (!container) { console.error('[Charts] Container not found:', containerId); return; }

    if (chart) { try { chart.remove(); } catch(e) {} chart = null; areaSeries = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    container.innerHTML = '';
    lastTime = 0; allData = []; usingCanvas = false;

    if (typeof LightweightCharts === 'undefined') {
      console.warn('[Charts] LightweightCharts not found — canvas fallback');
      _initCanvas(); return;
    }

    try {
      chart = LightweightCharts.createChart(container, {
        width  : container.clientWidth  || 800,
        height : container.clientHeight || 380,
        layout : {
          backgroundColor : '#080c14',
          textColor       : '#4a6080',
          fontSize        : 11,
          fontFamily      : "'IBM Plex Mono', monospace",
        },
        grid : {
          vertLines : { color: 'rgba(0,212,255,0.06)', style: 1 },
          horzLines : { color: 'rgba(0,212,255,0.06)', style: 1 },
        },
        crosshair : {
          mode     : LightweightCharts.CrosshairMode.Normal,
          vertLine : { color: 'rgba(0,212,255,0.5)',   labelBackgroundColor: '#0d2030' },
          horzLine : { color: 'rgba(245,166,35,0.5)',  labelBackgroundColor: '#1a1200' },
        },
        rightPriceScale : {
          borderColor  : 'rgba(0,212,255,0.12)',
          scaleMargins : { top: 0.08, bottom: 0.08 },
        },
        timeScale : {
          borderColor    : 'rgba(0,212,255,0.12)',
          timeVisible    : true,
          secondsVisible : true,
          rightOffset    : 6,
        },
      });

      areaSeries = chart.addAreaSeries({
        lineColor   : '#00d4ff',
        lineWidth   : 2,
        topColor    : 'rgba(0,212,255,0.20)',
        bottomColor : 'rgba(0,212,255,0.01)',
        crosshairMarkerVisible         : true,
        crosshairMarkerRadius          : 5,
        crosshairMarkerBorderColor     : '#00d4ff',
        crosshairMarkerBackgroundColor : '#080c14',
        lastValueVisible : true,
        priceLineVisible : true,
        priceLineColor   : 'rgba(245,166,35,0.8)',
        priceLineWidth   : 1,
        priceLineStyle   : LightweightCharts.LineStyle.Dashed,
      });

      _initTooltip();

      resizeObs = new ResizeObserver(() => {
        if (chart && container) {
          chart.applyOptions({
            width  : container.clientWidth,
            height : container.clientHeight || 380,
          });
        }
      });
      resizeObs.observe(container);

      console.log('[Charts] Initialized with LightweightCharts v3');

    } catch (err) {
      console.error('[Charts] Init failed:', err.message);
      _initCanvas();
    }

    return chart;
  };

  // ─── TOOLTIP ──────────────────────────────────────────────────────────────
  const _initTooltip = () => {
    if (!chart || !areaSeries || !container) return;
    const old = container.querySelector('.chart-tooltip');
    if (old) old.remove();

    const tt = document.createElement('div');
    tt.className = 'chart-tooltip';
    tt.style.cssText = 'position:absolute;top:12px;left:12px;z-index:20;pointer-events:none;display:none;' +
      'background:rgba(8,12,20,0.9);border:1px solid rgba(0,212,255,0.3);border-radius:6px;' +
      "padding:8px 12px;font-family:'IBM Plex Mono',monospace;font-size:11px;line-height:1.7;min-width:150px;";
    container.style.position = 'relative';
    container.appendChild(tt);

    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.point) { tt.style.display = 'none'; return; }
      const d = param.seriesData && param.seriesData.get(areaSeries);
      if (d === undefined || d === null) { tt.style.display = 'none'; return; }
      const price = (d.value !== undefined) ? d.value : d;
      const ts    = new Date(param.time * 1000).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      tt.style.display = 'block';
      tt.innerHTML =
        `<span style="color:#4a7090;font-size:10px;">TIME &nbsp;</span><span style="color:#8aa0b8;">${ts}</span><br>` +
        `<span style="color:#4a7090;font-size:10px;">PRICE</span> <span style="color:#00d4ff;font-weight:700;font-size:13px;">${parseFloat(price).toFixed(_dec(price))}</span>`;
    });
  };

  const _dec = (v) => { const s = String(parseFloat(v)); const i = s.indexOf('.'); return i >= 0 ? s.length - i - 1 : 2; };

  // ─── LOAD HISTORY ─────────────────────────────────────────────────────────
  const loadHistory = (historyData) => {
    let prices, times;
    if (Array.isArray(historyData)) { prices = historyData; times = null; }
    else { prices = historyData.prices || []; times = historyData.times || null; }
    if (!prices.length) return;

    const now = Math.floor(Date.now() / 1000);
    let data = prices.map((price, i) => ({
      time  : times && times[i] ? parseInt(times[i]) : now - (prices.length - i),
      value : parseFloat(price),
    }));
    data = _dedupe(data);
    allData  = data;
    lastTime = data.length ? data[data.length - 1].time : 0;

    if (usingCanvas) { _canvasDraw(); return; }
    if (!areaSeries)  return;
    try { areaSeries.setData(data); chart.timeScale().fitContent(); }
    catch (err) { console.error('[Charts] setData error:', err); }
  };

  // ─── ADD LIVE TICK ────────────────────────────────────────────────────────
  const addTick = (price, epoch) => {
    let t = epoch ? parseInt(epoch) : Math.floor(Date.now() / 1000);
    if (t <= lastTime) t = lastTime + 1;
    lastTime = t;
    const pt = { time: t, value: parseFloat(price) };
    allData.push(pt);
    if (allData.length > 2000) allData.shift();
    if (usingCanvas) { _canvasDraw(); return; }
    if (!areaSeries) return;
    try { areaSeries.update(pt); } catch (err) { console.warn('[Charts] update error:', err); }
  };

  // ─── RESET ────────────────────────────────────────────────────────────────
  const reset = () => {
    lastTime = 0; allData = [];
    if (usingCanvas) { _canvasDraw(); return; }
    if (areaSeries) try { areaSeries.setData([]); } catch(e) {}
  };

  // ─── DEDUPE ───────────────────────────────────────────────────────────────
  const _dedupe = (data) => {
    let prev = -Infinity;
    return data.map(pt => { let t = pt.time; if (t <= prev) t = prev + 1; prev = t; return {time:t, value:pt.value}; });
  };

  // ─── CANVAS FALLBACK ──────────────────────────────────────────────────────
  const _initCanvas = () => {
    usingCanvas = true;
    container.innerHTML = '<canvas id="zalo-chart-canvas" style="width:100%;height:100%;display:block;"></canvas>';
    const cv = container.querySelector('#zalo-chart-canvas');
    cv.width  = container.clientWidth  || 800;
    cv.height = container.clientHeight || 380;
    resizeObs = new ResizeObserver(() => {
      cv.width  = container.clientWidth;
      cv.height = container.clientHeight || 380;
      _canvasDraw();
    });
    resizeObs.observe(container);
  };

  const _canvasDraw = () => {
    const cv = container && container.querySelector('#zalo-chart-canvas');
    if (!cv || allData.length < 2) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const p = { t: 20, r: 65, b: 28, l: 10 };
    const iW = W - p.l - p.r, iH = H - p.t - p.b;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#080c14'; ctx.fillRect(0, 0, W, H);

    const vals = allData.map(d => d.value);
    const minV = Math.min(...vals), maxV = Math.max(...vals);
    const rng  = maxV - minV || 1;
    const xOf  = i => p.l + (i / (allData.length - 1)) * iW;
    const yOf  = v => p.t + iH - ((v - minV) / rng) * iH;

    // Grid
    ctx.strokeStyle = 'rgba(0,212,255,0.07)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (i / 4) * iH;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = '#3a5070'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
      ctx.fillText((maxV - (i / 4) * rng).toFixed(_dec(maxV)), W - p.r + 4, y + 4);
    }

    // Area fill
    const grad = ctx.createLinearGradient(0, p.t, 0, p.t + iH);
    grad.addColorStop(0, 'rgba(0,212,255,0.18)');
    grad.addColorStop(1, 'rgba(0,212,255,0.01)');
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(allData[0].value));
    allData.forEach((d, i) => ctx.lineTo(xOf(i), yOf(d.value)));
    ctx.lineTo(xOf(allData.length - 1), p.t + iH);
    ctx.lineTo(xOf(0), p.t + iH);
    ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

    // Line
    ctx.beginPath(); ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 1.8;
    allData.forEach((d, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(d.value)) : ctx.lineTo(xOf(i), yOf(d.value)));
    ctx.stroke();

    // Last price dashed line + dot + label
    const last = allData[allData.length - 1];
    const lx = xOf(allData.length - 1), ly = yOf(last.value);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(245,166,35,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(W - p.r, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#00d4ff';
    ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
    const lbl = last.value.toFixed(_dec(last.value));
    ctx.fillStyle = '#080c14'; ctx.fillRect(W - p.r + 1, ly - 9, p.r - 2, 18);
    ctx.fillStyle = '#00d4ff'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left';
    ctx.fillText(lbl, W - p.r + 4, ly + 4);
  };

  return { initLineChart, loadHistory, addTick, reset };

})();
