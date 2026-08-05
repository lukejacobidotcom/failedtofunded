/*!
 * MarketFramework Positioning Widgets  v1.0.0
 * ------------------------------------------------------------------
 * Embeddable custom elements. One script tag, no dependencies, no build step.
 *
 *   <script src=".../mkfm-widgets.js" async>   (close the tag as usual)
 *   <mkfm-positioning-card symbol="MNQ"></mkfm-positioning-card>
 *   <mkfm-positioning-rail></mkfm-positioning-rail>
 *   <mkfm-positioning-chart symbol="NQ"></mkfm-positioning-chart>
 *
 * Everything renders inside a shadow root, so host CSS cannot leak in and
 * widget CSS cannot leak out. Safe to drop into any dashboard.
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';
  if (window.MKFM && window.MKFM.version) return; // already loaded

  var VERSION = '1.0.0';

  /* ============================================================
   * 1. CONFIG
   * ========================================================== */
  // Legend swatch for the price candles: half up-green, half down-red, so the
  // key matches what is actually drawn instead of implying a single line.
  var PRICE_SWATCH = 'linear-gradient(90deg,#16a34a 0 50%,#ef4444 50% 100%)';

  var CFG = {
    // Data endpoint. This is the SAME endpoint the live Positioning Edge tool
    // at marketframework.com/tools/positioning-edge calls for its cohort chart.
    // It is public and unauthenticated; it returns 5-minute cohort buckets for
    // all six instruments in one response (winners / losers / all + volumes).
    //
    // It does NOT currently send an Access-Control-Allow-Origin header, so a
    // browser on tradesyncer.com will refuse to read the response. Verified by
    // cross-origin fetch: mode:'cors' throws, mode:'no-cors' returns an opaque
    // response, which means the server answers and only the header is missing.
    // The moment MarketFramework adds that header this widget goes live with
    // no change on TradeSyncer's side. Until then every widget falls back to
    // the bundled snapshot and shows a visible DELAYED chip.
    //
    // Override globally with window.MKFM_CONFIG.endpoint, or per-element with
    // the `endpoint` attribute (e.g. to point at your own caching proxy).
    endpoint: 'https://www.marketframework.com/api/aggregator/cohort-intraday?interval=5m',

    // The single place the "Powered by MarketFramework" link points at.
    // >>> CHANGE THIS ONE CONSTANT to re-target every widget on every site. <<<
    link: 'https://www.marketframework.com/tools/positioning-edge?utm_source=tradesyncer&utm_medium=widget&utm_campaign=positioning',

    fetchTimeoutMs: 8000,
    refreshMs: 60000,       // poll while the market is open
    staleAfterMs: 15 * 60 * 1000, // data older than this shows the STALE chip
    symbols: ['NQ', 'MNQ', 'ES', 'MES', 'MGC', 'SIL'],
    tradesPerDayLabel: '250K trades/day'
  };
  if (window.MKFM_CONFIG) for (var k in window.MKFM_CONFIG) CFG[k] = window.MKFM_CONFIG[k];

  /* ============================================================
   * 2. DESIGN TOKENS
   * Sampled directly from the TradeSyncer dashboard screenshot:
   * shadcn/ui zinc scale with primary overridden to #146aff.
   * ========================================================== */
  var TOKENS = [
    '--mkfm-font: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
    '--mkfm-primary:#146aff;',
    '--mkfm-primary-soft:#eaf1ff;',
    '--mkfm-primary-soft-b:#d6e4ff;',
    '--mkfm-long:#146aff;',
    '--mkfm-short:#e11d1d;',
    '--mkfm-short-soft:#fdeded;',
    '--mkfm-ink:#09090b;',
    '--mkfm-muted:#71717a;',
    '--mkfm-faint:#a1a1aa;',
    '--mkfm-surface:#ffffff;',
    '--mkfm-surface-2:#fafafa;',
    '--mkfm-border:#e8e8ea;',
    '--mkfm-hair:#f1f1f2;',
    '--mkfm-tick:#9ca3af;',
    '--mkfm-live:#04a36d;',
    '--mkfm-warn:#b45309;',
    '--mkfm-warn-soft:#fff7ed;',
    '--mkfm-radius:12px;',
    '--mkfm-shadow:0 1px 2px rgba(9,9,11,.05);'
  ].join('');

  var DARK = [
    '--mkfm-primary:#4d8cff;',
    '--mkfm-primary-soft:#16233d;',
    '--mkfm-primary-soft-b:#24365c;',
    '--mkfm-long:#4d8cff;',
    '--mkfm-short:#f2555a;',
    '--mkfm-short-soft:#2a1618;',
    '--mkfm-ink:#fafafa;',
    '--mkfm-muted:#a1a1aa;',
    '--mkfm-faint:#71717a;',
    '--mkfm-surface:#0e0e11;',
    '--mkfm-surface-2:#161619;',
    '--mkfm-border:#27272a;',
    '--mkfm-hair:#1f1f23;',
    '--mkfm-tick:#52525b;',
    '--mkfm-live:#12b981;',
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
  // True only for a real, plottable number. null and NaN both have to fail
  // here, because Math.min/Math.max silently coerce null to 0 and would
  // otherwise drag an axis to zero on a feed that simply omits a field.
  function num(v) { return typeof v === 'number' && !isNaN(v); }
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
  function decimalsFor(px) { return px == null ? 2 : (px < 10 ? 3 : px < 1000 ? 2 : 2); }

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

  // Wall-clock label for a bucket timestamp (unix seconds), rendered in ET so
  // every viewer sees the same exchange time regardless of where they sit.
  // Used for the intraday chart's x axis, which is built from real bucket
  // timestamps rather than assumed RTH boundaries — the cohort feed records
  // 24/7, so an assumed 9:30a–4:00p axis would be a lie most of the day.
  function etClock(unixSeconds) {
    if (unixSeconds == null || isNaN(unixSeconds)) return '';
    var p = etParts(new Date(unixSeconds * 1000));
    var h = p.hour, suffix = h >= 12 ? 'p' : 'a';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + (p.minute < 10 ? '0' : '') + p.minute + suffix;
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
    var url = CFG.endpoint;
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
    if (last.w == null || last.l == null) return null;

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

    // Price move since the stance began (close before the run started -> now).
    var basis = startIdx > 0 ? rows[startIdx - 1].c : rows[startIdx].c;
    var move = (last.c != null && basis != null) ? last.c - basis : null;
    var movePct = (move != null && basis) ? (move / basis) * 100 : null;

    // Intraday move from the 5m series, when the feed carries it.
    var m5 = inst.m5, dayMove = null, dayPct = null;
    if (m5 && m5.c && m5.c.length && m5.o != null) {
      var lastPx = m5.c[m5.c.length - 1];
      dayMove = lastPx - m5.o;
      dayPct = m5.o ? (dayMove / m5.o) * 100 : null;
    }

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
      sym: sym, name: inst.name || sym, rows: rows, last: last, m5: m5,
      dv: dv, side: side, grain: grain, bucketSeconds: bs,
      pctLong: clamp(last.w, 0, 100),
      unprofLong: clamp(last.l, 0, 100),
      allLong: last.a,
      run: run, runMs: runMs, runLabel: runLabel,
      runStart: rows[startIdx] ? rows[startIdx].d : null,
      move: move, movePct: movePct, dayMove: dayMove, dayPct: dayPct,
      trades: last.v, dp: decimalsFor(last.c),
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

  // A single positioning bar: blue up to `pctLong`, red after, grey tick at 50.
  function barTrack(pctLong, h) {
    var wrap = el('div', 'mkfm-track');
    if (h) wrap.style.setProperty('--h', h + 'px');
    var fill = el('div', 'mkfm-fill');
    var p = clamp(pctLong, 0, 100);
    fill.style.background =
      'linear-gradient(to right,var(--mkfm-long) 0 ' + p + '%,var(--mkfm-short) ' + p + '% 100%)';
    wrap.appendChild(fill);
    wrap.appendChild(el('i', 'mkfm-tick'));
    return wrap;
  }

  function sideLabel(pctLong) {
    if (pctLong >= 50) return { txt: Math.round(pctLong) + '% long', cls: 'up' };
    return { txt: Math.round(100 - pctLong) + '% short', cls: 'dn' };
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
      if (!this.hasAttribute('theme')) this.setAttribute('theme', 'auto');
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
  function chipFor(status, res) {
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
    } else if (status === 'stale') {
      c.className = 'mkfm-chip stale';
      c.textContent = 'DELAYED';
      c.title = (res && res.source === 'snapshot')
        ? 'Live feed unreachable — showing the last cached session.'
        : 'Feed has not updated recently — showing the last value received.';
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
      'background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'5\' viewBox=\'0 0 8 5\'%3E%3Cpath d=\'M1 1l3 3 3-3\' fill=\'none\' stroke=\'%23146aff\' stroke-width=\'1.6\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");' +
      'background-repeat:no-repeat;background-position:right 8px center}' +
    ':host([theme="dark"]) .mkfm-sel,:host([theme="auto"]) .mkfm-sel{background-image:none}' +
    '@media (prefers-color-scheme:light){:host([theme="auto"]) .mkfm-sel{' +
      'background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'5\' viewBox=\'0 0 8 5\'%3E%3Cpath d=\'M1 1l3 3 3-3\' fill=\'none\' stroke=\'%23146aff\' stroke-width=\'1.6\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");' +
      'background-repeat:no-repeat;background-position:right 8px center}}' +
    '.mkfm-sel:focus-visible{outline:2px solid var(--mkfm-primary);outline-offset:1px}' +
    '.mkfm-sel option{color:#09090b;background:#fff}' +

    '.mkfm-chip{flex:none;display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 6px;' +
      'border-radius:999px;font:700 8.5px/1 var(--mkfm-font);letter-spacing:.055em;' +
      'background:var(--mkfm-hair);color:var(--mkfm-muted);cursor:default}' +
    '.mkfm-chip i{width:5px;height:5px;border-radius:50%;background:currentColor;display:block}' +
    '.mkfm-chip.live{background:rgba(4,163,109,.1);color:var(--mkfm-live)}' +
    '.mkfm-chip.stale{background:var(--mkfm-warn-soft);color:var(--mkfm-warn)}' +
    '.mkfm-chip.err{background:var(--mkfm-short-soft);color:var(--mkfm-short)}' +

    '.mkfm-i{flex:none;width:17px;height:17px;border-radius:50%;border:1px solid var(--mkfm-border);' +
      'color:var(--mkfm-faint);font:600 10px/15px var(--mkfm-font);text-align:center;' +
      'display:flex;align-items:center;justify-content:center}' +
    '.mkfm-i:hover{color:var(--mkfm-muted);border-color:var(--mkfm-tick)}' +
    '.mkfm-i:focus-visible{outline:2px solid var(--mkfm-primary);outline-offset:1px}' +

    '.mkfm-hl{margin-top:6px;height:19px;flex:none;font:700 15.5px/19px var(--mkfm-font);' +
      'letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-hl b{font-weight:800}' +
    '.mkfm-hl .up{color:var(--mkfm-long)}.mkfm-hl .dn{color:var(--mkfm-short)}' +
    '.mkfm-hl .nu{color:var(--mkfm-muted)}' +
    '.mkfm-sub{height:14px;flex:none;font:400 11px/14px var(--mkfm-font);color:var(--mkfm-muted);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +

    '.mkfm-bars{margin-top:7px;flex:none}' +
    '.mkfm-row{height:20px}' +
    '.mkfm-row+.mkfm-row{margin-top:4px}' +
    '.mkfm-rl{height:12px;display:flex;align-items:baseline;justify-content:space-between;gap:8px}' +
    '.mkfm-rl span:first-child{font:500 10.5px/12px var(--mkfm-font);color:var(--mkfm-ink);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-rl b{font:700 10.5px/12px var(--mkfm-font);white-space:nowrap;flex:none}' +
    '.mkfm-rl b.up{color:var(--mkfm-long)}.mkfm-rl b.dn{color:var(--mkfm-short)}' +
    '.mkfm-track{--h:6px;position:relative;margin-top:2px;height:var(--h)}' +
    '.mkfm-fill{position:absolute;inset:0;border-radius:calc(var(--h)/2);overflow:hidden;' +
      'background:var(--mkfm-hair)}' +
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

    '.mkfm-info{position:absolute;inset:0;background:var(--mkfm-surface);padding:11px 12px;' +
      'display:none;flex-direction:column;z-index:3}' +
    '.mkfm-card.open .mkfm-info{display:flex}' +
    '.mkfm-info h4{font:700 11px/14px var(--mkfm-font);margin-bottom:4px}' +
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
    head.appendChild(chipFor(status, res));

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

    /* subline: real numbers only --------------------------------------- */
    var bits = [];
    if (d.run > 0) bits.push(d.grain === 'intraday' ? d.runLabel + ' on this side' : (d.run === 1 ? 'this session' : d.runLabel));
    if (d.move != null && d.run > 1) bits.push(d.sym + ' ' + fmtSigned(d.move, d.dp) + ' since');
    else if (d.dayMove != null) bits.push(d.sym + ' ' + fmtSigned(d.dayMove, d.dp) + ' today');
    if (!bits.length) bits.push('Session of ' + (d.tradeDate || ''));
    b.appendChild(el('div', 'mkfm-sub', bits.join(' · ')));

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
      'cohorts by realised account performance, then measures what share of each is net long.';
    info.appendChild(p1i);
    var p2i = el('p'); p2i.innerHTML =
      'Bar left of the grey tick = long, right = short. The tick is the 50/50 line. ' +
      '<b>' + d.runLabel + '</b> on the current side, from <b>' + fmtCount(d.trades) +
      '</b> trades in the last read.';
    info.appendChild(p2i);
    var p3i = el('p'); p3i.innerHTML =
      'Positioning, not advice. Cohort share is bucketed ' +
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
   * 11. WIDGET B — SIX-INSTRUMENT RAIL
   * ========================================================== */
  var RAIL_CSS =
    ':host{display:block;width:100%}' +
    '.mkfm-railbox{background:var(--mkfm-surface);border:1px solid var(--mkfm-border);' +
      'border-radius:var(--mkfm-radius);box-shadow:var(--mkfm-shadow);overflow:hidden}' +
    '.mkfm-rail{display:flex;align-items:stretch}' +
    '.mkfm-lead{flex:none;width:158px;padding:12px 14px;background:var(--mkfm-surface-2);' +
      'border-right:1px solid var(--mkfm-hair);display:flex;flex-direction:column;justify-content:center;gap:5px}' +
    '.mkfm-lead .t{display:flex;align-items:center;gap:6px;font:700 11px/1 var(--mkfm-font);' +
      'letter-spacing:.06em;color:var(--mkfm-primary)}' +
    '.mkfm-lead .t i{width:6px;height:6px;border-radius:50%;background:var(--mkfm-live);flex:none}' +
    '.mkfm-lead .t.off i{background:var(--mkfm-faint)}' +
    '.mkfm-lead .t.off{color:var(--mkfm-muted)}' +
    '.mkfm-lead .s{font:400 11px/1.3 var(--mkfm-font);color:var(--mkfm-faint)}' +
    '.mkfm-lead .mkfm-pb{font-size:11px}' +
    '.mkfm-scroll{flex:1 1 auto;min-width:0;display:flex;overflow-x:auto;overflow-y:hidden;' +
      'scrollbar-width:thin;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}' +
    '.mkfm-scroll::-webkit-scrollbar{height:5px}' +
    '.mkfm-scroll::-webkit-scrollbar-thumb{background:var(--mkfm-border);border-radius:3px}' +
    /* 6 cells fit from ~950px of track width; below that the row scrolls
       horizontally rather than crushing the labels. */
    '.mkfm-cell{flex:1 1 0;min-width:132px;scroll-snap-align:start;padding:12px 13px;' +
      'border-left:1px solid var(--mkfm-hair);display:flex;flex-direction:column;gap:7px}' +
    '.mkfm-cell:first-child{border-left:0}' +
    '.mkfm-ct{display:flex;align-items:center;gap:5px}' +
    '.mkfm-ct .sym{font:700 13.5px/1 var(--mkfm-font);letter-spacing:-.01em}' +
    '.mkfm-ct .ar{font:400 10px/1 var(--mkfm-font)}' +
    '.mkfm-ct .ar.up{color:var(--mkfm-long)}.mkfm-ct .ar.dn{color:var(--mkfm-short)}' +
    '.mkfm-ct .ar.nu{color:var(--mkfm-faint)}' +
    '.mkfm-dl{margin-left:auto;flex:none;padding:2px 7px;border-radius:6px;' +
      'font:700 10.5px/1.25 var(--mkfm-font);color:var(--mkfm-primary);' +
      'background:var(--mkfm-primary-soft);border:1px solid var(--mkfm-primary-soft-b)}' +
    '.mkfm-mini{display:flex;align-items:center;gap:7px}' +
    '.mkfm-mini span{width:7px;flex:none;font:600 8.5px/1 var(--mkfm-font);color:var(--mkfm-faint)}' +
    '.mkfm-mini .mkfm-track{flex:1 1 auto;margin-top:0}' +
    '.mkfm-cf{font:400 10.5px/1.25 var(--mkfm-font);color:var(--mkfm-muted);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mkfm-cf b{font-weight:700}' +
    '.mkfm-cf b.up{color:var(--mkfm-long)}.mkfm-cf b.dn{color:var(--mkfm-short)}' +
    '.mkfm-cf b.nu{color:var(--mkfm-muted)}' +
    '.mkfm-track{--h:6px;position:relative;height:var(--h)}' +
    '.mkfm-fill{position:absolute;inset:0;border-radius:calc(var(--h)/2);overflow:hidden;background:var(--mkfm-hair)}' +
    '.mkfm-track i.mkfm-tick{position:absolute;left:50%;top:-2px;bottom:-2px;width:1.5px;' +
      'margin-left:-.75px;background:var(--mkfm-tick);border-radius:1px}' +
    '.mkfm-pb{display:inline-flex;align-items:center;gap:5px;font:500 11px/1 var(--mkfm-font);color:var(--mkfm-muted)}' +
    '.mkfm-pb:hover{color:var(--mkfm-primary)}' +
    '.mkfm-logo{width:12px;height:10px;fill:var(--mkfm-primary);flex:none}' +
    '.mkfm-note{padding:7px 14px;border-top:1px solid var(--mkfm-hair);background:var(--mkfm-warn-soft);' +
      'font:500 10.5px/1.3 var(--mkfm-font);color:var(--mkfm-warn)}' +
    '.mkfm-sk{background:linear-gradient(90deg,var(--mkfm-hair) 25%,var(--mkfm-surface-2) 37%,var(--mkfm-hair) 63%);' +
      'background-size:400% 100%;animation:mkfmsk 1.4s ease infinite;border-radius:4px}' +
    '@keyframes mkfmsk{0%{background-position:100% 50%}100%{background-position:0 50%}}' +
    '.mkfm-fallback{border:1px solid var(--mkfm-border);border-radius:var(--mkfm-radius);' +
      'background:var(--mkfm-surface);padding:20px;display:flex;align-items:center;' +
      'justify-content:center;gap:10px;flex-wrap:wrap}' +
    '.mkfm-fb-msg{font:500 12px/1.4 var(--mkfm-font);color:var(--mkfm-muted)}' +
    '@media (max-width:640px){.mkfm-rail{flex-direction:column}' +
      '.mkfm-lead{width:100%;border-right:0;border-bottom:1px solid var(--mkfm-hair);' +
      'flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px}' +
      '.mkfm-lead .s{margin-right:auto}}';

  defineBase('mkfm-positioning-rail', RAIL_CSS, function (body, data, status, res) {
    var host = this;
    var syms = (host.getAttribute('symbols') || CFG.symbols.join(',')).split(',')
      .map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);

    if (status === 'loading') {
      body.innerHTML = '';
      var wbox = el('div', 'mkfm-railbox');
      var w = el('div', 'mkfm-rail');
      var ld = el('div', 'mkfm-lead');
      var t0 = el('div', 'mkfm-sk'); t0.style.cssText = 'width:120px;height:12px';
      var t1 = el('div', 'mkfm-sk'); t1.style.cssText = 'width:86px;height:10px';
      ld.appendChild(t0); ld.appendChild(t1); w.appendChild(ld);
      var sc = el('div', 'mkfm-scroll');
      for (var i = 0; i < 6; i++) {
        var c = el('div', 'mkfm-cell');
        var a = el('div', 'mkfm-sk'); a.style.cssText = 'width:56px;height:13px';
        var b1 = el('div', 'mkfm-sk'); b1.style.cssText = 'height:6px';
        var b2 = el('div', 'mkfm-sk'); b2.style.cssText = 'height:6px';
        var b3 = el('div', 'mkfm-sk'); b3.style.cssText = 'width:100px;height:10px';
        c.appendChild(a); c.appendChild(b1); c.appendChild(b2); c.appendChild(b3);
        sc.appendChild(c);
      }
      w.appendChild(sc); wbox.appendChild(w); body.appendChild(wbox);
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
    // outer = the bordered card; wrap = the horizontal flex row inside it.
    // The degradation note must live in `outer`, below the row — appending it to
    // `wrap` would make it a flex sibling of the cells and eat instrument slots.
    var outer = el('div', 'mkfm-railbox');
    var wrap = el('div', 'mkfm-rail');

    var lead = el('div', 'mkfm-lead');
    var title = el('div', 'mkfm-t');
    title.className = 't' + (status === 'ok' ? '' : ' off');
    title.appendChild(el('i'));
    title.appendChild(document.createTextNode(
      status === 'ok' ? 'LIVE POSITIONING'
        : status === 'closed' ? 'LAST SESSION'
          : status === 'stale' ? 'DELAYED DATA' : 'POSITIONING'));
    lead.appendChild(title);
    lead.appendChild(el('div', 's', status === 'closed'
      ? 'Session of ' + (data.tradeDate || '')
      : CFG.tradesPerDayLabel));
    lead.appendChild(poweredBy(host));
    wrap.appendChild(lead);

    var scroll = el('div', 'mkfm-scroll');
    ds.forEach(function (d) {
      var cell = el('div', 'mkfm-cell');

      var top = el('div', 'mkfm-ct');
      top.appendChild(el('span', 'sym', d.sym));
      var arCls = d.side === 'long' ? 'up' : d.side === 'short' ? 'dn' : 'nu';
      top.appendChild(el('span', 'ar ' + arCls,
        d.side === 'long' ? '▲' : d.side === 'short' ? '▼' : '●'));
      var dl = el('span', 'mkfm-dl', 'Δ' + Math.abs(d.dv).toFixed(Math.abs(d.dv) < 10 ? 1 : 0));
      dl.title = 'Profitable minus unprofitable net-long share: ' +
        fmtSigned(d.dv, 1) + ' percentage points';
      top.appendChild(dl);
      cell.appendChild(top);

      [['P', d.pctLong, 'Profitable traders'], ['U', d.unprofLong, 'Unprofitable traders']]
        .forEach(function (p) {
          var m = el('div', 'mkfm-mini');
          m.appendChild(el('span', null, p[0]));
          var tr = barTrack(p[1], 6);
          tr.title = p[2] + ': ' + sideLabel(p[1]).txt;
          m.appendChild(tr);
          cell.appendChild(m);
        });

      var f = el('div', 'mkfm-cf');
      var sideTxt = d.side === 'long' ? 'Long' : d.side === 'short' ? 'Short' : 'Split';
      f.appendChild(el('b', arCls, sideTxt));
      var tail = ' · ' + d.runLabel +
        ' · ' + fmtCount(d.trades);
      f.appendChild(document.createTextNode(tail));
      f.title = d.name + ' — profitable cohort ' + sideLabel(d.pctLong).txt +
        ', ' + (d.grain === 'intraday' ? d.runLabel : (d.run > 1 ? d.runLabel + ' consecutive' : 'first session')) +
        ' on this side, from ' + fmtCount(d.trades) + ' trades read.';
      cell.appendChild(f);
      scroll.appendChild(cell);
    });
    wrap.appendChild(scroll);
    outer.appendChild(wrap);

    if (status !== 'ok') {
      var ms = marketState();
      outer.appendChild(el('div', 'mkfm-note',
        status === 'closed'
          ? 'Market closed — showing the last completed session.' +
            (ms.minutesToOpen != null ? ' Reopens in ' + humanDur(ms.minutesToOpen) + '.' : '')
          : (res && res.source === 'snapshot')
            ? 'Live feed unreachable — showing the last cached session.'
            : 'Feed has not updated recently — values may be behind.'));
    }
    body.appendChild(outer);
  });

  /* ============================================================
   * 12. WIDGET C — POSITIONING vs PRICE CHART
   * ------------------------------------------------------------
   * mode="auto"  (default) real intraday when the feed advertises
   *              caps.intraday, otherwise the real session view
   * mode="session"  real 5m price + session-level cohort levels
   * mode="demo"     the reference intraday look, loudly stamped SIMULATED
   * ========================================================== */
  var CHART_CSS =
    ':host{display:block;width:100%}' +
    '.mkfm-ch{background:var(--mkfm-surface);border:1px solid var(--mkfm-border);' +
      'border-radius:var(--mkfm-radius);box-shadow:var(--mkfm-shadow);padding:14px 16px 10px;' +
      'display:flex;flex-direction:column;gap:9px}' +
    '.mkfm-chh{display:flex;align-items:center;gap:9px;flex-wrap:wrap}' +
    '.mkfm-badge{flex:none;padding:3px 8px;border-radius:7px;font:700 11.5px/1.2 var(--mkfm-font);' +
      'color:var(--mkfm-primary);background:var(--mkfm-primary-soft)}' +
    '.mkfm-cht{font:700 14px/1.2 var(--mkfm-font);letter-spacing:-.015em}' +
    '.mkfm-chh .mkfm-chip{height:18px;font-size:9.5px}' +
    '.mkfm-upd{font:400 11.5px/1.2 var(--mkfm-font);color:var(--mkfm-faint)}' +
    '.mkfm-seg{margin-left:auto;display:flex;gap:2px;padding:2px;border-radius:9px;' +
      'background:var(--mkfm-surface-2);border:1px solid var(--mkfm-hair)}' +
    '.mkfm-seg button{padding:4px 10px;border-radius:7px;font:600 11.5px/1.2 var(--mkfm-font);' +
      'color:var(--mkfm-muted)}' +
    '.mkfm-seg button[aria-pressed="true"]{background:var(--mkfm-surface);color:var(--mkfm-ink);' +
      'box-shadow:var(--mkfm-shadow)}' +
    '.mkfm-seg button:focus-visible{outline:2px solid var(--mkfm-primary);outline-offset:1px}' +
    '.mkfm-lede{font:400 12.5px/1.45 var(--mkfm-font);color:var(--mkfm-ink)}' +
    '.mkfm-lede b{font-weight:700}' +
    '.mkfm-lede b.up{color:var(--mkfm-long)}.mkfm-lede b.dn{color:var(--mkfm-short)}' +
    '.mkfm-key{display:flex;align-items:center;gap:16px;flex-wrap:wrap;' +
      'font:500 11.5px/1.2 var(--mkfm-font);color:var(--mkfm-muted)}' +
    '.mkfm-key span{display:inline-flex;align-items:center;gap:6px}' +
    '.mkfm-key i{width:16px;height:3px;border-radius:2px;display:block}' +
    '.mkfm-plot{width:100%;display:block;overflow:visible}' +
    '.mkfm-chf{display:flex;align-items:center;justify-content:space-between;gap:10px;' +
      'padding-top:8px;border-top:1px solid var(--mkfm-hair);flex-wrap:wrap}' +
    '.mkfm-chf>span{font:400 11px/1.3 var(--mkfm-font);color:var(--mkfm-faint)}' +
    '.mkfm-pb{display:inline-flex;align-items:center;gap:5px;font:600 11px/1 var(--mkfm-font);color:var(--mkfm-muted)}' +
    '.mkfm-pb:hover{color:var(--mkfm-primary)}' +
    '.mkfm-logo{width:12px;height:10px;fill:var(--mkfm-primary);flex:none}' +
    '.mkfm-chip{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 7px;' +
      'border-radius:999px;font:700 9.5px/1 var(--mkfm-font);letter-spacing:.055em;' +
      'background:var(--mkfm-hair);color:var(--mkfm-muted)}' +
    '.mkfm-chip i{width:5px;height:5px;border-radius:50%;background:currentColor;display:block}' +
    '.mkfm-chip.live{background:rgba(4,163,109,.1);color:var(--mkfm-live)}' +
    '.mkfm-chip.stale{background:var(--mkfm-warn-soft);color:var(--mkfm-warn)}' +
    '.mkfm-chip.err{background:var(--mkfm-short-soft);color:var(--mkfm-short)}' +
    '.mkfm-sim{padding:6px 10px;border-radius:8px;background:var(--mkfm-warn-soft);' +
      'color:var(--mkfm-warn);font:600 11px/1.35 var(--mkfm-font)}' +
    '.mkfm-fallback{padding:34px 20px;display:flex;flex-direction:column;align-items:center;gap:9px;' +
      'border:1px solid var(--mkfm-border);border-radius:var(--mkfm-radius);background:var(--mkfm-surface)}' +
    '.mkfm-fb-msg{font:500 12.5px/1.4 var(--mkfm-font);color:var(--mkfm-muted)}' +
    '.mkfm-sk{background:linear-gradient(90deg,var(--mkfm-hair) 25%,var(--mkfm-surface-2) 37%,var(--mkfm-hair) 63%);' +
      'background-size:400% 100%;animation:mkfmsk 1.4s ease infinite;border-radius:6px}' +
    '@keyframes mkfmsk{0%{background-position:100% 50%}100%{background-position:0 50%}}' +
    '@media (max-width:560px){.mkfm-seg{margin-left:0;width:100%;overflow-x:auto}' +
      '.mkfm-ch{padding:12px 12px 8px}}';

  var SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var a in attrs) n.setAttribute(a, attrs[a]);
    return n;
  }

  // Deterministic pseudo-random, seeded by symbol, so the SIMULATED demo
  // series is stable across reloads and across every viewer's screen.
  function seeded(seed) {
    var s = 0;
    for (var i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  defineBase('mkfm-positioning-chart', CHART_CSS, function (body, data, status, res) {
    var host = this;
    var syms = (host.getAttribute('symbols') || CFG.symbols.join(',')).split(',')
      .map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
    var sym = (host.getAttribute('symbol') || syms[0] || 'NQ').trim().toUpperCase();
    var mode = (host.getAttribute('mode') || 'auto').toLowerCase();
    var caps = (data && data.caps) || {};
    if (mode === 'auto') mode = caps.intraday ? 'intraday' : 'session';

    if (status === 'loading') {
      body.innerHTML = '';
      var lw = el('div', 'mkfm-ch');
      var l1 = el('div', 'mkfm-sk'); l1.style.cssText = 'width:260px;height:16px';
      var l2 = el('div', 'mkfm-sk'); l2.style.cssText = 'width:100%;height:14px';
      var l3 = el('div', 'mkfm-sk'); l3.style.cssText = 'width:100%;height:300px';
      lw.appendChild(l1); lw.appendChild(l2); lw.appendChild(l3);
      body.appendChild(lw); return;
    }

    var d = derive(data, sym);
    if (!d) {
      body.innerHTML = '';
      var fb = el('div', 'mkfm-fallback');
      fb.appendChild(el('div', 'mkfm-fb-msg', 'Positioning data is unavailable right now.'));
      fb.appendChild(poweredBy(host));
      body.appendChild(fb); return;
    }

    body.innerHTML = '';
    var ch = el('div', 'mkfm-ch');

    /* header ----------------------------------------------------------- */
    var hd = el('div', 'mkfm-chh');
    hd.appendChild(el('span', 'mkfm-badge', d.sym));
    // Held by reference because the title has to tell the truth about whether
    // price is on the chart, and that is not known until the series is built.
    var titleEl = el('span', 'mkfm-cht',
      mode === 'session' ? 'Positioning vs. price · by session'
        : 'Positioning vs. price · intraday');
    hd.appendChild(titleEl);
    hd.appendChild(chipFor(status, res));
    var gen = (data.generatedAt || 0) * 1000;
    var mins = gen ? Math.round((Date.now() - gen) / 60000) : null;
    hd.appendChild(el('span', 'mkfm-upd',
      status === 'closed' ? 'session of ' + (data.tradeDate || '')
        : mins == null ? '' : mins < 2 ? 'updated just now' : 'updated ' + humanDur(mins) + ' ago'));

    var seg = el('div', 'mkfm-seg');
    syms.forEach(function (s) {
      if (!data.instruments[s]) return;
      var bn = el('button', null, s);
      bn.type = 'button';
      bn.setAttribute('aria-pressed', s === sym ? 'true' : 'false');
      bn.addEventListener('click', function () {
        host.setAttribute('symbol', s);
        host.emit('symbolchange', { symbol: s });
      });
      seg.appendChild(bn);
    });
    hd.appendChild(seg);
    ch.appendChild(hd);

    /* lede ------------------------------------------------------------- */
    var lede = el('div', 'mkfm-lede');
    var sideTxt = d.side === 'long' ? 'long' : d.side === 'short' ? 'short' : 'split';
    var sideCls = d.side === 'long' ? 'up' : d.side === 'short' ? 'dn' : 'nu';
    var lb = el('b', sideCls, 'Profitable traders are ' + sideTxt);
    lede.appendChild(lb);
    lede.appendChild(document.createTextNode(
      ' — ' + (d.grain === 'intraday' ? d.runLabel + ' on this side' : (d.run > 1 ? d.runLabel + ' consecutive on this side' : 'first session on this side')) +
      (d.move != null && d.run > 1 ? ', ' + d.sym + ' ' + fmtSigned(d.move, d.dp) + ' since' : '') +
      '. Unprofitable traders are ' + sideLabel(d.unprofLong).txt + '.'));
    ch.appendChild(lede);

    /* key -------------------------------------------------------------- */
    var key = el('div', 'mkfm-key');
    function keyItem(color, label, dash) {
      var s = el('span');
      var i = el('i');
      i.style.background = color;
      if (dash) { i.style.background = 'none'; i.style.borderTop = '3px dashed ' + color; i.style.height = '0'; }
      s.appendChild(i); s.appendChild(document.createTextNode(label));
      return s;
    }
    // Counts are only shown when the feed actually carries them. A feed without
    // per-cohort counts gets an unlabelled legend rather than a fabricated "(0)".
    function cnt(n) { return (n == null || isNaN(n)) ? '' : ' (' + fmtCount(n) + ')'; }
    key.appendChild(keyItem('var(--mkfm-long)', 'Profitable traders' + cnt(d.last.vw)));
    key.appendChild(keyItem('#f2620f', 'Unprofitable traders' + cnt(d.last.vl)));
    key.appendChild(keyItem('var(--mkfm-tick)', 'All traders' + cnt(d.trades), true));
    ch.appendChild(key);

    /* plot ------------------------------------------------------------- */
    // MR has to hold the right-edge value labels ("Unprofitable 58.1" at 14px
    // ≈ 120px of text starting 26px past the last plotted point), so it is wide.
    var W = 1000, H = 430, ML = 46, MR = 158, MT = 22, MB = 34;
    var PW = W - ML - MR, PH = H - MT - MB;
    var svg = sv('svg', {
      class: 'mkfm-plot', viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'xMidYMid meet', role: 'img'
    });
    svg.setAttribute('aria-label',
      d.sym + ' positioning versus price. Profitable traders ' + sideLabel(d.pctLong).txt +
      ', unprofitable traders ' + sideLabel(d.unprofLong).txt + '.');

    var series, xLabels, priceSeries, flipIdx = null, simulated = false;

    if (mode === 'demo' || (mode === 'intraday' && !caps.intraday)) {
      /* ---- SIMULATED intraday: real closing values as the anchor, a
              deterministic path between them. Stamped, never implied real. */
      simulated = true;
      var rnd = seeded(d.sym + (d.tradeDate || ''));
      var N = 78, pw = [], pu = [], pa = [], px = [];
      var endW = d.pctLong, endU = d.unprofLong;
      var startW = clamp(50 + (endW - 50) * -0.25 + (rnd() - .5) * 8, 12, 88);
      var startU = clamp(50 + (endU - 50) * -0.25 + (rnd() - .5) * 8, 12, 88);
      flipIdx = Math.round(N * 0.34);
      var basePx = (d.m5 && d.m5.o) || d.last.c || 100;
      var endPx = (d.m5 && d.m5.c && d.m5.c.length) ? d.m5.c[d.m5.c.length - 1] : basePx;
      for (var i2 = 0; i2 < N; i2++) {
        var t = i2 / (N - 1);
        var ease = t < flipIdx / N ? t / (flipIdx / N) * 0.18 : 0.18 + (t - flipIdx / N) / (1 - flipIdx / N) * 0.82;
        pw.push(clamp(startW + (endW - startW) * ease + (rnd() - .5) * 6.5, 8, 92));
        pu.push(clamp(startU + (endU - startU) * ease + (rnd() - .5) * 6.5, 8, 92));
        pa.push((pw[i2] * 0.28 + pu[i2] * 0.72));
        px.push(basePx + (endPx - basePx) * ease + (rnd() - .5) * Math.abs(endPx - basePx || basePx * 0.002) * 0.55);
      }
      series = { w: pw, u: pu, a: pa };
      priceSeries = px;
      xLabels = ['9:30a', '11:10a', '12:45p', '2:25p', '3:59p'];
    } else if (mode === 'intraday') {
      /* ---- REAL intraday, read straight off the same 5-minute cohort buckets
              the card and the rail consume. Deliberately d.rows and not a
              separate intraday payload: there is exactly one series in the
              library, so all three widgets agree by construction and can never
              drift apart. */
      var ir = d.rows.filter(function (r) {
        // A bucket with a null cohort value would plot as NaN and break the
        // path, so thin buckets are dropped rather than drawn as zero.
        return num(r.w) && num(r.l) && num(r.a);
      }).slice(-96);                                   // ~8h of 5-minute buckets
      series = {
        w: ir.map(function (r) { return r.w; }),
        u: ir.map(function (r) { return r.l; }),
        a: ir.map(function (r) { return r.a; })
      };
      // The cohort feed carries no price, so every c is null here. The price
      // block below is gated on a numeric series, so it omits rather than
      // inventing a flat line at zero.
      priceSeries = ir.map(function (r) { return r.c; });
      for (var fj = ir.length - 1; fj >= 1; fj--) {
        var cj = ir[fj].w > 50 ? 1 : -1, pj = ir[fj - 1].w > 50 ? 1 : -1;
        if (cj !== pj) { flipIdx = fj; break; }
      }
      // Real bucket timestamps, in ET. Five evenly spaced ticks across whatever
      // window the feed actually returned.
      xLabels = [];
      for (var xi = 0; xi < 5 && ir.length; xi++) {
        xLabels.push(etClock(ir[Math.round((ir.length - 1) * (xi / 4))].d));
      }
    } else {
      /* ---- REAL session view: one point per session, honest resolution. */
      var rr = d.rows.slice(-45);
      series = {
        w: rr.map(function (r) { return r.w; }),
        u: rr.map(function (r) { return r.l; }),
        a: rr.map(function (r) { return r.a; })
      };
      priceSeries = rr.map(function (r) { return r.c; });
      for (var fi = rr.length - 1; fi >= 1; fi--) {
        var cur = rr[fi].w > 50 ? 1 : -1, prev = rr[fi - 1].w > 50 ? 1 : -1;
        if (cur !== prev) { flipIdx = fi; break; }
      }
      xLabels = [rr[0].d, rr[Math.floor(rr.length / 2)].d, rr[rr.length - 1].d];
    }

    var n = series.w.length;
    var yLo = 20, yHi = 80;
    var allv = series.w.concat(series.u, series.a).filter(num);
    if (!allv.length) allv = [50];
    yLo = Math.min(20, Math.floor((Math.min.apply(null, allv) - 4) / 10) * 10);
    yHi = Math.max(80, Math.ceil((Math.max.apply(null, allv) + 4) / 10) * 10);
    function X(i) { return ML + (n <= 1 ? PW / 2 : (i / (n - 1)) * PW); }
    function Y(v) { return MT + PH - ((v - yLo) / (yHi - yLo)) * PH; }

    // The cohort endpoint carries positioning only — no price. Rather than
    // plotting nulls (which Math.min coerces to 0, collapsing the scale and
    // printing "Price null–null" in the legend), the whole price layer is
    // gated on the series actually containing numbers. When it does not, the
    // chart is a positioning chart and says so, instead of drawing a fiction.
    var pxNums = priceSeries.filter(num);
    var hasPrice = pxNums.length > 1;
    if (!hasPrice) {
      titleEl.textContent = mode === 'session'
        ? 'Cohort positioning · by session' : 'Cohort positioning · intraday';
    }
    var pLo = 0, pHi = 1;
    if (hasPrice) {
      pLo = Math.min.apply(null, pxNums); pHi = Math.max.apply(null, pxNums);
      if (pHi === pLo) { pHi = pLo + 1; }
    }
    var pPad = (pHi - pLo) * 0.12;
    function PY(v) { return MT + PH - ((v - (pLo - pPad)) / ((pHi + pPad) - (pLo - pPad))) * PH; }

    // Price rides its own scale, not the 0–100% axis, so the legend carries the
    // range it spans. Appended here rather than with the other key items
    // because pLo/pHi are only known once the series has been built.
    if (hasPrice) {
      key.appendChild(keyItem(PRICE_SWATCH,
        'Price ' + fmtNum(pLo, d.dp) + '–' + fmtNum(pHi, d.dp) + ' (own scale)'));
    }

    // gridlines + y axis
    for (var g = yLo; g <= yHi; g += 10) {
      svg.appendChild(sv('line', {
        x1: ML, x2: ML + PW, y1: Y(g), y2: Y(g),
        stroke: g === 50 ? 'var(--mkfm-border)' : 'var(--mkfm-hair)',
        'stroke-width': g === 50 ? 1.5 : 1
      }));
      var yl = sv('text', {
        x: ML - 9, y: Y(g) + 4, 'text-anchor': 'end',
        fill: 'var(--mkfm-faint)', 'font-size': 13, 'font-weight': 500,
        'font-family': 'var(--mkfm-font)'
      });
      yl.textContent = g + '%';
      svg.appendChild(yl);
    }

    // shaded "time on current signal" zone
    if (flipIdx != null && flipIdx < n - 1) {
      svg.appendChild(sv('rect', {
        x: X(flipIdx), y: MT, width: (ML + PW) - X(flipIdx), height: PH,
        fill: d.side === 'short' ? 'var(--mkfm-short)' : 'var(--mkfm-primary)',
        opacity: .055
      }));
      svg.appendChild(sv('line', {
        x1: X(flipIdx), x2: X(flipIdx), y1: MT, y2: MT + PH,
        stroke: d.side === 'short' ? 'var(--mkfm-short)' : 'var(--mkfm-primary)',
        'stroke-width': 1.5, 'stroke-dasharray': '5 4', opacity: .75
      }));
    }

    // Price rides its own scale, so it is drawn as candles in every mode rather
    // than as a line. A fourth line on a 0–100% axis reads as a fourth cohort;
    // candles read as price instantly. Drawn before the cohort lines so they
    // stay behind, at reduced opacity so they never compete with the signal.
    if (hasPrice) {
      var pg = sv('g', { opacity: .45 });
      var step = Math.max(1, Math.round(n / 62));
      var bw = Math.max(2, Math.min(7, (PW / Math.ceil(n / step)) * 0.55));
      for (var ci = 1; ci < n; ci += step) {
        var o = priceSeries[Math.max(0, ci - step)], c2 = priceSeries[ci];
        if (!num(o) || !num(c2)) continue;   // gap in the price series, skip
        var up = c2 >= o;
        var yA = PY(Math.max(o, c2)), yB = PY(Math.min(o, c2));
        pg.appendChild(sv('rect', {
          x: X(ci) - bw / 2, y: yA, width: bw, height: Math.max(1.4, yB - yA),
          rx: 1, fill: up ? '#16a34a' : '#ef4444'
        }));
      }
      svg.appendChild(pg);
    }

    function line(vals, stroke, width, dash) {
      var dd = vals.map(function (v, i) { return (i ? 'L' : 'M') + X(i) + ' ' + Y(v); }).join('');
      var a = { d: dd, fill: 'none', stroke: stroke, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
      if (dash) { a['stroke-dasharray'] = '7 6'; a.opacity = .8; }
      return sv('path', a);
    }
    svg.appendChild(line(series.a, 'var(--mkfm-tick)', 2, true));
    svg.appendChild(line(series.u, '#f2620f', 2.6));
    svg.appendChild(line(series.w, 'var(--mkfm-long)', 2.6));

    // end dots + right-hand value labels
    [[series.w, 'var(--mkfm-long)', 'Profitable'], [series.u, '#f2620f', 'Unprofitable']]
      .forEach(function (p) {
        var v = p[0][n - 1];
        if (!num(v)) return;
        svg.appendChild(sv('circle', { cx: X(n - 1), cy: Y(v), r: 4.5, fill: p[1] }));
        svg.appendChild(sv('line', {
          x1: X(n - 1) + 7, x2: X(n - 1) + 20, y1: Y(v), y2: Y(v),
          stroke: p[1], 'stroke-width': 3, 'stroke-linecap': 'round'
        }));
        var tx = sv('text', {
          x: X(n - 1) + 26, y: Y(v) + 5, fill: 'var(--mkfm-ink)',
          'font-size': 14, 'font-weight': 600, 'font-family': 'var(--mkfm-font)'
        });
        tx.textContent = p[2] + ' ' + p[0][n - 1].toFixed(1);
        svg.appendChild(tx);
      });

    // x labels
    xLabels.forEach(function (lbl, i) {
      var xp = ML + (xLabels.length === 1 ? PW / 2 : (i / (xLabels.length - 1)) * PW);
      var t = sv('text', {
        x: xp, y: MT + PH + 22,
        'text-anchor': i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle',
        fill: 'var(--mkfm-faint)', 'font-size': 13, 'font-weight': 500,
        'font-family': 'var(--mkfm-font)'
      });
      t.textContent = lbl;
      svg.appendChild(t);
    });

    ch.appendChild(svg);

    var bmin = Math.round((d.bucketSeconds || 300) / 60);

    if (simulated) {
      ch.appendChild(el('div', 'mkfm-sim',
        'SIMULATED PATH — the endpoints are today’s real cohort readings for ' + d.sym +
        '; the minute-by-minute path between them is generated for demonstration. ' +
        'This runs only when the live intraday feed is unreachable.'));
    } else if (mode === 'session') {
      ch.appendChild(el('div', 'mkfm-sim',
        'SESSION RESOLUTION — one point per completed session. Switch to intraday ' +
        'for the ' + bmin + '-minute cohort buckets.'));
    } else if (!hasPrice) {
      // Said out loud rather than quietly omitted: a reader who expects the
      // mockup's candles needs to know why they are not there.
      ch.appendChild(el('div', 'mkfm-sim',
        'POSITIONING ONLY — the cohort endpoint returns trader positioning without price, ' +
        'so no price series is drawn. The lines are real ' + bmin + '-minute cohort readings.'));
    }

    var cf = el('div', 'mkfm-chf');
    cf.appendChild(el('span', null,
      mode === 'session'
        ? 'Cohort share bucketed per session' + (hasPrice ? ' · price from settlement closes' : '')
        : bmin + '-minute buckets · recorded 24/7'));
    cf.appendChild(poweredBy(host));
    ch.appendChild(cf);
    body.appendChild(ch);
  });

  /* ============================================================
   * 13. AUTO-MOUNT for dashboards that inject markup at runtime
   *     <div data-mkfm="card" data-symbol="MNQ"></div>
   * ========================================================== */
  var TAGS = { card: 'mkfm-positioning-card', rail: 'mkfm-positioning-rail', chart: 'mkfm-positioning-chart' };

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
   * 14. PUBLIC API
   * ========================================================== */
  window.MKFM = {
    version: VERSION,
    config: CFG,
    refresh: function () { return load(true); },
    mount: mountAll,
    marketState: marketState,
    _store: store
  };
})();
