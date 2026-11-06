/* دریافت قیمت — منابع ایرانی + سفارشی کاربر */
(function (root) {
  'use strict';

  function proxyUrl(url) {
    return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
  }

  async function fetchText(url) {
    const tryUrls = [url, proxyUrl(url)];
    let lastErr;
    for (const u of tryUrls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(18000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.text();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('fetch failed');
  }

  function pickNumber(text, patterns) {
    for (const re of patterns) {
      const m = text.match(re);
      if (!m) continue;
      const raw = (m[1] || m[0]).replace(/[^\d.]/g, '');
      const n = parseFloat(raw);
      if (isFinite(n) && n > 0) return n;
    }
    return null;
  }

  // منابع پیش‌فرض ایرانی + جهانی
  const BUILTIN = [
    { id: 'goldprice', name: 'goldprice.org انس', assetId: 'ounce', url: 'https://data-asg.goldprice.org/dbXRates/USD', type: 'json-ounce' },
    { id: 'tgju-ons', name: 'tgju انس', assetId: 'ounce', url: 'https://www.tgju.org/profile/ons', type: 'html' },
    { id: 'tgju-mesghal', name: 'tgju مثقال', assetId: 'mithqal', url: 'https://www.tgju.org/profile/mesghal', type: 'html' },
    { id: 'tgju-geram18', name: 'tgju گرم۱۸', assetId: 'mithqal', url: 'https://www.tgju.org/profile/geram18', type: 'html' },
    { id: 'tgju-sekee', name: 'tgju سکه', assetId: 'mithqal', url: 'https://www.tgju.org/profile/sekee', type: 'html' },
    { id: 'tgju-usd', name: 'tgju دلار', assetId: 'usd', url: 'https://www.tgju.org/profile/price_dollar_rl', type: 'html-rial' },
    { id: 'tgju-currency', name: 'tgju ارز', assetId: 'usd', url: 'https://www.tgju.org/currency', type: 'html-rial' },
    { id: 'navasan', name: 'navasan', assetId: 'usd', url: 'https://www.navasan.net/', type: 'html-rial' },
    { id: 'bonbast', name: 'bonbast', assetId: 'usd', url: 'https://www.bonbast.com/', type: 'html-rial' },
    { id: 'talasea', name: 'طلاسی', assetId: 'mithqal', url: 'https://www.talasea.ir/', type: 'html' },
    { id: 'iranjib-gold', name: 'ایران‌جیب طلا', assetId: 'mithqal', url: 'https://www.iranjib.ir/show/gold', type: 'html' },
    { id: 'iranjib', name: 'ایران‌جیب', assetId: 'usd', url: 'https://www.iranjib.ir/', type: 'html-rial' },
    { id: 'eghtesad', name: 'اقتصادنیوز', assetId: 'usd', url: 'https://www.eghtesadnews.com/', type: 'html-rial' }
  ];

  async function readSource(src) {
    try {
      if (src.type === 'json-ounce') {
        const t = await fetchText(src.url);
        const j = JSON.parse(t);
        const v = j && j.items && j.items[0] && j.items[0].xauPrice;
        if (v > 100) return { value: +v, source: src.name };
        return { error: 'json خالی' };
      }
      const t = await fetchText(src.url);
      let patterns;
      if (src.type === 'html-rial') {
        patterns = [/([0-9]{2}(?:,[0-9]{3}){1,3})/g, /([0-9]{5,8})/];
      } else {
        patterns = [/([0-9]{1,3}(?:,[0-9]{3}){2,})/g, /([0-9]{6,12})/];
      }
      // custom regex from user
      if (src.regex) {
        try { patterns = [new RegExp(src.regex)]; } catch (e) {}
      }
      let v = null;
      for (const re of patterns) {
        const m = t.match(re);
        if (!m) continue;
        // take largest plausible
        const nums = [];
        const r2 = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        let mm;
        const text = t;
        const re3 = new RegExp(re.source, 'g');
        while ((mm = re3.exec(text)) && nums.length < 30) {
          const n = parseFloat((mm[1] || mm[0]).replace(/[^\d.]/g, ''));
          if (isFinite(n) && n > 0) nums.push(n);
        }
        if (nums.length) {
          nums.sort((a, b) => b - a);
          v = nums[0];
          break;
        }
      }
      if (!v) return { error: 'عدد پیدا نشد' };
      if (src.type === 'html-rial' && v > 500000) v = Math.round(v / 10);
      if (src.assetId === 'ounce' && (v < 100 || v > 20000)) return { error: 'خارج از بازه انس' };
      return { value: v, source: src.name };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }

  function allSources(custom) {
    const extra = (custom || []).map((c, i) => ({
      id: c.id || ('custom_' + i),
      name: c.name || c.url,
      assetId: c.assetId || 'mithqal',
      url: c.url,
      type: c.type || 'html',
      regex: c.regex || '',
      enabled: c.enabled !== false
    })).filter(c => c.url);
    return BUILTIN.map(b => Object.assign({ enabled: true }, b)).concat(extra);
  }

  async function refreshAll(custom) {
    const out = { at: Date.now(), ounce: null, usd: null, usd_naghdi: null, mithqal: null, errors: [], tried: [] };
    const list = allSources(custom).filter(s => s.enabled !== false);
    for (const src of list) {
      out.tried.push(src.name);
      const r = await readSource(src);
      if (r.value) {
        const slot = src.assetId === 'usd_naghdi' ? 'usd_naghdi'
          : src.assetId === 'usd' ? 'usd'
          : src.assetId === 'ounce' ? 'ounce'
          : 'mithqal';
        if (!out[slot]) out[slot] = { value: r.value, source: r.source };
        if (slot === 'usd' && !out.usd_naghdi) out.usd_naghdi = { value: r.value, source: r.source + ' (تقریبی)' };
      } else {
        out.errors.push(src.name + ': ' + (r.error || '?'));
      }
      // enough?
      if (out.ounce && out.usd && out.mithqal) break;
    }
    return out;
  }

  root.PriceFeed = { refreshAll, readSource, BUILTIN, allSources, fetchText };
})(typeof self !== 'undefined' ? self : this);
