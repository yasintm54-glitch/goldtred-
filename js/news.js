/* تحلیل خبر مرورگر — RSS + کلیدواژه (بدون Node) */
(function (root) {
  'use strict';

  const RULES = [
    { re: /rate (hike|rise)|hawkish|strong(er)? dollar|yields? (rise|jump)/i, e: { ounce: -1 }, tag: 'فدرال/دلار قوی' },
    { re: /rate cut|dovish|weak(er)? dollar|yields? (fall|drop)/i, e: { ounce: 1 }, tag: 'فدرال/دلار ضعیف' },
    { re: /safe[- ]haven|\bwar\b|missile|escalat|conflict/i, e: { ounce: 0.7 }, tag: 'ریسک ژئوپلیتیک' },
    { re: /central banks?.{0,25}(buy|purchas)|gold reserves/i, e: { ounce: 0.8 }, tag: 'خرید بانک مرکزی' },
    { re: /ceasefire|de-?escalat|peace/i, e: { ounce: -0.4 }, tag: 'کاهش تنش' },
    { re: /iran.{0,40}sanction|sanction.{0,40}iran/i, e: { usd: 0.75 }, tag: 'تحریم' },
    { re: /iran.{0,40}(talks|deal|nuclear)/i, e: { usd: -0.45 }, tag: 'مذاکره' },
    { re: /cpi (hot|higher)|payrolls|inflation (hot|higher)/i, e: { ounce: -0.5 }, tag: 'تورم/اشتغال آمریکا' },
    { re: /cpi (cool|soft)|inflation (cool|ease)/i, e: { ounce: 0.45 }, tag: 'تورم آرام‌تر' },
    { re: /افزایش نرخ بهره|دلار (قوی|تقویت)/, e: { ounce: -1 }, tag: 'دلار قوی' },
    { re: /کاهش نرخ بهره|تضعیف دلار|دلار (ضعیف|افت)/, e: { ounce: 1 }, tag: 'دلار ضعیف' },
    { re: /جنگ|حمله|تنش|موشک|اسرائیل|غزه|تنگه هرمز/, e: { ounce: 0.7, usd: 0.55 }, tag: 'تنش' },
    { re: /آتش[\s-]?بس|کاهش تنش/, e: { ounce: -0.35, usd: -0.25 }, tag: 'کاهش تنش' },
    { re: /تحریم|فشار حداکثری|قطعنامه/, e: { usd: 0.75 }, tag: 'تحریم' },
    { re: /مذاکرات|برجام|توافق|رفع تحریم/, e: { usd: -0.45 }, tag: 'مذاکره' },
    { re: /(افزایش|صعود|جهش|رکورد).{0,12}(دلار|ارز)|دلار (گران|صعود|جهش)/, e: { usd: 1 }, tag: 'صعود دلار' },
    { re: /(کاهش|ریزش|افت).{0,12}(دلار|ارز)|دلار (ارزان|نزول|ریزش)/, e: { usd: -1 }, tag: 'نزول دلار' },
    { re: /(افزایش|صعود|جهش).{0,12}(مثقال|آبشده|سکه|طلا)/, e: { ounce: 0.35, usd: 0.25 }, tag: 'صعود طلا داخلی' },
    { re: /(کاهش|ریزش|افت).{0,12}(مثقال|آبشده|سکه|طلا)/, e: { ounce: -0.35, usd: -0.25 }, tag: 'نزول طلا داخلی' },
    { re: /حراج سکه|مرکز مبادله|بانک مرکزی.{0,20}(عرضه|حراج)/, e: { usd: -0.4 }, tag: 'عرضه/مداخله' },
    { re: /تورم|نقدینگی|کسری بودجه/, e: { usd: 0.45 }, tag: 'تورم' },
    { re: /انس (طلا|جهانی)|قیمت انس/, e: { ounce: 0.15 }, tag: 'انس' }
  ];

  const DEFAULT_FEEDS = [
    'https://news.google.com/rss/search?q=%D8%B7%D9%84%D8%A7+OR+%D8%AF%D9%84%D8%A7%D8%B1+OR+%D9%85%D8%AB%D9%82%D8%A7%D9%84+when:1d&hl=fa&gl=IR&ceid=IR:fa',
    'https://news.google.com/rss/search?q=gold+price+OR+Fed+OR+Iran+sanctions+when:1d&hl=en-US&gl=US&ceid=US:en'
  ];

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

  function parseRss(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const items = [];
    const nodes = doc.querySelectorAll('item');
    nodes.forEach((it, i) => {
      if (i >= 25) return;
      const title = (it.querySelector('title') || {}).textContent || '';
      const link = (it.querySelector('link') || {}).textContent || '';
      const desc = (it.querySelector('description') || {}).textContent || '';
      const pub = (it.querySelector('pubDate') || {}).textContent || '';
      if (title) items.push({ title: title.trim(), link, snippet: desc.replace(/<[^>]+>/g, '').slice(0, 200), t: Date.parse(pub) || Date.now() });
    });
    return items;
  }

  function scoreItem(it) {
    const text = `${it.title} ${it.snippet || ''}`;
    const s = { ounce: 0, usd: 0, hits: [] };
    for (const r of RULES) {
      if (r.re.test(text)) {
        s.ounce += r.e.ounce || 0;
        s.usd += r.e.usd || 0;
        s.hits.push(r.tag);
      }
    }
    return s;
  }

  function offlineAnalysis(items) {
    let ounce = 0, usd = 0;
    const scored = [];
    for (const it of (items || []).slice(0, 40)) {
      const s = scoreItem(it);
      ounce += s.ounce;
      usd += s.usd;
      if (s.hits.length) scored.push(Object.assign({}, it, s));
    }
    const n = Math.max(1, scored.length);
    const direction = usd + ounce > 0.4 ? 'bullish' : usd + ounce < -0.4 ? 'bearish' : 'neutral';
    return {
      ounce: ounce / n,
      usd: usd / n,
      direction,
      goldBias: ounce > 0.2 ? 'up' : ounce < -0.2 ? 'down' : 'neutral',
      fxBias: usd > 0.2 ? 'up' : usd < -0.2 ? 'down' : 'neutral',
      items: scored.slice(0, 15),
      overall: { ounce: ounce / n, usd: usd / n, direction }
    };
  }

  async function fetchFeeds(feeds) {
    const list = (feeds && feeds.length) ? feeds : DEFAULT_FEEDS;
    const items = [];
    const errors = [];
    for (const url of list) {
      try {
        const xml = await fetchText(url);
        items.push(...parseRss(xml));
      } catch (e) {
        errors.push({ url, error: String(e.message || e) });
      }
    }
    // dedupe by title
    const seen = new Set();
    const uniq = [];
    for (const it of items) {
      const k = it.title.slice(0, 80);
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(it);
    }
    uniq.sort((a, b) => (b.t || 0) - (a.t || 0));
    return { items: uniq.slice(0, 40), errors };
  }

  root.NewsLite = { fetchFeeds, offlineAnalysis, scoreItem, DEFAULT_FEEDS, fetchText, proxyUrl };
})(typeof self !== 'undefined' ? self : this);
