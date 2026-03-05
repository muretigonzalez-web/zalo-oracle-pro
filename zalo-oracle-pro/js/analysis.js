/**
 * ZALO ORACLE PRO
 * FILE: js/analysis.js
 * PURPOSE: Powers all analysis tools — digit stats, even/odd, over/under scanner
 * Used by analysis.html and dashboard.html
 */

const Analysis = (() => {

  // ─── STATE ────────────────────────────────────────────────────────────────
  let scanResults   = [];     // Multi-market scan results
  let isScanning    = false;  // Whether volatility scanner is running
  let scanSymbols   = [       // All symbols to scan
    '1HZ10V','R_10','1HZ25V','R_25','1HZ50V',
    'R_50','1HZ75V','R_75','1HZ100V','R_100'
  ];

  // ─── RENDER DIGIT BARS (horizontal bar chart per digit) ───────────────────
  // containerId: the element to render into
  // stats: result from Utils.calcDigitStats()
  const renderDigitBars = (containerId, stats) => {
    const el = document.getElementById(containerId);
    if (!el || !stats) return;

    const { percentages } = stats;
    const { hot, cold }   = Utils.getHotColdDigits(percentages);

    let html = '';
    for (let i = 0; i <= 9; i++) {
      const pct    = percentages[i];
      const isHot  = i === hot;
      const isCold = i === cold;
      const barCls = isHot ? 'green' : isCold ? 'red' : 'cyan';
      const tag    = isHot ? '<span class="badge badge-green" style="font-size:0.6rem;padding:1px 6px;">HOT</span>'
                   : isCold ? '<span class="badge badge-red" style="font-size:0.6rem;padding:1px 6px;">COLD</span>'
                   : '';

      html += `
        <div class="digit-bar-row">
          <span class="digit-bar-label">${i}</span>
          <div class="progress-bar" style="flex:1;">
            <div class="progress-fill ${barCls}" style="width:${pct}%;transition:width 0.4s ease;"></div>
          </div>
          <span class="digit-bar-pct mono">${pct}%</span>
          ${tag}
        </div>`;
    }

    el.innerHTML = html;
  };

  // ─── RENDER EVEN/ODD BAR CHART ────────────────────────────────────────────
  const renderEvenOdd = (containerId, eoData) => {
    const el = document.getElementById(containerId);
    if (!el || !eoData) return;

    el.innerHTML = `
      <div class="eo-chart">
        <div class="eo-bar-wrap">
          <div class="eo-bar-label text-cyan">EVEN</div>
          <div class="eo-bar-track">
            <div class="eo-bar-fill cyan" style="width:${eoData.evenPercent}%;transition:width 0.5s ease;"></div>
          </div>
          <div class="eo-bar-value mono text-cyan">${eoData.evenPercent}%</div>
          <div class="eo-bar-count mono text-muted">(${eoData.even})</div>
        </div>
        <div class="eo-bar-wrap mt-12">
          <div class="eo-bar-label text-gold">ODD</div>
          <div class="eo-bar-track">
            <div class="eo-bar-fill gold" style="width:${eoData.oddPercent}%;transition:width 0.5s ease;"></div>
          </div>
          <div class="eo-bar-value mono text-gold">${eoData.oddPercent}%</div>
          <div class="eo-bar-count mono text-muted">(${eoData.odd})</div>
        </div>
        <div class="eo-verdict mt-16">
          ${eoData.evenPercent > eoData.oddPercent
            ? `<span class="badge badge-cyan">📊 EVEN is dominant (${eoData.evenPercent}%)</span>`
            : eoData.oddPercent > eoData.evenPercent
            ? `<span class="badge badge-gold">📊 ODD is dominant (${eoData.oddPercent}%)</span>`
            : `<span class="badge badge-green">📊 Balanced (50/50)</span>`
          }
        </div>
      </div>`;
  };

  // ─── RENDER OVER/UNDER ANALYSIS ───────────────────────────────────────────
  const renderOverUnder = (containerId, ouData) => {
    const el = document.getElementById(containerId);
    if (!el || !ouData) return;

    el.innerHTML = `
      <div class="ou-analysis">
        <div class="ou-analysis-row">
          <span class="ou-analysis-label text-green">OVER ${ouData.barrier}</span>
          <div class="progress-bar" style="flex:1;">
            <div class="progress-fill green" style="width:${ouData.overPercent}%;transition:width 0.5s ease;"></div>
          </div>
          <span class="mono text-green">${ouData.overPercent}%</span>
          <span class="mono text-muted">(${ouData.over})</span>
        </div>
        <div class="ou-analysis-row mt-8">
          <span class="ou-analysis-label text-red">UNDER ${ouData.barrier}</span>
          <div class="progress-bar" style="flex:1;">
            <div class="progress-fill red" style="width:${ouData.underPercent}%;transition:width 0.5s ease;"></div>
          </div>
          <span class="mono text-red">${ouData.underPercent}%</span>
          <span class="mono text-muted">(${ouData.under})</span>
        </div>
        <div class="ou-analysis-row mt-8">
          <span class="ou-analysis-label text-cyan">MATCH ${ouData.barrier}</span>
          <div class="progress-bar" style="flex:1;">
            <div class="progress-fill cyan" style="width:${ouData.matchPercent}%;transition:width 0.5s ease;"></div>
          </div>
          <span class="mono text-cyan">${ouData.matchPercent}%</span>
          <span class="mono text-muted">(${ouData.matches})</span>
        </div>
        <div class="ou-verdict mt-16">
          ${ouData.overPercent > ouData.underPercent
            ? `<span class="badge badge-green">📈 OVER ${ouData.barrier} is dominant (${ouData.overPercent}%)</span>`
            : `<span class="badge badge-red">📉 UNDER ${ouData.barrier} is dominant (${ouData.underPercent}%)</span>`
          }
        </div>
      </div>`;
  };

  // ─── RENDER DIGIT SEQUENCE (last N digits as colored bubbles) ─────────────
  const renderDigitSequence = (containerId, ticks, count = 30) => {
    const el = document.getElementById(containerId);
    if (!el) return;

    const last = ticks.slice(-count);
    el.innerHTML = last.map(price => {
      const d    = Utils.getLastDigit(price);
      const type = Utils.isEven(d) ? 'even' : 'odd';
      return `<div class="seq-digit ${type}">${d}</div>`;
    }).join('');
  };

  // ─── RENDER STREAK ANALYSIS ───────────────────────────────────────────────
  // Finds current streak of even/odd/over/under
  const getStreak = (ticks, type = 'even') => {
    let streak = 0;
    for (let i = ticks.length - 1; i >= 0; i--) {
      const d = Utils.getLastDigit(ticks[i]);
      let match = false;
      if (type === 'even'  && Utils.isEven(d))       match = true;
      if (type === 'odd'   && Utils.isOdd(d))        match = true;
      if (type === 'over5' && d > 5)                 match = true;
      if (type === 'under5'&& d < 5)                 match = true;
      if (match) streak++;
      else break;
    }
    return streak;
  };

  // ─── BUILD FULL ANALYSIS REPORT ───────────────────────────────────────────
  // Returns a complete analysis object for a given tick array
  const buildReport = (ticks, barrier = 5) => {
    if (!ticks || ticks.length === 0) return null;

    const digitStats = Utils.calcDigitStats(ticks);
    const evenOdd    = Utils.calcEvenOdd(ticks);
    const overUnder  = Utils.calcOverUnder(ticks, barrier);
    const { hot, cold } = Utils.getHotColdDigits(digitStats.percentages);

    const evenStreak  = getStreak(ticks, 'even');
    const oddStreak   = getStreak(ticks, 'odd');
    const overStreak  = getStreak(ticks, 'over5');
    const underStreak = getStreak(ticks, 'under5');

    return {
      total       : ticks.length,
      digitStats,
      evenOdd,
      overUnder,
      hot,
      cold,
      streaks     : { evenStreak, oddStreak, overStreak, underStreak },
      lastDigit   : Utils.getLastDigit(ticks[ticks.length - 1]),
      timestamp   : Utils.getDateTime(),
    };
  };

  // ─── RENDER FULL REPORT CARD ──────────────────────────────────────────────
  const renderReport = (containerId, report) => {
    const el = document.getElementById(containerId);
    if (!el || !report) return;

    const pnl = report.evenOdd;
    el.innerHTML = `
      <div class="report-grid">
        <div class="report-item">
          <span class="report-label">Total Ticks</span>
          <span class="report-value cyan">${report.total}</span>
        </div>
        <div class="report-item">
          <span class="report-label">Hot Digit</span>
          <span class="report-value gold">${report.hot} (${report.digitStats.percentages[report.hot]}%)</span>
        </div>
        <div class="report-item">
          <span class="report-label">Cold Digit</span>
          <span class="report-value red">${report.cold} (${report.digitStats.percentages[report.cold]}%)</span>
        </div>
        <div class="report-item">
          <span class="report-label">Even %</span>
          <span class="report-value">${pnl.evenPercent}%</span>
        </div>
        <div class="report-item">
          <span class="report-label">Odd %</span>
          <span class="report-value">${pnl.oddPercent}%</span>
        </div>
        <div class="report-item">
          <span class="report-label">Even Streak</span>
          <span class="report-value ${report.streaks.evenStreak > 3 ? 'gold' : ''}">${report.streaks.evenStreak}</span>
        </div>
        <div class="report-item">
          <span class="report-label">Odd Streak</span>
          <span class="report-value ${report.streaks.oddStreak > 3 ? 'gold' : ''}">${report.streaks.oddStreak}</span>
        </div>
        <div class="report-item">
          <span class="report-label">Over Streak</span>
          <span class="report-value ${report.streaks.overStreak > 3 ? 'green' : ''}">${report.streaks.overStreak}</span>
        </div>
        <div class="report-item">
          <span class="report-label">Under Streak</span>
          <span class="report-value ${report.streaks.underStreak > 3 ? 'red' : ''}">${report.streaks.underStreak}</span>
        </div>
        <div class="report-item">
          <span class="report-label">Last Digit</span>
          <span class="report-value cyan">${report.lastDigit}</span>
        </div>
      </div>`;
  };

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return {
    renderDigitBars,
    renderEvenOdd,
    renderOverUnder,
    renderDigitSequence,
    getStreak,
    buildReport,
    renderReport,
  };

})();
