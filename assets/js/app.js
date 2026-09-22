/* TL mevduatın döviz karşısındaki getiri primi — hesaplama ve arayüz
 * Veri: data/dataset.json (scripts/update_data.py üretir), data/events.json (elle düzenlenir)
 */
(() => {
  "use strict";

  // ── Dil (TR/EN) ───────────────────────────────────────────────────────
  // Türkçe metinler index.html'den okunur; İngilizce karşılıklar aşağıdadır.
  const params = new URLSearchParams(location.search);
  let LANG = (params.get("lang") || safeGet("lang") || "tr") === "en" ? "en" : "tr";
  function safeGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* gizli mod */ } }
  const isEN = () => LANG === "en";
  const L = (tr, en) => (isEN() ? en : tr);

  // ── Sabitler ──────────────────────────────────────────────────────────
  // Faiz serisi (EVDS TL mevduat faizi) ile vade (yenileme sıklığı) birbirinden bağımsız seçilir.
  const SERIES = {
    tum: { key: "MT06", tr: "toplam (tüm vadeler)", en: "total (all maturities)", term: "y1" },
    m1:  { key: "MT01", tr: "1 aya kadar vadeli", en: "up to 1 month", term: "m1" },
    m3:  { key: "MT02", tr: "3 aya kadar vadeli", en: "up to 3 months", term: "m3" },
    m6:  { key: "MT03", tr: "6 aya kadar vadeli", en: "up to 6 months", term: "m6" },
    y1:  { key: "MT04", tr: "1 yıla kadar vadeli", en: "up to 1 year", term: "y1" },
    y1p: { key: "MT05", tr: "1 yıl ve daha uzun vadeli", en: "1 year and longer", term: "y1p" },
  };
  const TERM = {
    m1:  { tr: "1 aylık", en: "1-month", weeks: 4, bucket: "m6" },
    m3:  { tr: "3 aylık", en: "3-month", weeks: 13, bucket: "m6" },
    m6:  { tr: "6 aylık", en: "6-month", weeks: 26, bucket: "m6" },
    y1:  { tr: "1 yıllık", en: "1-year", weeks: 52, bucket: "y1" },
    y1p: { tr: "1 yıldan uzun (yıllık yenileme)", en: "longer than 1 year (annual rollover)", weeks: 52, bucket: "y1p" },
  };
  const CURRENCY = {
    USD: { tr: "ABD doları", en: "US dollar", unit: "USD", spread: true },
    EUR: { tr: "euro", en: "euro", unit: "EUR", spread: true },
    GBP: { tr: "İngiliz sterlini", en: "British pound", unit: "GBP", spread: true },
    XAU: { tr: "gram altın", en: "gold (gram)", unit: "gram", spread: false },
  };
  const lbl = (o) => (isEN() ? o.en : o.tr);
  // events.json'da label_en yoksa kullanılacak İngilizce olay adları
  const EVENT_EN = {
    "2018-08-10": "2018 currency shock",
    "2021-09-23": "Rate cuts",
    "2021-12-20": "KKM",
    "2023-06-22": "Monetary tightening",
  };
  const H = 52;          // 12 aylık pencere (hafta)
  const MIN_PARTIAL = 13; // ana grafikte gösterilen en kısa yıllıklandırılmış dönem
  const MONTHS_TR = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
  const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ── Yardımcılar ───────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const nf = (x, d = 0) => x.toLocaleString(isEN() ? "en-US" : "tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (x, d = 1) => (x == null || !isFinite(x)) ? "–"
    : isEN() ? (x < 0 ? "−" : "") + nf(Math.abs(x * 100), d) + "%"
    : (x < 0 ? "−%" : "%") + nf(Math.abs(x * 100), d);
  const pctRaw = (v, d = 1) => pct(v / 100, d); // yüzde cinsinden sayı (15.4 → %15,4)
  const trDate = (s) => isEN()
    ? +s.slice(8, 10) + " " + MONTHS_EN[+s.slice(5, 7) - 1] + " " + s.slice(0, 4)
    : s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4);
  // BIS aylık verisi ay sonu değeridir: bir hafta, ayın başında geçerli olan oranı
  // (bir önceki ayın ay sonu değerini) alır; böylece karar tarihinden önce gösterilmez.
  const prevMonth = (d) => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
  const trMonth = (ym) => (isEN() ? MONTHS_EN : MONTHS_TR)[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const annualize = (r, w) => (r == null || w <= 0) ? null : (w === H ? r : Math.pow(1 + r, H / w) - 1);
  const cls = (x) => (x == null ? "" : x >= 0 ? "pos" : "neg");

  // ── Durum ─────────────────────────────────────────────────────────────
  const S = {
    data: null, events: [], N: 0, weeks: [],
    rateFilled: {}, cpiIdx: {},
    series: null, period: null,
  };
  const cfg = () => ({
    cur: document.querySelector("#curSeg [aria-checked=true]").dataset.cur,
    ser: $("ser").value,
    term: $("term").value,
    taxMode: $("taxMode").value,
    fixedTax: Math.max(0, parseFloat($("fixedTax").value) || 0) / 100,
    spread: $("spread").checked,
    deflator: $("deflator").value,
  });

  // ── Veri hazırlığı ────────────────────────────────────────────────────
  function prepare(data) {
    S.data = data;
    S.weeks = data.weeks;
    S.N = data.weeks.length - 1;
    // Faiz serileri: sondaki boşluklar son gözlemle doldurulur (yalnızca hesap için)
    for (const [k, arr] of Object.entries(data.rates)) {
      const out = arr.slice();
      let last = null;
      for (let i = 0; i < out.length; i++) { if (out[i] != null) last = out[i]; else out[i] = last; }
      S.rateFilled[k] = out;
    }
    data.cpi.months.forEach((m, i) => { S.cpiIdx[m] = i; });
    S.policy = {};
    if (data.policy) data.policy.months.forEach((m, i) => { S.policy[m] = data.policy.rate[i]; });
  }

  function taxRate(date, bucket, c) {
    if (c.taxMode === "none") return 0;
    if (c.taxMode === "fixed") return c.fixedTax;
    let t = S.data.stopaj[0][bucket];
    for (const row of S.data.stopaj) if (date >= row.start) t = row[bucket];
    return t / 100;
  }

  const buyAt = (c, i) => S.data.fx[c.cur].buy[i];
  const exitAt = (c, i) => (c.spread && CURRENCY[c.cur].spread) ? S.data.fx[c.cur].sell[i] : S.data.fx[c.cur].buy[i];

  function cpiAt(c, date) {
    const k = S.cpiIdx[date.slice(0, 7)];
    return k == null ? null : S.data.cpi[c.deflator][k];
  }

  /* Tek bir yatırımın TL bakiyesini hafta hafta izler.
   * Başlangıçta 1 birim döviz alış kuruyla TL'ye çevrilir.
   * tl[k]: (i+k). haftadaki TL değeri (işlemiş faiz dahil, stopaj düşülmüş). */
  function simulate(i, end, c, withRolls) {
    const m = TERM[c.term];
    const rates = S.rateFilled[SERIES[c.ser].key];
    let bal = buyAt(c, i);
    const tl = [bal];
    const rolls = withRolls ? [] : null;
    let t = i;
    while (t < end) {
      const r = rates[t] / 100;
      const tax = taxRate(S.weeks[t], m.bucket, c);
      const stop = Math.min(t + m.weeks, end);
      for (let k = t + 1; k <= stop; k++) tl.push(bal * (1 + r * 7 * (k - t) / 365 * (1 - tax)));
      if (withRolls) {
        const gross = bal * r * 7 * (stop - t) / 365;
        rolls.push({ from: t, to: stop, rate: r, tax, bal0: bal, gross, stop: gross * tax, net: gross * (1 - tax),
          complete: stop === t + m.weeks });
      }
      bal = tl[tl.length - 1];
      t = stop;
    }
    return { tl, rolls };
  }

  /* Bir başlangıç ve bitiş haftası için özet getiriler (1 birim döviz başına). */
  function outcome(i, end, c, sim) {
    const w = end - i;
    const entry = buyAt(c, i), exit = exitAt(c, end);
    const tlEnd = sim.tl[w];
    const carry = tlEnd / exit - 1;
    const tlRet = tlEnd / entry - 1;
    const fxChg = exit / entry - 1;
    const p0 = cpiAt(c, S.weeks[i]), p1 = cpiAt(c, S.weeks[end]);
    const infl = (p0 && p1) ? p1 / p0 - 1 : null;
    const real = infl == null ? null : (1 + tlRet) / (1 + infl) - 1;
    return { w, entry, exit, tlEnd, carry, tlRet, fxChg, infl, real };
  }

  // ── Ana seri ──────────────────────────────────────────────────────────
  function computeSeries(c) {
    const out = [];
    for (let i = 0; i < S.N; i++) {
      if (buyAt(c, i) == null) continue;
      const w = Math.min(H, S.N - i);
      if (w < MIN_PARTIAL) break;
      const end = i + w;
      if (exitAt(c, end) == null) continue;
      const o = outcome(i, end, c, simulate(i, end, c, false));
      const full = w === H;
      out.push({
        i, date: S.weeks[i], w, full,
        carry: annualize(o.carry, w), tlRet: annualize(o.tlRet, w),
        fxChg: annualize(o.fxChg, w), real: annualize(o.real, w),
        policy: S.policy[prevMonth(S.weeks[i])] ?? null,
      });
    }
    return out;
  }

  // ── Plotly ────────────────────────────────────────────────────────────
  function registerLocale() {
    Plotly.register({ moduleType: "locale", name: "tr", dictionary: {}, format: {
      days: ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"],
      shortDays: ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"],
      months: ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"],
      shortMonths: MONTHS_TR, date: "%d.%m.%Y", decimal: ",", thousands: ".",
    } });
  }
  const plotConfig = () => ({ responsive: true, displaylogo: false, locale: isEN() ? "en" : "tr",
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"] });

  function baseLayout() {
    const ink = css("--ink"), muted = css("--muted"), rule = css("--rule");
    return {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: css("--sans") || "IBM Plex Sans, sans-serif", color: ink, size: 12.5 },
      margin: { l: 58, r: 18, t: 40, b: 44 },
      hovermode: "x unified",
      hoverlabel: { bgcolor: "#ffffff", bordercolor: rule, font: { color: ink, size: 12.5 } },
      legend: { orientation: "h", x: 0, y: 1.07, font: { color: ink, size: 12.5 } },
      xaxis: { type: "date", showgrid: true, gridcolor: css("--grid"), griddash: "dot", linecolor: css("--ink-2"),
        tickcolor: rule, hoverformat: "%d.%m.%Y" },
      yaxis: { showgrid: true, gridcolor: css("--grid"), griddash: "dot", zerolinecolor: ink, zerolinewidth: 1.2,
        tick0: 0, dtick: 10, tickformat: ",.0f", ticksuffix: "",
        minor: { dtick: 5, showgrid: true, gridcolor: css("--grid-minor"), griddash: "dot" } },
    };
  }

  /* Yakınlaştırınca y ekseni görünen aralıktaki verilere göre yeniden ölçeklenir.
   * Sıfır çizgisi her zaman görünür kalır; aralık darsa ızgara 5'lik olur. */
  function rescaleY() {
    const gd = $("mainChart");
    if (!gd || !gd.layout || !gd.data) return;
    const xa = gd.layout.xaxis;
    const yearly = { "xaxis.dtick": window.innerWidth < 700 ? "M48" : "M12", "xaxis.tickformat": "%Y" };
    if (!xa.range || xa.autorange === true) {
      Plotly.relayout(gd, Object.assign({ "yaxis.autorange": true, "yaxis.dtick": 10, "yaxis.minor.dtick": 5 }, yearly));
      return;
    }
    const lo = String(xa.range[0]).slice(0, 10), hi = String(xa.range[1]).slice(0, 10);
    // Kısa aralıklarda x ekseni ay/çeyrek etiketlerine geçer
    const days = (new Date(hi) - new Date(lo)) / 864e5;
    const narrow = window.innerWidth < 700;
    const xt = days <= (narrow ? 200 : 400) ? { "xaxis.dtick": "M1", "xaxis.tickformat": "%b %Y" }
      : days <= (narrow ? 550 : 1100) ? { "xaxis.dtick": "M3", "xaxis.tickformat": "%b %Y" }
      : days <= (narrow ? 1300 : 2600) ? { "xaxis.dtick": "M6", "xaxis.tickformat": "%b %Y" }
      : yearly;
    let mn = 0, mx = 0;
    gd.data.forEach((t, k) => {
      if (k < 2 || t.visible === false || t.visible === "legendonly") return; // dolgu izleri ana çizgiyi tekrarlar
      t.x.forEach((x, j) => {
        const y = t.y[j];
        if (y == null || x < lo || x > hi) return;
        if (y < mn) mn = y;
        if (y > mx) mx = y;
      });
    });
    const span = Math.max(mx - mn, 10);
    const pad = span * 0.08;
    const step = span <= 40 ? 5 : 10;
    const y0 = Math.floor((mn - pad) / step) * step, y1 = Math.ceil((mx + pad) / step) * step;
    Plotly.relayout(gd, Object.assign({ "yaxis.range": [y0, y1], "yaxis.autorange": false,
      "yaxis.dtick": step, "yaxis.minor.dtick": step / 5 }, xt));
  }

  function renderMain(keepRange) {
    const c = cfg();
    S.series = computeSeries(c);
    const s = S.series;
    const d = s.map((x) => x.date);
    const lastFull = s.reduce((a, x, k) => (x.full ? k : a), -1);
    const val = (f, k) => (s[k][f] == null ? null : s[k][f] * 100);
    const fullY = s.map((x, k) => (x.full ? val("carry", k) : null));
    const partY = s.map((x, k) => (!x.full || k === lastFull ? val("carry", k) : null));
    const custom = s.map((x) => [
      pct(x.carry), pct(x.tlRet), pct(x.real), pct(x.fxChg),
      x.full ? L("12 aylık dönem", "12-month period") : L(`${x.w} hafta, yıllıklandırılmış`, `${x.w} weeks, annualised`),
      x.policy == null ? "–" : pctRaw(x.policy),
    ]);
    const cur = CURRENCY[c.cur];
    const gain = css("--gain"), loss = css("--loss");
    const hov = "<b>Carry (" + cur.unit + "): %{customdata[0]}</b><br>" + L("TL nominal", "TL nominal") + ": %{customdata[1]}<br>" +
      L("Reel TL", "Real TL") + ": %{customdata[2]}<br>" + L("Kur değişimi (sonraki 52 hafta)", "FX change (next 52 weeks)") + ": %{customdata[3]}<br>" +
      L("Politika faizi", "Policy rate") + ": %{customdata[5]}<br><span style='opacity:.7'>%{customdata[4]}</span><extra></extra>";
    const traces = [
      { x: d, y: fullY.map((v) => (v == null ? null : Math.max(v, 0))), type: "scatter", mode: "lines",
        line: { width: 0 }, fill: "tozeroy", fillcolor: gain + "59", hoverinfo: "skip", showlegend: false, connectgaps: false },
      { x: d, y: fullY.map((v) => (v == null ? null : Math.min(v, 0))), type: "scatter", mode: "lines",
        line: { width: 0 }, fill: "tozeroy", fillcolor: loss + "59", hoverinfo: "skip", showlegend: false, connectgaps: false },
      { x: d, y: s.map((_, k) => val("tlRet", k)), name: L("TL nominal getiri", "TL nominal return"), type: "scatter", mode: "lines",
        line: { color: css("--tl"), width: 1.3, dash: "dash" }, visible: $("showTl").checked, hoverinfo: "skip" },
      { x: d, y: s.map((_, k) => val("real", k)), name: L("Reel TL getiri", "Real TL return"), type: "scatter", mode: "lines",
        line: { color: css("--real"), width: 1.5 }, visible: $("showReal").checked, hoverinfo: "skip" },
      { x: d, y: s.map((_, k) => val("fxChg", k)), name: L(`Kur değişimi (sonraki 52 hafta, ${cur.unit}/TL)`, `FX change (next 52 weeks, ${cur.unit}/TL)`), type: "scatter", mode: "lines",
        line: { color: css("--fx"), width: 1.2, dash: "dot" }, visible: $("showFx").checked, hoverinfo: "skip" },
      { x: d, y: fullY, name: L(`Carry trade getirisi (${cur.unit} bazında)`, `Carry trade return (in ${cur.unit})`), type: "scatter", mode: "lines",
        line: { color: css("--accent"), width: 2.2 }, customdata: custom, connectgaps: false,
        hovertemplate: hov },
      { x: d, y: partY, name: L("Devam eden dönem (yıllıklandırılmış)", "Ongoing period (annualised)"), type: "scatter", mode: "lines",
        line: { color: css("--accent"), width: 2, dash: "dash" }, customdata: custom, connectgaps: false,
        hovertemplate: hov },
      // TCMB politika faizi: getiri değil, başlangıç haftasında geçerli yıllık oran (yalnızca gösterim)
      { x: d, y: s.map((x) => x.policy), name: L("TCMB politika faizi (yıllık oran)", "CBRT policy rate (annual rate)"),
        type: "scatter", mode: "lines", line: { color: "#1d2733", width: 1.6, shape: "hv" },
        visible: !!($("showPolicy") && $("showPolicy").checked), hoverinfo: "skip" },
    ];

    const layout = baseLayout();
    layout.xaxis.hoverformat = L("%d.%m.%Y başlangıç", "Start: %d %b %Y");
    layout.xaxis.dtick = window.innerWidth < 700 ? "M48" : "M12";
    layout.xaxis.tickformat = "%Y";
    layout.xaxis.ticklabelmode = "period";
    layout.yaxis.title = { text: L("Getiri (%)", "Return (%)"), font: { color: css("--muted"), size: 12 } };
    layout.shapes = [];
    layout.annotations = [];
    if ($("showEvents").checked) {
      // Birbirine yakın olayların etiketleri farklı yüksekliklere yerleştirilir
      let prev = null, level = 0;
      for (const e of [...S.events].sort((a, b) => a.date.localeCompare(b.date))) {
        level = prev && (new Date(e.date) - new Date(prev)) / 864e5 < 240 ? level + 1 : 0;
        prev = e.date;
        layout.shapes.push({ type: "line", xref: "x", yref: "paper", x0: e.date, x1: e.date, y0: 0, y1: 1,
          line: { color: css("--event"), width: 1, dash: "dot" } });
        if (window.innerWidth < 640) continue; // dar ekranda yalnızca çizgi
        layout.annotations.push({ x: e.date, xref: "x", y: 1 - level * 0.2, yref: "paper", text: isEN() ? (e.label_en || EVENT_EN[e.date] || e.label) : e.label, showarrow: false,
          textangle: -90, xanchor: "right", yanchor: "top", xshift: -2, font: { size: 11, color: css("--ink-2") } });
      }
    }
    if (S.period && S.userPicked) {
      layout.shapes.push({ type: "line", xref: "x", yref: "paper", x0: S.weeks[S.period.i0], x1: S.weeks[S.period.i0],
        y0: 0, y1: 1, line: { color: css("--accent"), width: 1.5 } });
    }
    if (keepRange) {
      const cur = $("mainChart").layout && $("mainChart").layout.xaxis.range;
      if (cur) layout.xaxis.range = cur.slice();
    }
    Plotly.react("mainChart", traces, layout, plotConfig());
    if (keepRange && layout.xaxis.range) rescaleY();

    const fixedTxt = pct(c.fixedTax);
    const taxTxt = c.taxMode === "period" ? L("dönemin stopaj oranları", "withholding tax rates in force")
      : c.taxMode === "fixed" ? L(`sabit ${fixedTxt} stopaj`, `fixed ${fixedTxt} withholding tax`) : L("stopajsız", "no withholding tax");
    const spreadTxt = cur.spread ? (c.spread ? L("kur makası dahil", "FX spread included") : L("kur makası hariç", "FX spread excluded")) : L("tek fiyat", "single price");
    $("mainCaption").textContent = isEN()
      ? `Figure 1. 12-month net return of a carry trade from the ${cur.en} into TL deposits (in ${cur.unit}, %). ` +
        `TL rate: ${SERIES[c.ser].en} deposits, ${TERM[c.term].en} rollover; ${taxTxt}; ${spreadTxt}. ` +
        `Each point shows the investment starting in that week.`
      : `Şekil 1. ${cap(cur.tr)} ile TL mevduat carry trade'inin 12 aylık net getirisi (${cur.unit} bazında, %). ` +
        `TL faizi: ${SERIES[c.ser].tr} mevduat, ${TERM[c.term].tr} vadeyle yenileme; ${taxTxt}; ${spreadTxt}. ` +
        `Her nokta, o hafta başlayan yatırımı gösterir.`;
    updateStats();
  }
  const cap = (s) => s.charAt(0).toLocaleUpperCase("tr-TR") + s.slice(1);

  function describe(vals) {
    const v = vals.filter((x) => x != null && isFinite(x));
    if (!v.length) return null;
    const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
    return {
      n: v.length, pos: v.filter((x) => x > 0).length / v.length,
      med: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2,
      mean: v.reduce((a, b) => a + b, 0) / v.length, min: s[0], max: s[s.length - 1],
    };
  }

  function updateStats() {
    const s = S.series; if (!s || !s.length) return;
    const rng = $("mainChart").layout && $("mainChart").layout.xaxis.range;
    const lo = rng ? String(rng[0]).slice(0, 10) : s[0].date;
    const hi = rng ? String(rng[1]).slice(0, 10) : s[s.length - 1].date;
    const inR = s.filter((x) => x.full && x.date >= lo && x.date <= hi);
    const unit = CURRENCY[cfg().cur].unit;
    const a = describe(inR.map((x) => x.carry));
    const b = describe(inR.map((x) => x.real));
    const row = (label, st) => !st ? `<div class="row"><span class="k">${label}</span><span>${L("Veri yok", "No data")}</span></div>` :
      `<div class="row"><span class="k">${label}</span><span>${L("Pozitif", "Positive")}: <b>${pct(st.pos, 0)}</b></span>` +
      `<span>${L("Medyan", "Median")}: <b>${pct(st.med)}</b></span><span>${L("Ortalama", "Mean")}: <b>${pct(st.mean)}</b></span>` +
      `<span>${L("En düşük", "Min")}: <b>${pct(st.min)}</b></span><span>${L("En yüksek", "Max")}: <b>${pct(st.max)}</b></span></div>`;
    $("stats").innerHTML =
      `<div class="row"><span>${L("Görünen aralık", "Visible range")}: <b>${trDate(lo)} – ${trDate(hi)}</b></span>` +
      `<span>${L("Tamamlanmış 12 aylık dönem", "Completed 12-month periods")}: <b>${nf(inR.length)}</b> ${L("başlangıç haftası", "start weeks")}</span></div>` +
      row(L(`Carry (${unit} bazında)`, `Carry (in ${unit})`), a) + row(L("Reel TL getiri", "Real TL return"), b);
  }

  // ── Dönem analizi ─────────────────────────────────────────────────────
  const idxOnOrAfter = (date) => { const k = S.weeks.findIndex((w) => w >= date); return k < 0 ? S.N : k; };
  const idxOnOrBefore = (date) => { let k = S.N; while (k > 0 && S.weeks[k] > date) k--; return k; };

  function firstValidStart(c) {
    let i = 0; while (i < S.N && buyAt(c, i) == null) i++; return i;
  }

  function setPeriod(i0, i1, fromChart) {
    const c = cfg();
    i0 = Math.max(firstValidStart(c), Math.min(i0, S.N - 1));
    i1 = Math.max(i0 + 1, Math.min(i1, S.N));
    S.period = { i0, i1 };
    $("pStart").value = S.weeks[i0];
    $("pEnd").value = S.weeks[i1];
    renderPeriod();
    if (fromChart) {
      renderMain(true);
    }
  }

  // Ana grafikteki seçili başlangıç çizgisini (son şekil) yeniden çizmeden taşır
  function moveMarker() {
    const gd = $("mainChart");
    const sh = (gd.layout.shapes || []).slice();
    if (!S.period) return;
    if (!S.userPicked) { S.userPicked = true; renderMain(true); return; }
    if (!sh.length) return;
    const d = S.weeks[S.period.i0];
    sh[sh.length - 1] = Object.assign({}, sh[sh.length - 1], { x0: d, x1: d });
    Plotly.relayout(gd, { shapes: sh });
  }

  function renderPeriod() {
    const c = cfg(), cur = CURRENCY[c.cur];
    const { i0, i1 } = S.period;
    const amt = Math.max(0.0001, parseFloat($("pAmount").value) || 1);
    $("amtLabel").textContent = L(`Tutar (${cur.unit})`, `Amount (${cur.unit})`);
    const sim = simulate(i0, i1, c, true);
    const o = outcome(i0, i1, c, sim);
    const w = i1 - i0;

    // Kümülatif seriler
    const x = [], yCarry = [], yTl = [], yReal = [], yFx = [];
    const entry = o.entry, p0 = cpiAt(c, S.weeks[i0]);
    let lastRealIdx = null;
    for (let k = 0; k <= w; k++) {
      const wi = i0 + k, ex = exitAt(c, wi);
      x.push(S.weeks[wi]);
      yCarry.push(ex ? (sim.tl[k] / ex - 1) * 100 : null);
      yTl.push((sim.tl[k] / entry - 1) * 100);
      yFx.push(ex ? (ex / entry - 1) * 100 : null);
      const p = cpiAt(c, S.weeks[wi]);
      if (p0 && p) { yReal.push(((sim.tl[k] / entry) / (p / p0) - 1) * 100); lastRealIdx = wi; } else yReal.push(null);
    }
    const realTotal = lastRealIdx == null ? null : yReal[lastRealIdx - i0] / 100;
    const realW = lastRealIdx == null ? 0 : lastRealIdx - i0;

    // Kartlar
    const endVal = amt * (1 + o.carry);
    const taxTotal = sim.rolls.reduce((a, r) => a + r.stop, 0) * amt;
    const annOk = w >= MIN_PARTIAL;
    const annTxt = (v) => L(`Yıllık bileşik ${pct(v)}`, `Annualised ${pct(v)}`);
    const dp = c.cur === "XAU" ? 1 : 0;
    const defl = c.deflator === "tufe" ? L("TÜFE", "CPI") : L("Yİ-ÜFE", "PPI");
    const years = w / H;
    const card = (title, v, sub, klass = "", primary = false) =>
      `<div class="card${primary ? " primary" : ""}"><h4>${title}</h4><div class="v ${klass}">${v}</div><div class="s">${sub}</div></div>`;
    $("cards").innerHTML =
      card(L(`Carry getirisi (${cur.unit})`, `Carry return (${cur.unit})`), pct(o.carry),
        annOk ? annTxt(annualize(o.carry, w)) : L("Dönem 13 haftadan kısa", "Period shorter than 13 weeks"), cls(o.carry), true) +
      card(L("Son değer", "Final value"), `${nf(endVal, dp)} ${cur.unit}`,
        L(`Başlangıç ${nf(amt, dp)} ${cur.unit} · fark `, `Initial ${nf(amt, dp)} ${cur.unit} · change `) + `${endVal >= amt ? "+" : "−"}${nf(Math.abs(endVal - amt), dp)}`) +
      card(L("TL nominal getiri", "TL nominal return"), pct(o.tlRet), annOk ? annTxt(annualize(o.tlRet, w)) : "–", cls(o.tlRet)) +
      card(L(`Reel TL getiri (${defl})`, `Real TL return (${defl})`), pct(realTotal),
        realTotal == null ? L("Endeks verisi yok", "No index data")
          : (lastRealIdx < i1 ? L(`${trMonth(S.weeks[lastRealIdx].slice(0, 7))} sonuna kadar`, `Through ${trMonth(S.weeks[lastRealIdx].slice(0, 7))}`)
          : (realW >= MIN_PARTIAL ? annTxt(annualize(realTotal, realW)) : "–")), cls(realTotal)) +
      card(L(`Kur değişimi (${cur.unit}/TL)`, `FX change (${cur.unit}/TL)`), pct(o.fxChg), `${nf(o.entry, 4)} → ${nf(o.exit, 4)} TL`, "") +
      card(L("Ödenen stopaj", "Withholding tax paid"), `${nf(taxTotal)} TL`, L(`${nf(w)} hafta · ${nf(years, 2)} yıl`, `${nf(w)} weeks · ${nf(years, 2)} years`));

    const lastRoll = sim.rolls[sim.rolls.length - 1];
    $("cumNote").textContent = lastRoll && !lastRoll.complete
      ? L(`Dönem sonu açık bir vadenin ortasına denk geliyor (${trDate(S.weeks[lastRoll.from])} başlangıçlı vade). Bu vadenin işlemiş faizi tahakkuk esasıyla hesaba katıldı; vade bozulursa banka faiz ödemeyebilir.`,
          `The period ends in the middle of an open deposit (started ${trDate(S.weeks[lastRoll.from])}). Interest accrued on this deposit is included; if the deposit were broken early, the bank might not pay it.`)
      : "";

    renderRolls(sim.rolls, amt);
  }

  function renderRolls(rolls, amt) {
    const head = L("<thead><tr><th>Dönem</th><th>Faiz (yıllık)</th><th>Stopaj</th><th>Brüt faiz (TL)</th><th>Stopaj (TL)</th><th>Net faiz (TL)</th><th>Bakiye (TL)</th></tr></thead>",
      "<thead><tr><th>Period</th><th>Rate (annual)</th><th>Tax rate</th><th>Gross interest (TL)</th><th>Tax (TL)</th><th>Net interest (TL)</th><th>Balance (TL)</th></tr></thead>");
    let rows;
    if (rolls.length > 40) {
      // Yıllık özet
      const byYear = new Map();
      for (const r of rolls) {
        const y = S.weeks[r.from].slice(0, 4);
        const g = byYear.get(y) || { y, from: r.from, to: r.to, gross: 0, stop: 0, net: 0, rw: 0, tw: 0, n: 0, bal: 0 };
        const len = r.to - r.from;
        g.to = r.to; g.gross += r.gross; g.stop += r.stop; g.net += r.net;
        g.rw += r.rate * len; g.tw += r.tax * len; g.n += len; g.bal = r.bal0 + r.net;
        byYear.set(y, g);
      }
      rows = [...byYear.values()].map((g) =>
        `<tr><td>${g.y} (${trDate(S.weeks[g.from])} → ${trDate(S.weeks[g.to])})</td><td>${pct(g.rw / g.n, 2)} ${L("ort.", "avg.")}</td><td>${pct(g.tw / g.n)} ${L("ort.", "avg.")}</td>` +
        `<td>${nf(g.gross * amt)}</td><td>${nf(g.stop * amt)}</td><td>${nf(g.net * amt)}</td><td>${nf(g.bal * amt)}</td></tr>`);
    } else {
      rows = rolls.map((r) =>
        `<tr><td>${trDate(S.weeks[r.from])} → ${trDate(S.weeks[r.to])}${r.complete ? "" : L(" (açık)", " (open)")}</td><td>${pct(r.rate, 2)}</td><td>${pct(r.tax)}</td>` +
        `<td>${nf(r.gross * amt)}</td><td>${nf(r.stop * amt)}</td><td>${nf(r.net * amt)}</td><td>${nf((r.bal0 + r.net) * amt)}</td></tr>`);
    }
    const sum = (f) => nf(rolls.reduce((a, r) => a + r[f], 0) * amt);
    const last = rolls[rolls.length - 1];
    rows.push(`<tr class="total"><td>${L("Toplam", "Total")}</td><td></td><td></td><td>${sum("gross")}</td><td>${sum("stop")}</td><td>${sum("net")}</td><td>${nf((last.bal0 + last.net) * amt)}</td></tr>`);
    $("rollTable").innerHTML = head + "<tbody>" + rows.join("") + "</tbody>";
  }

  // ── Statik içerik ─────────────────────────────────────────────────────
  function renderStatic() {
    const d = S.data, M = d.meta.last;
    $("metaLine").textContent = isEN()
      ? `Data: ${trDate(d.weeks[0])} – ${trDate(M.fx)} (weekly). Latest observations: rates ${trDate(M.rates)}, FX ${trDate(M.fx)}, ` +
        `gold ${trDate(M.gold)}, CPI ${trMonth(M.tufe)}, PPI ${trMonth(M.ufe)}` + (M.policy ? `, policy rate ${trMonth(M.policy)}` : "") +
        `. Data updated: ${trDate(d.meta.generated)}.`
      : `Veri: ${trDate(d.weeks[0])} – ${trDate(M.fx)} (haftalık). Son gözlemler: faiz ${trDate(M.rates)}, kur ${trDate(M.fx)}, ` +
        `altın ${trDate(M.gold)}, TÜFE ${trMonth(M.tufe)}, Yİ-ÜFE ${trMonth(M.ufe)}` + (M.policy ? `, politika faizi ${trMonth(M.policy)}` : "") +
        `. Veri güncelleme: ${trDate(d.meta.generated)}.`;
    $("metaFiles").textContent = L("Kaynak dosyalar (data/raw): ", "Source files (data/raw): ") + Object.values(d.meta.files).join(", ") + ".";
    const period = (label) => isEN() ? label.replace(/günümüz/i, "present") : label;
    $("taxTable").innerHTML =
      L("<thead><tr><th>Yürürlük dönemi</th><th>6 aya kadar</th><th>1 yıla kadar</th><th>1 yıldan uzun</th></tr></thead><tbody>",
        "<thead><tr><th>Period in force</th><th>Up to 6 months</th><th>Up to 1 year</th><th>Longer than 1 year</th></tr></thead><tbody>") +
      d.stopaj.map((r) => `<tr><td>${period(r.label)}</td><td>${pctRaw(r.m6)}</td><td>${pctRaw(r.y1)}</td><td>${pctRaw(r.y1p)}</td></tr>`).join("") +
      "</tbody>";
  }

  // ── Sayfadaki sabit metinler: Türkçe index.html'den alınır, İngilizcesi burada ──
  const STATIC_EN = [
    // [öğe bulucu, mod, İngilizce]  mod: text | html | last (son metin düğümü) | attr:ad
    [() => document.querySelector("meta[name=description]"), "attr:content",
      "Weekly analysis of the return on Turkish lira deposits in foreign currency and gold terms after exchange rate movements (2002–present)."],
    [() => document.querySelector("h1"), "text", "Carry trade returns and TL deposit rate policy"],
    [() => document.querySelector(".subtitle"), "text", "12-month net return on foreign currency converted into TL deposits, weekly, 2002–present"],
    [() => document.querySelector(".controls"), "attr:aria-label", "Analysis settings"],
    [() => $("curLabel"), "text", "Currency"],
    [() => document.querySelector('#curSeg [data-cur="XAU"]'), "text", "Gold (gram)"],
    [() => ctlLabel("ser"), "text", "TL rate series"],
    [() => ctlLabel("term"), "text", "Term (rollover)"],
    [() => ctlLabel("taxMode"), "text", "Withholding tax"],
    [() => ctlLabel("fixedTax"), "text", "Fixed tax rate (%)"],
    [() => ctlLabel("deflator"), "text", "Inflation measure"],
    [() => document.querySelector(".checks .ctl-label"), "text", "Display"],
    [() => opt("ser", "tum"), "text", "Total (all maturities)"],
    [() => opt("ser", "m1"), "text", "Up to 1 month"],
    [() => opt("ser", "m3"), "text", "Up to 3 months"],
    [() => opt("ser", "m6"), "text", "Up to 6 months"],
    [() => opt("ser", "y1"), "text", "Up to 1 year"],
    [() => opt("ser", "y1p"), "text", "1 year and longer"],
    [() => opt("term", "m1"), "text", "1 month"],
    [() => opt("term", "m3"), "text", "3 months"],
    [() => opt("term", "m6"), "text", "6 months"],
    [() => opt("term", "y1"), "text", "1 year"],
    [() => opt("term", "y1p"), "text", "Longer than 1 year"],
    [() => opt("taxMode", "period"), "text", "Rates in force"],
    [() => opt("taxMode", "fixed"), "text", "Fixed rate"],
    [() => opt("taxMode", "none"), "text", "No tax (gross)"],
    [() => opt("deflator", "tufe"), "text", "CPI (TÜFE)"],
    [() => opt("deflator", "ufe"), "text", "PPI (Yİ-ÜFE)"],
    [() => $("spread").parentElement, "last", " FX spread"],
    [() => $("showTl").parentElement, "last", " TL nominal"],
    [() => $("showReal").parentElement, "last", " Real TL"],
    [() => $("showFx").parentElement, "last", " FX change (next 52 weeks)"],
    [() => $("showEvents").parentElement, "last", " Events"],
    [() => document.querySelector("#bulgu h2"), "last", "Carry trade return: 12-month window"],
    [() => $("mainChart"), "attr:aria-label", "12-month carry trade return by start week"],
    [() => document.querySelector("#bulgu .chart-note"), "text",
      "The solid line shows completed 12-month periods; the dashed line shows annualised returns for periods running 13–51 weeks. " +
      "Click a week to analyse the period from that date onwards, or zoom in to analyse the visible range. Double-click to return to the full period."],
    [() => document.querySelector("#bulgu .intro"), "text",
      "This study examines the level of return provided on Turkish lira deposits in order to shift resident investors from foreign currency " +
      "and FX-protected deposits (KKM) into Turkish lira deposits and to attract foreign carry trade flows. The measure is the net return, " +
      "in the original currency, of foreign currency placed in TL deposits after withholding tax and exchange rate movements. " +
      "Default view: 12-month net return of a US dollar carry trade in which the total TL deposit rate (TP.TRY.MT06) is applied annually."],
    [() => $("dlMain"), "text", "Download chart data (CSV)"],
    [() => document.querySelector("#donem h2"), "last", "Period analysis"],
    [() => document.querySelector("#donem .lead"), "text",
      "Select start and end dates, or click a week on the chart above. Values are cumulative for the selected period; annualised equivalents are shown on the cards."],
    [() => ctlLabel("pStart"), "text", "Start"],
    [() => ctlLabel("pEnd"), "text", "End"],
    [() => document.querySelector('[data-quick="52"]'), "text", "1 year"],
    [() => document.querySelector('[data-quick="52"]'), "attr:title", "1 year from the start date"],
    [() => document.querySelector('[data-quick="156"]'), "text", "3 years"],
    [() => document.querySelector('[data-quick="156"]'), "attr:title", "3 years from the start date"],
    [() => document.querySelector('[data-quick="260"]'), "text", "5 years"],
    [() => document.querySelector('[data-quick="260"]'), "attr:title", "5 years from the start date"],
    [() => document.querySelector('[data-quick="toEnd"]'), "text", "To date"],
    [() => document.querySelector('[data-quick="toEnd"]'), "attr:title", "From the start date to today"],
    [() => document.querySelector(".rolls summary"), "text", "Deposit breakdown: interest, tax and balance"],
    [() => document.querySelector("#yontem h2"), "last", "Methodology"],
    [() => nth("#yontem h3", 0), "text", "Carry trade return"],
    [() => nth("#yontem h3", 1), "text", "Withholding tax"],
    [() => nth("#yontem h3", 2), "text", "Exchange rate and spread"],
    [() => nth("#yontem h3", 3), "text", "Real return"],
    [() => nth("#yontem h3", 4), "text", "Annualisation"],
    [() => nth("#yontem h3", 5), "text", "Limitations"],
    [() => nth("#yontem p", 0), "html",
      "At the start week, the investor sells foreign currency (or gold) to the bank, converts it into TL and places it in a TL deposit of the selected term. " +
      "At maturity, principal and net interest are reinvested at that week's interest rate. At the end of the period, the TL balance is converted back into foreign currency. " +
      "The return is calculated in foreign currency terms relative to the initial foreign currency amount."],
    [() => nth("#yontem p", 1), "html",
      "The interest rate series and the term are chosen independently. Interest accrues on each deposit as <em>balance × annual rate × days / 365</em>; " +
      "at maturity, principal and net interest are reinvested at that week's rate of the selected series. " +
      "Terms are 4 weeks for 1 month, 13 for 3 months, 26 for 6 months and 52 for 1 year and longer. " +
      "In the default view, the total (all maturities) series is applied annually: a single 52-week deposit is opened at the start week's rate, " +
      "interest accrues once at maturity and the \"up to 1 year\" withholding tax rate applies. " +
      "When a rate series is selected, the term is set to that series' own maturity and can be changed separately."],
    [() => nth("#yontem p", 2), "html",
      "For each deposit, the withholding tax rate in force on the date the deposit is opened or rolled over is deducted from gross interest. " +
      "The tax bracket follows the selected term: \"up to 6 months\" for 1-, 3- and 6-month terms, " +
      "\"up to 1 year\" for the 1-year term, and \"longer than 1 year\" for longer terms."],
    [() => nth("#yontem p", 3), "html",
      "With the FX spread enabled, entry uses the CBRT foreign exchange buying rate (foreign currency is sold to the bank) and exit uses the selling rate " +
      "(foreign currency is bought from the bank). When disabled, the buying rate is used at both ends. Spreads applied by banks are usually wider than the CBRT spread. " +
      "No spread is applied to gold, for which a single price is used."],
    [() => nth("#yontem p", 4), "html",
      "The real TL return is calculated as <em>(1 + nominal TL return) ÷ (1 + period inflation) − 1</em>. " +
      "Period inflation is derived from the index values of the months containing the start and end weeks. " +
      "No real return is calculated for months whose index has not yet been released."],
    [() => nth("#yontem p", 5), "html",
      "For periods shorter than 52 weeks, the annualised compound return is <em>(1 + r)<sup>52/h</sup> − 1</em> (h: weeks). " +
      "Because exchange rate volatility inflates annualised values over short periods, the main chart shows only periods of at least 13 weeks. " +
      "If the period ends in the middle of a deposit, accrued interest is included."],
    [() => nth("#yontem p", 6), "html",
      "The interest rate series are flow-based weighted averages across banks; the rate obtained by an individual investor may differ. " +
      "Transaction taxes on foreign currency purchases and bank fees are not included. " +
      "When EVDS weekly exchange rates are downloaded as weekly averages, entry and exit rates may deviate from actual transaction rates, especially in weeks of currency shocks."],
    [() => document.querySelector("#veri h2"), "last", "Data and sources"],
    [() => $("dataScopeTitle"), "text", "Data selection and scope"],
    [() => $("dataScope"), "text",
      "TLREF, which is widely used in studies focusing on institutional derivative models, has no history extending before 2018/2019. " +
      "To extend the time series without interruption back to the early 2000s and to compare different macroeconomic regimes, " +
      "this study uses the weighted average TL deposit rates published in CBRT EVDS (TP.TRY.MT series). " +
      "The study aims to capture, on the one hand, the actual opportunity cost faced by residents in deciding to switch from foreign currency deposits and KKM " +
      "into Turkish lira and, on the other, the cash carry dynamics realised through deposit liabilities (non-resident deposit inflows) " +
      "under the financial account of the balance of payments."],
    [() => nth(".sources li", 0), "html", "<strong>Deposit rates:</strong> CBRT EVDS, TL deposit interest rates (flow, weekly), TP.TRY.MT01–MT06."],
    [() => nth(".sources li", 1), "html", "<strong>Exchange rates:</strong> CBRT EVDS, USD, EUR and GBP foreign exchange buying and selling rates (weekly), TP.DK.*.A.YTL and TP.DK.*.S.YTL."],
    [() => nth(".sources li", 2), "html", "<strong>Gold (gram):</strong> ICE, XAU/TRY (commodity CFD), weekly price in TL per gram."],
    [() => nth(".sources li", 3), "html", "<strong>Price indices:</strong> TurkStat (via EVDS), CPI 2003=100 (TP.GENENDEKS.T1) and domestic PPI (TP.TUFE1YI.T1), monthly."],
    [() => nth(".sources li", 4), "html", "<strong>Withholding tax rates:</strong> Council of Ministers and Presidential decisions published in the Official Gazette."],
    [() => document.querySelector(".downloads a"), "text", "Combined dataset (CSV)"],
    [() => document.querySelector(".site-footer .contact strong"), "text", "Author:"],
    [() => document.querySelector(".site-footer .contact a") && document.querySelector(".site-footer .contact a").previousSibling, "node",
      " Cem Karakutuk · "],
    [() => nth(".site-footer p", 1), "text",
      "This site is for academic purposes and does not constitute investment advice. Calculations run in the browser using open data and documented assumptions."],
  ];
  const ctlLabel = (id) => { const el = $(id); const w = el && el.closest(".ctl"); return w && w.querySelector(".ctl-label"); };
  const opt = (id, v) => document.querySelector(`#${id} option[value="${v}"]`);
  const nth = (sel, k) => document.querySelectorAll(sel)[k];
  const lastText = (el) => { const n = [...el.childNodes].reverse().find((x) => x.nodeType === 3 && x.textContent.trim()); return n; };

  let staticTR = null;
  function applyLanguage() {
    const items = STATIC_EN.map(([find, mode, en]) => ({ el: find(), mode, en }));
    if (!staticTR) {
      // İlk çağrıda sayfadaki Türkçe metinler saklanır
      staticTR = items.map(({ el, mode }) => {
        if (!el) return null;
        if (mode === "html") return el.innerHTML;
        if (mode === "text") return el.textContent;
        if (mode === "node") return el.textContent;
        if (mode === "last") { const n = lastText(el); return n ? n.textContent : null; }
        return el.getAttribute(mode.slice(5));
      });
      staticTR.title = document.title;
    }
    items.forEach(({ el, mode, en }, k) => {
      const tr = staticTR[k];
      if (!el || tr == null) return;
      const v = isEN() ? en : tr;
      if (mode === "html") el.innerHTML = v;
      else if (mode === "text" || mode === "node") el.textContent = v;
      else if (mode === "last") { const n = lastText(el); if (n) n.textContent = v; }
      else el.setAttribute(mode.slice(5), v);
    });
    document.title = isEN() ? "Carry Trade Analysis" : staticTR.title;
    document.documentElement.lang = LANG;
    const btn = $("langBtn");
    if (btn) {
      btn.textContent = isEN() ? "Türkçe" : "English";
      btn.setAttribute("aria-label", isEN() ? "Türkçeye geç" : "Switch to English");
      btn.lang = isEN() ? "tr" : "en";
    }
  }

  // Politika faizi kutucuğu ve kaynak satırı sayfaya JS ile eklenir (index.html'e dokunmadan)
  function addPolicyControls() {
    if (!S.data.policy || $("showPolicy")) return;
    const lab = document.createElement("label");
    lab.innerHTML = '<input type="checkbox" id="showPolicy"> <span id="policyLbl"></span>';
    const tl = $("showTl").parentElement;
    tl.parentElement.insertBefore(lab, tl.nextSibling);
    const li = document.createElement("li");
    li.id = "policySrc";
    const list = document.querySelector(".sources");
    if (list) list.appendChild(li);
    $("showPolicy").addEventListener("change", () => {
      Plotly.restyle("mainChart", { visible: $("showPolicy").checked }, [7]);
      if ($("mainChart").layout.xaxis.range && $("mainChart").layout.xaxis.autorange !== true) rescaleY();
    });
  }
  function translatePolicyControls() {
    if ($("policyLbl")) $("policyLbl").textContent = L("Politika faizi", "Policy rate");
    if ($("policySrc")) $("policySrc").innerHTML = L(
      "<strong>Politika faizi:</strong> TCMB politika faizi, aylık düzey (BIS kaynaklı, EVDS TP.BISPOLFAIZ.TUR).",
      "<strong>Policy rate:</strong> CBRT policy rate, monthly level (source: BIS, via EVDS TP.BISPOLFAIZ.TUR).");
  }

  /* Vade seçicisi yalnızca "toplam (tüm vadeler)" serisinde görünür.
   * Diğer serilerde vade zaten serinin kendi vadesidir ve otomatik ayarlanır. */
  function syncTermVisibility() {
    const wrap = $("term") && $("term").closest(".ctl");
    if (wrap) wrap.hidden = $("ser").value !== "tum";
  }

  function addLanguageButton() {
    const st = document.createElement("style");
    st.textContent =
      ".masthead .wrap{position:relative}" +
      "#langBtn{position:absolute;top:0;right:24px;font:inherit;font-size:.85rem;color:var(--accent);background:#fff;" +
      "border:1px solid var(--accent);border-radius:6px;padding:5px 12px;cursor:pointer;min-height:32px}" +
      "#langBtn:hover{background:var(--accent);color:#fff}" +
      ".masthead h1{padding-right:110px}" +
      "@media (max-width:600px){#langBtn{right:16px}}";
    document.head.appendChild(st);
    const b = document.createElement("button");
    b.type = "button"; b.id = "langBtn";
    document.querySelector(".masthead .wrap").appendChild(b);
    b.addEventListener("click", () => setLanguage(isEN() ? "tr" : "en"));
  }

  function setLanguage(lang) {
    LANG = lang;
    safeSet("lang", lang);
    const u = new URL(location.href);
    if (lang === "en") u.searchParams.set("lang", "en"); else u.searchParams.delete("lang");
    history.replaceState(null, "", u);
    applyLanguage();
    translatePolicyControls();
    if (S.data) {
      renderStatic();
      renderMain(true);
      renderPeriod();
    }
  }

  function downloadMainCsv() {
    // TR: Türkçe Excel uyumlu (noktalı virgül, virgül ondalık). EN: standart CSV (virgül, nokta ondalık).
    const c = cfg(), unit = CURRENCY[c.cur].unit;
    const sep = isEN() ? "," : ";";
    const f = (v) => (v == null ? "" : isEN() ? (v * 100).toFixed(2) : (v * 100).toFixed(2).replace(".", ","));
    const defl = c.deflator === "tufe" ? L("TÜFE", "CPI") : L("Yİ-ÜFE", "PPI");
    const head = isEN()
      ? ["Start week", "Length (weeks)", "Period", `Carry return ${unit} (%)`, "TL nominal return (%)", `Real TL return ${defl} (%)`, `FX change ${unit}/TL (%)`, "CBRT policy rate (%)"]
      : ["Başlangıç haftası", "Süre (hafta)", "Dönem", `Carry getirisi ${unit} (%)`, "TL nominal getiri (%)", `Reel TL getiri ${defl} (%)`, `Kur değişimi ${unit}/TL (%)`, "TCMB politika faizi (%)"];
    const rows = S.series.map((x) => [isEN() ? x.date : trDate(x.date), x.w,
      x.full ? L("12 ay", "12 months") : L("Yıllıklandırılmış", "Annualised"),
      f(x.carry), f(x.tlRet), f(x.real), f(x.fxChg), f(x.policy == null ? null : x.policy / 100)].join(sep));
    const blob = new Blob(["\uFEFF" + [head.join(sep)].concat(rows).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `carry_${c.cur}_${c.ser}_${c.term}_${c.taxMode}${c.spread ? "" : L("_makassiz", "_nospread")}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── Olaylar ───────────────────────────────────────────────────────────
  function bind() {
    document.querySelectorAll("#curSeg button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("#curSeg button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      const spreadOk = CURRENCY[b.dataset.cur].spread;
      // Altında makul varsayılan tutar: 1.000 gram
      const amt = $("pAmount");
      if (b.dataset.cur === "XAU" && amt.value === "100000") amt.value = "1000";
      if (b.dataset.cur !== "XAU" && amt.value === "1000") amt.value = "100000";
      $("spread").disabled = !spreadOk;
      $("spread").parentElement.classList.toggle("disabled", !spreadOk);
      recalc();
    }));
    ["term", "deflator", "spread"].forEach((id) => $(id).addEventListener("change", recalc));
    // Faiz serisi değişince vade, serinin kendi vadesine ayarlanır (sonra ayrıca değiştirilebilir)
    $("ser").addEventListener("change", () => { $("term").value = SERIES[$("ser").value].term; syncTermVisibility(); recalc(); });
    $("taxMode").addEventListener("change", () => { $("fixedWrap").hidden = $("taxMode").value !== "fixed"; recalc(); });
    $("fixedTax").addEventListener("input", recalc);
    const vis = (id, mainIdx, cumIdx) => $(id).addEventListener("change", () => {
      Plotly.restyle("mainChart", { visible: $(id).checked }, [mainIdx]);
      if ($("mainChart").layout.xaxis.range && $("mainChart").layout.xaxis.autorange !== true) rescaleY();
    });
    vis("showTl", 2, 1); vis("showReal", 3, 2); vis("showFx", 4, 3);
    $("showEvents").addEventListener("change", () => renderMain(true));

    // Tek tık dönem analizini günceller; çift tık yalnızca yakınlaştırmadan çıkar.
    // Tek tık, çift tık olup olmadığı anlaşılana kadar kısa bir süre bekletilir.
    let clickTimer = null, ignoreUntil = 0;
    const cancelClick = () => { clearTimeout(clickTimer); clickTimer = null; ignoreUntil = Date.now() + 450; };
    $("mainChart").on("plotly_doubleclick", cancelClick);
    $("mainChart").on("plotly_click", (e) => {
      if (Date.now() < ignoreUntil) return;          // çift tıklamanın parçası
      if (clickTimer) { cancelClick(); return; }       // kısa sürede ikinci tık: çift tıklama
      const p = e.points.find((q) => q.curveNumber === 5 || q.curveNumber === 6) || e.points[0];
      if (!p) return;
      clickTimer = setTimeout(() => { clickTimer = null; pickWeek(p); }, 350);
    });
    const pickWeek = (p) => {
      const i0 = S.series[p.pointIndex].i;
      // Grafik yakınlaştırılmışsa bitiş görünen aralığın sonu, değilse bugün
      const rng = $("mainChart").layout.xaxis.range;
      const hi = rng ? String(rng[1]).slice(0, 10) : null;
      const zoomed = hi && hi < S.series[S.series.length - 1].date;
      let i1 = zoomed ? idxOnOrBefore(hi) : S.N;
      if (i1 <= i0) i1 = S.N;
      S.userPicked = true;
      setPeriod(i0, i1, true);
    };
    // Yakınlaştırma: dönem analizi görünen aralığa (başlangıç → bitiş) göre güncellenir
    $("mainChart").on("plotly_relayout", (ev) => {
      updateStats();
      let lo = null, hi = null;
      if (ev["xaxis.range[0]"] != null) { lo = ev["xaxis.range[0]"]; hi = ev["xaxis.range[1]"]; }
      else if (Array.isArray(ev["xaxis.range"])) { [lo, hi] = ev["xaxis.range"]; }
      else if (ev["xaxis.autorange"]) { rescaleY(); return; } // yakınlaştırmadan çıkış: dönem analizi değişmez
      else return; // işaret çizgisi güncellemesi gibi diğer olaylar
      const i0 = idxOnOrAfter(String(lo).slice(0, 10));
      const i1 = idxOnOrBefore(String(hi).slice(0, 10));
      rescaleY();
      if (i1 - i0 < 1) return;
      setPeriod(i0, i1);
      moveMarker();
    });

    $("pStart").addEventListener("change", () => { if ($("pStart").value) setPeriod(idxOnOrAfter($("pStart").value), S.period.i1); });
    $("pEnd").addEventListener("change", () => { if ($("pEnd").value) setPeriod(S.period.i0, idxOnOrBefore($("pEnd").value)); });
    $("pAmount").addEventListener("input", renderPeriod);
    document.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => {
      const q = b.dataset.quick;
      // Süre, seçili başlangıç tarihinden itibaren sayılır
      const i0 = S.period.i0;
      const i1 = q === "toEnd" ? S.N : Math.min(S.N, i0 + parseInt(q, 10));
      setPeriod(i0, i1);
    }));
    $("dlMain").addEventListener("click", downloadMainCsv);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recalc);
  }

  function recalc() {
    renderMain(true);
    setPeriod(S.period.i0, S.period.i1);
  }

  // ── Başlatma ──────────────────────────────────────────────────────────
  async function init() {
    const fail = (msg) => {
      $("mainChart").innerHTML = `<p class="chart-msg">${msg}</p>`;
      $("metaLine").textContent = "";
    };
    if (typeof Plotly === "undefined") {
      fail(L("Grafik kütüphanesi (Plotly) yüklenemedi. İnternet bağlantısını veya içerik engelleyiciyi kontrol edin.",
        "The charting library (Plotly) could not be loaded. Check your internet connection or content blocker."));
      return;
    }
    let data;
    try {
      const res = await fetch("data/dataset.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (err) {
      fail(location.protocol === "file:"
        ? "Veri dosyası tarayıcı güvenliği nedeniyle doğrudan dosyadan açılamıyor. Siteyi GitHub Pages üzerinden görüntüleyin ya da repo klasöründe <code>python -m http.server</code> çalıştırıp http://localhost:8000 adresini açın."
        : L("Veri dosyası (data/dataset.json) yüklenemedi.", "The data file (data/dataset.json) could not be loaded."));
      return;
    }
    try {
      const r = await fetch("data/events.json", { cache: "no-cache" });
      if (r.ok) S.events = await r.json();
    } catch (_) { /* olay dosyası isteğe bağlı */ }

    registerLocale();
    prepare(data);
    addLanguageButton();
    addPolicyControls();
    applyLanguage();
    syncTermVisibility();
    translatePolicyControls();
    renderStatic();
    S.period = { i0: S.N - H, i1: S.N };
    renderMain(false);
    setPeriod(S.N - H, S.N);
    bind();
  }

  init();
})();
