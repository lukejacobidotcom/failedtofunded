/*!
 * MarketFramework Positioning Widgets  v1.0.0
 * ------------------------------------------------------------------
 * Embeddable custom elements. One script tag, no dependencies, no build step.
 *
 *   <script src=".../mkfm-widgets.js" async>   (close the tag as usual)
 *   <mkfm-positioning-card symbol="MNQ"></mkfm-positioning-card>
 *   <mkfm-positioning-rail></mkfm-positioning-rail>
 *
 * Everything renders inside a shadow root, so host CSS cannot leak in and
 * widget CSS cannot leak out. Safe to drop into any dashboard.
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';
  if (window.MKFM && window.MKFM.version) return; // already loaded

  // 2.0.0, not 1.1.0. The price layer is gone and the rail's DOM and class
  // names changed wholesale, so anything a host wrote against v1 internals
  // breaks. The custom-element names and attributes are unchanged.
  var VERSION = '2.0.0';

  /* ============================================================
   * 1. CONFIG
   * ========================================================== */
  var CFG = {
    // Data endpoint. This is the SAME endpoint the live Positioning Edge tool
    // at marketframework.com/tools/positioning-edge calls for its cohort chart.
    // It is public and unauthenticated; it returns cohort buckets for all six
    // instruments in one response (winners / losers / all + volumes).
    //
    // It does NOT currently send an Access-Control-Allow-Origin header, so a
    // browser on tradesyncer.com will refuse to read the response. Verified by
    // cross-origin fetch: mode:'cors' throws, mode:'no-cors' returns an opaque
    // response, which means the server answers and only the header is missing.
    // The moment MarketFramework adds that header these widgets go live with
    // no change on TradeSyncer's side. Until then they fall back to the
    // bundled snapshot and keep rendering the last known session.
    //
    // Override globally with window.MKFM_CONFIG.endpoint, or per-element with
    // the `endpoint` attribute (e.g. to point at your own caching proxy).
    // NOTE: no query string here — the interval below is appended at fetch
    // time, so pointing this at a caching proxy needs no other change.
    endpoint: 'https://www.marketframework.com/api/aggregator/cohort-intraday',

    // Grain for the cohort read. 5m is the right read for a headline: a
    // 5-minute bucket carries enough trades that one order cannot move it.
    interval: '5m',

    // ---------------------------------------------------------------------
    // NO PRICE LAYER. This is a compliance boundary, not an omission.
    //
    // TradeSyncer's review (Rodin Kadri, 2026-08-06, changelog v2) removed all
    // prices and % change from these components: redistributing CME price data
    // onto a third party's surface needs a licence that this widget is not
    // covered by. Cohort positioning is MarketFramework's own first-party
    // measurement of its own traders, so it carries no such restriction — it
    // is the only thing here that can be shown, and it is the whole product.
    //
    // What was deleted with it, all of which existed only to defend a price:
    // the delayed-quotes endpoint, the MGC->GC / SIL->SI quote aliases, the
    // reference-close drift band, the prior-close gate, the session-move gate
    // and the changePercent cross-check. Do not reintroduce any of them
    // without a licence in hand.
    // ---------------------------------------------------------------------

    // Plausibility bands for the numbers that remain. Nothing here tries to
    // decide whether a value is *right* — only whether it is possible. A value
    // that fails one of these is not drawn at all: the widget omits that one
    // readout and keeps everything else. Blank is recoverable; a wrong number
    // on a trading dashboard is not.
    sanity: {
      // Cohort shares are a percentage of a population. Outside 0-100 they
      // are definitionally broken. The half point absorbs float noise from
      // the x100 fraction scaling in the adapter.
      cohortMin: -0.5,
      cohortMax: 100.5,
      // The divergence between the two cohorts, in percentage points. Both
      // sides are already gated to 0-100, so the spread is bounded to ±100 by
      // construction; this is a belt-and-braces guard on the printed value.
      maxSpreadPp: 100,
      // Rejections are kept for inspection via MKFM.rejects(). Capped so a
      // feed stuck in a bad state cannot grow the array without bound.
      logCap: 100
    },

    // MKFM.debug(true) also console.warns every rejection as it happens.
    debug: false,

    // The single place the "Powered by MarketFramework" link points at.
    // >>> CHANGE THIS ONE CONSTANT to re-target every widget on every site. <<<
    link: 'https://www.marketframework.com/tools/positioning-edge?utm_source=tradesyncer&utm_medium=widget&utm_campaign=positioning',

    fetchTimeoutMs: 8000,
    refreshMs: 60000,       // poll while the market is open
    staleAfterMs: 15 * 60 * 1000,
    symbols: ['NQ', 'MNQ', 'ES', 'MES', 'MGC', 'SIL'],
    tradesPerDayLabel: '250K trades/day',

    // Rail paging. TradeSyncer's changelog v4 specifies three cards per view
    // with arrow paging and disabled ends. Kept configurable because three is
    // their layout decision for a 1488px container, not a property of the data.
    railPerView: 3,

    // Monogram badges (changelog v5). Deliberately NOT unique: NQ/MNQ both
    // resolve to N and ES/MES both to S, which is how TradeSyncer specced it.
    // Micro and full-size contracts are different products with different
    // trader bases, so the badge alone cannot identify the instrument — the
    // symbol beside it does that, and every badge carries the full name as a
    // title for anyone reading with assistive tech.
    monograms: { NQ: 'N', MNQ: 'N', ES: 'S', MES: 'S', MGC: 'Au', SIL: 'Ag' },

    // Bars are drawn on a 30–70% window rather than 0–100%. Real cohort
    // positioning almost never leaves that band, so a full-width track wastes
    // ~60% of its pixels and makes a 53/47 split look like a dead heat. The
    // printed percentage above each bar is always the true value.
    scaleMin: 30,
    scaleMax: 70
  };
  var SANITY_DEFAULTS = {
    cohortMin: -0.5, cohortMax: 100.5, maxSpreadPp: 100, logCap: 100
  };
  if (window.MKFM_CONFIG) for (var k in window.MKFM_CONFIG) CFG[k] = window.MKFM_CONFIG[k];
  // The override above is a shallow copy, so a host that sets one sanity key
  // would otherwise wipe the rest and leave the gates comparing against
  // undefined — which is always false, i.e. silently gate-open. Backfill.
  if (!CFG.sanity) CFG.sanity = {};
  for (var sk in SANITY_DEFAULTS) {
    if (CFG.sanity[sk] == null) CFG.sanity[sk] = SANITY_DEFAULTS[sk];
  }

  /* ============================================================
   * 2. DESIGN TOKENS
   *
   * Aligned to TradeSyncer's own codebase tokens, per Rodin Kadri's changelog
   * v6 ("blue pixel-verified against your dashboard"). His value supersedes the
   * #146aff this widget previously carried, which was sampled by eye from a
   * screenshot — a value read out of their stylesheet beats a value read off a
   * PNG, so their number wins wherever the two disagree.
   *
   * ONE DELIBERATE DEPARTURE, and it is the only place this file knowingly
   * differs from his spec. v6 sends every bar to chart-negative #ef4444. Both
   * cohort bars rendering in the same colour destroys the single reading the
   * widget exists to deliver — that profitable traders are positioned one way
   * while unprofitable traders are positioned the other. Red-on-red forces the
   * viewer to read two numbers and difference them mentally, which nobody does
   * on a dashboard they came to for something else. So long is green (#10b981,
   * already in his own token set) and short is red (#ef4444, his chart-negative).
   * Flipping back is a one-token edit: set --mkfm-long to #ef4444.
   * ========================================================== */
  var TOKENS = [
    '--mkfm-font: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
    '--mkfm-primary:#156bff;',
    '--mkfm-primary-soft:#e9f0ff;',
    '--mkfm-primary-soft-b:#d4e2ff;',
    '--mkfm-long:#10b981;',
    '--mkfm-long-soft:#e7f8f1;',
    '--mkfm-short:#ef4444;',
    '--mkfm-short-soft:#fdeceb;',
    // The error pill only. shadcn keeps `destructive` a step darker than
    // `chart-negative` so a failure state does not read as a data value.
    '--mkfm-destructive:#dc2626;',
    '--mkfm-destructive-soft:#fdeceb;',
    '--mkfm-ink:#09090b;',
    '--mkfm-muted:#71717a;',
    '--mkfm-faint:#a1a1aa;',
    '--mkfm-surface:#ffffff;',
    '--mkfm-surface-2:#fafafa;',
    '--mkfm-border:#e8e8ea;',
    '--mkfm-hair:#f1f1f2;',
    '--mkfm-tick:#9ca3af;',
    '--mkfm-live:#10b981;',
    '--mkfm-warn:#b45309;',
    '--mkfm-warn-soft:#fff7ed;',
    '--mkfm-radius:12px;',
    '--mkfm-shadow:0 1px 2px rgba(9,9,11,.05);',
    '--mkfm-shadow-pop:0 1px 3px rgba(9,9,11,.10),0 1px 2px rgba(9,9,11,.06);'
  ].join('');

  var DARK = [
    '--mkfm-primary:#4d8cff;',
    '--mkfm-primary-soft:#16233d;',
    '--mkfm-primary-soft-b:#24365c;',
    '--mkfm-long:#34d399;',
    '--mkfm-long-soft:#0d2620;',
    '--mkfm-short:#f87171;',
    '--mkfm-short-soft:#2a1618;',
    '--mkfm-destructive:#f87171;',
    '--mkfm-destructive-soft:#2a1618;',
    '--mkfm-ink:#fafafa;',
    '--mkfm-muted:#a1a1aa;',
    '--mkfm-faint:#71717a;',
    '--mkfm-surface:#0e0e11;',
    '--mkfm-surface-2:#161619;',
    '--mkfm-border:#27272a;',
    '--mkfm-hair:#1f1f23;',
    '--mkfm-tick:#52525b;',
    '--mkfm-live:#34d399;',
    '--mkfm-warn:#fbbf24;',
    '--mkfm-warn-soft:#251c0c;',
    '--mkfm-shadow:0 1px 2px rgba(0,0,0,.4);'
  ].join('');

  var BASE_CSS =
    ':host{' + TOKENS + 'display:inline-block;line-height:1.35;' +
      '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;' +
      'font-family:var(--mkfm-font);color:var(--mkfm-ink);' +
      'font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}' +
    ':host([hidden]){display:none}' +
    ':host([theme="dark"]){' + DARK + '}' +
    '@media (prefers-color-scheme:dark){:host([theme="auto"]){' + DARK + '}}' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'a{color:inherit;text-decoration:none}' +
    'button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}' +
    '@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}';

  /* ============================================================
   * 3. SMALL UTILITIES
   * ========================================================== */
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function fmtNum(n, dp) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtSigned(n, dp) {
    if (n == null || !isFinite(n)) return '—';
    return (n < 0 ? '−' : '+') + fmtNum(Math.abs(n), dp);
  }
  function fmtCount(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  /* ============================================================
   * 3b. SANITY GATES
   *
   * The upstream feed is intermittently wrong in ways that are obvious to a
   * human and invisible to a renderer. The worst cases measured live were in
   * the price fields — ES printing a -99.10% session move, GC printing
   * -37,485.71%, both self-correcting on the next poll — and those fields are
   * now gone on compliance grounds, taking four of the original six gates with
   * them. What remains guards the cohort shares, which is what the widget
   * actually draws.
   *
   * Every number that reaches the DOM passes through one of these. The rule
   * is the same as it always was: a value that cannot be true is not drawn.
   * The widget omits that one readout and renders everything else it still
   * trusts — it does not clamp the value into range (which turns "4000%"
   * into a confident full bar), and it does not throw away good neighbours.
   *
   * Rejections are recorded rather than swallowed. Silent blanking is close
   * to undebuggable in the field, so MKFM.rejects() returns the log and
   * MKFM.debug(true) warns as they happen.
   * ========================================================== */
  var REJECTS = [];

  // Always returns null, so a caller can write `x = reject(...)` and both
  // record the rejection and blank the value in one statement.
  function reject(where, sym, field, value, why) {
    if (REJECTS.length < CFG.sanity.logCap) {
      REJECTS.push({
        at: Date.now(), where: where, sym: sym,
        field: field, value: value, why: why
      });
    }
    if (CFG.debug && window.console && console.warn) {
      console.warn('[MKFM] dropped ' + sym + '.' + field + ' = ' + value +
        ' — ' + why + ' (' + where + ')');
    }
    return null;
  }

  function inRange(v, lo, hi) {
    return v != null && typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
  }

  /* ============================================================
   * 4. MARKET CLOCK  (CME Globex, evaluated in America/New_York)
   * The feed's own sessionStatus wins when present; this is the fallback
   * and is also what produces the "opens in Xh Ym" copy.
   * ========================================================== */
  var etFmt;
  try {
    etFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit'
    });
  } catch (e) { etFmt = null; }

  var DAYNUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function etParts(date) {
    if (!etFmt) { // last-ditch: treat local time as ET rather than throwing
      return { dow: date.getDay(), hour: date.getHours(), minute: date.getMinutes() };
    }
    var out = {}, parts = etFmt.formatToParts(date);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === 'weekday') out.dow = DAYNUM[p.value];
      else if (p.type === 'hour') out.hour = parseInt(p.value, 10) % 24;
      else if (p.type === 'minute') out.minute = parseInt(p.value, 10);
    }
    return out;
  }

  // Globex runs Sun 18:00 ET -> Fri 17:00 ET with a 17:00-18:00 ET daily halt.
  // Exchange holidays are NOT modelled here; on a holiday the feed goes stale
  // and the widget shows the stale chip instead of claiming to be live.
  function marketState(now) {
    var p = etParts(now || new Date());
    var mins = p.hour * 60 + p.minute;
    var open = true, reason = '';
    if (p.dow === 6) { open = false; reason = 'weekend'; }
    else if (p.dow === 0 && mins < 18 * 60) { open = false; reason = 'weekend'; }
    else if (p.dow === 5 && mins >= 17 * 60) { open = false; reason = 'weekend'; }
    else if (mins >= 17 * 60 && mins < 18 * 60) { open = false; reason = 'daily-break'; }
    var toOpen = null;
    if (!open) {
      if (reason === 'daily-break') toOpen = 18 * 60 - mins;
      else {
        var d = p.dow, add = 0;
        if (d === 5) add = (7 - 5 + 0) * 24 * 60 - mins + 18 * 60; // Fri eve -> Sun 18:00
        else if (d === 6) add = 24 * 60 - mins + 18 * 60;          // Sat -> Sun 18:00
        else add = 18 * 60 - mins;                                  // Sun morning
        toOpen = add;
      }
    }
    return { open: open, reason: reason, minutesToOpen: toOpen, et: p };
  }


  function humanDur(mins) {
    if (mins == null) return '';
    if (mins < 60) return Math.max(1, Math.round(mins)) + 'm';
    var h = Math.floor(mins / 60), m = Math.round(mins % 60);
    if (h >= 24) { var d = Math.floor(h / 24); return d + 'd ' + (h % 24) + 'h'; }
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  /* ============================================================
   * 5. DATA LAYER
   * One in-flight request shared by every widget on the page.
   * Always resolves — never rejects — so a widget can always paint
   * something truthful (bundled snapshot + a visible STALE chip).
   * ========================================================== */
  var store = {
    promise: null, data: null, source: null, fetchedAt: 0,
    subs: [], timer: null
  };

  function bundled() {
    var s = window.MKFM_SNAPSHOT;
    return s && s.instruments ? s : null;
  }

  function fetchJSON(url, ms) {
    return new Promise(function (resolve, reject) {
      if (typeof fetch !== 'function') return reject(new Error('nofetch'));
      var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
      var to = setTimeout(function () { ctl && ctl.abort(); reject(new Error('timeout')); }, ms);
      fetch(url, {
        credentials: 'omit', mode: 'cors', cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        clearTimeout(to);
        if (!r.ok) throw new Error('http' + r.status);
        return r.json();
      }).then(resolve, function (e) { clearTimeout(to); reject(e); });
    });
  }

  /* ------------------------------------------------------------
   * ADAPTER — MarketFramework /api/aggregator/cohort-intraday
   *
   * Live shape (verified against the running Positioning Edge tool):
   *   { interval, bucketSeconds, sessionStatus, smoothing,
   *     tickers: [ { symbol,
   *                  series: [ { t, all, winners, losers,
   *                              volAll, volWinners, volLosers } ] } ] }
   *
   * Cohort values arrive as fractions (0.5352 = 53.5% long). The widgets work
   * in percentage points, so they are scaled once here rather than at every
   * render site.
   *
   * This feed carries no price, so `c` is left null. Every price-dependent
   * readout already null-checks, so they simply omit rather than invent.
   * ---------------------------------------------------------- */
  function adaptCohortIntraday(j) {
    if (!j || !j.tickers || !j.tickers.length) return null;
    var pct = function (v) { return (v == null || isNaN(v)) ? null : v * 100; };
    var out = {
      instruments: {},
      sessionStatus: j.sessionStatus,
      bucketSeconds: j.bucketSeconds || 300,
      grain: 'intraday',
      caps: { intraday: true }
    };
    var newest = 0;
    for (var i = 0; i < j.tickers.length; i++) {
      var t = j.tickers[i];
      if (!t || !t.symbol || !t.series || !t.series.length) continue;
      var rows = [];
      for (var k = 0; k < t.series.length; k++) {
        var p = t.series[k];
        if (p.winners == null || p.losers == null) continue;  // thin bucket, skip
        rows.push({
          d: p.t, w: pct(p.winners), l: pct(p.losers), a: pct(p.all),
          v: p.volAll, vw: p.volWinners, vl: p.volLosers, c: null
        });
      }
      if (!rows.length) continue;
      if (rows[rows.length - 1].d > newest) newest = rows[rows.length - 1].d;
      out.instruments[t.symbol] = { name: t.symbol, rows: rows };
    }
    if (!newest) return null;
    // The newest bucket timestamp is the honest "as of" — it is what the
    // freshness chip is measured against, not the moment we happened to fetch.
    out.generatedAt = newest + (out.bucketSeconds || 300);
    out.tradeDate = new Date(newest * 1000).toISOString().slice(0, 10);
    return out;
  }

  // Accepts either the internal snapshot shape or the live MarketFramework
  // shape, so the endpoint can be swapped without touching any widget.
  function adapt(j) {
    if (!j) return null;
    if (j.instruments) return j;
    if (j.tickers) return adaptCohortIntraday(j);
    return null;
  }

  function load(force) {
    if (store.promise && !force) return store.promise;
    var url = CFG.endpoint +
      (CFG.endpoint.indexOf('?') > -1 ? '&' : '?') + 'interval=' + CFG.interval;
    store.promise = fetchJSON(url, CFG.fetchTimeoutMs).then(function (raw) {
      var j = adapt(raw);
      if (!j || !j.instruments) throw new Error('shape');
      store.data = j; store.source = 'live'; store.fetchedAt = Date.now();
      return { data: j, source: 'live', error: null };
    }).catch(function (err) {
      var s = bundled();
      store.data = s; store.source = s ? 'snapshot' : null; store.fetchedAt = Date.now();
      return { data: s, source: s ? 'snapshot' : null, error: err };
    }).then(function (res) {
      for (var i = 0; i < store.subs.length; i++) { try { store.subs[i](res); } catch (e) {} }
      return res;
    });
    return store.promise;
  }

  function subscribe(fn) {
    store.subs.push(fn);
    if (!store.timer) {
      store.timer = setInterval(function () {
        if (document.hidden) return;
        if (!marketState().open) return;      // don't hammer the API overnight
        if (!store.subs.length) return;
        load(true);
      }, CFG.refreshMs);
    }
    return function () {
      var i = store.subs.indexOf(fn);
      if (i > -1) store.subs.splice(i, 1);
    };
  }

  /* ============================================================
   * 6. NORMALISE + DERIVE
   * Accepts both the compact snapshot shape (rows as arrays) and the
   * verbose API shape (rows as objects), so the same widget code works
   * against either without a translation layer at the edge.
   * ========================================================== */
  function rowsOf(inst) {
    if (!inst) return [];
    // Compact array form (bundled snapshot): [date, profitable%, unprofitable%,
    // all%, trades, close, profitableTrades, unprofitableTrades].
    if (inst.r) return inst.r.map(function (a) {
      return { d: a[0], w: a[1], l: a[2], a: a[3], v: a[4], c: a[5], vw: a[6], vl: a[7] };
    });
    // Object form (live API).
    return (inst.rows || []).map(function (o) {
      return { d: o.d, w: o.w, l: o.l, a: o.a, v: o.v, c: o.c, vw: o.vw, vl: o.vl };
    });
  }

  // Everything the widgets display, derived once per instrument.
  // Every field here is computed from real feed values. Nothing is invented.
  function derive(data, sym) {
    var inst = data && data.instruments && data.instruments[sym];
    if (!inst) return null;
    var rows = rowsOf(inst);
    if (!rows.length) return null;
    var last = rows[rows.length - 1];

    // GATE — the cohort shares themselves. These drive the bars, the headline
    // side, and the printed percentages, so a broken pair poisons the whole
    // card and there is nothing worth rendering around it: the instrument is
    // withdrawn, the card shows its branded fallback and the rail skips the
    // cell. This deliberately replaces a clamp(0,100) that used to sit at the
    // bottom of this function, which turned a feed value of 4,000 into a
    // confidently full bar — exactly the failure mode worth preventing.
    //
    // The missing-value case is folded in here rather than returned early
    // above it, which is where it used to sit. An early `return null` withdrew
    // the instrument with no entry in the rejection log, so a null share and a
    // healthy-but-absent instrument were indistinguishable from the console —
    // and the log exists precisely so that "the card is empty" and "the card
    // is empty because the feed sent null at 14:03" are different tickets.
    // inRange() already rejects null, so one gate now covers both.
    var S = CFG.sanity;
    if (!inRange(last.w, S.cohortMin, S.cohortMax) || !inRange(last.l, S.cohortMin, S.cohortMax)) {
      reject('cohort', sym, 'winners/losers', last.w + ' / ' + last.l,
        (last.w == null || last.l == null) ? 'missing from the feed' : 'outside 0-100%');
      return null;
    }

    var dv = last.w - last.l;                 // profitable minus unprofitable, in pp
    var side = last.w > 50.5 ? 'long' : last.w < 49.5 ? 'short' : 'split';

    // Consecutive-session stance run: how many sessions the profitable cohort
    // has been on this side. Real, and it replaces the mockup's "4h 28m",
    // which the daily-bucketed feed cannot produce.
    var run = 0, startIdx = rows.length - 1;
    if (side !== 'split') {
      for (var i = rows.length - 1; i >= 0; i--) {
        var s = rows[i].w > 50.5 ? 'long' : rows[i].w < 49.5 ? 'short' : 'split';
        if (s !== side) break;
        run++; startIdx = i;
      }
    }

    // The derived point move that used to live here ("MNQ +621.25 since") was
    // computed from the cohort feed's close column. It is a price, so it went
    // out with the rest of the price layer on the same compliance grounds, and
    // the m5 intraday move with it. `rows[].c` is deliberately left unread by
    // this file now — see the CFG note. The spread below replaces it, and is a
    // better subline anyway: it is the actual signal rather than context for it.

    // GATE — the divergence. dv is already bounded by construction because both
    // sides passed the 0-100 gate above, so this only fires if the gate bounds
    // are reconfigured incoherently. Cheap, and it keeps the printed headline
    // number from ever being the one thing on the card nobody checked.
    var spread = inRange(dv, -S.maxSpreadPp, S.maxSpreadPp)
      ? dv
      : reject('cohort', sym, 'spread', dv, 'outside ±' + S.maxSpreadPp + 'pp');

    // How long the profitable cohort has held this side, phrased in the units
    // the feed actually resolves. A daily feed can only honestly say
    // "3 sessions"; the 5-minute cohort feed can say "4h 25m", which is what
    // the mockup asked for and what the earlier daily-only feed could not
    // support. `run` counts buckets; bucketSeconds turns it into real time.
    var grain = (data && data.grain) || 'day';
    var bs = (data && data.bucketSeconds) || 0;
    var runMs = grain === 'intraday' ? run * bs * 1000 : null;
    var runLabel;
    if (grain === 'intraday' && runMs != null) {
      var mins = Math.round(runMs / 60000);
      var hrs = Math.floor(mins / 60);
      runLabel = hrs ? hrs + 'h ' + (mins % 60) + 'm' : mins + 'm';
    } else {
      runLabel = run > 1 ? run + ' sessions' : '1 session';
    }

    return {
      sym: sym, name: inst.name || sym, rows: rows, last: last,
      dv: dv, spread: spread, side: side, grain: grain, bucketSeconds: bs,
      // The gate above already rejected anything genuinely out of range, so
      // these clamps now only absorb the ±0.5 float noise the gate tolerates.
      // They are kept because bar geometry divides by the track width and a
      // 100.4% share would draw one pixel past the rail.
      pctLong: clamp(last.w, 0, 100),
      unprofLong: clamp(last.l, 0, 100),
      // Secondary readout, so a bad value blanks itself rather than costing
      // the user the whole instrument.
      allLong: inRange(last.a, S.cohortMin, S.cohortMax) ? clamp(last.a, 0, 100) : null,
      run: run, runMs: runMs, runLabel: runLabel,
      runStart: rows[startIdx] ? rows[startIdx].d : null,
      trades: last.v,
      sig: inst.sig, hits: inst.hits,
      tradeDate: data.tradeDate
    };
  }

  // loading | ok | stale | closed | error | empty
  function statusOf(res, data) {
    if (!data) return 'error';
    if (res && res.error && res.source === 'snapshot') return 'stale';
    var ms = marketState();
    var gen = (data.generatedAt || 0) * 1000;
    var age = gen ? Date.now() - gen : Infinity;
    if (data.sessionStatus === 'closed') return 'closed';
    if (!ms.open) return 'closed';
    if (age > CFG.staleAfterMs) return 'stale';
    return 'ok';
  }

  /* ============================================================
   * 7. SHARED PIECES
   * ========================================================== */
  var LOGO =
    '<svg class="mkfm-logo" viewBox="0 0 14 12" aria-hidden="true" focusable="false">' +
    '<rect x="0" y="5" width="3" height="7" rx="1"/><rect x="5.5" y="2" width="3" height="10" rx="1"/>' +
    '<rect x="11" y="7" width="3" height="5" rx="1"/></svg>';

  function poweredBy(host, extraCls) {
    var href = host.getAttribute('link') || CFG.link;
    var a = el('a', 'mkfm-pb' + (extraCls ? ' ' + extraCls : ''));
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = LOGO + '<span>Powered by MarketFramework</span>';
    return a;
  }

  // Map a true cohort percentage onto the drawn track, which spans
  // CFG.scaleMin..CFG.scaleMax (30..70) rather than 0..100. Cohort positioning
  // lives almost entirely inside that band, so a 0..100 track spends ~60% of
  // its width on territory the data never visits and renders a 53/47 split as
  // a visual dead heat. 50 stays the exact midpoint of 30..70, so the grey
  // tick remains correct at left:50% with no arithmetic.
  function scalePos(pctLong) {
    var lo = CFG.scaleMin, hi = CFG.scaleMax;
    return clamp(((pctLong - lo) / (hi - lo)) * 100, 0, 100);
  }

  // A single positioning bar: blue up to the scaled position, red after, grey
  // tick at the 50/50 line. A value outside the 30-70 window pins to the end
  // and squares off that corner so a clamped bar is visibly distinct from one
  // that merely reaches the edge. The exact percentage is always printed above.
  function barTrack(pctLong, h) {
    var wrap = el('div', 'mkfm-track');
    if (h) wrap.style.setProperty('--h', h + 'px');
    var fill = el('div', 'mkfm-fill');
    var p = scalePos(pctLong);
    if (pctLong >= CFG.scaleMax) fill.className += ' clamp-hi';
    else if (pctLong <= CFG.scaleMin) fill.className += ' clamp-lo';
    fill.style.background =
      'linear-gradient(to right,var(--mkfm-long) 0 ' + p + '%,var(--mkfm-short) ' + p + '% 100%)';
    wrap.appendChild(fill);
    wrap.appendChild(el('i', 'mkfm-tick'));
    return wrap;
  }

  function sideLabel(pctLong) {
    if (pctLong >= 50) return { txt: Math.round(pctLong) + '% long', cls: 'up', num: Math.round(pctLong) + '%', word: 'long' };
    return { txt: Math.round(100 - pctLong) + '% short', cls: 'dn', num: Math.round(100 - pctLong) + '%', word: 'short' };
  }

  /* ------------------------------------------------------------
   * THE SPREAD
   *
   * The gap between the two cohorts, in percentage points, printed as its own
   * number rather than left for the reader to difference. Two 53%-ish bars
   * three points apart and two bars thirteen points apart look nearly
   * identical on a 6px track at rail scale, and the difference between them is
   * the entire signal — a wide spread means the profitable and unprofitable
   * cohorts genuinely disagree, which is the only thing here worth acting on.
   *
   * Signed, because direction matters: positive means the profitable cohort is
   * further long than the unprofitable one. Coloured on the same green/red
   * axis as the bars so the spread and the bars cannot contradict each other
   * at a glance. Returns null when the gate withdrew the value.
   * ---------------------------------------------------------- */
  function spreadLabel(d) {
    if (!d || d.spread == null) return null;
    var v = d.spread;
    var mag = Math.abs(v);
    // Under half a point there is no divergence worth signing. Printing
    // "+0.2pt" in green implies a direction the data does not support, so the
    // sign and the colour are both dropped below that threshold.
    return {
      txt: mag < 0.5 ? '0pt' : fmtSigned(v, mag < 10 ? 1 : 0) + 'pt',
      cls: v > 0.5 ? 'up' : v < -0.5 ? 'dn' : 'nu',
      title: mag < 0.5
        ? 'Both cohorts are positioned the same way — no divergence to read.'
        : 'Profitable traders are ' + mag.toFixed(1) + ' points more ' +
          (v > 0 ? 'long' : 'short') + ' than unprofitable traders.'
    };
  }

  // Instrument monogram badge (changelog v5). The letters are not unique by
  // design — see CFG.monograms. The full instrument name rides along as a
  // title so the badge is never the only thing identifying the cell.
  function monogram(d) {
    var m = (CFG.monograms && CFG.monograms[d.sym]) || d.sym.slice(0, 2);
    var b = el('span', 'mkfm-mono mono-' + m.toLowerCase(), m);
    b.title = d.name;
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  /* ============================================================
   * 8. BASE ELEMENT
   * ========================================================== */
  function defineBase(name, css, render) {
    if (customElements.get(name)) return;

    function Cls() {
      var self = Reflect.construct(HTMLElement, [], Cls);
      self._root = self.attachShadow({ mode: 'open' });
      var st = document.createElement('style');
      st.textContent = BASE_CSS + css;
      self._root.appendChild(st);
      self._body = document.createElement('div');
      self._root.appendChild(self._body);
      self._state = 'loading';
      return self;
    }
    Cls.prototype = Object.create(HTMLElement.prototype);
    Cls.prototype.constructor = Cls;
    Object.setPrototypeOf(Cls, HTMLElement);

    Cls.observedAttributes = ['symbol', 'symbols', 'theme', 'mode', 'link', 'accent', 'force-state'];

    Cls.prototype.connectedCallback = function () {
      // Default LIGHT, not auto. These widgets ship onto a light dashboard,
      // and `auto` follows the viewer's OS setting — so a dark-mode visitor
      // got a black card sitting in a white page. Opt into `dark` or `auto`
      // explicitly; the default should match the host, not the operating system.
      if (!this.hasAttribute('theme')) this.setAttribute('theme', 'light');
      var acc = this.getAttribute('accent');
      if (acc) {
        this.style.setProperty('--mkfm-primary', acc);
        this.style.setProperty('--mkfm-long', acc);
      }
      if (this._mounted) return;
      this._mounted = true;
      var self = this;
      this._paint({ data: null, source: null, error: null }, true);
      this._unsub = subscribe(function (res) { self._paint(res, false); });
      load().then(function (res) { self._paint(res, false); });
    };
    Cls.prototype.disconnectedCallback = function () {
      if (this._unsub) this._unsub();
      // A renderer may have attached a ResizeObserver or a window listener of
      // its own (the rail does, to re-measure its page width). Those outlive
      // the shadow tree unless something tears them down, and a dashboard that
      // mounts and unmounts widgets on route changes would otherwise leak one
      // observer per mount, each still firing against a detached element.
      if (this._mkfmCleanup) { this._mkfmCleanup(); this._mkfmCleanup = null; }
      this._mounted = false;
    };
    Cls.prototype.attributeChangedCallback = function (n, o, v) {
      if (o === v || !this._mounted) return;
      if (n === 'accent') {
        if (v) {
          this.style.setProperty('--mkfm-primary', v);
          this.style.setProperty('--mkfm-long', v);
        } else {
          this.style.removeProperty('--mkfm-primary');
          this.style.removeProperty('--mkfm-long');
        }
      }
      if (this._last) this._paint(this._last, false);
    };
    Cls.prototype.emit = function (type, detail) {
      this.dispatchEvent(new CustomEvent('mkfm:' + type, {
        bubbles: true, composed: true, detail: detail || {}
      }));
    };
    Cls.prototype._paint = function (res, first) {
      this._last = res;
      var data = res && res.data;
      var status = first && !data ? 'loading' : statusOf(res, data);

      // force-state exists so an integrator (or this demo page) can see every
      // degradation state on demand instead of waiting for a weekend or an
      // outage to find out what the widget does. It never engages on its own.
      var forced = this.getAttribute('force-state');
      if (forced) {
        status = forced;
        if (forced === 'error' || forced === 'empty' || forced === 'loading') data = null;
      }

      this._state = status;
      this.setAttribute('data-state', status);
      try {
        render.call(this, this._body, data, status, res);
      } catch (e) {
        this._body.innerHTML = '';
        this._body.appendChild(errorBox(this, 'Widget error'));
        if (window.console) console.error('[mkfm]', e);
        this.emit('error', { error: String(e && e.message || e) });
        return;
      }
      if (!first) {
        this.emit(status === 'error' ? 'error' : 'ready',
          { status: status, source: res && res.source, version: VERSION });
      }
    };
    customElements.define(name, Cls);
    return Cls;
  }

  function errorBox(host, msg) {
    var d = el('div', 'mkfm-fallback');
    d.appendChild(el('div', 'mkfm-fb-msg', msg));
    d.appendChild(poweredBy(host));
    return d;
  }

  /* ============================================================
   * 9. STATUS CHIP — the visible half of graceful degradation
   * ========================================================== */
  // Returns null when the status does not warrant a chip. Callers MUST guard
  // the append. `stale` deliberately returns null: a DELAYED flag on a widget
  // sitting in a partner dashboard reads as "this product is broken" rather
  // than "this reading is a few minutes old", and nothing truthful is lost —
  // the card footer still prints "Cached · <date>" in that state.
  function chipFor(status, res) {
    if (status === 'stale') return null;
    var c = el('span', 'mkfm-chip');
    if (status === 'ok') {
      c.className = 'mkfm-chip live';
      c.innerHTML = '<i></i>LIVE';
      c.title = 'Live positioning, refreshed every 60s';
    } else if (status === 'closed') {
      c.className = 'mkfm-chip closed';
      var ms = marketState();
      c.textContent = 'CLOSED';
      c.title = ms.minutesToOpen != null
        ? 'Market closed — reopens in ' + humanDur(ms.minutesToOpen) + '. Showing the last completed session.'
        : 'Market closed. Showing the last completed session.';
    } else if (status === 'loading') {
      c.className = 'mkfm-chip load';
      c.textContent = '…';
    } else {
      c.className = 'mkfm-chip err';
      c.textContent = 'NO DATA';
    }
    return c;
  }

  /* ============================================================
   * 10. WIDGET A — COMPACT CARD, exactly 360 x 150
   * ------------------------------------------------------------
   * Vertical budget inside the 150px box (all fixed, none elastic):
   *   10 pad-top + 22 head + 6 gap + 19 headline + 14 subline
   *   + 7 gap + 20 bar-row + 4 gap + 20 bar-row  = 122
   *   + 22 footer (absolute, flush bottom) = 144. 6px of slack absorbs
   *   sub-pixel line-height rounding without ever reaching 150.
   * ========================================================== */
  var CARD_CSS =
    ':host{width:360px;height:150px}' +
    ':host([full]){width:100%}' +
    '.mkfm-card{position:relative;width:100%;height:150px;overflow:hidden;' +
      'background:var(--mkfm-surface);border:1px solid var(--mkfm-border);' +
      'border-radius:var(--mkfm-radius);box-shadow:var(--mkfm-shadow)}' +
    '.mkfm-b{padding:10px 12px 0;height:128px;display:flex;flex-direction:column}' +

    '.mkfm-head{height:22px;display:flex;align-items:center;gap:6px;flex:none}' +
    '.mkfm-sel{appearance:none;-webkit-appearance:none;flex:1 1 auto;min-width:0;height:22px;' +
      'padding:0 20px 0 9px;border-radius:999px;font:600 11.5px/22px var(--mkfm-font);' +
      'color:var(--mkfm-primary);background:var(--mkfm-primary-soft);' +
      'border:1px solid var(--mkfm-primary-soft-b);cursor:pointer;' +
      'text-overflow:ellipsis;white-space:nowrap;overflow:hidden;' +
      'background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'5\' viewBox=\'0 0 8 5\'%3E%3Cpath d=\'M1 1l3 3 3-3\' fill=\'none\' stroke=\'%23156bff\' stroke-width=\'1.6\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");' +
      'background-repeat:no-repeat;background-position:right 8px center}' +
    ':host([theme="dark"]) .mkfm-sel,:host([theme="auto"]) .mkfm-sel{background-image:none}' +
    '@media (prefers-color-scheme:light){:host([theme="auto"]) .mkfm-sel{' +
      'background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'5\' viewBox=\'0 0 8 5\'%3E%3Cpath d=\'M1 1l3 3 3-3\' fill=\'none\' stroke=\'%23156bff\' stroke-width=\'1.6\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");' +
      'background-repeat:no-repeat;background-position:right 8px center}}' +
    '.mkfm-sel:focus-visible{outline:2px solid var(--mkfm-primary);outline-offset:1px}' +
    '.mkfm-sel option{color:#09090b;background:#fff}' +

    '.mkfm-chip{flex:none;display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 6px;' +
      'border-radius:999px;font:600 8.5px/1 var(--mkfm-font);letter-spacing:.055em;' +
      'background:var(--mkfm-hair);color:var(--mkfm-muted);cursor:default}' +
    '.mkfm-chip i{width:5px;height:5px;border-radius:50%;background:currentColor;display:block}' +
    '.mkfm-chip.live{background:var(--mkfm-long-soft);color:var(--mkfm-live)}' +
    /* no .stale rule — chipFor() returns null for that state, by design */
    /* destructive, not chart-negative: a failure pill must not read as a data
       value sitting on the same red as a short bar three lines below it. */
    '.mkfm-chip.err{background:var(--mkfm-destructive-soft);color:var(--mkfm-destructive)}' +

    '.mkfm-i{flex:none;width:17px;height:17px;border-radius:50%;border:1px solid var(--mkfm-border);' +
      'color:var(--mkfm-faint);font:600 10px/15px var(--mkfm-font);text-align:center;' +
      'display:flex;align-items:center;justify-content:center}' +
    '.mkfm-i:hover{color:var(--mkfm-muted);border-color:var(--mkfm-tick)}' +
    '.mkfm-i:focus-visible{outline:2px solid var(--mkfm-primary);outline-offset:1px}' +

    /* Weights 500/600 only, per changelog v3/v6. The headline used to sit at
       700 with an 800 emphasis inside it; at 15.5px on a white card that was
       heavier than anything in TradeSyncer's own type scale. */
    '.mkfm-hl{margin-top:6px;height:19px;flex:none;font:500 15.5px/19px var(--mkfm-font);' +
      'letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-hl b{font-weight:600}' +
    '.mkfm-hl .up{color:var(--mkfm-long)}.mkfm-hl .dn{color:var(--mkfm-short)}' +
    '.mkfm-hl .nu{color:var(--mkfm-muted)}' +
    '.mkfm-sub{height:14px;flex:none;font:500 11px/14px var(--mkfm-font);color:var(--mkfm-muted);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'font-variant-numeric:tabular-nums}' +
    /* The spread leads the subline, so it carries the emphasis the price move
       used to. Same green/red axis as the bars, never the primary blue —
       a divergence number that matched the brand colour would read as chrome. */
    '.mkfm-sub b{font-weight:600;font-variant-numeric:tabular-nums}' +
    '.mkfm-sub b.up{color:var(--mkfm-long)}.mkfm-sub b.dn{color:var(--mkfm-short)}' +
    '.mkfm-sub b.nu{color:var(--mkfm-muted)}' +

    '.mkfm-bars{margin-top:7px;flex:none}' +
    '.mkfm-row{height:20px}' +
    '.mkfm-row+.mkfm-row{margin-top:4px}' +
    '.mkfm-rl{height:12px;display:flex;align-items:baseline;justify-content:space-between;gap:8px}' +
    '.mkfm-rl span:first-child{font:500 10.5px/12px var(--mkfm-font);color:var(--mkfm-muted);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-rl b{font:600 11.5px/12px var(--mkfm-font);white-space:nowrap;flex:none;' +
      'font-variant-numeric:tabular-nums}' +
    '.mkfm-rl b.up{color:var(--mkfm-long)}.mkfm-rl b.dn{color:var(--mkfm-short)}' +
    '.mkfm-track{--h:6px;position:relative;margin-top:2px;height:var(--h)}' +
    '.mkfm-fill{position:absolute;inset:0;border-radius:calc(var(--h)/2);overflow:hidden;' +
      'background:var(--mkfm-hair)}' +
    /* bar pinned to an end of the 30-70 window: square that corner off */
    '.mkfm-fill.clamp-hi{border-top-right-radius:1px;border-bottom-right-radius:1px}' +
    '.mkfm-fill.clamp-lo{border-top-left-radius:1px;border-bottom-left-radius:1px}' +
    '.mkfm-track i.mkfm-tick{position:absolute;left:50%;top:-2px;bottom:-2px;width:1.5px;' +
      'margin-left:-.75px;background:var(--mkfm-tick);border-radius:1px}' +

    '.mkfm-foot{position:absolute;left:0;right:0;bottom:0;height:22px;padding:0 12px;' +
      'display:flex;align-items:center;justify-content:space-between;gap:8px;' +
      'border-top:1px solid var(--mkfm-hair);background:var(--mkfm-surface)}' +
    '.mkfm-foot>span{font:400 9.5px/1 var(--mkfm-font);color:var(--mkfm-faint);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-pb{display:inline-flex;align-items:center;gap:4px;flex:none;' +
      'font:600 9.5px/1 var(--mkfm-font);color:var(--mkfm-muted)}' +
    '.mkfm-pb:hover{color:var(--mkfm-primary)}' +
    '.mkfm-pb:focus-visible{outline:2px solid var(--mkfm-primary);outline-offset:2px;border-radius:3px}' +
    '.mkfm-logo{width:11px;height:9px;fill:var(--mkfm-primary);flex:none}' +

    /* overflow-y:auto is insurance, not decoration: the copy is sized to fit
       150px, but run labels and trade counts are data-driven and can wrap an
       extra line on a long value. Scrolling beats clipping the last sentence. */
    '.mkfm-info{position:absolute;inset:0;background:var(--mkfm-surface);padding:11px 12px;' +
      'display:none;flex-direction:column;z-index:3;overflow-y:auto}' +
    '.mkfm-card.open .mkfm-info{display:flex}' +
    '.mkfm-info h4{font:600 11px/14px var(--mkfm-font);margin-bottom:4px}' +
    '.mkfm-info p{font:400 10px/13.5px var(--mkfm-font);color:var(--mkfm-muted);margin-bottom:4px}' +
    '.mkfm-info p b{color:var(--mkfm-ink);font-weight:600}' +
    '.mkfm-x{position:absolute;top:7px;right:8px;width:18px;height:18px;border-radius:50%;' +
      'color:var(--mkfm-faint);font:400 14px/16px var(--mkfm-font);text-align:center}' +
    '.mkfm-x:hover{background:var(--mkfm-hair);color:var(--mkfm-ink)}' +

    '.mkfm-sk{background:linear-gradient(90deg,var(--mkfm-hair) 25%,var(--mkfm-surface-2) 37%,var(--mkfm-hair) 63%);' +
      'background-size:400% 100%;animation:mkfmsk 1.4s ease infinite;border-radius:4px;color:transparent!important}' +
    '@keyframes mkfmsk{0%{background-position:100% 50%}100%{background-position:0 50%}}' +
    '.mkfm-fallback{width:100%;height:150px;border:1px solid var(--mkfm-border);border-radius:var(--mkfm-radius);' +
      'background:var(--mkfm-surface);display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:6px;padding:12px;text-align:center}' +
    '.mkfm-fb-msg{font:500 11.5px/16px var(--mkfm-font);color:var(--mkfm-muted)}';

  defineBase('mkfm-positioning-card', CARD_CSS, function (body, data, status, res) {
    var host = this;
    var syms = (host.getAttribute('symbols') || CFG.symbols.join(',')).split(',')
      .map(function (s) { return s.trim(); }).filter(Boolean);
    var sym = (host.getAttribute('symbol') || syms[0] || 'NQ').trim().toUpperCase();

    // --- loading skeleton -------------------------------------------------
    if (status === 'loading') {
      body.innerHTML = '';
      var sk = el('div', 'mkfm-card');
      var skb = el('div', 'mkfm-b');
      var skh = el('div', 'mkfm-head');
      var p1 = el('div', 'mkfm-sk'); p1.style.cssText = 'width:150px;height:22px;border-radius:999px';
      skh.appendChild(p1); skb.appendChild(skh);
      var p2 = el('div', 'mkfm-sk'); p2.style.cssText = 'width:230px;height:19px;margin-top:6px';
      var p3 = el('div', 'mkfm-sk'); p3.style.cssText = 'width:140px;height:11px;margin-top:3px';
      skb.appendChild(p2); skb.appendChild(p3);
      var bw = el('div', 'mkfm-bars');
      for (var q = 0; q < 2; q++) {
        var r = el('div', 'mkfm-row'), t = el('div', 'mkfm-sk');
        t.style.cssText = 'height:6px;margin-top:12px'; r.appendChild(t); bw.appendChild(r);
      }
      skb.appendChild(bw); sk.appendChild(skb);
      var f0 = el('div', 'mkfm-foot');
      f0.appendChild(el('span', null, 'Loading positioning…'));
      f0.appendChild(poweredBy(host)); sk.appendChild(f0);
      body.appendChild(sk);
      return;
    }

    var d = derive(data, sym);

    // --- hard failure: still branded, still linked, never a blank box -----
    if (!d) {
      body.innerHTML = '';
      var fb = el('div', 'mkfm-fallback');
      fb.appendChild(el('div', 'mkfm-fb-msg',
        status === 'error'
          ? 'Positioning data is unavailable right now.'
          : 'No positioning data for ' + sym + '.'));
      fb.appendChild(poweredBy(host));
      body.appendChild(fb);
      return;
    }

    body.innerHTML = '';
    var card = el('div', 'mkfm-card');
    var b = el('div', 'mkfm-b');

    /* head ------------------------------------------------------------- */
    var head = el('div', 'mkfm-head');
    var sel = el('select', 'mkfm-sel');
    sel.setAttribute('aria-label', 'Choose instrument');
    for (var i = 0; i < syms.length; i++) {
      var s = syms[i], inst = data.instruments[s];
      if (!inst) continue;
      var o = el('option', null, s + ' · ' + (inst.name || s));
      o.value = s; if (s === sym) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', function () {
      host.setAttribute('symbol', sel.value);
      host.emit('symbolchange', { symbol: sel.value });
    });
    head.appendChild(sel);
    var chip = chipFor(status, res);
    if (chip) head.appendChild(chip);

    var ib = el('button', 'mkfm-i', 'i');
    ib.type = 'button';
    ib.setAttribute('aria-label', 'How to read this');
    ib.addEventListener('click', function () { card.classList.add('open'); });
    head.appendChild(ib);
    b.appendChild(head);

    /* headline --------------------------------------------------------- */
    var word = d.side === 'long' ? 'LONG' : d.side === 'short' ? 'SHORT' : 'SPLIT';
    var wcls = d.side === 'long' ? 'up' : d.side === 'short' ? 'dn' : 'nu';
    var hl = el('div', 'mkfm-hl');
    hl.appendChild(document.createTextNode('Profitable traders are '));
    var bEl = el('b', wcls, word); hl.appendChild(bEl);
    b.appendChild(hl);

    /* subline: the spread first, then the run ---------------------------
       This slot used to carry the derived point move ("MNQ +621.25 today"),
       which is gone on compliance grounds. The spread is a better tenant: the
       move described what price did, whereas the spread describes what the two
       cohorts disagree about, which is the thing this widget alone can say. */
    var sub = el('div', 'mkfm-sub');
    var sp = spreadLabel(d);
    if (sp) {
      var spb = el('b', sp.cls, sp.txt);
      sub.appendChild(spb);
      sub.appendChild(document.createTextNode(' spread'));
      sub.title = sp.title;
    }
    var bits = [];
    if (d.run > 0) bits.push(d.grain === 'intraday' ? d.runLabel + ' on this side' : (d.run === 1 ? 'this session' : d.runLabel));
    if (!bits.length && !sp) bits.push('Session of ' + (d.tradeDate || ''));
    if (bits.length) {
      sub.appendChild(document.createTextNode((sp ? ' · ' : '') + bits.join(' · ')));
    }
    b.appendChild(sub);

    /* two bars --------------------------------------------------------- */
    var bars = el('div', 'mkfm-bars');
    [['Profitable traders', d.pctLong], ['Unprofitable traders', d.unprofLong]].forEach(function (pair) {
      var row = el('div', 'mkfm-row');
      var lab = el('div', 'mkfm-rl');
      lab.appendChild(el('span', null, pair[0]));
      var sl = sideLabel(pair[1]);
      lab.appendChild(el('b', sl.cls, sl.txt));
      row.appendChild(lab);
      row.appendChild(barTrack(pair[1], 6));
      bars.appendChild(row);
    });
    b.appendChild(bars);
    card.appendChild(b);

    /* footer ------------------------------------------------------------ */
    var foot = el('div', 'mkfm-foot');
    var ftxt = status === 'closed'
      ? 'Last session · ' + (d.tradeDate || '')
      : status === 'stale'
        ? 'Cached · ' + (d.tradeDate || '')
        : fmtCount(d.trades) + ' trades read';
    foot.appendChild(el('span', null, ftxt));
    foot.appendChild(poweredBy(host));
    card.appendChild(foot);

    /* info overlay ------------------------------------------------------ */
    var info = el('div', 'mkfm-info');
    info.appendChild(el('h4', null, 'How to read this'));
    var p1i = el('p'); p1i.innerHTML =
      'MarketFramework splits live futures traders into <b>profitable</b> and <b>unprofitable</b> ' +
      'cohorts by realised performance, then measures what share of each is net long.';
    info.appendChild(p1i);
    // The scale note is not optional copy. A reader who assumes a 0-100 track
    // will read a 57%-filled bar as 57% long when it is 53%. Stating the
    // window, and that the printed number is the true one, is what keeps the
    // compressed scale honest rather than merely flattering.
    var p2i = el('p'); p2i.innerHTML =
      'Green is the long share, red the short share; the grey tick is the 50/50 line. The track spans ' +
      '<b>' + CFG.scaleMin + '–' + CFG.scaleMax + '%</b>, the band positioning actually occupies, ' +
      'so a real edge is visible. The printed percentages are the true values.';
    info.appendChild(p2i);
    if (sp) {
      var p4i = el('p'); p4i.innerHTML =
        'The <b>spread</b> is the gap between the two cohorts in percentage points. ' +
        'A wide spread means they genuinely disagree; near zero means there is no edge to read.';
      info.appendChild(p4i);
    }
    var p3i = el('p'); p3i.innerHTML =
      'Positioning, not advice. <b>' + d.runLabel + '</b> on the current side, from <b>' +
      fmtCount(d.trades) + '</b> trades, bucketed ' +
      (d.grain === 'intraday' ? 'every ' + Math.round((d.bucketSeconds || 300) / 60) + ' minutes' : 'per session') + '.';
    info.appendChild(p3i);
    var x = el('button', 'mkfm-x', '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', function () { card.classList.remove('open'); });
    info.appendChild(x);
    card.appendChild(info);

    body.appendChild(card);
  });

  /* ============================================================
   * 11. WIDGET B — INSTRUMENT RAIL
   *
   * Rebuilt to TradeSyncer's spec (Rodin Kadri, changelog v2/v4/v5/v7/v8).
   * The old shape was one bordered box with six flush cells divided by
   * hairlines and a lead panel welded to the left. The new shape is separate
   * cards on a paged track: CFG.railPerView at a time, arrows straddling the
   * outer border of the first and last visible card, disabled at the ends.
   *
   * Two things about the paging are worth knowing before changing it.
   *
   * First, paging is done with a transform on a track inside an overflow-hidden
   * viewport, NOT by re-rendering the visible subset. Re-rendering would
   * rebuild the DOM on every arrow click, which drops focus, restarts the
   * skeleton shimmer, and would fight the 60s poll for control of the same
   * nodes. The transform leaves every card mounted and simply moves them.
   *
   * Second, the page index is deliberately NOT stored on the host element. A
   * poll lands every 60 seconds and calls this renderer again from scratch; an
   * index kept in a closure resets to 0 on each poll, which is wrong — a user
   * reading page 2 would be yanked back to page 1 once a minute. It is stored
   * on the host as _mkfmPage and clamped on re-render in case the instrument
   * count shrank underneath it.
   * ========================================================== */
  var RAIL_CSS =
    ':host{display:block;width:100%}' +
    /* The arrows hang outside the first and last card, so the component needs
       side room of its own. Without this they clip against whatever container
       the host drops the rail into. */
    '.mkfm-railwrap{position:relative;padding:0 14px}' +
    '.mkfm-viewport{overflow:hidden}' +
    '.mkfm-rtrack{display:flex;gap:12px;transition:transform .28s cubic-bezier(.4,0,.2,1);' +
      'will-change:transform}' +
    '@media (prefers-reduced-motion:reduce){.mkfm-rtrack{transition:none}}' +

    /* Each instrument is its own card now — own border, own radius, own
       shadow. `flex:0 0 auto` with a computed width rather than `flex:1` so
       the track can be translated by an exact page width. */
    '.mkfm-card{flex:0 0 auto;background:var(--mkfm-surface);' +
      'border:1px solid var(--mkfm-border);border-radius:var(--mkfm-radius);' +
      'box-shadow:var(--mkfm-shadow);padding:14px 16px 12px;' +
      'display:flex;flex-direction:column;gap:10px;min-width:0}' +

    /* head: monogram badge + symbol. v7 puts the symbol at 24/32 semibold. */
    '.mkfm-ch{display:flex;align-items:center;gap:9px;min-width:0}' +
    '.mkfm-mono{flex:none;width:30px;height:30px;border-radius:9px;' +
      'display:flex;align-items:center;justify-content:center;' +
      'font:600 12px/1 var(--mkfm-font);letter-spacing:-.01em;' +
      'background:var(--mkfm-hair);color:var(--mkfm-muted)}' +
    '.mkfm-mono.mono-n{background:var(--mkfm-primary-soft);color:var(--mkfm-primary)}' +
    '.mkfm-mono.mono-s{background:#efeaff;color:#6d43d9}' +
    '.mkfm-mono.mono-au{background:#fdf3e2;color:#a86a12}' +
    '.mkfm-mono.mono-ag{background:#eef1f5;color:#5b6675}' +
    '.mkfm-csym{min-width:0;font:600 24px/32px var(--mkfm-font);letter-spacing:-.02em;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-cname{margin-left:auto;flex:none;font:500 11px/1 var(--mkfm-font);' +
      'color:var(--mkfm-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'max-width:45%}' +

    /* cohort rows. v8 sets labels at 14/20 medium muted. The VALUE departs
       from v8's 16/20: it is the only number left on the card after the price
       strip, and at 16px it sat below the 24px symbol — which put the loudest
       type on the least informative element. 26px keeps it above the symbol
       while staying inside the two weights the spec allows. */
    '.mkfm-crow{display:flex;flex-direction:column;gap:5px}' +
    '.mkfm-crow+.mkfm-crow{margin-top:2px}' +
    '.mkfm-clab{display:flex;align-items:baseline;justify-content:space-between;gap:10px}' +
    '.mkfm-clab span{font:500 14px/20px var(--mkfm-font);color:var(--mkfm-muted);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    /* The direction word rides at label size, not value size. Two cards' worth
       of "51% long" all set at 26px turned the rail into a wall of green type
       with no internal hierarchy — the eye had nothing to land on first. The
       number is the measurement and carries the size and the colour; "long" is
       a unit, and units do not get to shout. Baseline-aligned so the pair still
       reads as one phrase. */
    '.mkfm-clab b{flex:none;font:600 26px/28px var(--mkfm-font);letter-spacing:-.02em;' +
      'font-variant-numeric:tabular-nums;white-space:nowrap;' +
      'display:inline-flex;align-items:baseline;gap:5px}' +
    '.mkfm-clab b em{font:500 14px/20px var(--mkfm-font);font-style:normal;' +
      'letter-spacing:0;color:var(--mkfm-muted)}' +
    '.mkfm-clab b.up{color:var(--mkfm-long)}.mkfm-clab b.dn{color:var(--mkfm-short)}' +
    '.mkfm-clab b.nu{color:var(--mkfm-muted)}' +

    '.mkfm-track{--h:6px;position:relative;height:var(--h)}' +
    '.mkfm-fill{position:absolute;inset:0;border-radius:calc(var(--h)/2);overflow:hidden;' +
      'background:var(--mkfm-hair)}' +
    '.mkfm-fill.clamp-hi{border-top-right-radius:1px;border-bottom-right-radius:1px}' +
    '.mkfm-fill.clamp-lo{border-top-left-radius:1px;border-bottom-left-radius:1px}' +
    '.mkfm-track i.mkfm-tick{position:absolute;left:50%;top:-2px;bottom:-2px;width:1.5px;' +
      'margin-left:-.75px;background:var(--mkfm-tick);border-radius:1px}' +

    /* card footer: the spread leads, then run and sample size */
    '.mkfm-cf{margin-top:2px;padding-top:9px;border-top:1px solid var(--mkfm-hair);' +
      'font:500 12px/16px var(--mkfm-font);color:var(--mkfm-muted);' +
      'font-variant-numeric:tabular-nums;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-cf b{font-weight:600}' +
    '.mkfm-cf b.up{color:var(--mkfm-long)}.mkfm-cf b.dn{color:var(--mkfm-short)}' +
    '.mkfm-cf b.nu{color:var(--mkfm-muted)}' +

    /* arrows: centred on the vertical, sitting on the outer border of the
       first and last card, soft shadow (v7). */
    '.mkfm-arrow{position:absolute;top:50%;width:28px;height:28px;margin-top:-14px;' +
      'border-radius:50%;border:1px solid var(--mkfm-border);background:var(--mkfm-surface);' +
      'box-shadow:var(--mkfm-shadow-pop);color:var(--mkfm-ink);cursor:pointer;z-index:2;' +
      'display:flex;align-items:center;justify-content:center;padding:0}' +
    '.mkfm-arrow svg{width:9px;height:9px;fill:none;stroke:currentColor;stroke-width:2;' +
      'stroke-linecap:round;stroke-linejoin:round}' +
    '.mkfm-arrow.prev{left:0}' +
    '.mkfm-arrow.next{right:0}' +
    '.mkfm-arrow:hover:not(:disabled){border-color:var(--mkfm-tick)}' +
    '.mkfm-arrow:focus-visible{outline:2px solid var(--mkfm-primary);outline-offset:2px}' +
    /* Disabled ends stay visible rather than disappearing: an arrow that
       vanishes at the end of the track reads as a rendering fault, and its
       absence also shifts nothing back into place. */
    '.mkfm-arrow:disabled{color:var(--mkfm-faint);cursor:default;box-shadow:none;opacity:.55}' +
    ':host([single]) .mkfm-arrow{display:none}' +
    ':host([single]) .mkfm-railwrap{padding:0}' +

    /* header line above the track: micro-label, sample size, attribution */
    '.mkfm-rhead{display:flex;align-items:center;gap:10px;margin:0 0 10px;min-width:0}' +
    '.mkfm-rhead .t{display:flex;align-items:center;gap:6px;flex:none;' +
      'font:600 11px/1 var(--mkfm-font);letter-spacing:.06em;color:var(--mkfm-primary)}' +
    '.mkfm-rhead .t i{width:6px;height:6px;border-radius:50%;background:var(--mkfm-live);flex:none}' +
    '.mkfm-rhead .t.off i{background:var(--mkfm-faint)}' +
    '.mkfm-rhead .t.off{color:var(--mkfm-muted)}' +
    '.mkfm-rhead .s{min-width:0;font:500 11px/1 var(--mkfm-font);color:var(--mkfm-faint);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-rhead .mkfm-pb{margin-left:auto;flex:none}' +
    '.mkfm-pb{display:inline-flex;align-items:center;gap:5px;font:500 11px/1 var(--mkfm-font);' +
      'color:var(--mkfm-muted)}' +
    '.mkfm-pb:hover{color:var(--mkfm-primary)}' +
    '.mkfm-pb:focus-visible{outline:2px solid var(--mkfm-primary);outline-offset:2px;border-radius:3px}' +
    '.mkfm-logo{width:12px;height:10px;fill:var(--mkfm-primary);flex:none}' +

    '.mkfm-note{margin-top:10px;padding:8px 12px;border:1px solid var(--mkfm-border);' +
      'border-radius:10px;background:var(--mkfm-surface-2);' +
      'font:500 11px/1.35 var(--mkfm-font);color:var(--mkfm-muted)}' +
    '.mkfm-sk{background:linear-gradient(90deg,var(--mkfm-hair) 25%,var(--mkfm-surface-2) 37%,var(--mkfm-hair) 63%);' +
      'background-size:400% 100%;animation:mkfmsk 1.4s ease infinite;border-radius:4px}' +
    '@keyframes mkfmsk{0%{background-position:100% 50%}100%{background-position:0 50%}}' +
    '.mkfm-fallback{border:1px solid var(--mkfm-border);border-radius:var(--mkfm-radius);' +
      'background:var(--mkfm-surface);padding:20px;display:flex;align-items:center;' +
      'justify-content:center;gap:10px;flex-wrap:wrap}' +
    '.mkfm-fb-msg{font:500 12px/1.4 var(--mkfm-font);color:var(--mkfm-muted)}' +
    /* Below this width three cards cannot hold a 26px value and a 24px symbol
       without crushing both, so the page size drops to one and the arrows keep
       working unchanged — the per-view count is read from the DOM, not assumed. */
    '@media (max-width:760px){.mkfm-rhead{flex-wrap:wrap}' +
      '.mkfm-rhead .mkfm-pb{margin-left:0}}';

  var CHEV_L = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M6.5 1.5 2.5 5l4 3.5"/></svg>';
  var CHEV_R = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7.5 5l-4 3.5"/></svg>';

  // How many cards fit a page at the current width. Three is TradeSyncer's
  // spec for their 1488px content container; below that this steps down rather
  // than letting the cards squash.
  //
  // The breakpoints are derived from the widest line a card has to hold, not
  // guessed: "Unprofitable" at 14px is ~78px and "56% long" at 26px is ~105px,
  // plus a 10px gap and 32px of horizontal padding — about 225px of hard
  // minimum. Three cards therefore need 3*225 + 2*12 of gap = ~700px of
  // viewport, and 940 is that with enough headroom that a wider font stack or
  // a longer label does not start clipping. Returns at least 1 in every case.
  function perView(px) {
    var n = CFG.railPerView || 3;
    if (px < 680) n = 1;
    else if (px < 940) n = Math.min(n, 2);
    return Math.max(1, n);
  }

  defineBase('mkfm-positioning-rail', RAIL_CSS, function (body, data, status, res) {
    var host = this;
    var syms = (host.getAttribute('symbols') || CFG.symbols.join(',')).split(',')
      .map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);

    if (status === 'loading') {
      body.innerHTML = '';
      var lw = el('div', 'mkfm-railwrap');
      var lh = el('div', 'mkfm-rhead');
      var t0 = el('div', 'mkfm-sk'); t0.style.cssText = 'width:120px;height:11px';
      var t1 = el('div', 'mkfm-sk'); t1.style.cssText = 'width:86px;height:11px';
      lh.appendChild(t0); lh.appendChild(t1); lw.appendChild(lh);
      var lv = el('div', 'mkfm-viewport');
      var lt = el('div', 'mkfm-rtrack');
      for (var i = 0; i < 3; i++) {
        var c = el('div', 'mkfm-card');
        c.style.cssText = 'flex:1 1 0';
        var a = el('div', 'mkfm-sk'); a.style.cssText = 'width:120px;height:30px';
        var b1 = el('div', 'mkfm-sk'); b1.style.cssText = 'height:28px';
        var b2 = el('div', 'mkfm-sk'); b2.style.cssText = 'height:6px';
        var b3 = el('div', 'mkfm-sk'); b3.style.cssText = 'height:28px';
        var b4 = el('div', 'mkfm-sk'); b4.style.cssText = 'height:6px';
        var b5 = el('div', 'mkfm-sk'); b5.style.cssText = 'width:70%;height:12px';
        c.appendChild(a); c.appendChild(b1); c.appendChild(b2);
        c.appendChild(b3); c.appendChild(b4); c.appendChild(b5);
        lt.appendChild(c);
      }
      lv.appendChild(lt); lw.appendChild(lv); body.appendChild(lw);
      return;
    }

    var ds = syms.map(function (s) { return derive(data, s); }).filter(Boolean);
    if (!ds.length) {
      body.innerHTML = '';
      var fb = el('div', 'mkfm-fallback');
      fb.appendChild(el('div', 'mkfm-fb-msg', 'Positioning data is unavailable right now.'));
      fb.appendChild(poweredBy(host));
      body.appendChild(fb);
      return;
    }

    body.innerHTML = '';
    var wrapper = el('div', 'mkfm-railwrap');

    /* header line ------------------------------------------------------- */
    var head = el('div', 'mkfm-rhead');
    var title = el('div', 't');
    title.className = 't' + (status === 'ok' ? '' : ' off');
    title.appendChild(el('i'));
    // No 'DELAYED DATA' branch. `stale` falls through to the neutral
    // 'POSITIONING' title: a delay flag on a partner dashboard reads as a
    // broken product, and the reading itself is unchanged.
    title.appendChild(document.createTextNode(
      status === 'ok' ? 'LIVE POSITIONING'
        : status === 'closed' ? 'LAST SESSION' : 'POSITIONING'));
    head.appendChild(title);
    head.appendChild(el('div', 's', status === 'closed'
      ? 'Session of ' + (data.tradeDate || '')
      : CFG.tradesPerDayLabel));
    head.appendChild(poweredBy(host));
    wrapper.appendChild(head);

    /* track ------------------------------------------------------------- */
    var viewport = el('div', 'mkfm-viewport');
    var track = el('div', 'mkfm-rtrack');

    ds.forEach(function (d) {
      var card = el('div', 'mkfm-card');

      var ch = el('div', 'mkfm-ch');
      ch.appendChild(monogram(d));
      ch.appendChild(el('span', 'mkfm-csym', d.sym));
      ch.appendChild(el('span', 'mkfm-cname', d.name));
      card.appendChild(ch);

      [['Profitable', d.pctLong, 'Profitable traders'],
       ['Unprofitable', d.unprofLong, 'Unprofitable traders']].forEach(function (p) {
        var row = el('div', 'mkfm-crow');
        var lab = el('div', 'mkfm-clab');
        lab.appendChild(el('span', null, p[0]));
        var sl = sideLabel(p[1]);
        var val = el('b', sl.cls);
        val.appendChild(document.createTextNode(sl.num));
        val.appendChild(el('em', null, sl.word));
        lab.appendChild(val);
        row.appendChild(lab);
        var tr = barTrack(p[1], 6);
        tr.title = p[2] + ': ' + sl.txt;
        row.appendChild(tr);
        card.appendChild(row);
      });

      var f = el('div', 'mkfm-cf');
      var sp = spreadLabel(d);
      if (sp) {
        f.appendChild(el('b', sp.cls, sp.txt));
        f.appendChild(document.createTextNode(' spread · '));
      }
      f.appendChild(document.createTextNode(d.runLabel + ' · ' + fmtCount(d.trades)));
      f.title = (sp ? sp.title + ' ' : '') +
        d.name + ' — ' +
        (d.grain === 'intraday' ? d.runLabel : (d.run > 1 ? d.runLabel + ' consecutive' : 'first session')) +
        ' on this side, from ' + fmtCount(d.trades) + ' trades read.';
      card.appendChild(f);

      track.appendChild(card);
    });

    viewport.appendChild(track);
    wrapper.appendChild(viewport);

    /* arrows ------------------------------------------------------------ */
    var prev = el('button', 'mkfm-arrow prev');
    prev.type = 'button'; prev.innerHTML = CHEV_L;
    prev.setAttribute('aria-label', 'Previous instruments');
    var next = el('button', 'mkfm-arrow next');
    next.type = 'button'; next.innerHTML = CHEV_R;
    next.setAttribute('aria-label', 'More instruments');
    wrapper.appendChild(prev);
    wrapper.appendChild(next);

    body.appendChild(wrapper);

    /* paging ------------------------------------------------------------
       Runs after the nodes are in the document, because every width below is
       measured rather than assumed — the host controls this component's width
       and there is no reliable way to guess it. */
    var GAP = 12;

    function layout() {
      var vw = viewport.clientWidth;
      if (!vw) return;                       // display:none or not yet laid out
      var n = ds.length;
      var per = Math.min(perView(vw), n);
      var cardW = (vw - GAP * (per - 1)) / per;
      for (var i = 0; i < track.children.length; i++) {
        track.children[i].style.width = cardW + 'px';
      }
      var pages = Math.max(1, Math.ceil(n / per));
      // Clamp: the instrument count can shrink between polls if the cohort
      // gate withdraws one, which would otherwise strand the view on a page
      // that no longer exists and render an empty track.
      var page = Math.min(host._mkfmPage || 0, pages - 1);
      host._mkfmPage = page;
      if (pages <= 1) host.setAttribute('single', '');
      else host.removeAttribute('single');
      track.style.transform = 'translateX(' + (-page * (vw + GAP)) + 'px)';
      prev.disabled = page <= 0;
      next.disabled = page >= pages - 1;
      return { pages: pages, page: page };
    }

    function go(delta) {
      var st = layout();
      if (!st) return;
      var p = Math.min(Math.max(st.page + delta, 0), st.pages - 1);
      if (p === st.page) return;
      host._mkfmPage = p;
      layout();
      host.emit('page', { page: p, pages: st.pages });
    }

    prev.addEventListener('click', function () { go(-1); });
    next.addEventListener('click', function () { go(1); });

    layout();

    // Re-measure on resize. ResizeObserver watches the element itself, which
    // matters because a dashboard can resize this component without the window
    // changing at all — a collapsing sidebar is the obvious case. The window
    // listener is the fallback for browsers without it, and both are torn down
    // by the base element's disconnect hook via _mkfmCleanup.
    if (host._mkfmCleanup) { host._mkfmCleanup(); host._mkfmCleanup = null; }
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(function () { layout(); });
      ro.observe(host);
      host._mkfmCleanup = function () { ro.disconnect(); };
    } else {
      var onR = function () { layout(); };
      window.addEventListener('resize', onR);
      host._mkfmCleanup = function () { window.removeEventListener('resize', onR); };
    }

    /* degradation note --------------------------------------------------
       Reserved for market-closed, which is genuine information a trader wants
       ("reopens in 4h 12m"). It does not carry feed warnings: a full-width
       band announcing that the data behind it is suspect is what made the old
       rail look broken while it was rendering exactly the same values as the
       card. */
    if (status === 'closed') {
      var ms = marketState();
      wrapper.appendChild(el('div', 'mkfm-note',
        'Market closed — showing the last completed session.' +
        (ms.minutesToOpen != null ? ' Reopens in ' + humanDur(ms.minutesToOpen) + '.' : '')));
    }
  });

  /* ============================================================
   * 12. AUTO-MOUNT for dashboards that inject markup at runtime
   *     <div data-mkfm="card" data-symbol="MNQ"></div>
   * ========================================================== */
  var TAGS = { card: 'mkfm-positioning-card', rail: 'mkfm-positioning-rail' };

  function mountAll(root) {
    var nodes = (root || document).querySelectorAll('[data-mkfm]:not([data-mkfm-done])');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], tag = TAGS[(n.getAttribute('data-mkfm') || '').toLowerCase()];
      if (!tag) continue;
      n.setAttribute('data-mkfm-done', '1');
      var w = document.createElement(tag);
      for (var j = 0; j < n.attributes.length; j++) {
        var a = n.attributes[j];
        if (a.name.indexOf('data-') === 0 && a.name !== 'data-mkfm' && a.name !== 'data-mkfm-done') {
          w.setAttribute(a.name.slice(5), a.value);
        }
      }
      n.innerHTML = '';
      n.appendChild(w);
    }
  }

  function boot() {
    mountAll(document);
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].addedNodes && muts[i].addedNodes.length) { mountAll(document); return; }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ============================================================
   * 13. PUBLIC API
   * ========================================================== */
  window.MKFM = {
    version: VERSION,
    config: CFG,
    refresh: function () { return load(true); },
    mount: mountAll,
    marketState: marketState,

    // Everything the sanity gates dropped, newest last. Blanking a value with
    // no record of it is close to undebuggable once this is running on
    // someone else's dashboard: "the price is missing" and "the price failed
    // gate 2 at 14:03 because the prior close was 69.00" are very different
    // support tickets. Call MKFM.rejects() in the console to see the second.
    rejects: function () { return REJECTS.slice(); },
    // MKFM.debug(true) additionally console.warns each rejection live.
    debug: function (on) { CFG.debug = (on !== false); return CFG.debug; },

    _store: store
  };
})();
