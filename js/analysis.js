/* موتور تحلیل v2: احتمال ترکیبی (تاریخچه + شرایط فعلی)، سیگنال ورود/خروج نوسان‌گیری،
   اندیکاتورها، بک‌تست و تفکیک اثر انس/دلار. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Analysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_TRAIN = 18; // کاهش یافته تا با ~25–30 روز هم احتمال فعال شود
  const OUNCE_G = 31.1035;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  };
  const dayKey = t => { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function toBars(ticks, tf) {
    const m = new Map();
    for (const k of ticks) m.set(tf === 'hour' ? Math.floor(k[0] / 3600000) : dayKey(k[0]), [k[0], k[1]]);
    return [...m.values()].sort((a, b) => a[0] - b[0]).map(([t, c]) => ({ t, c }));
  }

  function scores(c) {
    const n = c.length;
    const sc = new Array(n).fill(null);
    const lr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) lr[i] = Math.log(c[i] / c[i - 1]);
    for (let i = 8; i < n; i++) {
      const w = Math.min(20, i);
      const vol = Math.max(sd(lr.slice(i - w + 1, i + 1)), 1e-4);
      const mom = Math.log(c[i] / c[Math.max(0, i - 5)]) / (vol * Math.sqrt(5));
      const win = c.slice(i - w, i + 1);
      const m = mean(win);
      const s = Math.max(sd(win), 1e-9 * m);
      sc[i] = Math.tanh(mom / 2) + Math.tanh((c[i] - m) / s / 2);
    }
    return sc;
  }

  function wilson(k, n, z) {
    z = z || 1.645;
    const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
    const a = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (c - a) / d), Math.min(1, (c + a) / d)];
  }

  function terciles(vals) {
    const s = vals.slice().sort((a, b) => a - b);
    return [s[Math.floor(s.length / 3)], s[Math.floor(2 * s.length / 3)]];
  }
  const bucketOf = (x, e) => (x < e[0] ? 0 : x < e[1] ? 1 : 2);

  function predictAt(c, sc, h, t) {
    const tr = [];
    for (let i = 8; i + h <= t; i++) if (sc[i] != null) tr.push(i);
    if (tr.length < MIN_TRAIN || sc[t] == null) return null;
    const e = terciles(tr.map(i => sc[i]));
    const b = bucketOf(sc[t], e);
    let m = 0, k = 0, ups = 0;
    for (const i of tr) {
      const up = c[i + h] > c[i];
      if (up) ups++;
      if (bucketOf(sc[i], e) === b) { m++; if (up) k++; }
    }
    if (m < 6) return null;
    const ci = wilson(k, m);
    return { p: (k + 1) / (m + 2), lo: ci[0], hi: ci[1], m, bucket: b, base: (ups + 1) / (tr.length + 2), N: tr.length };
  }

  function backtest(c, sc, h) {
    const n = c.length;
    let tests = 0, calls = 0, hits = 0, bs = 0, bb = 0;
    for (let t = 8 + MIN_TRAIN + h; t + h < n; t++) {
      const pr = predictAt(c, sc, h, t);
      if (!pr) continue;
      const up = c[t + h] > c[t] ? 1 : 0;
      tests++;
      bs += (pr.p - up) * (pr.p - up);
      bb += (pr.base - up) * (pr.base - up);
      if (Math.abs(pr.p - 0.5) >= 0.05) { calls++; if ((pr.p > 0.5 ? 1 : 0) === up) hits++; }
    }
    if (!tests) return { tests: 0, calls: 0, hits: 0, hitRate: null, brier: null, brierBase: null, skill: null };
    return {
      tests, calls, hits, hitRate: calls ? hits / calls : null,
      brier: bs / tests, brierBase: bb / tests, skill: bb > 0 ? 1 - bs / bb : null
    };
  }

  const quant = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

  function expectedMove(c, h, defVol) {
    const r = [];
    for (let i = 0; i + h < c.length; i++) r.push(Math.log(c[i + h] / c[i]));
    if (r.length >= MIN_TRAIN) {
      const f = x => (Math.exp(x) - 1) * 100;
      return { p10: f(quant(r, 0.1)), p50: f(quant(r, 0.5)), p90: f(quant(r, 0.9)), basis: 'empirical' };
    }
    const lr = [];
    for (let i = 1; i < c.length; i++) lr.push(Math.log(c[i] / c[i - 1]));
    const v = lr.length >= 5 ? sd(lr) : defVol;
    const s = v * Math.sqrt(h);
    return { p10: (Math.exp(-1.2816 * s) - 1) * 100, p50: 0, p90: (Math.exp(1.2816 * s) - 1) * 100, basis: 'normal' };
  }

  function rsi(c, period) {
    if (c.length <= period) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
    g /= period; l /= period;
    for (let i = period + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
      l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  const smaAt = (c, n) => (c.length >= n ? mean(c.slice(-n)) : null);
  const pct = (c, k) => (c.length > k ? (c[c.length - 1] / c[c.length - 1 - k] - 1) * 100 : null);
  const BUCKETS = ['ضعیف', 'میانه', 'قوی'];

  // --- امتیاز شرایط فعلی (نه فقط گذشته) ---
  // خروجی بین -1 (فشار نزولی قوی) تا +1 (فشار صعودی قوی)
  function currentBias(ind, last) {
    if (!ind || last == null) return { bias: 0, parts: [] };
    let score = 0;
    const parts = [];

    // روند
    if (ind.trend === 'صعودی') { score += 0.35; parts.push({ k: 'روند', v: '+صعودی', w: 0.35 }); }
    else if (ind.trend === 'نزولی') { score -= 0.35; parts.push({ k: 'روند', v: '−نزولی', w: -0.35 }); }
    else if (ind.trend && ind.trend.indexOf('صعودی') >= 0) { score += 0.15; parts.push({ k: 'روند', v: '+کمی صعودی', w: 0.15 }); }
    else if (ind.trend && ind.trend.indexOf('نزولی') >= 0) { score -= 0.15; parts.push({ k: 'روند', v: '−کمی نزولی', w: -0.15 }); }

    // RSI
    if (ind.rsi != null) {
      if (ind.rsi <= 28) { score += 0.28; parts.push({ k: 'RSI', v: `اشباع فروش (${Math.round(ind.rsi)})`, w: 0.28 }); }
      else if (ind.rsi <= 40) { score += 0.12; parts.push({ k: 'RSI', v: `نزدیک اشباع فروش (${Math.round(ind.rsi)})`, w: 0.12 }); }
      else if (ind.rsi >= 72) { score -= 0.28; parts.push({ k: 'RSI', v: `اشباع خرید (${Math.round(ind.rsi)})`, w: -0.28 }); }
      else if (ind.rsi >= 60) { score -= 0.12; parts.push({ k: 'RSI', v: `نزدیک اشباع خرید (${Math.round(ind.rsi)})`, w: -0.12 }); }
      else parts.push({ k: 'RSI', v: `خنثی (${Math.round(ind.rsi)})`, w: 0 });
    }

    // فاصله از حمایت/مقاومت
    if (ind.support != null && ind.resistance != null && last > 0) {
      const range = ind.resistance - ind.support;
      if (range > 0) {
        const pos = (last - ind.support) / range; // 0=حمایت، 1=مقاومت
        if (pos <= 0.2) { score += 0.22; parts.push({ k: 'موقعیت', v: 'نزدیک حمایت', w: 0.22 }); }
        else if (pos >= 0.8) { score -= 0.22; parts.push({ k: 'موقعیت', v: 'نزدیک مقاومت', w: -0.22 }); }
        else if (pos <= 0.4) { score += 0.08; parts.push({ k: 'موقعیت', v: 'نیمهٔ پایینی کانال', w: 0.08 }); }
        else if (pos >= 0.6) { score -= 0.08; parts.push({ k: 'موقعیت', v: 'نیمهٔ بالایی کانال', w: -0.08 }); }
      }
    }

    // مومنتوم اخیر
    if (ind.chg1 != null) {
      if (ind.chg1 <= -1.2) { score += 0.1; parts.push({ k: 'مومنتوم', v: 'افت تند اخیر (احتمال برگشت)', w: 0.1 }); }
      else if (ind.chg1 >= 1.2) { score -= 0.1; parts.push({ k: 'مومنتوم', v: 'رشد تند اخیر (احتمال اصلاح)', w: -0.1 }); }
    }
    if (ind.chg3 != null) {
      if (ind.chg3 <= -2.5) { score += 0.08; parts.push({ k: 'مومنتوم۳', v: 'اصلاح چنددوره‌ای', w: 0.08 }); }
      else if (ind.chg3 >= 2.5) { score -= 0.08; parts.push({ k: 'مومنتوم۳', v: 'صعود چنددوره‌ای', w: -0.08 }); }
    }

    // فاصله از میانگین
    if (ind.sma5 != null && last > 0) {
      const d5 = (last / ind.sma5 - 1) * 100;
      if (d5 < -1.5) { score += 0.1; parts.push({ k: 'SMA5', v: 'زیر میانگین ۵', w: 0.1 }); }
      else if (d5 > 1.5) { score -= 0.1; parts.push({ k: 'SMA5', v: 'بالای میانگین ۵', w: -0.1 }); }
    }

    return { bias: clamp(score, -1, 1), parts };
  }

  // ترکیب احتمال تاریخی با شرایط فعلی + زمینهٔ بازار (انس/دلار/خبر)
  function hybridProb(histP, bias, extraBias) {
    const base = histP == null ? 0.5 : histP;
    // وقتی تاریخچه نیست، وزن شرایط فعلی بیشتر است
    const wPrice = histP == null ? 0.42 : 0.30;
    const wCtx = histP == null ? 0.28 : 0.22;
    const adj = bias * wPrice * 0.55 + (extraBias || 0) * wCtx * 0.55;
    return clamp(base + adj, 0.08, 0.92);
  }

  // زمینهٔ چندعاملی: انس، دلار، اسپرد، اخبار (نه فقط قیمت خودِ دارایی)
  function marketContextBias(opts) {
    opts = opts || {};
    let score = 0;
    const parts = [];

    // روند انس
    if (opts.ounceTicks && opts.ounceTicks.length >= 5) {
      const ob = toBars(opts.ounceTicks, 'day');
      if (ob.length >= 3) {
        const last = ob[ob.length - 1].c;
        const prev = ob[Math.max(0, ob.length - 4)].c;
        const ch = (last / prev - 1) * 100;
        if (ch >= 0.8) { score += 0.35; parts.push({ k: 'انس', v: `صعود اخیر ${ch.toFixed(1)}٪`, w: 0.35 }); }
        else if (ch <= -0.8) { score -= 0.35; parts.push({ k: 'انس', v: `نزول اخیر ${ch.toFixed(1)}٪`, w: -0.35 }); }
        else parts.push({ k: 'انس', v: `تقریباً خنثی (${ch.toFixed(1)}٪)`, w: 0 });
      }
    }

    // روند دلار (فردایی ترجیح)
    const usdTicks = opts.usdTicks || opts.usdNaghdiTicks;
    if (usdTicks && usdTicks.length >= 5) {
      const ub = toBars(usdTicks, 'day');
      if (ub.length >= 3) {
        const last = ub[ub.length - 1].c;
        const prev = ub[Math.max(0, ub.length - 4)].c;
        const ch = (last / prev - 1) * 100;
        if (ch >= 0.6) { score += 0.4; parts.push({ k: 'دلار', v: `صعود ${ch.toFixed(1)}٪ → فشار روی طلای داخلی`, w: 0.4 }); }
        else if (ch <= -0.6) { score -= 0.4; parts.push({ k: 'دلار', v: `نزول ${ch.toFixed(1)}٪ → فشار کاهشی`, w: -0.4 }); }
        else parts.push({ k: 'دلار', v: `نسبتاً آرام (${ch.toFixed(1)}٪)`, w: 0 });
      }
    }

    // تفکیک اثر (premium z)
    if (opts.attribution && opts.attribution.z != null) {
      const z = opts.attribution.z;
      if (z > 1.4) { score -= 0.2; parts.push({ k: 'حباب', v: 'حباب بالاتر از معمول → ریسک اصلاح', w: -0.2 }); }
      else if (z < -1.4) { score += 0.2; parts.push({ k: 'حباب', v: 'مثقال عقب‌تر از انس×دلار → ظرفیت جبران', w: 0.2 }); }
    }

    // اخبار (تحلیل ذخیره‌شده)
    const na = opts.newsAnalysis && opts.newsAnalysis.result;
    if (na) {
      // ساختارهای رایج: ounce/usd scores یا summary direction
      let nBias = 0;
      if (typeof na.ounce === 'number') nBias += na.ounce * 0.25;
      if (typeof na.usd === 'number') nBias += na.usd * 0.35;
      if (na.bias && typeof na.bias === 'number') nBias += na.bias * 0.3;
      if (na.direction === 'bullish' || na.direction === 'up') nBias += 0.25;
      if (na.direction === 'bearish' || na.direction === 'down') nBias -= 0.25;
      if (na.goldBias === 'up') nBias += 0.2;
      if (na.goldBias === 'down') nBias -= 0.2;
      if (na.fxBias === 'up') nBias += 0.25;
      if (na.fxBias === 'down') nBias -= 0.25;
      // امتیاز تجمیعی از items
      if (Array.isArray(na.items)) {
        let o = 0, u = 0, n = 0;
        for (const it of na.items.slice(0, 20)) {
          if (it.ounce != null) { o += it.ounce; n++; }
          if (it.usd != null) { u += it.usd; n++; }
        }
        if (n) nBias += clamp((o * 0.2 + u * 0.3) / Math.max(1, n / 2), -0.35, 0.35);
      }
      nBias = clamp(nBias, -0.45, 0.45);
      if (Math.abs(nBias) >= 0.08) {
        score += nBias;
        parts.push({ k: 'اخبار', v: nBias > 0 ? 'سوگیری خبری به نفع صعود' : 'سوگیری خبری به نفع نزول', w: nBias });
      }
    }

    // اسپرد نقدی/حواله یا فردایی/نقدی
    if (opts.spreadAbshodeh && opts.spreadAbshodeh.spreadPct != null) {
      const s = opts.spreadAbshodeh.spreadPct;
      if (s > 0.8) { score += 0.08; parts.push({ k: 'اسپرد آبشده', v: 'نقدی بالاتر از حواله', w: 0.08 }); }
      else if (s < -0.8) { score -= 0.08; parts.push({ k: 'اسپرد آبشده', v: 'حواله بالاتر — احتیاط', w: -0.08 }); }
    }

    return { bias: clamp(score, -1, 1), parts };
  }


  // رژیم بازار: آرام / عادی / پرنوسان / بی‌جهت
  function detectRegime(c, ind) {
    const n = c.length;
    if (n < 8) return { id: 'unknown', label: 'نامشخص', tradeMult: 0.5, note: 'داده کم برای تشخیص رژیم' };
    const lr = [];
    for (let i = 1; i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
    const recent = lr.slice(-Math.min(15, lr.length));
    const vol = sd(recent) * 100; // درصد تقریبی روزانه
    const longer = lr.slice(-Math.min(40, lr.length));
    const volLong = longer.length >= 5 ? sd(longer) * 100 : vol;
    const ch3 = ind && ind.chg3 != null ? Math.abs(ind.chg3) : 0;
    const rsi = ind && ind.rsi != null ? ind.rsi : 50;
    // بی‌جهت: نوسان متوسط ولی حرکت خالص کم
    const path = recent.reduce((s, x) => s + Math.abs(x), 0);
    const net = Math.abs(recent.reduce((s, x) => s + x, 0));
    const efficiency = path > 1e-9 ? net / path : 0;

    if (vol >= 1.6 || (vol >= 1.2 && vol > volLong * 1.4)) {
      return { id: 'volatile', label: 'پرنوسان', tradeMult: 0.35, vol, note: 'نوسان بالا — فقط سیگنال خیلی قوی، حجم کمتر' };
    }
    if (efficiency < 0.18 && vol > 0.35 && ch3 < 1.2) {
      return { id: 'choppy', label: 'بی‌جهت / رنج', tradeMult: 0.25, vol, note: 'بازار رنج است — احتمال شکار حد ضرر بیشتر' };
    }
    if (vol <= 0.45 && ch3 < 0.8) {
      return { id: 'calm', label: 'آرام', tradeMult: 0.85, vol, note: 'نوسان پایین — اهداف نزدیک‌تر، صبور باش' };
    }
    return { id: 'normal', label: 'عادی', tradeMult: 1, vol, note: 'رژیم معمولی' };
  }

  // بک‌تست راه رفتن به جلو: آیا جهت احتمال ترکیبی در گذشته درست بوده؟
  function walkForwardSignals(c, sc, horizon) {
    const h = horizon || 1;
    const n = c.length;
    let tests = 0, hits = 0, longHits = 0, longN = 0, shortHits = 0, shortN = 0;
    let tpBeforeStop = 0, stopBeforeTp = 0, pathN = 0;
    const start = 8 + MIN_TRAIN + h;
    for (let t = start; t + h < n; t++) {
      const pr = predictAt(c, sc, h, t);
      if (!pr || pr.m < 8) continue;
      const p = pr.p;
      const future = c[t + h];
      const now = c[t];
      if (!(future > 0 && now > 0)) continue;
      const up = future > now;
      tests++;
      // سیگنال فقط وقتی لبه‌دار باشد
      if (p >= 0.58) {
        longN++;
        if (up) { hits++; longHits++; }
      } else if (p <= 0.42) {
        shortN++;
        if (!up) { hits++; shortHits++; }
      } else {
        // خنثی را در hit rate جهت‌دار حساب نکن
        tests--;
        continue;
      }
      // مسیر ساده: آیا حرکت 1.2% در جهت سیگنال زودتر از 0.8% خلاف بوده؟
      const dir = p >= 0.58 ? 1 : -1;
      let hitTp = false, hitSl = false;
      for (let k = 1; k <= h; k++) {
        const ret = (c[t + k] / now - 1) * dir;
        if (ret >= 0.012) { hitTp = true; break; }
        if (ret <= -0.008) { hitSl = true; break; }
      }
      if (hitTp || hitSl) {
        pathN++;
        if (hitTp && !hitSl) tpBeforeStop++;
        else if (hitSl) stopBeforeTp++;
      }
    }
    const edgeN = longN + shortN;
    const hitRate = edgeN ? hits / edgeN : null;
    const pathRate = pathN ? tpBeforeStop / pathN : null;
    return {
      tests: edgeN, hits, hitRate,
      longN, longHitRate: longN ? longHits / longN : null,
      shortN, shortHitRate: shortN ? shortHits / shortN : null,
      pathN, tpBeforeStop, stopBeforeTp, pathRate,
      reliable: edgeN >= 12 && hitRate != null && hitRate >= 0.52
    };
  }

  // سیگنال دوطرفه نوسان‌گیری: صعودی (خرید→خروج) و نزولی (فروش→خرید مجدد)
  // unit: 'ساعت' | 'روز'  — horizon اختیاری برای برچسب افق
  function scalpingPlan(last, ind, pUp, move, unit, horizon) {
    if (last == null || !ind) return null;
    const vol = Math.max(Math.abs(move.p10 || 0), Math.abs(move.p90 || 0), unit === 'ساعت' ? 0.4 : 0.8);
    const atrPct = vol / 100;
    // افق‌های بلندتر = حد ضرر و هدف کمی بازتر
    const h = horizon || 1;
    const scale = unit === 'ساعت' ? (1 + Math.min(h, 12) * 0.04) : (1 + Math.min(h, 7) * 0.08);
    const horizonLabel = horizon
      ? (unit === 'ساعت' ? `${horizon} ساعته` : horizon >= 5 ? `${horizon} روزه / نزدیک هفتگی` : `${horizon} روزه`)
      : (unit === 'ساعت' ? 'ساعتی' : 'روزانه');

    let side = 'neutral';
    let conf = 0.4;
    const reasons = [];

    if (pUp >= 0.58) {
      side = 'long';
      conf = 0.45 + (pUp - 0.5) * 1.2;
      reasons.push(`احتمال صعود بالا برای افق ${horizonLabel}`);
    } else if (pUp <= 0.42) {
      side = 'short';
      conf = 0.45 + (0.5 - pUp) * 1.2;
      reasons.push(`احتمال نزول بالا برای افق ${horizonLabel}`);
    } else {
      reasons.push('احتمال متعادل — ورود تهاجمی توصیه نمی‌شود');
    }

    if (ind.rsi != null && ind.rsi <= 32 && side !== 'short') {
      side = 'long'; conf = Math.max(conf, 0.55);
      reasons.push('RSI در ناحیه اشباع فروش → مناسب خرید');
    }
    if (ind.rsi != null && ind.rsi >= 68 && side !== 'long') {
      side = 'short'; conf = Math.max(conf, 0.55);
      reasons.push('RSI در ناحیه اشباع خرید → مناسب فروش/خروج');
    }

    // نقاط قیمتی — حد ضرر بر اساس نوسان (ATR)، نه فاصلهٔ کامل تا حمایت/مقاومت
    let entry = last;
    let stop, tp1, tp2;
    let action, entryLabel, exitLabel, stopLabel, note;
    const riskBand = Math.max(atrPct * 0.9 * scale, unit === 'ساعت' ? 0.0035 : 0.006); // حداقل پهنای ریسک

    if (side === 'long') {
      if (ind.support != null && last - ind.support < last * atrPct * 0.45) {
        entry = Math.max(ind.support * 1.001, last * 0.998);
        reasons.push('ورود نزدیک حمایت');
      }
      stop = entry * (1 - riskBand);
      // اگر حمایت خیلی نزدیک است، حد ضرر را کمی زیر حمایت بگذار ولی از ۲× riskBand دورتر نرو
      if (ind.support != null && ind.support < entry) {
        const soft = ind.support * 0.997;
        if (soft > entry * (1 - riskBand * 2)) stop = Math.min(stop, soft);
      }
      tp1 = entry * (1 + riskBand * 1.25);
      tp2 = entry * (1 + riskBand * 2.1);
      action = `نوسان مثبت · افق ${horizonLabel}`;
      entryLabel = 'نقطه خرید (ورود)';
      exitLabel = 'نقطه خروج از خرید (فروش)';
      stopLabel = 'حد ضرر خرید (اگر شکست)';
    } else if (side === 'short') {
      if (ind.resistance != null && ind.resistance - last < last * atrPct * 0.45) {
        entry = Math.min(ind.resistance * 0.999, last * 1.002);
        reasons.push('فروش نزدیک مقاومت');
      }
      stop = entry * (1 + riskBand);
      if (ind.resistance != null && ind.resistance > entry) {
        const soft = ind.resistance * 1.003;
        if (soft < entry * (1 + riskBand * 2)) stop = Math.max(stop, soft);
      }
      tp1 = entry * (1 - riskBand * 1.25);
      tp2 = entry * (1 - riskBand * 2.1);
      action = `نوسان منفی · افق ${horizonLabel}`;
      entryLabel = 'نقطه فروش (ورود شورت / خروج از خرید قبلی)';
      exitLabel = 'نقطه خرید مجدد (بستن معامله نزولی)';
      stopLabel = 'حد ضرر فروش (اگر برگشت بالا)';
    } else {
      stop = last * (1 - riskBand * 0.8);
      tp1 = last * (1 + riskBand * 0.8);
      tp2 = last * (1 + riskBand * 1.4);
      action = `صبر · افق ${horizonLabel}`;
      entryLabel = 'منطقه رصد';
      exitLabel = '—';
      stopLabel = 'حد مراقبت';
    }

    conf = clamp(conf, 0.2, 0.85);
    const riskPct = Math.abs(entry - stop) / entry * 100;
    const reward1 = Math.abs(tp1 - entry) / entry * 100;
    const rr = riskPct > 0 ? reward1 / riskPct : null;

    if (side === 'long') {
      note = `برای افق ${horizonLabel}: حدود ${Math.round(entry).toLocaleString('fa-IR')} بخر؛ ` +
        `خروج سود در ${Math.round(tp1).toLocaleString('fa-IR')} (هدف۱) یا ${Math.round(tp2).toLocaleString('fa-IR')} (هدف۲)؛ ` +
        `اگر زیر ${Math.round(stop).toLocaleString('fa-IR')} رفت از معامله خارج شو.`;
    } else if (side === 'short') {
      note = `برای افق ${horizonLabel}: حدود ${Math.round(entry).toLocaleString('fa-IR')} بفروش؛ ` +
        `خرید مجدد / بستن در ${Math.round(tp1).toLocaleString('fa-IR')} (هدف۱) یا ${Math.round(tp2).toLocaleString('fa-IR')} (هدف۲)؛ ` +
        `اگر بالای ${Math.round(stop).toLocaleString('fa-IR')} برگشت، معامله را ببند تا ضرر بیشتر نشود.`;
    } else {
      note = `تا افق ${horizonLabel} جهت واضحی نیست؛ صبر کن یا با حجم خیلی کم وارد شو.`;
    }

    // توصیهٔ اصلی سخت‌گیرانه
    let advice = 'صبر';
    let adviceDetail = 'الان ورود توصیه نمی‌شود؛ صبر کن تا سیگنال واضح‌تر شود.';
    let tradeOk = false;
    if (side === 'long' && conf >= 0.55 && rr != null && rr >= 1.15 && pUp >= 0.58) {
      advice = 'نوسان مثبت (خرید)';
      adviceDetail = `ترجیح الان: خرید. ورود ≈ ${Math.round(entry).toLocaleString('fa-IR')} · خروج ≈ ${Math.round(tp1).toLocaleString('fa-IR')} · حد ضرر ≈ ${Math.round(stop).toLocaleString('fa-IR')}.`;
      tradeOk = true;
    } else if (side === 'short' && conf >= 0.55 && rr != null && rr >= 1.15 && pUp <= 0.42) {
      advice = 'نوسان منفی (فروش)';
      adviceDetail = `ترجیح الان: فروش. فروش ≈ ${Math.round(entry).toLocaleString('fa-IR')} · خرید مجدد ≈ ${Math.round(tp1).toLocaleString('fa-IR')} · حد ضرر ≈ ${Math.round(stop).toLocaleString('fa-IR')}.`;
      tradeOk = true;
    } else if (side === 'long' && conf >= 0.48 && pUp >= 0.55) {
      advice = 'نوسان مثبت با احتیاط';
      adviceDetail = 'تمایل به صعود هست، ولی هنوز برای ورود کامل قانع‌کننده نیست — حجم کم یا صبر.';
    } else if (side === 'short' && conf >= 0.48 && pUp <= 0.45) {
      advice = 'نوسان منفی با احتیاط';
      adviceDetail = 'تمایل به نزول هست، ولی هنوز برای ورود کامل قانع‌کننده نیست — حجم کم یا صبر.';
    }

    return {
      action, side, conf, horizon: h, unit, horizonLabel,
      entry, stop, tp1, tp2,
      entryLabel, exitLabel, stopLabel,
      riskPct, reward1, rr,
      advice, adviceDetail, tradeOk,
      reasons, note
    };
  }

  function buildForecast(last, ind, hz, unit, hybridP, biasInfo, scalp) {
    if (!last || !ind) return null;
    const mv = hz.move;
    const pUp = hybridP != null ? hybridP : (hz.status === 'ok' ? hz.pUp : null);
    const pUpPct = pUp != null ? Math.round(pUp * 100) : null;
    const pDownPct = pUpPct != null ? 100 - pUpPct : null;

    const t10 = last * (1 + mv.p10 / 100);
    const t50 = last * (1 + mv.p50 / 100);
    const t90 = last * (1 + mv.p90 / 100);

    const reasons = [];
    if (biasInfo && biasInfo.parts) {
      for (const p of biasInfo.parts) if (Math.abs(p.w) >= 0.08) reasons.push(`${p.k}: ${p.v}`);
    }
    if (hz.status === 'ok' && hz.m) {
      reasons.push(`تاریخچه: از ${hz.m} موقعیت مشابه، ${Math.round((hz.pUp || 0.5) * 100)}٪ بعد از ${hz.h} ${unit} بالاتر بوده‌اند`);
    }
    if (ind.chg1 != null) {
      const dir = ind.chg1 > 0.15 ? 'مثبت' : ind.chg1 < -0.15 ? 'منفی' : 'تقریباً صفر';
      reasons.push(`تغییر آخرین ${unit}: ${dir} (${ind.chg1.toFixed(2)}٪)`);
    }

    let headline = '', detail = '';
    if (pUpPct != null) {
      if (pUpPct >= 58) {
        headline = `احتمال صعود حدود ${pUpPct}٪ تا ${hz.h} ${unit} آینده (ترکیب تاریخچه + شرایط فعلی)`;
        detail = `با وضعیت فعلی بازار، احتمال حرکت رو به بالا حدود ${pUpPct}٪ برآورد می‌شود. ` +
          `بازه‌ی محتمل ۸۰٪: ${mv.p10.toFixed(1)}٪ تا ${mv.p90.toFixed(1)}٪. ` +
          `هدف میانه ≈ ${Math.round(t50).toLocaleString('fa-IR')} و در سناریوی قوی تا ≈ ${Math.round(t90).toLocaleString('fa-IR')}.`;
      } else if (pUpPct <= 42) {
        headline = `احتمال نزول حدود ${pDownPct}٪ تا ${hz.h} ${unit} آینده (ترکیب تاریخچه + شرایط فعلی)`;
        detail = `احتمال حرکت رو به پایین حدود ${pDownPct}٪ است. بازه‌ی محتمل ۸۰٪: ${mv.p10.toFixed(1)}٪ تا ${mv.p90.toFixed(1)}٪. ` +
          `هدف میانه ≈ ${Math.round(t50).toLocaleString('fa-IR')} و سناریوی ضعیف تا ≈ ${Math.round(t10).toLocaleString('fa-IR')}.`;
      } else {
        headline = `احتمال تقریباً متعادل (صعود ${pUpPct}٪) تا ${hz.h} ${unit} آینده`;
        detail = `بازار جهت واضحی ندارد. بازه‌ی محتمل ۸۰٪: ${mv.p10.toFixed(1)}٪ تا ${mv.p90.toFixed(1)}٪ ` +
          `(≈ ${Math.round(t10).toLocaleString('fa-IR')} تا ${Math.round(t90).toLocaleString('fa-IR')}).`;
      }
    } else {
      headline = `برآورد بر اساس شرایط فعلی (دادهٔ تاریخی هنوز کم است)`;
      detail = `بازه‌ی تقریبی ۸۰٪ حرکت: ${mv.p10.toFixed(1)}٪ تا ${mv.p90.toFixed(1)}٪ ` +
        `(≈ ${Math.round(t10).toLocaleString('fa-IR')} تا ${Math.round(t90).toLocaleString('fa-IR')}).`;
    }

    return {
      headline, detail, reasons,
      targets: { p10: t10, p50: t50, p90: t90, pct10: mv.p10, pct50: mv.p50, pct90: mv.p90 },
      pUp, directionBias: pUpPct == null ? 'unknown' : pUpPct >= 55 ? 'up' : pUpPct <= 45 ? 'down' : 'neutral',
      scalp, bias: biasInfo ? biasInfo.bias : 0
    };
  }

  function analyze(ticks, tf, horizons, opts) {
    opts = opts || {};
    const bars = toBars(ticks, tf || 'day');
    const c = bars.map(b => b.c);
    const n = c.length;
    const defVol = opts.defVol || (tf === 'hour' ? 0.004 : 0.008);
    const unit = tf === 'hour' ? 'ساعت' : 'روز';
    const out = { tf: tf || 'day', n, last: n ? c[n - 1] : null, horizons: [], ind: null, forecasts: [], scalp: null, bias: null };
    if (n < 2) return out;

    const lr = [];
    for (let i = 1; i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
    const sma5 = smaAt(c, 5), sma20 = smaAt(c, 20);
    const last20 = c.slice(-Math.min(20, n));
    const sc = scores(c);
    let trend = 'نامشخص';
    if (sma5 != null && sma20 != null) {
      trend = c[n - 1] > sma5 && sma5 > sma20 ? 'صعودی' : c[n - 1] < sma5 && sma5 < sma20 ? 'نزولی' : 'خنثی / درجا';
    } else if (n >= 3) {
      trend = pct(c, 2) > 0.3 ? 'کمی صعودی' : pct(c, 2) < -0.3 ? 'کمی نزولی' : 'خنثی / درجا';
    }
    out.ind = {
      trend, sma5, sma10: smaAt(c, 10), sma20, rsi: rsi(c, Math.min(14, n - 1)),
      vol: lr.length >= 3 ? sd(lr.slice(-20)) * 100 : null,
      chg1: pct(c, 1), chg3: pct(c, 3), chg7: pct(c, 7),
      support: Math.min(...last20), resistance: Math.max(...last20),
      score: sc[n - 1]
    };

    const biasInfo = currentBias(out.ind, out.last);
    const ctxInfo = marketContextBias(opts);
    const regime = detectRegime(c, out.ind);
    out.regime = regime;
    // ادغام دلایل زمینه با bias قیمت
    const mergedBias = {
      bias: clamp(biasInfo.bias * 0.65 + ctxInfo.bias * 0.35, -1, 1),
      parts: [...(biasInfo.parts || []), ...(ctxInfo.parts || []), { k: 'رژیم', v: regime.label + ' — ' + regime.note, w: 0 }]
    };
    out.bias = mergedBias;
    out.context = ctxInfo;

    for (const h of horizons || [1, 3, 5]) {
      const need = 8 + MIN_TRAIN + h;
      const res = { h, status: 'insufficient', need, have: n, move: expectedMove(c, h, defVol) };
      const pr = n - 1 - h >= 0 ? predictAt(c, sc, h, n - 1) : null;
      if (pr) {
        const bt = backtest(c, sc, h);
        let rel = 'low', note = 'تعداد آزمون‌های گذشته کمه؛ با شرایط فعلی و زمینهٔ بازار ترکیب شده.';
        if (bt.skill != null && bt.tests >= 20) {
          if (bt.skill <= 0) { rel = 'none'; note = 'در گذشته این روش از حدس ساده بهتر نبوده؛ وزن شرایط فعلی و خبر بیشتر شده.'; }
          else if (bt.tests >= 40) { rel = 'ok'; note = 'در گذشته کمی بهتر از حدس ساده بوده.'; }
          else { rel = 'mid'; note = 'اعتبار متوسط.'; }
        }
        Object.assign(res, { status: 'ok', pUp: pr.p, lo: pr.lo, hi: pr.hi, m: pr.m, bucket: BUCKETS[pr.bucket], base: pr.base, N: pr.N, bt, rel, note });
      }

      // احتمال ترکیبی: تاریخچه + قیمت فعلی + انس/دلار/خبر
      const hybridP = hybridProb(res.status === 'ok' ? res.pUp : null, biasInfo.bias, ctxInfo.bias);
      res.hybridP = hybridP;
      res.pUpDisplay = hybridP;
      res.contextParts = ctxInfo.parts;

      const scalp = scalpingPlan(out.last, out.ind, hybridP, res.move, unit, h);
      res.forecast = buildForecast(out.last, out.ind, res, unit, hybridP, mergedBias, scalp);
      res.scalp = scalp;
      out.horizons.push(res);
      if (res.forecast) out.forecasts.push(res.forecast);
      if (!out.scalp && h === (horizons || [1, 3, 5])[0]) out.scalp = scalp;
    }
    if (!out.scalp && out.horizons[0]) out.scalp = out.horizons[0].scalp;

    // بک‌تست راه به جلو برای افق اول
    const h0 = (horizons || [1, 3, 5])[0];
    const wf = walkForwardSignals(c, sc, h0);
    out.walkForward = wf;

    // سخت‌گیری ورود بر اساس رژیم و بک‌تست
    for (const hz of out.horizons) {
      const s = hz.scalp;
      if (!s) continue;
      s.regime = regime;
      s.walkForward = wf;
      if (s.tradeOk) {
        if (regime.id === 'choppy' || regime.id === 'volatile') {
          if (!(s.conf >= 0.68 && (hz.hybridP >= 0.65 || hz.hybridP <= 0.35))) {
            s.tradeOk = false;
            s.advice = 'صبر (رژیم ' + regime.label + ')';
            s.adviceDetail = regime.note + ' — ورود فقط با سیگنال بسیار قوی مجاز است.';
            s.reasons = (s.reasons || []).concat(['فیلتر رژیم بازار']);
          }
        }
        if (wf.tests >= 12 && wf.hitRate != null && wf.hitRate < 0.48) {
          s.tradeOk = false;
          s.advice = 'صبر (بک‌تست ضعیف)';
          s.adviceDetail = 'در تاریخچهٔ همین داده، سیگنال‌های مشابه فقط ' + Math.round(wf.hitRate * 100) + '٪ درست بودند — فعلاً ورود توصیه نمی‌شود.';
          s.reasons = (s.reasons || []).concat(['hit-rate تاریخی پایین']);
        }
        if (regime.tradeMult < 0.5 && s.tradeOk) {
          s.adviceDetail = (s.adviceDetail || '') + ' حجم را کمتر از معمول بگیر (رژیم سخت).';
        }
      }
    }
    if (out.scalp && out.horizons[0] && out.horizons[0].scalp) out.scalp = out.horizons[0].scalp;
    return out;
  }

  function attribution(mTicks, oTicks, uTicks, cfg, nBars) {
    nBars = nBars || 5;
    const bm = new Map(toBars(mTicks || [], 'day').map(b => [dayKey(b.t), b]));
    const bo = new Map(toBars(oTicks || [], 'day').map(b => [dayKey(b.t), b]));
    const bu = new Map(toBars(uTicks || [], 'day').map(b => [dayKey(b.t), b]));
    const keys = [...bm.keys()].filter(k => bo.has(k) && bu.has(k)).sort((a, b) => a - b);
    if (keys.length < 3) return null;
    const theory = k => bo.get(k).c * bu.get(k).c / OUNCE_G * cfg.gramsPerMithqal * cfg.purity;
    const prem = keys.map(k => bm.get(k).c / theory(k));
    const i1 = keys.length - 1, i0 = Math.max(0, i1 - nBars);
    const lg = (a, b) => Math.log(a / b) * 100;
    const dm = lg(bm.get(keys[i1]).c, bm.get(keys[i0]).c);
    const dO = lg(bo.get(keys[i1]).c, bo.get(keys[i0]).c);
    const dU = lg(bu.get(keys[i1]).c, bu.get(keys[i0]).c);
    const win = prem.slice(-30);
    const z = win.length >= 5 && sd(win) > 0 ? (prem[i1] - mean(win)) / sd(win) : null;
    return {
      days: i1 - i0, from: keys[i0], to: keys[i1], dm, dO, dU, dP: dm - dO - dU,
      premium: (prem[i1] - 1) * 100, premMean: (mean(win) - 1) * 100, z, nCommon: keys.length
    };
  }

  function spread(aTicks, bTicks, nBars) {
    nBars = nBars || 5;
    const ba = new Map(toBars(aTicks || [], 'day').map(b => [dayKey(b.t), b]));
    const bb = new Map(toBars(bTicks || [], 'day').map(b => [dayKey(b.t), b]));
    const keys = [...ba.keys()].filter(k => bb.has(k)).sort((a, b) => a - b);
    if (keys.length < 2) return null;
    const i1 = keys.length - 1;
    const lastA = ba.get(keys[i1]).c, lastB = bb.get(keys[i1]).c;
    const spr = (lastA / lastB - 1) * 100;
    const hist = keys.slice(-Math.min(30, keys.length)).map(k => (ba.get(k).c / bb.get(k).c - 1) * 100);
    return {
      lastA, lastB, spreadPct: spr,
      meanSpread: mean(hist),
      recentChange: keys.length > nBars ? spr - ((ba.get(keys[i1 - nBars]).c / bb.get(keys[i1 - nBars]).c - 1) * 100) : null,
      n: keys.length
    };
  }

  return { toBars, scores, analyze, attribution, spread, predictAt, backtest, walkForwardSignals, detectRegime, wilson, rsi, MIN_TRAIN, dayKey, buildForecast, currentBias, hybridProb, scalpingPlan, marketContextBias };
});
