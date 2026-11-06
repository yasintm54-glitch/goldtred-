(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const nf = (n, d = 0) => (n == null || !isFinite(n) ? '—' : new Intl.NumberFormat('fa-IR', { maximumFractionDigits: d }).format(n));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ASSETS = [
    { id: 'mithqal', name: 'مثقال', unit: 'تومان', dec: 0 },
    { id: 'mithqal_havaleh', name: 'مثقال حواله', unit: 'تومان', dec: 0 },
    { id: 'usd', name: 'دلار فردایی', unit: 'تومان', dec: 0 },
    { id: 'usd_naghdi', name: 'دلار نقدی', unit: 'تومان', dec: 0 },
    { id: 'ounce', name: 'انس', unit: 'دلار', dec: 2 }
  ];

  const STORE_KEY = 'goldtrend-mobile-v2';

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || localStorage.getItem('goldtrend-mobile-v1') || '{}');
      return {
        ticks: d.ticks || {},
        settings: Object.assign({
          capital: 500000000, riskPct: 1, tradeMode: 'auto',
          autoRefreshMin: 5, autoNews: true
        }, d.settings || {}),
        signalLog: d.signalLog || [],
        news: d.news || { items: [], at: 0, analysis: null, errors: [] },
        lastNetRefresh: d.lastNetRefresh || 0,
        customSources: d.customSources || []
      };
    } catch (e) {
      return {
        ticks: {}, settings: { capital: 500000000, riskPct: 1, tradeMode: 'auto', autoRefreshMin: 5, autoNews: true },
        signalLog: [], news: { items: [], at: 0, analysis: null, errors: [] }, lastNetRefresh: 0
      };
    }
  }

  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      ticks: state.ticks, settings: state.settings, signalLog: state.signalLog,
      news: state.news, lastNetRefresh: state.lastNetRefresh, customSources: state.customSources || []
    }));
  }

  const state = Object.assign({ tab: 'dash', asset: 'mithqal', busy: false }, load());

  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind === 'err' ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 4000);
  }

  function ticksOf(id) { return state.ticks[id] || []; }
  function lastOf(id) { const t = ticksOf(id); return t.length ? t[t.length - 1] : null; }

  function addPrice(assetId, value, t, manual) {
    const v = Number(value);
    if (!isFinite(v) || v <= 0) throw new Error('قیمت نامعتبر');
    const arr = state.ticks[assetId] = state.ticks[assetId] || [];
    const last = arr[arr.length - 1];
    if (last && !manual && Math.abs(last[1] - v) / v < 0.0005 && Date.now() - last[0] < 120000) return;
    arr.push([t || Date.now(), v, 1, manual ? 1 : 0]);
    arr.sort((a, b) => a[0] - b[0]);
    save();
  }

  function parseBulk(text) {
    let added = 0;
    for (const line of String(text).split(/\n+/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const parts = s.split(/[,\t]/).map(x => x.trim());
      let assetId = state.asset, time = Date.now(), price;
      if (parts.length >= 3) {
        assetId = parts[0];
        time = Date.parse(parts[1].replace(' ', 'T'));
        price = Number(parts[2].replace(/,/g, ''));
      } else if (parts.length === 2) {
        time = Date.parse(parts[0].replace(' ', 'T'));
        price = Number(parts[1].replace(/,/g, ''));
      } else price = Number(parts[0].replace(/,/g, ''));
      if (!isFinite(time)) time = Date.now();
      if (!isFinite(price) || price <= 0) continue;
      if (!ASSETS.find(a => a.id === assetId)) assetId = state.asset;
      addPrice(assetId, price, time, true);
      added++;
    }
    return added;
  }

  function analyzeCurrent() {
    if (!window.Analysis) return null;
    return Analysis.analyze(ticksOf(state.asset), 'day', [1, 3, 5], {
      ounceTicks: ticksOf('ounce'),
      usdTicks: ticksOf('usd'),
      usdNaghdiTicks: ticksOf('usd_naghdi'),
      newsAnalysis: state.news.analysis ? { result: state.news.analysis } : null
    });
  }

  async function refreshPrices() {
    if (!window.PriceFeed) throw new Error('ماژول قیمت لود نشده');
    if (!navigator.onLine) throw new Error('اینترنت نیست');
    const r = await PriceFeed.refreshAll(state.customSources || []);
    const map = { ounce: r.ounce, usd: r.usd, usd_naghdi: r.usd_naghdi, mithqal: r.mithqal };
    let n = 0;
    for (const [id, o] of Object.entries(map)) {
      if (o && o.value > 0) { addPrice(id, o.value, r.at, false); n++; }
    }
    state.lastNetRefresh = r.at;
    save();
    return { n, errors: r.errors || [] };
  }

  async function refreshNews() {
    if (!window.NewsLite) throw new Error('ماژول خبر لود نشده');
    if (!navigator.onLine) throw new Error('اینترنت نیست');
    const { items, errors } = await NewsLite.fetchFeeds();
    const analysis = NewsLite.offlineAnalysis(items);
    state.news = { items, at: Date.now(), analysis, errors };
    save();
    return state.news;
  }

  async function refreshAllNet() {
    state.busy = true; render();
    const msgs = [];
    try {
      try {
        const p = await refreshPrices();
        msgs.push(p.n ? p.n + ' قیمت اینترنتی' : 'قیمت اینترنتی محدود');
      } catch (e) { msgs.push('قیمت: ' + (e.message || e)); }
      if (state.settings.autoNews !== false) {
        try {
          const n = await refreshNews();
          msgs.push((n.items || []).length + ' خبر');
        } catch (e) { msgs.push('خبر: ' + (e.message || e)); }
      }
      toast(msgs.join(' · '));
    } finally {
      state.busy = false; render();
    }
  }

  function renderDash() {
    const a = ASSETS.find(x => x.id === state.asset) || ASSETS[0];
    const last = lastOf(a.id);
    const an = analyzeCurrent();
    const mode = state.settings.tradeMode || 'auto';
    const online = navigator.onLine;

    let h = '<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px">' +
      '<span class="badge ' + (online ? 'ok' : 'none') + '">' + (online ? 'آنلاین' : 'آفلاین') + '</span>' +
      '<button type="button" class="btn" data-act="net-refresh" ' + (state.busy ? 'disabled' : '') + '>' + (state.busy ? '…' : 'بروزرسانی اینترنت') + '</button></div>' +
      '<div class="row" style="margin-bottom:8px;gap:6px">' +
      ASSETS.map(x => '<button type="button" class="chip ' + (x.id === a.id ? 'on' : '') + '" data-act="asset" data-id="' + x.id + '">' + esc(x.name) + '</button>').join('') +
      '</div><div class="mute">' + esc(a.name) + '</div>' +
      '<div class="price">' + (last ? nf(last[1], a.dec) : '—') + ' <span class="mute" style="font-size:14px">' + esc(a.unit) + '</span></div>' +
      '<div class="mute">' + (last ? new Date(last[0]).toLocaleString('fa-IR') : 'بدون قیمت') + ' · ' + nf(ticksOf(a.id).length) + ' نقطه' +
      (state.lastNetRefresh ? ' · نت: ' + new Date(state.lastNetRefresh).toLocaleTimeString('fa-IR') : '') + '</div></div>';

    h += '<div class="card"><h2>نوع نوسان</h2><div class="row">' +
      ['auto|پیشنهاد', 'long|مثبت', 'short|منفی'].map(pair => {
        const [v, l] = pair.split('|');
        return '<button type="button" class="chip ' + (mode === v ? 'on' : '') + '" data-act="mode" data-v="' + v + '">' + l + '</button>';
      }).join('') + '</div></div>';

    if (!an || !an.ind) {
      return h + '<div class="card"><p class="note">قیمت بزن یا بروزرسانی اینترنت. برای تحلیل چند نقطه تاریخی بهتر است.</p></div>';
    }

    if (an.regime) {
      h += '<div class="card"><h2>رژیم</h2><b>' + esc(an.regime.label) + '</b><div class="note">' + esc(an.regime.note || '') + '</div></div>';
    }

    let scalpList = (an.horizons || []).map(hz => hz.scalp).filter(Boolean);
    if (mode !== 'auto' && an.last != null && an.ind && Analysis.scalpingPlan) {
      scalpList = (an.horizons || []).map(hz => {
        const base = hz.pUpDisplay != null ? hz.pUpDisplay : hz.hybridP != null ? hz.hybridP : hz.pUp;
        const p = mode === 'long' ? Math.max(base || 0.5, 0.62) : Math.min(base || 0.5, 0.38);
        return Analysis.scalpingPlan(an.last, an.ind, p, hz.move || { p10: -1, p90: 1 }, 'روز', hz.h);
      }).filter(Boolean);
    }
    const primary = scalpList.find(s => s.tradeOk) || scalpList[0];
    if (primary) {
      const sideCls = primary.side === 'long' ? 'up' : primary.side === 'short' ? 'down' : '';
      h += '<div class="card"><div class="row"><div class="advice ' + sideCls + '">' + esc(primary.advice || primary.action) + '</div>' +
        '<span class="badge ' + (primary.tradeOk ? 'ok' : 'mid') + '">' + (primary.tradeOk ? 'ورود' : 'صبر') + '</span></div>' +
        '<p class="note">' + esc(primary.adviceDetail || primary.note || '') + '</p><div class="kv">' +
        '<div><span>ورود</span><b>' + nf(primary.entry) + '</b></div>' +
        '<div><span>حد ضرر</span><b class="down">' + nf(primary.stop) + '</b></div>' +
        '<div><span>هدف۱</span><b class="up">' + nf(primary.tp1) + '</b></div>' +
        '<div><span>هدف۲</span><b class="up">' + nf(primary.tp2) + '</b></div>' +
        '<div><span>R/R</span><b>' + (primary.rr == null ? '—' : nf(primary.rr, 1)) + '</b></div>' +
        '<div><span>اطمینان</span><b>' + nf((primary.conf || 0) * 100, 0) + '٪</b></div></div>';
      const cap = Number(state.settings.capital) || 0;
      const rPct = Number(state.settings.riskPct) || 1;
      if (cap > 0 && primary.entry && primary.stop) {
        const riskUnit = Math.abs(primary.entry - primary.stop);
        const budget = cap * rPct / 100;
        const units = riskUnit > 0 ? budget / riskUnit : null;
        if (units) h += '<div class="note" style="margin-top:8px">حجم ≈ <b>' + nf(units, 2) + '</b> (ریسک ' + nf(rPct, 1) + '٪)</div>';
      }
      h += '<button type="button" class="btn block" data-act="log-sig" data-side="' + esc(primary.side || '') +
        '" data-entry="' + primary.entry + '" data-stop="' + primary.stop + '" data-tp1="' + primary.tp1 + '">ثبت سیگنال</button></div>';
    }

    for (const hz of an.horizons || []) {
      const p = hz.pUpDisplay != null ? hz.pUpDisplay : hz.hybridP;
      if (p == null) continue;
      const pct = Math.round(p * 100);
      h += '<div class="card"><h2>تا ' + nf(hz.h) + ' روز</h2><div class="' +
        (pct >= 55 ? 'up' : pct <= 45 ? 'down' : '') + '" style="font-size:20px;font-weight:800">صعود ' + nf(pct) + '٪</div>' +
        (hz.forecast ? '<div class="note">' + esc(hz.forecast.headline || '') + '</div>' : '') + '</div>';
    }

    if (an.walkForward) {
      const wf = an.walkForward;
      h += '<div class="card"><h2>بک‌تست محلی</h2><div class="kv"><div><span>آزمون</span><b>' + nf(wf.tests) +
        '</b></div><div><span>hit-rate</span><b>' + (wf.hitRate == null ? '—' : nf(wf.hitRate * 100, 0) + '٪') + '</b></div></div></div>';
    }

    if (state.news.analysis) {
      const na = state.news.analysis;
      h += '<div class="card"><h2>اثر خبر</h2><div class="note">جهت: <b>' + esc(na.direction || '—') +
        '</b> · دلار: ' + esc(na.fxBias || '—') + ' · انس: ' + esc(na.goldBias || '—') + '</div></div>';
    }
    return h;
  }

  function renderData() {
    const a = ASSETS.find(x => x.id === state.asset) || ASSETS[0];
    let h = '<div class="card"><button type="button" class="btn block" data-act="net-refresh" ' + (state.busy ? 'disabled' : '') +
      '>دریافت قیمت از اینترنت</button><p class="note">انس معمولاً بهتر لود می‌شود؛ دلار/مثقال ایران گاهی محدود است — دستی هم بزن.</p></div>';
    h += '<div class="card"><h2>ثبت دستی</h2><label class="f"><span>دارایی</span><select id="d-asset">' +
      ASSETS.map(x => '<option value="' + x.id + '" ' + (x.id === a.id ? 'selected' : '') + '>' + esc(x.name) + '</option>').join('') +
      '</select></label><label class="f"><span>قیمت</span><input id="d-price" inputmode="decimal"></label>' +
      '<button type="button" class="btn block" data-act="add-price">ثبت</button></div>';
    h += '<div class="card"><h2>ورود دسته‌ای</h2><textarea id="d-bulk" rows="5"></textarea>' +
      '<button type="button" class="btn block ghost" data-act="bulk">ثبت دسته‌ای</button></div>';
    const t = ticksOf(a.id).slice(-12).reverse();
    h += '<div class="card"><h2>' + esc(a.name) + '</h2>';
    if (!t.length) h += '<p class="note">خالی</p>';
    else for (const k of t) h += '<div class="list-item"><b>' + nf(k[1], a.dec) + '</b><div class="mute">' +
      new Date(k[0]).toLocaleString('fa-IR') + (k[3] ? ' · دستی' : ' · نت') + '</div></div>';
    return h + '</div>';
  }

  function renderNews() {
    let h = '<div class="card"><button type="button" class="btn block" data-act="news-refresh" ' + (state.busy ? 'disabled' : '') +
      '>دریافت و تحلیل اخبار</button><p class="note">با اینترنت گوشی — مستقل از مک.</p></div>';
    if (state.news.analysis) {
      const na = state.news.analysis;
      h += '<div class="card"><h2>جمع‌بندی</h2><div class="kv">' +
        '<div><span>جهت</span><b>' + esc(na.direction || '—') + '</b></div>' +
        '<div><span>دلار</span><b>' + esc(na.fxBias || '—') + '</b></div>' +
        '<div><span>انس</span><b>' + esc(na.goldBias || '—') + '</b></div></div></div>';
    }
    const items = state.news.items || [];
    if (!items.length) h += '<div class="card"><p class="note">خبری نیست.</p></div>';
    for (const it of items.slice(0, 20)) {
      h += '<div class="card list-item"><a href="' + esc(it.link || '#') + '" target="_blank" rel="noopener" style="color:var(--ink);font-weight:700;text-decoration:none">' +
        esc(it.title) + '</a><div class="mute">' + (it.t ? new Date(it.t).toLocaleString('fa-IR') : '') + '</div></div>';
    }
    return h;
  }

  function renderSignals() {
    const log = state.signalLog || [];
    const done = log.filter(x => x.outcome === 'win' || x.outcome === 'loss');
    const wins = done.filter(x => x.outcome === 'win').length;
    let h = '<div class="card"><h2>بازخورد</h2><div class="kv"><div><span>کل</span><b>' + nf(log.length) +
      '</b></div><div><span>نتیجه‌دار</span><b>' + nf(done.length) + '</b></div><div><span>برد</span><b class="up">' + nf(wins) +
      '</b></div><div><span>نرخ</span><b>' + (done.length ? nf(wins / done.length * 100, 0) + '٪' : '—') + '</b></div></div></div>';
    for (const sg of log.slice(0, 25)) {
      h += '<div class="card"><b>' + (sg.side === 'short' ? 'فروش' : 'خرید') + '</b><div class="note">ورود ' + nf(sg.entry) + '</div>';
      if (!sg.outcome) h += '<div class="row" style="margin-top:8px"><button type="button" class="btn ghost" data-act="sig-win" data-id="' +
        esc(sg.id) + '">برد</button><button type="button" class="btn ghost" data-act="sig-loss" data-id="' + esc(sg.id) + '">باخت</button></div>';
      else h += '<div class="' + (sg.outcome === 'win' ? 'up' : 'down') + '">' + (sg.outcome === 'win' ? 'برد' : 'باخت') + '</div>';
      h += '</div>';
    }
    if (!log.length) h += '<div class="card"><p class="note">سیگنالی نیست.</p></div>';
    return h;
  }

  function renderSettings() {
    const s = state.settings;
    return '<div class="card"><h2>ریسک</h2>' +
      '<label class="f"><span>سرمایه</span><input id="s-cap" value="' + esc(s.capital) + '" inputmode="numeric"></label>' +
      '<label class="f"><span>ریسک ٪</span><input id="s-risk" value="' + esc(s.riskPct) + '" inputmode="decimal"></label>' +
      '<label class="f"><span>بروزرسانی خودکار (دقیقه، ۰=خاموش)</span><input id="s-int" value="' + esc(s.autoRefreshMin) + '" inputmode="numeric"></label>' +
      '<label class="note"><input type="checkbox" id="s-autonews" ' + (s.autoNews !== false ? 'checked' : '') + '> خبر همراه قیمت</label>' +
      '<button type="button" class="btn block" data-act="save-set">ذخیره</button></div>' +
      '<div class="card"><h2>استقلال از مک</h2><p class="note">بعد از Install روی گوشی، برنامه از کش گوشی و اینترنت خود گوشی کار می‌کند.</p></div>' +
      '<div class="card"><h2>منابع قیمت (لینک سایت)</h2><p class="note">لینک سایت ایرانی یا هر URL. اگر سایت اجازه ندهد، خطا می‌دهد — لینک دیگر اضافه کن.</p>' +
      '<label class="f"><span>نام</span><input id="src-name" placeholder="منبع من"></label>' +
      '<label class="f"><span>آدرس</span><input id="src-url" placeholder="https://..." dir="ltr"></label>' +
      '<label class="f"><span>دارایی</span><select id="src-asset"><option value="mithqal">مثقال</option><option value="usd">دلار</option><option value="usd_naghdi">دلار نقدی</option><option value="ounce">انس</option></select></label>' +
      '<button type="button" class="btn block" data-act="src-add">افزودن منبع</button>' +
      ((state.customSources||[]).map((s,i)=>'<div class="list-item"><b>'+esc(s.name||s.url)+'</b><div class="mute ltr">'+esc(s.url)+'</div><button type="button" class="btn danger small" data-act="src-del" data-i="'+i+'">حذف</button></div>').join('')||'<p class="note">منبع سفارشی ندارید — پیش‌فرض‌ها: tgju، navasan، bonbast، …</p>') +
      '</div>' +
      '<div class="card"><h2>پشتیبان</h2><button type="button" class="btn block ghost" data-act="export">دانلود JSON</button>' +

      '<label class="btn block ghost" style="display:block;text-align:center;margin-top:8px">بازیابی<input type="file" id="importfile" accept=".json" style="display:none"></label>' +
      '<button type="button" class="btn block" style="background:#5a2030;margin-top:8px" data-act="wipe">پاک‌سازی</button></div>';
  }

  function render() {
    $$('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
    const last = lastOf(state.asset);
    $('#status').textContent = state.busy ? '…' : (last ? nf(last[1]) : '');
    const v = $('#view');
    if (state.tab === 'dash') v.innerHTML = renderDash();
    else if (state.tab === 'data') v.innerHTML = renderData();
    else if (state.tab === 'news') v.innerHTML = renderNews();
    else if (state.tab === 'signals') v.innerHTML = renderSignals();
    else v.innerHTML = renderSettings();
  }

  document.addEventListener('click', e => {
    const tab = e.target.closest('.nav button[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; render(); return; }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    (async () => {
      try {
        if (act === 'asset') { state.asset = t.dataset.id; render(); }
        else if (act === 'mode') { state.settings.tradeMode = t.dataset.v; save(); render(); }
        else if (act === 'net-refresh') await refreshAllNet();
        else if (act === 'news-refresh') {
          state.busy = true; render();
          try { const n = await refreshNews(); toast((n.items || []).length + ' خبر'); }
          finally { state.busy = false; render(); }
        } else if (act === 'add-price') {
          state.asset = $('#d-asset').value;
          addPrice(state.asset, $('#d-price').value.replace(/,/g, ''), Date.now(), true);
          toast('ثبت شد'); render();
        } else if (act === 'bulk') { toast(parseBulk($('#d-bulk').value) + ' قیمت'); render(); }
        else if (act === 'save-set') {
          state.settings.capital = Number(($('#s-cap').value || '').replace(/,/g, '')) || state.settings.capital;
          state.settings.riskPct = Number($('#s-risk').value) || state.settings.riskPct;
          state.settings.autoRefreshMin = Math.max(0, Number($('#s-int').value) || 0);
          state.settings.autoNews = $('#s-autonews').checked;
          save(); scheduleAuto(); toast('ذخیره شد');
        } else if (act === 'log-sig') {
          state.signalLog.unshift({
            id: 's' + Date.now(), at: Date.now(), side: t.dataset.side || 'long',
            entry: Number(t.dataset.entry), stop: Number(t.dataset.stop), tp1: Number(t.dataset.tp1),
            assetId: state.asset, outcome: null
          });
          state.signalLog = state.signalLog.slice(0, 100);
          save(); toast('ثبت شد');
        } else if (act === 'sig-win' || act === 'sig-loss') {
          const sg = state.signalLog.find(x => x.id === t.dataset.id);
          if (sg) { sg.outcome = act === 'sig-win' ? 'win' : 'loss'; save(); render(); }
        } else if (act === 'src-add') {
          const url = ($('#src-url').value || '').trim();
          if (!/^https?:\/\//i.test(url)) throw new Error('آدرس باید با http شروع شود');
          state.customSources = state.customSources || [];
          state.customSources.push({
            name: ($('#src-name').value || url).trim(),
            url,
            assetId: $('#src-asset').value,
            type: $('#src-asset').value === 'ounce' ? 'html' : 'html-rial'
          });
          save(); toast('منبع اضافه شد'); render();
        } else if (act === 'src-del') {
          state.customSources = (state.customSources || []).filter((_, i) => i !== Number(t.dataset.i));
          save(); render();
        } else if (act === 'export') {
          const blob = new Blob([JSON.stringify({
            ticks: state.ticks, settings: state.settings, signalLog: state.signalLog, news: state.news
          }, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'goldtrend-mobile-backup.json';
          a.click();
        } else if (act === 'wipe') {
          if (confirm('پاک شود؟')) {
            state.ticks = {}; state.signalLog = []; state.news = { items: [], at: 0, analysis: null, errors: [] };
            save(); toast('پاک شد'); render();
          }
        }
      } catch (err) {
        toast(err.message || String(err), 'err');
        state.busy = false; render();
      }
    })();
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'importfile' && e.target.files && e.target.files[0]) {
      e.target.files[0].text().then(txt => {
        const d = JSON.parse(txt);
        if (d.ticks) state.ticks = d.ticks;
        if (d.settings) state.settings = Object.assign(state.settings, d.settings);
        if (d.signalLog) state.signalLog = d.signalLog;
        if (d.news) state.news = d.news;
        save(); toast('بازیابی شد'); render();
      }).catch(() => toast('فایل نامعتبر', 'err'));
    }
  });

  let autoTimer = null;
  function scheduleAuto() {
    clearInterval(autoTimer);
    const m = Number(state.settings.autoRefreshMin) || 0;
    if (m > 0) autoTimer = setInterval(() => { if (navigator.onLine && !state.busy) refreshAllNet(); }, m * 60000);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  window.addEventListener('online', () => toast('آنلاین'));
  window.addEventListener('offline', () => toast('آفلاین', 'err'));

  scheduleAuto();
  render();
  if (navigator.onLine && Object.keys(state.ticks).length < 2) {
    setTimeout(() => refreshAllNet().catch(() => {}), 800);
  }
})();
