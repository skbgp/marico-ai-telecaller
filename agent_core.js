/* =====================================================================
 * Marico AI General Trade Telecalling Agent - core engine
 * ---------------------------------------------------------------------
 * One file, shared by the browser demo (index.html) and the Node test
 * suite (run_tests.js).  Three layers:
 *
 *   1. PLANNER    - before the call: who to call, when, what to
 *                   recommend, how much, which single cross-sell.
 *   2. TOOLS      - guard-railed business actions (stock check, add
 *                   line, read-back, confirm, callback, escalate ...).
 *                   Every commercial action goes through these, in both
 *                   modes, so an LLM can never book stock that is not
 *                   there, invent a discount or skip the read-back.
 *   3. DIALOGUE   - deterministic Hinglish/English dialogue manager
 *                   (offline fallback + test harness).  In "Claude mode"
 *                   the LLM replaces this layer and calls the same TOOLS.
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');

  /* ------------------------------------------------------------------ */
  /* 0. INDEX                                                            */
  /* ------------------------------------------------------------------ */
  const SHORT = {
    P001: 'Parachute 100 ml', P002: 'Parachute 200 ml', P003: 'Parachute 500 ml', P004: 'Parachute 1 litre',
    P005: 'Parachute Advansed Jasmine 200 ml', P006: 'Saffola Gold 1 litre pouch', P007: 'Saffola Gold 5 litre jar',
    P008: 'Saffola Active 1 litre pouch', P009: 'Saffola Masala Oats 40 g', P010: 'Saffola Masala Oats 500 g',
    P011: 'Saffola Oats 1 kg', P012: 'Nihar Shanti Amla 100 ml', P013: 'Nihar Shanti Amla 300 ml',
    P014: 'Nihar Coconut Oil 200 ml', P015: 'Livon Serum 50 ml', P016: 'Livon Serum 100 ml',
    P017: 'Livon Styler Gel 100 g', P018: 'Set Wet Deo 150 ml', P019: 'Set Wet Gel 50 ml', P020: 'Set Wet Gel 100 ml'
  };

  function buildIndex(data, opts) {
    opts = opts || {};
    const idx = { data, callDate: opts.callDate || data.meta.as_of, asOf: data.meta.as_of,
      snapshot: data.meta.inventory_snapshot, reserved: {}, outbox: [] };
    idx.deltaDays = Math.round((Date.parse(idx.callDate) - Date.parse(idx.asOf)) / DAY);
    idx.retailers = {}; data.retailers.forEach(r => { idx.retailers[r.Retailer_ID] = r; });
    idx.prefs = {}; data.preferences.forEach(p => { idx.prefs[p.Retailer_ID] = Object.assign({}, p); });
    idx.products = {}; data.products.forEach(p => { idx.products[p.SKU_ID] = Object.assign({ Short: SHORT[p.SKU_ID] || p.Product_Name + ' ' + p.Pack_Size }, p); });
    idx.history = {}; data.history.forEach(h => { (idx.history[h.Retailer_ID] = idx.history[h.Retailer_ID] || []).push(h); });
    idx.stock = {}; data.inventory.forEach(i => { idx.stock[i.Distributor_ID + '|' + i.SKU_ID] = i; });
    // peer adoption: share of retailers in the same segment that buy a SKU
    const seg = {}, segN = {};
    data.retailers.forEach(r => { segN[r.Segment] = (segN[r.Segment] || 0) + 1; });
    data.history.forEach(h => {
      const s = idx.retailers[h.Retailer_ID].Segment;
      seg[s + '|' + h.SKU_ID] = (seg[s + '|' + h.SKU_ID] || 0) + 1;
    });
    idx.peer = (segment, sku) => (seg[segment + '|' + sku] || 0) / (segN[segment] || 1);
    return idx;
  }

  function stockOf(idx, dist, sku) {
    const s = idx.stock[dist + '|' + sku];
    if (!s) return { units: 0, available: 0, status: 'Not stocked' };
    const available = Math.max(0, s.Available_Stock_Units - (idx.reserved[dist + '|' + sku] || 0));
    const status = available === 0 ? 'Out of stock' : (available <= 15 ? 'Low stock' : 'Available');
    return { units: s.Available_Stock_Units, available, status, snapshot: s.Last_Updated };
  }

  /* ------------------------------------------------------------------ */
  /* 1. PLANNER                                                          */
  /* ------------------------------------------------------------------ */
  // Score weights (documented in the deck: "When to call")
  const W = { urgency: 0.40, value: 0.25, serviceability: 0.20, opportunity: 0.15 };

  function suggestQty(h, freq, avail) {
    const cycle = h.Avg_Monthly_Qty * freq / 30;                 // run-rate per order cycle
    let q = Math.round(0.5 * h.Last_Order_Qty + 0.5 * cycle);    // anchor on last order, smooth with run-rate
    const cap = Math.ceil(1.5 * Math.max(h.Last_Order_Qty, h.Previous_Order_Qty)); // anti over-stocking
    q = clamp(q, 1, cap);
    return { qty: Math.min(q, avail), cycle: Math.round(cycle * 10) / 10, cap, cappedByStock: q > avail };
  }

  function sameFamilyAlternative(idx, dist, sku) {
    // same brand + same product line, nearest pack size, that is in stock
    const p = idx.products[sku];
    const fam = Object.values(idx.products).filter(x => x.SKU_ID !== sku && x.Brand === p.Brand &&
      x.Product_Name === p.Product_Name && x.Pack_Measure_Unit === p.Pack_Measure_Unit);
    const inStock = fam.map(x => ({ p: x, s: stockOf(idx, dist, x.SKU_ID) })).filter(o => o.s.available > 0);
    inStock.sort((a, b) => Math.abs(Math.log(a.p.Pack_Measure / p.Pack_Measure)) - Math.abs(Math.log(b.p.Pack_Measure / p.Pack_Measure)));
    return inStock.length ? inStock[0].p.SKU_ID : null;
  }

  function validateCrossSell(idx, r, pref, hist, dist) {
    const bought = new Set(hist.map(h => h.SKU_ID));
    const brands = pref.Preferred_Brands.split(',').map(s => s.trim());
    const hint = pref.Cross_Sell_Opportunity;
    const ok = (sku) => stockOf(idx, dist, sku).status === 'Available';   // never push low/out-of-stock lines
    const trialQty = (sku, share) => {
      const price = idx.products[sku].Distributor_Billing_Price_INR;
      return Math.max(3, Math.min(24, Math.round(pref.Typical_Order_Value_INR * share / price)));
    };
    let res = { hint, hintValid: false, hintIssue: null, pick: null };
    if (hint.startsWith('Parachute 200 ml')) {
      if (!bought.has('P002')) res.hintIssue = 'Retailer does not buy Parachute 200 ml, so a 200->500 ml trade-up has no base';
      else if (bought.has('P003')) res.hintIssue = 'Retailer already buys Parachute 500 ml';
      else if (!ok('P003')) res.hintIssue = 'Parachute 500 ml not freely in stock at distributor';
      else {
        const h2 = hist.find(h => h.SKU_ID === 'P002');
        const q = Math.max(3, Math.round(0.3 * h2.Avg_Monthly_Qty * pref.Purchase_Frequency_Days / 30 * 200 / 500));
        res.hintValid = true; res.pick = { sku: 'P003', type: 'trade-up', qty: q, reason: 'Moves 200 ml buyer to 500 ml: lower cost per ml, higher margin per bottle' };
      }
    } else if (hint === 'Saffola Gold replenishment') {
      const g = ['P006', 'P007'].find(s => bought.has(s));
      if (!g) res.hintIssue = 'No Saffola Gold in purchase history, so "replenishment" is not possible';
      else if (stockOf(idx, dist, g).available === 0) res.hintIssue = 'Saffola Gold out of stock at distributor';
      else {
        const h = hist.find(x => x.SKU_ID === g);
        const sq = suggestQty(h, pref.Purchase_Frequency_Days, stockOf(idx, dist, g).available);
        res.hintValid = true; res.pick = { sku: g, type: 'replenishment', qty: sq.qty, reason: 'Regular Saffola Gold line, due for replenishment' };
      }
    } else if (hint === 'Saffola Oats cross-sell') {
      if (hist.some(h => ['P009', 'P010', 'P011'].includes(h.SKU_ID))) res.hintIssue = 'Already buys Saffola Oats';
      else {
        const t = ['P009', 'P010'].find(ok);
        if (!t) res.hintIssue = 'Saffola Oats not freely in stock';
        else { res.hintValid = true; res.pick = { sku: t, type: 'cross-sell', qty: t === 'P009' ? 12 : trialQty(t, 0.05), reason: 'New category for this outlet (foods); low-ticket trial pack' }; }
      }
    } else if (hint.startsWith('Livon / Set Wet')) {
      const missing = ['Livon', 'Set Wet'].filter(b => !brands.includes(b));
      if (!missing.length) res.hintIssue = 'Retailer already buys both Livon and Set Wet';
      else {
        const entry = { 'Livon': ['P015', 'P016'], 'Set Wet': ['P019', 'P018', 'P020'] };
        const t = missing.map(b => entry[b].find(ok)).find(Boolean);
        if (!t) res.hintIssue = 'Entry SKU not freely in stock';
        else { res.hintValid = true; res.pick = { sku: t, type: 'cross-sell', qty: trialQty(t, 0.04), reason: 'Adds a personal-care brand the outlet does not stock yet' }; }
      }
    } else {
      res.hintIssue = 'No hint supplied';
    }
    // Engine fallback when the hint is missing or contradicts the data:
    // best in-stock SKU from a preferred brand that the outlet does not buy yet, weighted by peer adoption.
    if (!res.pick) {
      const cands = Object.values(idx.products).filter(p => brands.includes(p.Brand) && !bought.has(p.SKU_ID) && ok(p.SKU_ID))
        .map(p => ({ sku: p.SKU_ID, adopt: idx.peer(r.Segment, p.SKU_ID) }))
        .filter(c => c.adopt >= 0.25).sort((a, b) => b.adopt - a.adopt);
      if (cands.length) {
        res.pick = { sku: cands[0].sku, type: 'range-extension', qty: trialQty(cands[0].sku, 0.04), peer: cands[0].adopt,
          reason: `Range extension: ${Math.round(cands[0].adopt * 100)}% of similar (${r.Segment.split(' ')[0]}-segment) outlets stock it` };
        res.fallback = true;
      }
    }
    return res;
  }

  function planCall(idx, rid) {
    const r = idx.retailers[rid], pref = idx.prefs[rid];
    const hist = (idx.history[rid] || []).slice();
    const dist = r.Distributor_ID, freq = pref.Purchase_Frequency_Days;
    const daysSince = Math.min.apply(null, hist.map(h => h.Days_Since_Last_Order)) + idx.deltaDays;
    const dueRatio = daysSince / freq;

    const basket = hist.map(h => {
      const p = idx.products[h.SKU_ID], st = stockOf(idx, dist, h.SKU_ID);
      const d = h.Days_Since_Last_Order + idx.deltaDays;
      const lapsed = d - daysSince >= freq;   // skipped in the retailer's recent order(s) while he kept ordering
      const sq = suggestQty(h, freq, st.available);
      let qty = lapsed ? Math.min(st.available, Math.max(1, Math.round(sq.cycle * 0.5))) : sq.qty;
      const due = d >= 0.8 * freq;
      const alt = st.available === 0 ? sameFamilyAlternative(idx, dist, h.SKU_ID) : null;
      const value = qty * p.Distributor_Billing_Price_INR;
      let reason = lapsed ? `Skipped in recent orders (last bought ${d}d ago, cycle ${freq}d): restart with half a cycle`
        : `Last ${h.Last_Order_Qty}, previous ${h.Previous_Order_Qty}, run-rate ${sq.cycle}/cycle`;
      if (sq.cappedByStock && st.available > 0) reason += `; capped at distributor stock ${st.available}`;
      if (st.available === 0) reason = 'Out of stock at distributor' + (alt ? `; offer ${idx.products[alt].Short} instead` : '');
      return { sku: h.SKU_ID, name: p.Short, brand: p.Brand, lastQty: h.Last_Order_Qty, prevQty: h.Previous_Order_Qty,
        suggestedQty: qty, value, daysSince: d, due, lapsed, stock: st.available, stockStatus: st.status, alt, reason,
        price: p.Distributor_Billing_Price_INR, score: (due ? 1 : 0.4) * value };
    }).sort((a, b) => b.score - a.score);

    const basketValue = basket.reduce((s, b) => s + (b.stock > 0 ? b.value : 0), 0);
    const histValue = hist.reduce((s, h) => s + h.Last_Order_Qty * idx.products[h.SKU_ID].Distributor_Billing_Price_INR, 0);
    const servable = histValue ? hist.reduce((s, h) => s + (stockOf(idx, dist, h.SKU_ID).available >= h.Last_Order_Qty ? h.Last_Order_Qty * idx.products[h.SKU_ID].Distributor_Billing_Price_INR : 0), 0) / histValue : 0;
    const cross = validateCrossSell(idx, r, pref, hist, dist);

    // lead lines for the opening: top brand by due value, its top two SKUs
    const brandVal = {};
    basket.filter(b => b.stock > 0 && !b.lapsed).forEach(b => { brandVal[b.brand] = (brandVal[b.brand] || 0) + b.score; });
    const brandsRanked = Object.keys(brandVal).sort((a, b) => brandVal[b] - brandVal[a]);
    const leadBrand = brandsRanked[0];
    const lead = basket.filter(b => b.brand === leadBrand && b.stock > 0 && !b.lapsed).slice(0, 2);

    // when-to-call score
    const comp = {
      urgency: clamp((dueRatio - 0.5) / 1.0, 0, 1),
      value: clamp(pref.Typical_Order_Value_INR / 12000, 0, 1),
      serviceability: servable,
      opportunity: cross.pick ? (cross.hintValid ? 1 : 0.6) : 0
    };
    const score = Math.round(100 * (W.urgency * comp.urgency + W.value * comp.value + W.serviceability * comp.serviceability + W.opportunity * comp.opportunity));
    let decision = 'CALL', why = [];
    if (pref.Do_Not_Call_Flag === 'Yes') { decision = 'DO_NOT_CALL'; why.push('Do-not-call flag'); }
    else if (dueRatio < 0.6) { decision = 'NOT_DUE'; why.push(`Ordered ${daysSince}d ago vs ${freq}d cycle`); }
    else why.push(dueRatio >= 1 ? `Overdue: ${daysSince}d since last order vs ${freq}d cycle` : `Due soon: ${daysSince}d of ${freq}d cycle`);

    return {
      rid, retailer: r, pref, distributor: dist, freq, daysSince, dueRatio: Math.round(dueRatio * 100) / 100,
      score, comp, decision, why, window: pref.Preferred_Calling_Window, language: pref.Preferred_Language,
      basket, basketValue, cross, lead, brandsRanked, histValue
    };
  }

  function dailyCallPlan(idx) {
    const rows = Object.keys(idx.retailers).map(rid => planCall(idx, rid));
    const order = { 'CALL': 0, 'NOT_DUE': 1, 'DO_NOT_CALL': 2 };
    rows.sort((a, b) => order[a.decision] - order[b.decision] || b.score - a.score);
    return rows;
  }

  /* ------------------------------------------------------------------ */
  /* 2. NLU (deterministic, Hinglish + English, Devanagari-tolerant)     */
  /* ------------------------------------------------------------------ */
  const DEVA = [
    ['पैराशूट', 'parachute'], ['सफोला', 'saffola'], ['सफ़ोला', 'saffola'], ['निहार', 'nihar'], ['लिवॉन', 'livon'], ['लिवोन', 'livon'],
    ['सेट वेट', 'setwet'], ['गोल्ड', 'gold'], ['ओट्स', 'oats'], ['हाँ', 'haan'], ['हां', 'haan'], ['जी', 'ji'], ['नहीं', 'nahi'], ['नही', 'nahi'],
    ['के', 'ke'], ['का', 'ka'], ['की', 'ki'], ['और', 'aur'], ['पीस', 'piece'], ['बॉक्स', 'box'], ['डिब्बा', 'dabba'], ['डिब्बे', 'dabbe'], ['पेटी', 'peti'],
    ['लीटर', 'litre'], ['एमएल', 'ml'], ['बस', 'bas'], ['ठीक', 'theek'], ['है', 'hai'], ['कन्फर्म', 'confirm'], ['भेज', 'bhej'], ['दो', 'do'],
    ['दीजिए', 'dijiye'], ['दीजिये', 'dijiye'], ['कर', 'kar'], ['एक', 'ek'], ['तीन', 'teen'], ['चार', 'char'], ['पांच', 'paanch'], ['पाँच', 'paanch'],
    ['छह', 'chhe'], ['सात', 'saat'], ['आठ', 'aath'], ['नौ', 'nau'], ['दस', 'das'], ['बारह', 'barah'], ['पंद्रह', 'pandrah'], ['बीस', 'bees'],
    ['दर्जन', 'darjan'], ['छोटी', 'chhoti'], ['छोटा', 'chhota'], ['बड़ी', 'badi'], ['बड़ा', 'bada'], ['बोतल', 'bottle'], ['स्टॉक', 'stock'], ['कम', 'kam'],
    ['मिलीलीटर', 'ml'], ['मिली', 'ml'], ['किलो', 'kilo'], ['ग्राम', 'gram'], ['पाउच', 'pouch'], ['पैकेट', 'packet'], ['जार', 'jar'], ['शांति', 'shanti'], ['आंवला', 'amla'],
    ['सीरम', 'serum'], ['जेल', 'gel'], ['डियो', 'deo'], ['एक्टिव', 'active'], ['मसाला', 'masala'], ['नारियल', 'nariyal'], ['वाली', 'wali'], ['वाला', 'wala'],
    ['चाहिए', 'chahiye'], ['सौ', 'sau'], ['पचास', 'pachas'], ['पच्चीस', 'pachees'], ['तीस', 'tees'], ['चालीस', 'chalis'], ['छः', 'chhe'], ['ग्यारह', 'gyarah'],
    ['तेरह', 'terah'], ['चौदह', 'chaudah'], ['सोलह', 'solah'], ['सत्रह', 'satrah'], ['अठारह', 'atharah'], ['उन्नीस', 'unnis'], ['ज्यादा', 'zyada'], ['ज़्यादा', 'zyada'],
    ['थोड़ा', 'thoda'], ['महंगा', 'mehenga'], ['उधार', 'udhaar'], ['डिलीवरी', 'delivery'], ['कैंसिल', 'cancel'], ['ऑर्डर', 'order'], ['डिस्काउंट', 'discount'],
    ['बिजी', 'busy'], ['बाद', 'baad'], ['में', 'mein'], ['कॉल', 'call'], ['मत', 'mat'], ['दोबारा', 'dobara'], ['करना', 'karna'], ['गलत', 'galat'], ['आया', 'aaya'],
    ['सेल्स', 'sales'], ['इंग्लिश', 'english'], ['फुल', 'full'], ['पिछली', 'pichhli'], ['बार', 'baar'], ['सही', 'sahi'], ['रेट', 'rate'], ['क्या', 'kya']
  ];
  const NUMW = { zero: 0, ek: 1, one: 1, a: null, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4, paanch: 5, panch: 5, five: 5,
    chhe: 6, chhah: 6, chah: 6, six: 6, saat: 7, seven: 7, aath: 8, eight: 8, nau: 9, nine: 9, das: 10, dus: 10, ten: 10,
    gyarah: 11, eleven: 11, barah: 12, baarah: 12, twelve: 12, terah: 13, thirteen: 13, chaudah: 14, fourteen: 14, pandrah: 15,
    pandra: 15, fifteen: 15, solah: 16, sixteen: 16, satrah: 17, seventeen: 17, atharah: 18, eighteen: 18, unnis: 19, nineteen: 19,
    bees: 20, twenty: 20, pachees: 25, pachchis: 25, tees: 30, thirty: 30, chalis: 40, chaalis: 40, forty: 40, pachas: 50,
    pachaas: 50, fifty: 50, sau: 100, hundred: 100 };
  delete NUMW.a;
  const VERB_BEFORE_DO = new Set(['bhej', 'de', 'kar', 'rakh', 'likh', 'daal', 'hata', 'bata', 'laga', 'bana', 'bol', 'sun', 'dikha',
    'mangwa', 'bhijwa', 'chhod', 'jod', 'add', 'cancel', 'confirm', 'book', 'place', 'mila', 'utha', 'i', 'you', 'we', 'they', 'what', 'how',
    'rehne', 'rahne', 'jane', 'jaane', 'hone', 'dene', 'lene', 'karne', 'aane', 'sochne', 'dekhne']);
  const U_PIECE = new Set(['piece', 'pieces', 'pc', 'pcs', 'peice', 'peices', 'nag', 'bottle', 'bottles', 'botal', 'pouch', 'pouches',
    'packet', 'packets', 'pack', 'packs', 'jar', 'jars', 'can', 'cans', 'tube', 'tubes', 'unit', 'units', 'qty']);
  const U_BOX = new Set(['box', 'boxes', 'dabba', 'dabbe', 'dibba', 'dibbe', 'carton', 'cartons', 'case', 'cases', 'peti', 'petiyan', 'cartoon', 'crate']);
  const U_L = new Set(['l', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters', 'lit', 'litar']);
  const U_ML = new Set(['ml', 'mls']);
  const U_KG = new Set(['kg', 'kgs', 'kilo', 'kilos']);
  const U_G = new Set(['g', 'gm', 'gms', 'gram', 'grams']);
  const U_DOZ = new Set(['dozen', 'darjan', 'dozan', 'darzan']);
  const BRAND_W = { parachute: 'Parachute', parashoot: 'Parachute', parachut: 'Parachute', paracute: 'Parachute', parasoot: 'Parachute',
    saffola: 'Saffola', safola: 'Saffola', safolla: 'Saffola', nihar: 'Nihar', nihaar: 'Nihar', livon: 'Livon', leevon: 'Livon',
    setwet: 'Set Wet' };
  const VARIANT_W = { gold: 'gold', active: 'active', oats: 'oats', oat: 'oats', masala: 'masala', jasmine: 'jasmine', advansed: 'jasmine',
    advanced: 'jasmine', chameli: 'jasmine', amla: 'amla', badam: 'amla', shanti: 'amla', coconut: 'coconut', nariyal: 'coconut',
    serum: 'serum', gel: 'gel', styler: 'styler', styling: 'styler', deo: 'deo', deodorant: 'deo', spray: 'deo' };
  const VARIANT_BRAND = { gold: 'Saffola', active: 'Saffola', oats: 'Saffola', masala: 'Saffola', jasmine: 'Parachute', amla: 'Nihar',
    serum: 'Livon', styler: 'Livon', deo: 'Set Wet' };
  const SMALL_W = new Set(['chhoti', 'chhota', 'chhote', 'small', 'smaller', 'smallest', 'mini']);
  const LARGE_W = new Set(['badi', 'bada', 'bade', 'big', 'large', 'bigger', 'biggest', 'jumbo']);

  const KW = {
    affirm: ['haan', 'ha', 'haa', 'han', 'hanji', 'ji haan', 'jee haan', 'ji boliye', 'ji bataiye', 'speaking', 'bol raha', 'bol rahi', 'main hi hoon', 'theek hai', 'thik hai', 'theek', 'ok', 'okay', 'okk', 'yes', 'yeah', 'yep',
      'sure', 'confirm', 'kar do', 'kar dijiye', 'chalega', 'bilkul', 'sahi hai', 'correct', 'right', 'done', 'place it', 'go ahead', 'bataiye', 'boliye', 'haanji'],
    deny: ['nahi', 'nahin', 'na', 'no', 'nope', 'mat', 'rehne do', 'rahne do', 'rehne dijiye', 'rahne dijiye', 'jane do', 'jaane do', 'chhodo', 'chhod do', 'leave it', 'skip it', 'not now', "don't", 'dont', 'abhi nahi'],
    done: ['bas', 'bas itna', "that's all", 'thats all', 'that is all', 'itna hi', 'aur kuch nahi', 'nothing else', 'bas yahi', 'enough', 'itna kaafi', 'no more'],
    busy: ['busy', 'vyast', 'baad mein', 'baad me', 'later', 'call back', 'callback', 'phir se call', 'phir call', 'shaam ko call', 'abhi time nahi',
      'time nahi hai', 'customer hai', 'grahak hai', 'call me after', 'call after'],
    notInterested: ['nahi chahiye', 'not interested', 'order nahi', 'kuch nahi chahiye', 'koi order nahi', "don't want", 'dont want', 'no order', 'interest nahi',
      'no need'],
    stockedUp: ['stock full', 'maal pada', 'maal bhara', 'stock hai abhi', 'stocked up', 'enough stock', 'already have stock', 'stock bahut hai', 'pura stock', 'full stock'],
    human: ['insaan', 'human', 'salesman', 'sales representative', 'sales rep', 'representative', 'real person', 'kisi aadmi', 'manager', 'executive',
      'asm', 'sales officer', 'person se baat', 'someone from marico', 'agent se baat', 'kisi se baat'],
    dnc: ['call mat karna', 'call mat karo', 'phone mat karna', 'phone mat karo', 'dobara call', 'do not call', "don't call", 'dont call', 'never call',
      'call band karo', 'mat kiya karo call', 'stop calling'],
    complaint: ['galat', 'wrong quantity', 'wrong item', 'wrong product', 'kam aaya', 'kam aayi', 'kam aaye', 'short aaya', 'short supply', 'damaged', 'toota',
      'tuta', 'leak', 'complaint', 'shikayat', 'galti', 'issue', 'problem', 'expired', 'missing', 'arrived with', 'delivered wrong',
      'came wrong', 'was wrong', 'wrong order', 'were short', 'was short', 'pieces short', 'came short', 'less pieces', 'leaking', 'broken'],
    discount: ['discount', 'chhoot', 'chhut', 'scheme do', 'extra margin', 'margin badha', 'rate kam', 'sasta', 'extra off', 'better rate', 'kuch kam karo',
      'offer do', 'free do'],
    wrongParty: ['wrong number', 'galat number', 'main nahi hoon', 'main woh nahi', 'yeh unka number nahi', 'ye unka number nahi', 'unka number nahi', 'this is not', "i'm not", 'i am not', 'koi aur',
      'not the owner', 'no one by that name', 'yahan koi', 'is naam ka koi'],
    vague: ['few more', 'a few', 'some more', 'thoda zyada', 'thode zyada', 'thode aur', 'thoda aur', 'kuch zyada', 'kuch aur', 'jyada bhej', 'zyada bhej', 'more than last'],
    sameAsLast: ['pichhli baar jitna', 'pichli baar jitna', 'same as last', 'wahi bhej', 'vahi bhej', 'same order', 'last time wala', 'jaisa pichhli baar', 'repeat order', 'repeat last'],
    price: ['rate', 'price', 'kitne ka', 'kitne ki', 'mrp', 'cost', 'daam', 'kimat', 'keemat', 'margin', 'how much is it', 'how much is this', 'how much does it', 'how much for'],
    sizes: ['kaunse size', 'kaun se size', 'which sizes', 'what sizes', 'sizes', 'size kya'],
    competitor: ['dabur', 'bajaj', 'emami', 'fortune', 'dhara', 'navratna', 'clinic plus', 'patanjali', 'keo karpin', 'fogg', 'axe', 'quaker', 'kellogg',
      'gemini', 'sundrop', 'competitor', 'dusri company', 'doosri company', 'other company', 'scheme chal', 'offer chal', 'free de rahe', 'promotion', 'bonus'],
    toEnglish: ['english mein', 'in english', 'speak english', 'english please', 'angrezi'],
    toHindi: ['hindi mein', 'in hindi', 'speak hindi', 'hindi please'],
    remove: ['hata do', 'hata dijiye', 'remove', 'nikal do', 'mat bhejo', 'drop'],
    cancelOrder: ['order cancel', 'cancel the order', 'cancel order', 'pura cancel', 'sab cancel', 'kuch mat bhejo', 'poora order cancel', 'cancel everything'],
    objection: ['mehenga', 'mehnga', 'mahanga', 'costly', 'expensive', 'nahi bikta', 'bikta nahi', 'nahi bik', 'slow moving', 'demand nahi', 'customer nahi lete', 'sasta hai', 'margin kam', 'too much stock', 'zyada ho jayega'],
    stockQ: ['available hai', 'available h', 'stock hai kya', 'stock me hai', 'stock mein hai', 'milega kya', 'mil jayega', 'is it available', 'in stock', 'do you have', 'hai kya stock'],
    terms: ['delivery', 'kab aayega', 'kab aayegi', 'kab tak', 'kab milega', 'payment', 'udhaar', 'udhar', 'credit', 'paise baad'],
    whoAreYou: ['kaun bol', 'who is this', 'aap kaun', 'robot', 'are you a bot', 'machine ho', 'computer ho', 'real person ho', 'insaan ho'],
    totalQ: ['kitna hua', 'total kitna', 'total kya', 'kul kitna', 'bill kitna', 'kitne ka hua', 'kitne ki hui', 'total batao', 'total bata', 'what is the total', "what's the total", 'whats the total', 'total amount', 'how much total', 'total how much'],
    ownerAway: ['nahi hain', 'nahin hain', 'bahar gaye', 'bahar hain', 'ghar gaye', 'ghar pe hain', 'dukaan pe nahi', 'dukan pe nahi', 'dukaan par nahi', 'dukan par nahi', 'shop pe nahi', 'not here', 'not available', 'is out', 'not in the shop',
      'abhi nahi hain', 'unka beta', 'unki beti', 'main unka', 'main unki', 'unka bhai', 'staff hoon', 'baad mein aayenge', 'baad me aayenge',
      'not at the shop', 'not at shop', 'not in shop', 'he is out', 'she is out', 'not there', 'out of station', 'gone out', 'went out', 'he is not here', 'she is not here'],
    repeatLine: ['dobara bolo', 'phir se bolo', 'fir se bolo', 'kya bola', 'kya kaha', 'say again', 'say that again', 'repeat that', 'samjha nahi', 'samajh nahi aaya'],
    change: ['kar do', 'kar dijiye', 'change', 'badal', 'instead', 'make it', 'update', 'balki', 'not ', ' nahi '],
  };
  const EN_W = new Set(['the', 'is', 'please', 'want', 'need', 'send', 'yes', 'can', 'you', 'and', 'of', 'i', 'my', 'order', 'how', 'what', 'okay',
    'have', 'will', 'would', 'should', 'this', 'that', 'it', 'me', 'we', 'are', 'for', 'with', 'time', 'today', 'more', 'also', 'thanks', 'thank', 'give',
    'tell', 'about', 'last', 'did', 'do', 'not', 'some', 'stock', 'available', 'pieces', 'only', 'right', 'now', 'speak', 'english', 'fine', 'good', 'lets', 'go',
    'make', 'instead', 'add', 'sorry', 'yes', 'no', 'hello', 'speaking', 'thats', 'all', 'ahead', 'place', 'pack', 'size', 'much', 'many', 'any', 'discount', 'later', 'call', 'back']);
  const HI_W = new Set(['hai', 'haan', 'nahi', 'ke', 'ka', 'ki', 'kar', 'dijiye', 'chahiye', 'bhej', 'aur', 'kitna', 'abhi', 'pichhli', 'baar', 'theek',
    'bhai', 'ji', 'mein', 'de', 'kya', 'bhi', 'bas', 'wala', 'wali', 'hoon', 'hain', 'thoda', 'kuch', 'dena', 'bhejo', 'karo', 'aap', 'mera', 'humko', 'hume']);

  function normalize(text) {
    let t = ' ' + String(text || '') + ' ';
    DEVA.forEach(([d, r]) => { t = t.split(d).join(' ' + r + ' '); });
    t = t.replace(/[०-९]/g, c => String(c.charCodeAt(0) - 0x0966));
    t = t.toLowerCase().replace(/₹/g, ' rs ');
    t = t.replace(/set[\s-]*wet/g, 'setwet').replace(/aadha\s+(litre|liter|l)\b/g, '500 ml').replace(/half\s+(a\s+)?(litre|liter)/g, '500 ml');
    t = t.replace(/half\s+dozen|aadha\s+darjan|adha\s+darjan/g, '6 piece');
    t = t.replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2');
    t = t.replace(/(\d),(\d{3})/g, '$1$2');
    t = t.replace(/[,;]/g, ' , ').replace(/[!?:()"“”‘’]/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
    t = t.replace(/(\d+)\s*-\s*(\d+)/g, '$1 $2');
    return t.replace(/\s+/g, ' ').trim();
  }
  const has = (norm, list) => list.some(k => (' ' + norm + ' ').includes(' ' + k + ' ') || (k.includes(' ') && norm.includes(k)));

  function langScore(tokens) {
    let en = 0, hi = 0;
    tokens.forEach(w => { if (EN_W.has(w)) en++; if (HI_W.has(w)) hi++; });
    return { en, hi };
  }

  function parseTime(norm) {
    let m = norm.match(/(\d{1,2})\s*(baje|bje|pm|am|o clock|oclock)/) || norm.match(/(?:after|baad)\s+(\d{1,2})/) || norm.match(/(\d{1,2})\s+(?:ke baad|ke bad)/);
    let hour = null;
    if (m) { hour = parseInt(m[1], 10); if (hour <= 8 && !/am/.test(m[0])) hour += 12; }
    else if (/shaam|evening/.test(norm)) hour = 18;
    else if (/dopahar|afternoon/.test(norm)) hour = 14;
    else if (/subah|morning/.test(norm)) hour = 10;
    const tomorrow = /\bkal\b|tomorrow/.test(norm);
    return hour === null && !tomorrow ? null : { hour, tomorrow };
  }

  function intents(norm) {
    const I = {};
    Object.keys(KW).forEach(k => { I[k] = has(norm, KW[k]); });
    I.affirm = has(norm.replace(/\bright (now|away)\b/g, ' '), KW.affirm);   // "he is not here right now" is not a yes
    // refine overlapping cues
    if (I.notInterested || I.dnc) I.deny = true;
    if (I.dnc) I.busy = false;
    if (/\bbas\b/.test(norm) && /\b(\d+|ek|do|teen)\b/.test(norm) && !/bas itna|bas yahi|bas ho gaya|bas\s*$/.test(norm)) I.done = false;
    I.time = parseTime(norm);
    if (I.time && /call|phone|baat|baje|after|baad/.test(norm) && (I.busy || /call/.test(norm))) I.busy = true;
    // "baaki baad mein bhej dena" / "send the rest later" is about delivery, not a callback
    if (I.busy && /\b(bhej\w*|send|deliver\w*|baaki|rest|follow)\b/.test(norm) && !/\b(call|phone)\b/.test(norm)) I.busy = false;
    const toks = norm.split(' ');
    I.lang = langScore(toks);
    return I;
  }

  function numberAt(toks, i) {
    const w = toks[i];
    if (/^\d+(\.\d+)?$/.test(w)) return parseFloat(w);
    if (w === 'do') {
      const prev = toks[i - 1], next = toks[i + 1];
      if (VERB_BEFORE_DO.has(prev)) return null;
      const nextOk = next === undefined || next === ',' || next === 'aur' || next === 'and' || U_PIECE.has(next) || U_BOX.has(next) ||
        U_DOZ.has(next) || BRAND_W[next] || VARIANT_W[next] || NUMW[next] !== undefined || /^\d/.test(next) || U_L.has(next) || next === 'nahi';
      const prevOk = ['ke', 'ka', 'ki', 'sirf', 'only', 'just', 'wale', 'wala', 'bas'].includes(prev) || prev === undefined;
      return (nextOk || prevOk) && !(next && ['na', 'ji', 'please'].includes(next)) ? 2 : null;
    }
    if (NUMW[w] !== undefined) {
      if (w === 'sau' && i > 0) return null;
      const next = toks[i + 1];
      if (next === 'sau') return NUMW[w] * 100;
      return NUMW[w];
    }
    if (w === 'dedh') return 1.5;
    if (w === 'dhai') return 2.5;
    return null;
  }

  // Split an utterance into product segments and pull out brand, variant, size and quantity
  function segments(norm) {
    const toks = norm.split(' ');
    const segs = []; let cur = [];
    toks.forEach(w => { if (w === ',' || w === 'aur' || w === 'and' || w === 'plus' || w === 'also') { if (cur.length) segs.push(cur); cur = []; } else cur.push(w); });
    if (cur.length) segs.push(cur);
    return segs.map(st => {
      const seg = { brand: null, variants: [], size: null, sizeWord: null, qty: null, qtyUnit: null, nums: [], rejected: [], litreNums: [], raw: st.join(' ') };
      const used = new Set();
      st.forEach((w, i) => {
        if (BRAND_W[w]) seg.brand = BRAND_W[w];
        if (VARIANT_W[w] && !seg.variants.includes(VARIANT_W[w])) seg.variants.push(VARIANT_W[w]);
        if (SMALL_W.has(w)) seg.sizeWord = 'small';
        if (LARGE_W.has(w)) seg.sizeWord = 'large';
      });
      for (let i = 0; i < st.length; i++) {
        const n = numberAt(st, i);
        if (n === null) continue;
        const next = st[i + 1], next2 = st[i + 2];
        if (st[i + 1] === 'sau') used.add(i + 1);
        const negAfter = ['nahi', 'nahin', 'not', 'no'].includes(next) || ['nahi', 'nahin', 'not'].includes(next2) && (U_PIECE.has(next) || U_BOX.has(next));
        const negBefore = (['not', 'na'].includes(st[i - 1]) && !['ke', 'ka'].includes(st[i - 2])) || (st[i - 1] === 'of' && st[i - 2] === 'instead') || (st[i - 1] === 'jagah' || st[i - 1] === 'bajaye');
        if (next && U_ML.has(next)) { seg.size = { v: n, u: 'ml' }; used.add(i); continue; }
        if (next && U_G.has(next)) { seg.size = { v: n, u: 'g' }; used.add(i); continue; }
        if (next && U_KG.has(next)) { seg.size = { v: n * 1000, u: 'g' }; used.add(i); continue; }
        if (next && U_L.has(next)) { seg.litreNums.push(n); used.add(i); continue; }
        if (negAfter || negBefore) { seg.rejected.push(n); continue; }
        let unit = null;
        if (next && U_PIECE.has(next)) unit = 'piece';
        else if (next && U_BOX.has(next)) unit = 'box';
        else if (next && U_DOZ.has(next)) unit = 'dozen';
        seg.nums.push({ n, unit });
      }
      // bare "darjan"/"dozen" without a number = 12
      if (!seg.nums.length && st.some(w => U_DOZ.has(w))) seg.nums.push({ n: 1, unit: 'dozen' });
      // bare box word without number ("ek box" is caught above)
      if (!seg.nums.some(x => x.unit === 'box') && st.some(w => U_BOX.has(w)) && seg.nums.length === 1 && !seg.nums[0].unit) seg.nums[0].unit = 'box';
      return seg;
    }).reduce((acc, seg) => {
      const prev = acc[acc.length - 1];
      const qtyOnly = !seg.brand && !seg.variants.length && !seg.size && !seg.sizeWord && !seg.litreNums.length && seg.nums.length;
      if (prev && qtyOnly && (prev.brand || prev.variants.length || prev.size) && !prev.nums.length) {
        prev.nums = seg.nums; prev.rejected = prev.rejected.concat(seg.rejected); prev.raw += ' , ' + seg.raw; return acc;
      }
      acc.push(seg); return acc;
    }, []);
  }

  /* ------------------------------------------------------------------ */
  /* 3. TOOLS (guard-railed actions, used by both modes)                 */
  /* ------------------------------------------------------------------ */
  function createSession(idx, rid, opts) {
    opts = opts || {};
    const plan = planCall(idx, rid);
    const S = {
      idx, plan, rid, r: plan.retailer, pref: plan.pref, dist: plan.distributor,
      callId: 'CALL-' + idx.callDate.replace(/-/g, '') + '-' + rid + '-' + String(1 + (idx.outbox.length % 97)).padStart(2, '0'),
      identityVerified: false, cart: [], cartVersion: 0, readbackVersion: -1, events: [], toolLog: [],
      outcome: null, order: null, closed: false, mode: opts.mode || 'deterministic'
    };
    const T = {};
    const log = (name, args, result) => { S.toolLog.push({ name, args, result, at: S.toolLog.length }); return result; };
    const line = sku => S.cart.find(l => l.sku === sku);
    const total = () => S.cart.reduce((s, l) => s + l.qty * l.price, 0);

    T.verify_identity = ({ confirmed }) => {
      S.identityVerified = !!confirmed;
      return log('verify_identity', { confirmed }, { ok: true, identityVerified: S.identityVerified });
    };
    T.get_retailer_context = () => {
      if (!S.identityVerified) return log('get_retailer_context', {}, { error: 'IDENTITY_NOT_VERIFIED', message: 'Confirm you are speaking to the named retailer before using any account data.' });
      const p = S.plan;
      return log('get_retailer_context', {}, {
        retailer: { id: p.rid, shop: p.retailer.Retailer_Name, owner: p.retailer.Owner_Name, city: p.retailer.City, language: p.language, segment: p.retailer.Segment, distributor: p.distributor },
        cadence: { purchase_frequency_days: p.freq, days_since_last_order: p.daysSince, typical_order_value_inr: p.pref.Typical_Order_Value_INR },
        recommended_lines: p.basket.slice(0, 8).map(b => ({ sku_id: b.sku, product: b.name, last_qty: b.lastQty, previous_qty: b.prevQty, suggested_qty: b.suggestedQty, stock_available: b.stock, stock_status: b.stockStatus, due: b.due, reason: b.reason })),
        one_suggestion: p.cross.pick ? { sku_id: p.cross.pick.sku, product: idx.products[p.cross.pick.sku].Short, type: p.cross.pick.type, suggested_qty: p.cross.pick.qty, reason: p.cross.pick.reason } : null
      });
    };
    T.find_products = ({ query }) => {
      const norm = normalize(query);
      const seg = segments(norm)[0] || { brand: null, variants: [] };
      const c = candidates(idx, seg, null).slice(0, 6).map(p => {
        const st = stockOf(idx, S.dist, p.SKU_ID);
        return { sku_id: p.SKU_ID, product: p.Short, pack: p.Pack_Size, billing_price_inr: p.Distributor_Billing_Price_INR, mrp_inr: p.MRP_INR, selling_unit: p.Selling_Unit, stock_available: st.available, stock_status: st.status };
      });
      return log('find_products', { query }, { matches: c, note: c.length > 1 ? 'More than one SKU matches: ask the retailer which pack size before adding.' : undefined });
    };
    T.check_stock = ({ sku_id }) => {
      const p = idx.products[sku_id];
      if (!p) return log('check_stock', { sku_id }, { error: 'UNKNOWN_SKU' });
      const st = stockOf(idx, S.dist, sku_id);
      const alt = st.available === 0 ? sameFamilyAlternative(idx, S.dist, sku_id) : null;
      return log('check_stock', { sku_id }, { sku_id, product: p.Short, available_units: st.available, status: st.status, snapshot_date: idx.snapshot,
        in_stock_alternative: alt ? { sku_id: alt, product: idx.products[alt].Short, available_units: stockOf(idx, S.dist, alt).available } : null });
    };
    T.add_or_update_item = ({ sku_id, quantity, unit, source }) => {
      const args = { sku_id, quantity, unit, source };
      const p = idx.products[sku_id];
      if (!S.identityVerified) return log('add_or_update_item', args, { error: 'IDENTITY_NOT_VERIFIED' });
      if (!p) return log('add_or_update_item', args, { error: 'UNKNOWN_SKU', message: 'Use find_products and ask the retailer to pick a pack size.' });
      const u = String(unit || 'piece').toLowerCase();
      if (!['piece', 'pieces', 'pc', 'pcs', 'unit', 'units', p.Selling_Unit.toLowerCase()].includes(u))
        return log('add_or_update_item', args, { error: 'UNIT_CONVERSION_NOT_SUPPLIED', message: `Billing is per ${p.Selling_Unit.toLowerCase()} (piece). Pieces per ${u} are not in master data: ask the retailer for the number of pieces. Do not guess.` });
      const q = Number(quantity);
      if (!Number.isInteger(q) || q <= 0) return log('add_or_update_item', args, { error: 'INVALID_QUANTITY', message: 'Quantity must be a whole number of pieces greater than zero.' });
      const st = stockOf(idx, S.dist, sku_id);
      if (st.available === 0) {
        const alt = sameFamilyAlternative(idx, S.dist, sku_id);
        return log('add_or_update_item', args, { error: 'OUT_OF_STOCK', available_units: 0, in_stock_alternative: alt ? { sku_id: alt, product: idx.products[alt].Short } : null });
      }
      if (q > st.available) return log('add_or_update_item', args, { error: 'EXCEEDS_STOCK', requested: q, available_units: st.available, message: 'Tell the retailer the available quantity; ask whether to reduce or take available now and follow up for the rest.' });
      const hist = (idx.history[S.rid] || []).find(h => h.SKU_ID === sku_id);
      const usual = hist ? Math.max(hist.Last_Order_Qty, hist.Previous_Order_Qty) : null;
      let l = line(sku_id);
      const prevQty = l ? l.qty : 0;
      if (l) l.qty = q; else { l = { sku: sku_id, name: p.Short, qty: q, price: p.Distributor_Billing_Price_INR, unit: p.Selling_Unit, source: source || 'retailer_request' }; S.cart.push(l); }
      S.cartVersion++;
      const warn = usual && q > 3 * usual ? `Unusually high vs usual ${usual}; confirm with retailer` : null;
      return log('add_or_update_item', args, { ok: true, action: prevQty ? 'updated' : 'added', sku_id, product: p.Short, quantity: q, previous_quantity: prevQty || null, line_value_inr: q * l.price, order_value_inr: total(), warning: warn });
    };
    T.remove_item = ({ sku_id }) => {
      const before = S.cart.length; S.cart = S.cart.filter(l => l.sku !== sku_id);
      if (S.cart.length !== before) S.cartVersion++;
      return log('remove_item', { sku_id }, { ok: S.cart.length !== before, order_value_inr: total() });
    };
    T.get_order_summary = () => {
      S.readbackVersion = S.cartVersion;
      return log('get_order_summary', {}, { lines: S.cart.map(l => ({ sku_id: l.sku, product: l.name, quantity: l.qty, unit_price_inr: l.price, line_value_inr: l.qty * l.price })),
        order_value_inr: total(), note: 'Read every line and the total back to the retailer, then ask for explicit confirmation.' });
    };
    T.confirm_order = ({ retailer_confirmation }) => {
      if (!S.cart.length) return log('confirm_order', { retailer_confirmation }, { error: 'EMPTY_ORDER' });
      if (S.readbackVersion !== S.cartVersion) return log('confirm_order', { retailer_confirmation }, { error: 'READBACK_REQUIRED', message: 'The order changed after the last read-back. Call get_order_summary, read it back, and get a fresh yes.' });
      for (const l of S.cart) {
        const st = stockOf(idx, S.dist, l.sku);
        if (l.qty > st.available) return log('confirm_order', {}, { error: 'EXCEEDS_STOCK', sku_id: l.sku, available_units: st.available });
      }
      S.cart.forEach(l => { idx.reserved[S.dist + '|' + l.sku] = (idx.reserved[S.dist + '|' + l.sku] || 0) + l.qty; });
      const value = total();
      const typical = S.pref.Typical_Order_Value_INR;
      if (value > 2 * typical) S.events.push({ type: 'ANOMALY_REVIEW', detail: `Order value ${inr(value)} is more than 2x typical ${inr(typical)}; flagged for human check before dispatch` });
      S.order = {
        order_id: 'ORD-' + idx.callDate.replace(/-/g, '') + '-' + S.rid + '-' + String(idx.outbox.length + 1).padStart(3, '0'),
        call_id: S.callId, channel: 'AI_TELECALL', created_on: idx.callDate,
        retailer_id: S.rid, retailer_name: S.r.Retailer_Name, distributor_id: S.dist, language: S.lang || S.plan.language,
        lines: S.cart.map((l, i) => ({ line_no: i + 1, sku_id: l.sku, product: idx.products[l.sku].Product_Name, pack_size: idx.products[l.sku].Pack_Size,
          quantity: l.qty, selling_unit: l.unit, unit_price_inr: l.price, line_value_inr: l.qty * l.price, source: l.source })),
        order_value_inr: value, currency: 'INR', price_basis: 'Distributor_Billing_Price_INR',
        confirmation_status: 'CONFIRMED_BY_RETAILER', confirmation_utterance: retailer_confirmation || null,
        stock_snapshot_date: idx.snapshot, allocation: 'Reserved against snapshot; final allocation by distributor DMS',
        discount_applied_inr: 0
      };
      idx.outbox.push(S.order);
      S.outcome = 'ORDER_CONFIRMED';
      return log('confirm_order', { retailer_confirmation }, { ok: true, order_id: S.order.order_id, order_value_inr: value });
    };
    const ev = (type, name) => (args) => { const e = Object.assign({ type }, args || {}); S.events.push(e); return log(name, args || {}, { ok: true, recorded: type }); };
    T.schedule_callback = ev('CALLBACK_SCHEDULED', 'schedule_callback');
    T.log_complaint = (args) => { const id = 'CMP-' + S.rid + '-' + String(S.events.length + 1).padStart(2, '0'); S.events.push(Object.assign({ type: 'COMPLAINT', ticket: id }, args)); S.events.push({ type: 'HUMAN_ESCALATION', reason: 'Complaint routed to area sales officer', ticket: id }); return log('log_complaint', args, { ok: true, ticket: id }); };
    T.request_human = ev('HUMAN_ESCALATION', 'request_human');
    T.set_do_not_call = (args) => { S.events.push(Object.assign({ type: 'DNC_SET' }, args || {})); S.pref.Do_Not_Call_Flag = 'Yes'; return log('set_do_not_call', args || {}, { ok: true }); };
    T.log_market_insight = ev('MARKET_INSIGHT', 'log_market_insight');
    T.log_discount_request = ev('DISCOUNT_REQUEST', 'log_discount_request');
    T.log_backorder = ev('BACKORDER_FOLLOWUP', 'log_backorder');
    T.end_call = ({ outcome }) => { S.closed = true; S.outcome = S.outcome || outcome; return log('end_call', { outcome }, { ok: true, outcome: S.outcome }); };
    S.T = T;
    S.total = total;
    S.record = () => ({
      call_id: S.callId, retailer_id: S.rid, distributor_id: S.dist, outcome: S.outcome || 'IN_PROGRESS', identity_verified: S.identityVerified,
      order: S.order, events: S.events
    });
    return S;
  }

  function candidates(idx, seg, ctxBrand) {
    let brand = seg.brand || seg.variants.map(v => VARIANT_BRAND[v]).find(Boolean) || ctxBrand || null;
    let list = Object.values(idx.products).filter(p => !brand || p.Brand === brand);
    const v = seg.variants || [];
    const f = (pred) => { const x = list.filter(pred); if (x.length) list = x; };
    if (v.includes('gold')) f(p => /Gold/.test(p.Product_Name));
    if (v.includes('active')) f(p => /Active/.test(p.Product_Name));
    if (v.includes('oats') || v.includes('masala')) f(p => /Oats/.test(p.Product_Name));
    if (v.includes('masala')) f(p => /Masala/.test(p.Product_Name));
    if (v.includes('jasmine')) f(p => /Jasmine/.test(p.Product_Name));
    if (v.includes('amla')) f(p => /Amla/.test(p.Product_Name));
    if (v.includes('coconut')) f(p => /Coconut Oil/.test(p.Product_Name));
    if (v.includes('serum')) f(p => /Serum/.test(p.Product_Name));
    if (v.includes('styler')) f(p => /Styler/.test(p.Product_Name));
    if (v.includes('gel') && !v.includes('styler')) f(p => /Gel/.test(p.Product_Name) && !/Edible/.test(p.Product_Name));
    if (v.includes('deo')) f(p => /Deodorant/.test(p.Product_Name));
    if (!brand && !v.length && !seg.size) return [];
    if (brand === 'Parachute' && !v.includes('jasmine')) f(p => p.SKU_ID !== 'P005');
    if (seg.size) {
      const m = seg.size.v, u = seg.size.u;
      const x = list.filter(p => p.Pack_Measure === m && (p.Pack_Measure_Unit === u));
      list = x;
    }
    return list;
  }

  /* ------------------------------------------------------------------ */
  /* 4. DIALOGUE MANAGER (deterministic mode)                            */
  /* ------------------------------------------------------------------ */
  const GREET = { Hindi: 'Namaste', Gujarati: 'Namaste (નમસ્તે)', Marathi: 'Namaskar (नमस्कार)',
    Tamil: 'Vanakkam (வணக்கம்)', Telugu: 'Namaskaram (నమస్కారం)',
    Kannada: 'Namaskara (ನಮಸ್ಕಾರ)', Malayalam: 'Namaskaram (നമസ്കാരം)',
    Bengali: 'Nomoskar (নমস্কার)', Odia: 'Namaskar (ନମସ୍କାର)', Assamese: 'Nomoskar (নমস্কাৰ)' };

  const TX = {
    open: {
      hi: c => `${GREET[c.language] || 'Namaste'}! Main Marico ki AI sales assistant Asha bol rahi hoon. Kya meri baat ${c.shop} ke ${c.owner} ji se ho rahi hai? ${c.brands ? c.brands + ' ke order' : 'Order'} ke liye do minute chahiye the.`,
      en: c => `${GREET[c.language] || 'Hello'}! This is Asha, Marico's AI sales assistant. Am I speaking with ${c.owner} of ${c.shop}? I'd like two minutes for your ${c.brands ? c.brands + ' ' : ''}order.`
    },
    lead: {
      hi: c => `Dhanyavaad ${c.hon}! Pichhli baar aapne ${c.lines} liye the, ${c.days} din pehle. Is baar kitna bhejun?`,
      en: c => `Thank you, ${c.hon}! Last time you took ${c.lines}, ${c.days} days ago. How much should I send this time?`
    },
    leadBrand: {
      hi: c => `Ji ${c.hon}. ${c.brand} mein pichhli baar aapne ${c.lines} liye the. Is baar kitna order karna chahenge?`,
      en: c => `Sure, ${c.hon}. For ${c.brand}, last time you took ${c.lines}. How much would you like this time?`
    },
    added: { hi: c => `Theek hai, ${c.items} note kar liya. Aur kuch chahiye?`, en: c => `Done, I've noted ${c.items}. Anything else?` },
    updated: { hi: c => `Ji, ${c.item} ab ${c.qty} pieces kar diya. Aur kuch?`, en: c => `Sure, ${c.item} is now ${c.qty} pieces. Anything else?` },
    removed: { hi: c => `${c.item} hata diya. Aur kuch?`, en: c => `Removed ${c.item}. Anything else?` },
    askSize: { hi: c => `${c.brand} mein kaunsa size chahiye: ${c.options}?`, en: c => `Which ${c.brand} pack size: ${c.options}?` },
    askWhich: { hi: c => `Kaunsa chahiye: ${c.options}?`, en: c => `Which one: ${c.options}?` },
    shortSplit: { hi: c => `Theek hai, ${c.item} ke ${c.avail} pieces note kar liye aur baaki ${c.rest} ke liye follow-up rakh diya. Aur kuch chahiye?`, en: c => `Okay, ${c.avail} pieces of ${c.item} noted, and a follow-up is set for the other ${c.rest}. Anything else?` },
    askQty: { hi: c => `${c.item} ke kitne pieces bhejun?${c.last ? ` Pichhli baar ${c.last} liye the.` : ''}`, en: c => `How many pieces of ${c.item}?${c.last ? ` Last time you took ${c.last}.` : ''}` },
    askBox: {
      hi: c => `${c.n} ${c.n > 1 ? 'box' : 'box'} mein kitne pieces honge? Billing piece mein hoti hai aur ${c.item} ka box conversion mere paas confirm nahi hai, isliye pieces mein bata dijiye.`,
      en: c => `How many pieces would ${c.n} box${c.n > 1 ? 'es' : ''} be? We bill per piece and I don't have a confirmed box size for ${c.item}, so please tell me the number of pieces.`
    },
    confirmBoxCalc: { hi: c => `Yaani ${c.n} box x ${c.per} = ${c.total} pieces ${c.item}, sahi hai?`, en: c => `So ${c.n} boxes x ${c.per} = ${c.total} pieces of ${c.item}, correct?` },
    litreAmb: { hi: c => `${c.v} litre matlab ${c.a}, ya ${c.b}?`, en: c => `By ${c.v} litres, do you mean ${c.a}, or ${c.b}?` },
    vague: { hi: c => `Zaroor. Pichhli baar ${c.item} ke ${c.last} pieces gaye the. Is baar exact kitne pieces bhejun?`, en: c => `Sure. Last time ${c.item} was ${c.last} pieces. Exactly how many pieces should I send this time?` },
    vagueNoItem: { hi: () => `Zaroor. Kis product ke, aur exact kitne pieces bhejun?`, en: () => `Sure. For which product, and exactly how many pieces?` },
    short: {
      hi: c => `${c.item} ke abhi distributor ke paas sirf ${c.avail} pieces hain. Abhi ${c.avail} bhej doon aur baaki ${c.rest} ke liye follow-up rakhun, ya quantity badalni hai?`,
      en: c => `The distributor has only ${c.avail} pieces of ${c.item} right now. Shall I send ${c.avail} now and follow up for the other ${c.rest}, or change the quantity?`
    },
    oosAlt: {
      hi: c => `Maaf kijiye, ${c.item} abhi distributor ke paas out of stock hai. ${c.alt} available hai, chahein to woh le sakte hain, warna koi baat nahi.`,
      en: c => `Sorry, ${c.item} is out of stock at your distributor. ${c.alt} is available if you'd like it instead, no pressure.`
    },
    oosNoAlt: { hi: c => `Maaf kijiye, ${c.item} abhi out of stock hai. Stock aate hi hum aapko batayenge. Aur kuch?`, en: c => `Sorry, ${c.item} is out of stock right now. We'll let you know when it's back. Anything else?` },
    suggestRepl: { hi: c => `Ek chhota suggestion: aapke yahan ${c.item} bhi regularly jata hai, pichhli baar ${c.last} liye the. Is baar ${c.qty} bhej doon?`, en: c => `One small suggestion: ${c.item} sells regularly at your store, last time ${c.last}. Shall I add ${c.qty}?` },
    suggestTrade: { hi: c => `Ek suggestion: aap Parachute 200 ml lete hain. 500 ml par aapka margin ${c.m500} per bottle hai, 200 ml par ${c.m200}. Try ke liye 500 ml ke ${c.qty} pieces bhej doon?`, en: c => `A suggestion: you stock Parachute 200 ml. Your margin on 500 ml is ${c.m500} per bottle versus ${c.m200} on 200 ml. Shall I add ${c.qty} pieces of 500 ml as a trial?` },
    suggestNew: { hi: c => `Ek naya suggestion: ${c.item}. ${c.why} Trial ke liye ${c.qty} pieces bhej doon? Na kahein to bhi koi baat nahi.`, en: c => `One new idea: ${c.item}. ${c.why} Shall I add ${c.qty} pieces as a trial? No problem if not.` },
    declineOk: { hi: () => `Koi baat nahi.`, en: () => `No problem.` },
    readback: { hi: c => `Main order dohra deti hoon: ${c.lines}. Kul order value ${c.total}. Kya main ye order place kar doon?`, en: c => `Let me read back your order: ${c.lines}. Total ${c.total}. Shall I place this order?` },
    confirmed: { hi: c => `Dhanyavaad ${c.hon}! Aapka order ${c.oid} place ho gaya hai aur distributor ko bhej diya gaya hai. Aapka din shubh ho!`, en: c => `Thank you, ${c.hon}! Your order ${c.oid} is placed and sent to your distributor. Have a good day!` },
    whatChange: { hi: () => `Ji, bataiye kya badalna hai?`, en: () => `Sure, what would you like to change?` },
    busy: { hi: c => `Bilkul, koi baat nahi. Main aapko ${c.when} call karungi. Dhanyavaad!`, en: c => `Of course. I'll call you back ${c.when}. Thank you!` },
    notInterested: { hi: c => `Koi baat nahi, ${c.hon}. Samay dene ke liye dhanyavaad. Jab zarurat ho, hum hazir hain.`, en: c => `No problem, ${c.hon}. Thanks for your time. We're here whenever you need us.` },
    human: { hi: () => `Zaroor. Maine aapke area ke sales representative ko callback ke liye request bhej di hai, woh isi number par aapko call karenge. Tab tak kuch aur madad kar sakti hoon?`, en: () => `Of course. I've asked your area sales representative to call you back on this number. Is there anything else I can help with meanwhile?` },
    complaintAsk: { hi: c => `Maafi chahti hoon, ${c.hon}, aisa nahi hona chahiye tha. Kaunse product mein aur kitni quantity galat aayi thi?`, en: c => `I'm sorry about that, ${c.hon}; it shouldn't have happened. Which product was wrong, and by how much?` },
    complaintLogged: { hi: c => `${c.sorry ? 'Maafi chahti hoon, aisa nahi hona chahiye tha. ' : 'Dhanyavaad. '}Maine shikayat ${c.ticket} darj kar di hai aur area sales officer ko bhej di hai, woh aapse sampark karenge. Kya aaj ka order bhi le loon?`, en: c => `${c.sorry ? "I'm sorry, that shouldn't have happened. " : 'Thank you. '}I've logged complaint ${c.ticket} and sent it to the area sales officer, who will contact you. Would you also like to place today's order?` },
    discount: { hi: c => `Main koi extra discount ka vaada nahi kar sakti. ${c.item ? c.item + ' ka billing rate ' + c.price + ' hi hai. ' : ''}Aap chahein to main aapki request sales officer tak pahuncha deti hoon.`, en: c => `I can't promise any extra discount. ${c.item ? 'The billing rate for ' + c.item + ' is ' + c.price + '. ' : ''}If you like, I'll pass your request to the sales officer.` },
    discountAfter: { hi: () => `Theek hai, request bhej di. Order ke saath aage badhein?`, en: () => `Done, request passed on. Shall we continue with the order?` },
    dnc: { hi: () => `Samajh gayi. Aapka number do-not-call list mein daal diya hai, aage se aisi call nahi aayegi. Asuvidha ke liye maafi.`, en: () => `Understood. I've added your number to our do-not-call list; you won't get these calls again. Sorry for the trouble.` },
    wrongParty: { hi: () => `Maaf kijiye, shayad galat number lag gaya. Aapka samay lene ke liye maafi. Dhanyavaad!`, en: () => `Sorry, I may have the wrong number. Apologies for the trouble. Thank you!` },
    unclear: { hi: () => `Maaf kijiye, aawaz saaf nahi aayi. Product aur quantity ek baar phir bata denge?`, en: () => `Sorry, I didn't catch that clearly. Could you repeat the product and quantity?` },
    echo: { hi: c => `Kya aapne ${c.item} ke ${c.qty} pieces kaha?`, en: c => `Did you say ${c.qty} pieces of ${c.item}?` },
    insight: { hi: c => `Samajh gayi, jaankari ke liye shukriya, maine note kar liya hai. Koi baat nahi, aaj order zaroori nahi. Stock kam hone par phir baat karte hain. Dhanyavaad!`, en: () => `Understood, thanks for telling me; I've noted it. No need to order today. We'll speak again when stock runs low. Thank you!` },
    price: { hi: c => `${c.item}: billing rate ${c.bill}, MRP ${c.mrp}, yaani aapka margin ${c.margin} per piece.`, en: c => `${c.item}: billing rate ${c.bill}, MRP ${c.mrp}, so your margin is ${c.margin} per piece.` },
    sizes: { hi: c => `${c.brand} mein ye sizes hain: ${c.list}.`, en: c => `${c.brand} comes in: ${c.list}.` },
    noOrderClose: { hi: c => `Theek hai, aaj koi order nahi. Dhanyavaad ${c.hon}!`, en: c => `Alright, no order today. Thank you, ${c.hon}!` },
    fallback: { hi: () => `Maaf kijiye, main samajh nahi paayi. Product, size aur pieces bata dijiye, jaise "Parachute 500 ml ke 10".`, en: () => `Sorry, I didn't get that. Please tell me the product, size and pieces, for example "Parachute 500 ml, 10 pieces".` },
    offerHuman: { hi: () => `Lagta hai mujhe samajhne mein dikkat ho rahi hai. Kya main aapko sales representative se callback karwa doon?`, en: () => `I seem to be having trouble understanding. Shall I arrange a callback from a sales representative?` },
    closed: { hi: () => `Call samaapt ho chuki hai. Dhanyavaad!`, en: () => `This call has ended. Thank you!` },
    anythingElse: { hi: () => `Aur kuch chahiye?`, en: () => `Anything else?` },
    bigQty: { hi: c => `${c.item} ke ${c.qty} pieces? Ye aapke usual ${c.usual} se kaafi zyada hai, isliye confirm kar rahi hoon. ${c.qty} hi bhejun?`, en: c => `${c.qty} pieces of ${c.item}? That's well above your usual ${c.usual}, so just confirming. Shall I put ${c.qty}?` },
    objection: { hi: c => `Samajh sakti hoon. ${c.item ? c.item + ' par aapka margin ' + c.margin + ' per piece hai. ' : ''}Rate main kam nahi kar sakti, par chahein to is baar kam quantity rakh lijiye${c.lower ? ', jaise ' + c.lower + ' pieces' : ''}. Kitne bhejun?`,
      en: c => `I understand. ${c.item ? 'Your margin on ' + c.item + ' is ' + c.margin + ' per piece. ' : ''}I can't lower the rate, but you could take a smaller quantity this time${c.lower ? ', say ' + c.lower + ' pieces' : ''}. How many should I send?` },
    stockYes: { hi: c => `Ji, ${c.item} available hai${c.low ? ', par sirf ' + c.n + ' pieces bache hain' : ''}. Kitne bhejun?`, en: c => `Yes, ${c.item} is available${c.low ? ', but only ' + c.n + ' pieces are left' : ''}. How many should I send?` },
    stockNo: { hi: c => `Abhi ${c.item} distributor ke paas out of stock hai.${c.alt ? ' ' + c.alt + ' available hai.' : ''}`, en: c => `${c.item} is out of stock at your distributor right now.${c.alt ? ' ' + c.alt + ' is available.' : ''}` },
    terms: { hi: () => `Delivery aur payment aapke distributor ke normal schedule aur terms par hi hongi. Main alag se koi date ya credit promise nahi kar sakti; zarurat ho to sales officer se baat karwa deti hoon.`, en: () => `Delivery and payment follow your distributor's normal schedule and terms. I can't promise a separate date or credit; I can connect you to the sales officer if needed.` },
    whoAreYou: { hi: () => `Ji, main Marico ki AI sales assistant hoon, aapka order lene ke liye. Aap chahein to main kisi sales representative se aapki baat karwa sakti hoon.`, en: () => `Yes, I'm Marico's AI sales assistant, calling to take your order. If you prefer, I can arrange a call from a sales representative.` },
    cancelled: { hi: () => `Theek hai, order cancel kar diya, kuch nahi bheja jayega. Dhanyavaad!`, en: () => `Okay, I've cancelled it; nothing will be sent. Thank you!` },
    complaintAgain: { hi: c => `Ji, aapki shikayat ${c.ticket} pehle hi darj ho chuki hai, area sales officer aapse sampark karenge. Kya aaj ka order bhi le loon?`, en: c => `Yes, your complaint ${c.ticket} is already logged; the area sales officer will contact you. Shall I take today's order as well?` },
    idAgain: { hi: c => lowerAfterComma(c.pre, `Kya meri baat ${c.shop} ke ${c.owner} ji se ho rahi hai?`), en: c => lowerAfterComma(c.pre, `Am I speaking with ${c.owner} of ${c.shop}?`) },
    ownerAway: { hi: c => `Koi baat nahi. Main ${c.hon} se baad mein baat kar loongi, ${c.when} dobara call karungi. Dhanyavaad!`, en: c => `No problem. I'll call again ${c.when} to speak with ${c.hon}. Thank you!` },
    runningTotal: { hi: c => `Abhi tak ${c.lines}, kul ${c.total}. Aur kuch chahiye?`, en: c => `So far: ${c.lines}, total ${c.total}. Anything else?` },
    emptyTotal: { hi: () => `Abhi tak koi item note nahi hua. Bataiye, kya bhejun?`, en: () => `Nothing is noted yet. What should I send?` },
    leadAgain: { hi: c => `Ji. Pichhli baar aapne ${c.lines} liye the. Is baar kitna bhejun?`, en: c => `Sure. Last time you took ${c.lines}. How much should I send this time?` },
    finalQ: { hi: () => `Ji. Toh order final kar doon?`, en: () => `Sure. Shall I finalise the order then?` },
    whatElse: { hi: () => `Ji bataiye, aur kya bhejun?`, en: () => `Sure, what else should I add?` },
    shortAgain: { hi: c => `Maaf kijiye, ${c.item} ke abhi ${c.avail} pieces bhej doon, aur baaki ${c.rest} baad mein?`, en: c => `Sorry, shall I send ${c.avail} pieces of ${c.item} now, and the other ${c.rest} later?` }
  };
  // "Maaf kijiye, " + "Kya ..." -> "Maaf kijiye, kya ..."
  function lowerAfterComma(pre, q) { pre = pre || ''; return /, $/.test(pre) ? pre + q.charAt(0).toLowerCase() + q.slice(1) : pre + q; }

  function joinList(items, lang) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + (lang === 'hi' ? ' aur ' : ' and ') + items[items.length - 1];
  }
  const qtyPhrase = (name, q, lang) => { const u = q === 1 ? 'piece' : 'pieces'; return lang === 'hi' ? `${name} ke ${q} ${u}` : `${q} ${u} of ${name}`; };
  // "Parachute 500 ml ke 12 aur 200 ml ke 8 pieces" - drop the repeated brand on consecutive lines
  function linesPhrase(list, lang) {
    // only when both lines are the plain product: "Parachute Advansed Jasmine 200 ml ..., 200 ml ..." would sound like more Jasmine
    let prevBrand = null, prevPlain = false;
    const VARIANT = /Advansed|Gold|Active|Oats|Shanti|Coconut|Serum|Gel|Deo|Styler/;
    const parts = list.map(x => {
      const brand = (x.name.match(/^(Parachute|Saffola|Nihar|Livon|Set Wet)/) || [null])[0];
      const plain = !!brand && !VARIANT.test(x.name);
      const nm = plain && brand === prevBrand && prevPlain ? x.name.replace(brand + ' ', '') : x.name;
      prevBrand = brand; prevPlain = plain;
      return qtyPhrase(nm, x.qty, lang);
    });
    return joinList(parts, lang);
  }

  class Conversation {
    constructor(idx, rid, opts) {
      this.S = createSession(idx, rid, opts);
      this.idx = idx;
      const lang = this.S.plan.language;
      this.S.lang = lang === 'Hindi' ? 'hi' : (opts && opts.lang) || (lang === 'Hindi' ? 'hi' : 'en');
      if (['Marathi', 'Gujarati'].includes(lang) && !(opts && opts.lang)) this.S.lang = 'hi'; // Hindi widely understood; full regional language in Claude mode
      this.stage = 'identity';
      this.pending = null; this.ctxBrand = null; this.lastSku = null; this.suggested = false; this.misses = 0; this.asrMisses = 0;
      this.transcript = [];
      const surname = this.S.r.Owner_Name.split(' ').slice(-1)[0];
      this.hon = surname + ' ji';
    }
    t(key, c) { return TX[key][this.S.lang](Object.assign({ hon: this.hon }, c || {})); }
    say(text) { this.transcript.push({ who: 'agent', text, lang: this.S.lang }); const tools = this.S.toolLog.slice(this.mark || 0); this.mark = this.S.toolLog.length; return { text, lang: this.S.lang, stage: this.stage, closed: this.S.closed, record: this.S.record(), cart: this.S.cart.map(l => Object.assign({}, l)), tools }; }
    start() {
      const p = this.S.plan;
      const brands = joinList(p.brandsRanked.slice(0, 2), this.S.lang);
      return this.say(this.t('open', { language: p.language, shop: p.retailer.Retailer_Name, owner: p.retailer.Owner_Name, brands }));
    }
    close(key, c, outcome) { const out = this.say(this.t(key, c)); this.S.T.end_call({ outcome }); this.stage = 'closed'; out.closed = true; out.record = this.S.record(); return out; }

    hear(text, meta) {
      meta = meta || {};
      this.transcript.push({ who: 'retailer', text, confidence: meta.confidence });
      if (this.S.closed) return this.say(this.t('closed'));
      const conf = meta.confidence === undefined ? 1 : meta.confidence;
      const norm = normalize(text);
      if (conf < 0.55 || /\[(inaudible|unclear|noise)\]/.test(norm) || !norm) {
        this.asrMisses++;
        this.S.events.push({ type: 'LOW_CONFIDENCE_ASR', confidence: conf, heard: text });
        if (this.asrMisses >= 3) { this.S.T.request_human({ reason: 'Repeated unclear audio' }); return this.say(this.t('offerHuman')); }
        return this.say(this.t('unclear'));
      }
      const I = intents(norm);
      // language adaptation (keeps all context; only the reply language changes)
      const nTok = norm.split(' ').filter(w => /[a-z]/.test(w)).length;
      if (I.toEnglish || (this.S.lang === 'hi' && ((I.lang.en >= 3 && I.lang.en > 2 * I.lang.hi) || (I.lang.en >= 2 && I.lang.hi === 0 && nTok >= 3)))) this.S.lang = 'en';
      else if (I.toHindi || (this.S.lang === 'en' && ((I.lang.hi >= 3 && I.lang.hi > 2 * I.lang.en) || (I.lang.hi >= 2 && I.lang.en === 0 && nTok >= 3)))) this.S.lang = 'hi';

      // ---- global intents, any stage ----
      if (I.dnc) { this.S.T.set_do_not_call({ said: text }); return this.close('dnc', {}, 'DNC_SET'); }
      if (this.stage === 'identity' && I.ownerAway && !/\b(main hi|mai hi|speaking|bol raha|bol rahi)\b/.test(norm)) {
        const when = this.callbackWhen(I.time);
        this.S.T.schedule_callback({ when: when.iso, reason: 'Owner not available', said: text });
        this.S.events.push({ type: 'OWNER_UNAVAILABLE', note: 'No account data disclosed' });
        return this.close('ownerAway', { when: when.say }, 'CALLBACK_SCHEDULED');
      }
      const firstTok = norm.split(' ')[0];
      const startsNo = ['nahi', 'nahin', 'no', 'na', 'nope'].includes(firstTok);
      if (this.stage === 'identity' && (I.wrongParty || (startsNo && !I.busy) || (I.deny && !I.affirm && !I.busy) || / ji nahi hoon| nahi hoon\b/.test(' ' + norm))) {
        this.S.events.push({ type: 'WRONG_PARTY', note: 'No account data disclosed' });
        return this.close('wrongParty', {}, 'WRONG_PARTY');
      }
      if (I.human) { this.S.T.request_human({ reason: 'Retailer asked for a sales representative', said: text }); this.pending = null; this.stage = 'ordering'; this.humanAsked = true; return this.say(this.t('human')); }
      if (I.busy && !this.S.cart.length) {
        const when = this.callbackWhen(I.time);
        this.S.T.schedule_callback({ when: when.iso, reason: 'Retailer busy', said: text });
        return this.close('busy', { when: when.say }, 'CALLBACK_SCHEDULED');
      }
      if (this.stage === 'identity') {
        if (I.affirm || norm === 'ji' || firstTok === 'ji' || /^(yes|yeah|haan|ha|han)\b/.test(norm)) {
          this.S.T.verify_identity({ confirmed: true });
          this.S.T.get_retailer_context();
          this.stage = 'ordering';
          if (I.complaint) return this.startComplaint(text, norm);
          const segs = segments(norm).filter(s => s.brand || s.variants.length);
          const hasQty = segments(norm).some(s => s.nums.length);
          if (segs.length && !hasQty) return this.leadForBrand(segs[0].brand || VARIANT_BRAND[segs[0].variants[0]]);
          if (segs.length && hasQty) return this.handleItems(norm, I, text);
          return this.leadLines();
        }
        const hiL = this.S.lang === 'hi';
        const pre = I.whoAreYou ? (hiL ? 'Main Asha hoon, Marico ki AI sales assistant. Aapke order ke liye call kiya hai. ' : "I'm Asha, Marico's AI sales assistant, calling about your order. ")
          : I.toEnglish ? 'Sure. ' : I.toHindi ? 'Ji zaroor. ' : I.repeatLine ? '' : (hiL ? 'Maaf kijiye, ' : 'Sorry, ');
        return this.say(this.t('idAgain', { pre, shop: this.S.r.Retailer_Name, owner: this.S.r.Owner_Name }));
      }
      if (this.pending && this.pending.type === 'complaint') return this.finishComplaint(text, norm);
      if (I.complaint && !this.complained) return this.startComplaint(text, norm);
      if (I.complaint && this.complained && !this.segsHaveItems(norm)) { const ev = this.S.events.filter(e => e.type === 'COMPLAINT').slice(-1)[0]; return this.say(this.t('complaintAgain', { ticket: ev ? ev.ticket : '' })); }
      if (I.discount) {
        const sku = this.lastSku || (this.S.cart[0] && this.S.cart[0].sku);
        const p = sku && this.idx.products[sku];
        this.S.T.log_discount_request({ said: text, sku_id: sku || null, granted: false });
        return this.say(this.t('discount', p ? { item: p.Short, price: inr(p.Distributor_Billing_Price_INR) } : {}));
      }
      if (I.repeatLine && !this.segsHaveItems(norm)) { const last = this.transcript.filter(t => t.who === 'agent').slice(-1)[0]; return this.say(last ? last.text : this.t('anythingElse')); }
      if (I.whoAreYou && !this.segsHaveItems(norm)) return this.say(this.t('whoAreYou'));
      if (I.cancelOrder && !this.S.order) {
        this.S.cart.slice().forEach(l => this.S.T.remove_item({ sku_id: l.sku }));
        this.S.events.push({ type: 'NO_ORDER', reason: 'Retailer cancelled before confirmation' });
        return this.close('cancelled', {}, 'NO_ORDER');
      }
      if (I.terms && !this.segsHaveItems(norm)) {
        if (/udhaar|udhar|credit|paise baad/.test(norm)) this.S.T.log_discount_request({ said: text, kind: 'credit_terms', granted: false });
        return this.say(this.t('terms'));
      }
      if (I.objection && !this.segsHaveItems(norm, true)) {
        const seg = segments(norm)[0];
        const c = seg && (seg.brand || seg.variants.length) ? this.resolve(seg).cands : [];
        const sku = (c.length === 1 && c[0].SKU_ID) || this.lastSku || (this.S.plan.lead[0] && this.S.plan.lead[0].sku);
        const p = sku && this.idx.products[sku];
        const b = sku && this.S.plan.basket.find(x => x.sku === sku);
        this.S.events.push({ type: 'OBJECTION', said: text, sku_id: sku || null });
        if (sku) { this.lastSku = sku; this.pending = { type: 'qty', sku }; }
        return this.say(this.t('objection', p ? { item: p.Short, margin: inr(p.MRP_INR - p.Distributor_Billing_Price_INR), lower: b && b.suggestedQty > 2 ? Math.max(1, Math.round(b.suggestedQty / 2)) : null } : {}));
      }
      if (I.stockQ && !this.segsHaveItems(norm)) {
        const seg = segments(norm)[0];
        let c = seg && (seg.brand || seg.variants.length || seg.size) ? this.resolve(seg).cands : [];
        if (seg && seg.litreNums.length) { const byL = c.filter(p => p.Pack_Measure === seg.litreNums[0] * 1000); if (byL.length) c = byL; }
        if (c.length === 1) {
          const r = this.S.T.check_stock({ sku_id: c[0].SKU_ID });
          this.lastSku = c[0].SKU_ID;
          if (r.available_units > 0) { this.pending = { type: 'qty', sku: c[0].SKU_ID }; return this.say(this.t('stockYes', { item: c[0].Short, n: r.available_units, low: r.available_units <= 15 })); }
          return this.say(this.t('stockNo', { item: c[0].Short, alt: r.in_stock_alternative && r.in_stock_alternative.product }) + ' ' + this.t('anythingElse'));
        }
        if (c.length > 1) { this.pending = { type: 'size', options: c.slice(0, 4).map(p => p.SKU_ID) }; return this.say(this.t('askSize', { brand: c[0].Brand, options: this.sizeOptions(c[0].Brand, c.slice(0, 4)) })); }
      }
      if ((I.stockedUp || I.competitor) && !this.S.cart.length && !segments(norm).some(s => (s.brand || s.variants.length) && s.nums.length)) {
        if (I.competitor) this.S.T.log_market_insight({ said: text, kind: 'competitor_activity' });
        else this.S.T.log_market_insight({ said: text, kind: 'stocked_up' });
        this.S.events.push({ type: 'NO_ORDER', reason: 'Retailer stocked up' });
        return this.close('insight', {}, 'NO_ORDER_INSIGHT');
      }
      if (I.notInterested && !this.S.cart.length && !this.pending) {
        this.S.events.push({ type: 'NO_ORDER', reason: 'Retailer declined' });
        return this.close('notInterested', {}, 'NO_ORDER');
      }
      if (I.totalQ && !this.segsHaveItems(norm)) {
        if (!this.S.cart.length) return this.say(this.t('emptyTotal'));
        const sum = this.S.T.get_order_summary();
        return this.say(this.t('runningTotal', { lines: linesPhrase(sum.lines.map(l => ({ name: l.product, qty: l.quantity })), this.S.lang), total: inr(sum.order_value_inr) }));
      }
      if (I.price || I.sizes) { const r = this.answerInfo(norm, I); if (r) return r; }

      // ---- pending clarifications ----
      if (this.pending) { const r = this.resolvePending(norm, I, text, conf); if (r) return r; }

      // ---- readback stage ----
      if (this.stage === 'readback') {
        if (I.affirm && !I.deny && !segments(norm).some(s => s.nums.length || s.rejected.length)) return this.confirm(text);
        if (I.deny && !segments(norm).some(s => s.nums.length || s.brand || s.size)) { this.stage = 'ordering'; return this.say(this.t('whatChange')); }
      }
      // ---- vague quantity ----
      if (I.vague) {
        const seg = segments(norm)[0];
        const rc = seg && (seg.brand || seg.variants.length || seg.size) ? this.resolve(seg).cands : [];
        const sku = (rc.length === 1 && rc[0].SKU_ID) || this.lastSku || (this.ctxBrand && this.S.plan.lead[0] && this.S.plan.lead[0].sku);
        const h = sku && (this.idx.history[this.S.rid] || []).find(x => x.SKU_ID === sku);
        this.pending = { type: 'qty', sku };
        if (sku && h) return this.say(this.t('vague', { item: this.idx.products[sku].Short, last: h.Last_Order_Qty }));
        return this.say(this.t('vagueNoItem'));
      }
      if (I.sameAsLast) return this.repeatLast();
      // ---- items ----
      const segs = segments(norm);
      if (segs.some(s => s.brand || s.variants.length || s.size || s.nums.length || s.litreNums.length)) {
        const r = this.handleItems(norm, I, text, conf);
        if (r) return r;
      }
      if (I.remove && this.lastSku) { const p = this.idx.products[this.lastSku]; this.S.T.remove_item({ sku_id: this.lastSku }); return this.say(this.t('removed', { item: p.Short })); }
      // ---- done / suggestion / readback ----
      if (I.affirm && !I.deny && this.S.cart.length && this.stage === 'ordering' && this.S.readbackVersion >= 0) {
        if (this.S.readbackVersion === this.S.cartVersion && /place|confirm|go ahead|bhej do|bhej dijiye|order kar do|book kar do/.test(norm)) return this.confirm(text);
        return this.readback();
      }
      if (I.done || (I.deny && this.stage === 'ordering') || (this.humanAsked && I.deny)) return this.afterDone();
      const finalWords = /\bbhej (do|dijiye|dena|dijie)\b|\bbas bhej\b|\bsend it\b|\bconfirm\b|\bplace\b|\bfinal\b|\bbook kar\b|\border kar do\b/.test(norm);
      if (this.stage === 'ordering' && this.S.cart.length && !this.pending && finalWords) return this.afterDone();
      if (this.stage === 'ordering' && !this.S.cart.length && finalWords && this.leadDone) return this.say(this.t('emptyTotal'));
      if (this.stage === 'ordering' && this.S.cart.length && !this.pending && I.affirm && !I.deny) { this.pending = { type: 'finalQ' }; return this.say(this.t('finalQ')); }
      if (I.affirm && this.stage === 'ordering' && !this.S.cart.length) return this.leadLines();
      if (I.affirm && this.stage === 'ordering' && this.complained) return this.leadLines();
      this.misses++;
      if (this.misses >= 2) { this.pending = { type: 'offerHuman' }; return this.say(this.t('offerHuman')); }
      return this.say(this.t('fallback'));
    }

    segsHaveItems(norm, needQty) { return segments(norm).some(sg => (sg.brand || sg.variants.length || sg.size) && (needQty ? sg.nums.length > 0 : sg.nums.length > 0)); }
    callbackWhen(t) {
      const [ws] = this.S.pref.Preferred_Calling_Window.split('-');
      if (!t) t = { hour: parseInt(ws, 10), tomorrow: false };
      const d = new Date(Date.parse(this.idx.callDate) + (t.tomorrow ? DAY : 0));
      const hh = t.hour === null ? parseInt(ws, 10) : t.hour;
      const iso = d.toISOString().slice(0, 10) + 'T' + String(hh).padStart(2, '0') + ':00';
      const h12 = hh > 12 ? hh - 12 : hh;
      const say = this.S.lang === 'hi' ? `${t.tomorrow ? 'kal ' : 'aaj '}${hh >= 16 ? 'shaam' : (hh >= 12 ? 'dopahar' : 'subah')} ${h12} baje` : `${t.tomorrow ? 'tomorrow' : 'today'} at ${h12} ${hh >= 12 ? 'PM' : 'AM'}`;
      return { iso, say };
    }

    leadLines() {
      const p = this.S.plan;
      if (!p.lead.length) return this.say(this.t('anythingElse'));
      this.ctxBrand = p.lead[0].brand;
      const lines = linesPhrase(p.lead.map(b => ({ name: b.name, qty: b.lastQty })), this.S.lang);
      const key = this.leadDone ? 'leadAgain' : 'lead'; this.leadDone = true;
      return this.say(this.t(key, { lines, days: p.daysSince }));
    }
    leadForBrand(brand) {
      this.ctxBrand = brand;
      const lines = this.S.plan.basket.filter(b => b.brand === brand && !b.lapsed).slice(0, 2);
      if (!lines.length) return this.say(this.t('askSize', { brand, options: this.sizeOptions(brand) }));
      return this.say(this.t('leadBrand', { brand, lines: linesPhrase(lines.map(b => ({ name: b.name.replace(new RegExp('^' + brand + ' '), '') || b.name, qty: b.lastQty })), this.S.lang) }));
    }
    sizeOptions(brand, list) {
      const ps = list || Object.values(this.idx.products).filter(p => p.Brand === brand);
      return joinList(ps.map(p => p.Short.replace(brand + ' ', '')), this.S.lang === 'hi' ? 'hi' : 'en').replace(' aur ', ' ya ').replace(' and ', ' or ');
    }
    resolve(seg) {
      const hist = this.idx.history[this.S.rid] || [];
      let c = candidates(this.idx, seg, this.ctxBrand);
      // bare number like "500" that matches a pack measure, when another qty number exists
      if (!seg.size && seg.nums.length >= 2) {
        const measures = new Set(c.map(p => p.Pack_Measure));
        const i = seg.nums.findIndex(x => !x.unit && measures.has(x.n));
        if (i >= 0) { const m = seg.nums[i].n; seg.nums.splice(i, 1); c = c.filter(p => p.Pack_Measure === m); }
      }
      if (!c.length && !seg.brand && !(seg.variants || []).length && (seg.size || seg.sizeWord)) {
        const any = candidates(this.idx, seg, null);
        const bought = new Set(hist.map(h => h.SKU_ID));
        const inHist = any.filter(p => bought.has(p.SKU_ID));
        c = inHist.length ? inHist : any;
        const lines = new Set(this.S.cart.map(l => this.idx.products[l.sku].Product_Name));
        const sameLine = c.filter(p => lines.has(p.Product_Name));
        if (sameLine.length === 1) c = sameLine;
      }
      if (seg.sizeWord && c.length > 1) {
        const sorted = c.slice().sort((a, b) => a.Pack_Measure - b.Pack_Measure);
        const half = Math.max(1, Math.floor(sorted.length / 2));
        c = seg.sizeWord === 'small' ? sorted.slice(0, half) : sorted.slice(-1);
      }
      return { cands: c, hist };
    }
    handleItems(norm, I, text, conf) {
      conf = conf === undefined ? 1 : conf;
      const segs = segments(norm);
      const notes = [], questions = [];
      let updates = 0, removed = 0;
      let lastBrand = this.ctxBrand;
      for (const seg of segs) {
        if (!seg.brand && !seg.variants.length && !seg.size && !seg.nums.length && !seg.litreNums.length && !seg.rejected.length) continue;
        if (seg.brand) lastBrand = seg.brand; else if (seg.variants.length) lastBrand = VARIANT_BRAND[seg.variants[0]] || lastBrand;
        const ctxSave = this.ctxBrand; this.ctxBrand = lastBrand;
        // quantity-only utterance ("15", "10 nahi 15 kar do") -> applies to the last touched line
        if (!seg.brand && !seg.variants.length && !seg.size && !seg.sizeWord && !seg.litreNums.length && seg.nums.length && this.lastSku) {
          const q = seg.nums[seg.nums.length - 1];
          const r = this.applyQty(this.lastSku, q, conf, text);
          if (r.question) { questions.push(r.question); break; }
          notes.push(r.note); if (r.updated) updates++; continue;
        }
        let { cands } = this.resolve(seg);
        // volume quantities: "Saffola Gold 10 litre"
        if (seg.litreNums.length) {
          const L = seg.litreNums[0];
          if (seg.nums.length) { cands = cands.filter(p => p.Pack_Measure === L * 1000); }
          else {
            const exact = cands.filter(p => p.Pack_Measure === L * 1000);
            const divisible = cands.filter(p => p.Pack_Measure_Unit === 'ml' && (L * 1000) % p.Pack_Measure === 0 && p.Pack_Measure < L * 1000);
            if (exact.length && divisible.length) {
              const small = divisible.sort((a, b) => b.Pack_Measure - a.Pack_Measure)[0];
              this.pending = { type: 'litreChoice', options: [{ sku: exact[0].SKU_ID, qty: 1 }, { sku: small.SKU_ID, qty: L * 1000 / small.Pack_Measure }] };
              questions.push(this.t('litreAmb', { v: L, a: qtyPhrase(exact[0].Short, 1, this.S.lang), b: qtyPhrase(small.Short, L * 1000 / small.Pack_Measure, this.S.lang) }));
              break;
            }
            if (exact.length === 1) { cands = exact; }
            else if (divisible.length) {
              const bought = new Set(this.idx.history[this.S.rid].map(h => h.SKU_ID));
              const pref = divisible.filter(p => bought.has(p.SKU_ID));
              const pick = pref.length === 1 ? pref[0] : (divisible.length === 1 ? divisible[0] : null);
              if (pick) { seg.nums = [{ n: L * 1000 / pick.Pack_Measure, unit: 'piece', fromLitres: L }]; cands = [pick]; }
              else {
                this.pending = { type: 'size', options: divisible.map(p => p.SKU_ID), litres: L };
                questions.push(this.t('askSize', { brand: lastBrand || divisible[0].Brand, options: this.sizeOptions(divisible[0].Brand, divisible) }));
                break;
              }
            }
          }
        }
        if (!cands.length) { if (seg.brand || seg.variants.length || seg.size) { questions.push(this.t('fallback')); break; } continue; }
        const qtyTok = seg.nums.length ? seg.nums[seg.nums.length - 1] : null;
        if (I.remove && !qtyTok) {
          const inCart = cands.filter(p => this.S.cart.some(l => l.sku === p.SKU_ID));
          if (inCart.length === 1) { this.S.T.remove_item({ sku_id: inCart[0].SKU_ID }); notes.push(this.S.lang === 'hi' ? `${inCart[0].Short} hata diya` : `removed ${inCart[0].Short}`); removed++; continue; }
        }
        if (cands.length > 1) {
          const bought = new Set((this.idx.history[this.S.rid] || []).map(h => h.SKU_ID));
          const inHist = cands.filter(p => bought.has(p.SKU_ID));
          const explicitSmall = seg.sizeWord;
          if (!explicitSmall && !seg.size && inHist.length === 1 && cands.length - inHist.length <= 3 && !seg.variants.includes('gel')) cands = inHist;
          else {
            const opts = cands.slice(0, 4);
            this.pending = { type: 'size', options: opts.map(p => p.SKU_ID), qty: qtyTok };
            if (new Set(opts.map(p => p.Brand)).size > 1) questions.push(this.t('askWhich', { options: joinList(opts.map(p => p.Short), this.S.lang).replace(' aur ', ' ya ').replace(' and ', ' or ') }));
            else questions.push(this.t('askSize', { brand: opts[0].Brand, options: this.sizeOptions(opts[0].Brand, opts) }));
            break;
          }
        }
        const sku = cands[0].SKU_ID;
        this.lastSku = sku; this.ctxBrand = cands[0].Brand;
        if (!qtyTok) {
          const h = (this.idx.history[this.S.rid] || []).find(x => x.SKU_ID === sku);
          this.pending = { type: 'qty', sku };
          questions.push(this.t('askQty', { item: cands[0].Short, last: h && h.Last_Order_Qty }));
          break;
        }
        const r = this.applyQty(sku, qtyTok, conf, text);
        if (r.question) { questions.push(r.question); break; }
        notes.push(r.note); if (r.updated) updates++;
        this.ctxBrand = ctxSave === null ? cands[0].Brand : cands[0].Brand;
      }
      if (!notes.length && !questions.length) return null;
      this.misses = 0;
      if (this.stage === 'readback' && !questions.length) return this.readback();
      const done = I.done && !questions.length;
      let msg = '';
      const added = notes.filter(Boolean);
      if (added.length && !done) msg = removed && added.length === removed ? (this.S.lang === 'hi' ? `Theek hai, ${joinList(added, 'hi')}. Aur kuch?` : `Okay, ${joinList(added, 'en')}. Anything else?`) : (updates === 1 && added.length === 1 && this.lastUpdate) ? this.t('updated', this.lastUpdate) : this.t('added', { items: joinList(added, this.S.lang) });
      if (questions.length) msg = (added.length ? (this.S.lang === 'hi' ? `${joinList(added, 'hi')} note kar liya. ` : `Noted ${joinList(added, 'en')}. `) : '') + questions[0];
      if (done) return this.afterDone(added.length ? (this.S.lang === 'hi' ? `${joinList(added, 'hi')} note kar liya. ` : `Noted ${joinList(added, 'en')}. `) : '');
      return this.say(msg);
    }
    applyQty(sku, qtyTok, conf, text) {
      const p = this.idx.products[sku];
      let q = qtyTok.n, unit = qtyTok.unit;
      if (unit === 'dozen') { q = q * 12; unit = 'piece'; }
      if (unit === 'box') {
        this.pending = { type: 'box', sku, n: q };
        return { question: this.t('askBox', { n: q, item: p.Short }) };
      }
      if (!Number.isInteger(q) || q <= 0) { this.pending = { type: 'qty', sku }; return { question: this.t('askQty', { item: p.Short }) }; }
      if (conf < 0.8) { this.pending = { type: 'echo', sku, qty: q }; return { question: this.t('echo', { item: p.Short, qty: q }) }; }
      return this.addLine(sku, q, this.pendingSource || 'retailer_request');
    }
    addLine(sku, q, source, bigOk) {
      const p = this.idx.products[sku];
      const h = (this.idx.history[this.S.rid] || []).find(x => x.SKU_ID === sku);
      const usual = h ? Math.max(h.Last_Order_Qty, h.Previous_Order_Qty) : null;
      if (!bigOk && usual && q > 3 * usual && q > 10) {
        this.pending = { type: 'bigConfirm', sku, qty: q, source };
        return { question: this.t('bigQty', { item: p.Short, qty: q, usual }) };
      }
      const existing = this.S.cart.find(l => l.sku === sku);
      const res = this.S.T.add_or_update_item({ sku_id: sku, quantity: q, unit: 'piece', source: existing ? existing.source : source });
      if (res.error === 'OUT_OF_STOCK') {
        if (res.in_stock_alternative) { this.pending = { type: 'alt', sku: res.in_stock_alternative.sku_id, from: sku, qty: q }; return { question: this.t('oosAlt', { item: p.Short, alt: res.in_stock_alternative.product }) }; }
        return { question: this.t('oosNoAlt', { item: p.Short }) };
      }
      if (res.error === 'EXCEEDS_STOCK') {
        this.pending = { type: 'stock', sku, requested: q, avail: res.available_units };
        return { question: this.t('short', { item: p.Short, avail: res.available_units, rest: q - res.available_units }) };
      }
      if (res.error) return { question: this.t('fallback') };
      this.lastSku = sku;
      if (res.action === 'updated') { this.lastUpdate = { item: p.Short, qty: q }; return { note: this.S.lang === 'hi' ? `${p.Short} ab ${q} pieces` : `${p.Short} now ${q} pieces`, updated: true }; }
      return { note: qtyPhrase(p.Short, q, this.S.lang) };
    }
    resolvePending(norm, I, text, conf) {
      const P = this.pending;
      const segs = segments(norm);
      const nums = segs.reduce((a, s) => a.concat(s.nums), []);
      const lastNum = nums.length ? nums[nums.length - 1] : null;
      if (P.type === 'qty' && P.sku) {
        if (lastNum && !segs.some(s => s.brand && candidates(this.idx, s, null).every(c => c.SKU_ID !== P.sku))) {
          this.pending = null; const r = this.applyQty(P.sku, lastNum, conf, text);
          if (r.question) return this.say(r.question);
          return this.say(this.t('added', { items: r.note }));
        }
        if (I.sameAsLast) {
          const h = (this.idx.history[this.S.rid] || []).find(x => x.SKU_ID === P.sku);
          if (h && h.Last_Order_Qty > 0) { this.pending = null; const r = this.applyQty(P.sku, { n: h.Last_Order_Qty, unit: 'piece' }, conf, text); if (r.question) return this.say(r.question); return this.say(this.t('added', { items: r.note })); }
        }
        if (I.vague) { const h = (this.idx.history[this.S.rid] || []).find(x => x.SKU_ID === P.sku); return this.say(this.t('vague', { item: this.idx.products[P.sku].Short, last: h ? h.Last_Order_Qty : '-' })); }
        if (I.deny && !lastNum) { this.pending = null; return this.say(this.t('anythingElse')); }
        return null;
      }
      if (P.type === 'size') {
        const opts = P.options.map(s => this.idx.products[s]);
        let pick = null;
        const seg = segs[0] || {};
        const sizeN = seg.size ? seg.size.v : (seg.litreNums && seg.litreNums.length ? seg.litreNums[0] * 1000 : null);
        if (sizeN) pick = opts.find(p => p.Pack_Measure === sizeN);
        if (!pick && nums.length) pick = opts.find(p => nums.some(x => x.n === p.Pack_Measure));
        if (!pick && /pehla|pehle|first|1st/.test(norm)) pick = opts[0];
        if (!pick && /doosra|dusra|second|2nd/.test(norm)) pick = opts[1];
        if (!pick && seg.sizeWord === 'small') pick = opts.slice().sort((a, b) => a.Pack_Measure - b.Pack_Measure)[0];
        if (!pick && seg.sizeWord === 'large') pick = opts.slice().sort((a, b) => b.Pack_Measure - a.Pack_Measure)[0];
        if (!pick && seg.variants && seg.variants.length) { const c = candidates(this.idx, seg, this.ctxBrand).filter(p => P.options.includes(p.SKU_ID)); if (c.length === 1) pick = c[0]; }
        if (!pick) return null;
        this.pending = null; this.lastSku = pick.SKU_ID; this.ctxBrand = pick.Brand;
        let qtok = P.qty || nums.find(x => x.n !== pick.Pack_Measure) || null;
        if (P.litres) qtok = { n: P.litres * 1000 / pick.Pack_Measure, unit: 'piece' };
        if (!qtok) { const h = (this.idx.history[this.S.rid] || []).find(x => x.SKU_ID === pick.SKU_ID); this.pending = { type: 'qty', sku: pick.SKU_ID }; return this.say(this.t('askQty', { item: pick.Short, last: h && h.Last_Order_Qty })); }
        const r = this.applyQty(pick.SKU_ID, qtok, conf, text);
        if (r.question) return this.say(r.question);
        return this.say(this.t('added', { items: r.note }));
      }
      if (P.type === 'litreChoice') {
        let pick = null;
        if (/jar|ek|one|1|bada|badi|big/.test(norm) && !/pouch/.test(norm)) pick = P.options[0];
        if (/pouch|packet|chhot|small/.test(norm)) pick = P.options[1];
        if (!pick && nums.length === 1 && !nums[0].unit) pick = { sku: P.options[0].sku, qty: nums[0].n };
        else if (pick && nums.length && pick === P.options[0] && nums[nums.length - 1].n > 1) pick = { sku: P.options[0].sku, qty: nums[nums.length - 1].n };
        if (!pick) return null;
        this.pending = null;
        const r = this.addLine(pick.sku, pick.qty, 'retailer_request');
        if (r.question) return this.say(r.question);
        return this.say(this.t('added', { items: r.note }));
      }
      if (P.type === 'box') {
        const p = this.idx.products[P.sku];
        const boxWord = /\b(box|boxes|dabba|dabbe|peti|carton|cartons|case|cases)\b/.test(norm);
        const convWord = /\b(mein|me|in|per|har|each)\b/.test(norm);
        const pieceTok = nums.find(x => x.unit === 'piece') || (nums.length === 1 && !nums[0].unit && !(boxWord && convWord) ? nums[0] : null);
        if (pieceTok) {
          this.pending = null; const r = this.addLine(P.sku, pieceTok.n, 'retailer_request');
          if (r.question) return this.say(r.question);
          return this.say(this.t('added', { items: r.note }));
        }
        // retailer states the conversion himself: "ek box mein 24" -> compute but confirm, never assume
        const per = nums.find(x => x.n > 1 && x.unit !== 'box');
        if (per && convWord) {
          this.pending = { type: 'boxConfirm', sku: P.sku, total: P.n * per.n };
          return this.say(this.t('confirmBoxCalc', { n: P.n, per: per.n, total: P.n * per.n, item: p.Short }));
        }
        if (/pata nahi|nahi pata|maloom nahi|malum nahi|dont know|don't know|not sure|idea nahi/.test(norm) || (I.deny && !nums.length)) {
          const h = (this.idx.history[this.S.rid] || []).find(x => x.SKU_ID === P.sku);
          this.pending = { type: 'qty', sku: P.sku };
          return this.say((this.S.lang === 'hi' ? 'Koi baat nahi. ' : 'No problem. ') + this.t('askQty', { item: p.Short, last: h && h.Last_Order_Qty }));
        }
        return this.say(this.t('askBox', { n: P.n, item: p.Short }));
      }
      if (P.type === 'boxConfirm') {
        if (I.affirm && !I.deny) { this.pending = null; const r = this.addLine(P.sku, P.total, 'retailer_request'); if (r.question) return this.say(r.question); return this.say(this.t('added', { items: r.note })); }
        if (lastNum) { this.pending = null; const r = this.addLine(P.sku, lastNum.n, 'retailer_request'); if (r.question) return this.say(r.question); return this.say(this.t('added', { items: r.note })); }
        this.pending = { type: 'box', sku: P.sku, n: 1 }; return this.say(this.t('askQty', { item: this.idx.products[P.sku].Short }));
      }
      if (P.type === 'echo') {
        if (I.affirm && !I.deny) { this.pending = null; const r = this.addLine(P.sku, P.qty, 'retailer_request'); if (r.question) return this.say(r.question); return this.say(this.t('added', { items: r.note })); }
        this.pending = null;
        if (lastNum || segs.some(s => s.brand)) return null;
        return this.say(this.t('unclear'));
      }
      if (P.type === 'bigConfirm') {
        if (lastNum && lastNum.n !== P.qty) { this.pending = null; const r = this.addLine(P.sku, lastNum.unit === 'dozen' ? lastNum.n * 12 : lastNum.n, P.source); return this.say(r.question || this.t('added', { items: r.note })); }
        if (I.affirm && !I.deny || lastNum) { this.pending = null; const r = this.addLine(P.sku, P.qty, P.source, true); return this.say(r.question || this.t('added', { items: r.note })); }
        if (I.deny) { this.pending = { type: 'qty', sku: P.sku }; return this.say(this.t('askQty', { item: this.idx.products[P.sku].Short })); }
        return null;
      }
      if (P.type === 'stock') {
        const p = this.idx.products[P.sku];
        if (/follow|baaki|baad mein|baad me|later|split|rest/.test(norm) || (I.affirm && !lastNum)) {
          this.pending = null;
          const r = this.addLine(P.sku, P.avail, 'retailer_request', true);
          if (r.question) return this.say(r.question);
          this.S.T.log_backorder({ sku_id: P.sku, quantity: P.requested - P.avail, note: 'Balance to follow when distributor restocks' });
          return this.say(this.t('shortSplit', { item: p.Short, avail: P.avail, rest: P.requested - P.avail }));
        }
        if (lastNum) { this.pending = null; const r = this.addLine(P.sku, lastNum.n, 'retailer_request', true); if (r.question) return this.say(r.question); return this.say(this.t('added', { items: r.note })); }
        if (I.done && !I.deny) { this.pending = null; const r = this.addLine(P.sku, P.avail, 'retailer_request', true); if (r.question) return this.say(r.question); return this.say(this.t('added', { items: r.note })); }
        if (I.deny) { this.pending = null; return this.say(this.t('declineOk') + ' ' + this.t('anythingElse')); }
        return this.say(this.t('shortAgain', { item: p.Short, avail: P.avail, rest: P.requested - P.avail }));
      }
      if (P.type === 'alt') {
        const p = this.idx.products[P.sku];
        if (I.affirm && !I.deny) {
          this.pending = null; this.lastSku = P.sku;
          if (lastNum) { const r = this.addLine(P.sku, lastNum.n, 'agent_alternative'); return this.say(r.question || this.t('added', { items: r.note })); }
          this.pending = { type: 'qty', sku: P.sku }; this.pendingSource = 'agent_alternative';
          return this.say(this.t('askQty', { item: p.Short }));
        }
        if (I.deny) { this.pending = null; return this.say(this.t('declineOk') + ' ' + this.t('anythingElse')); }
        return null;
      }
      if (P.type === 'suggest') {
        const p = this.idx.products[P.sku];
        if (I.affirm && !I.deny || lastNum || segs.some(s => s.litreNums.length)) {
          this.pending = null;
          let q = P.qty;
          const seg = segs.find(s => s.litreNums.length);
          if (seg && p.Pack_Measure_Unit === 'ml' && (seg.litreNums[0] * 1000) % p.Pack_Measure === 0) q = seg.litreNums[0] * 1000 / p.Pack_Measure;
          else if (lastNum) {
            if (lastNum.unit === 'box') { this.pending = { type: 'box', sku: P.sku, n: lastNum.n }; return this.say(this.t('askBox', { n: lastNum.n, item: p.Short })); }
            q = lastNum.unit === 'dozen' ? lastNum.n * 12 : lastNum.n;
          }
          const r = this.addLine(P.sku, q, P.source);
          if (r.question) return this.say(r.question);
          return this.readback(this.S.lang === 'hi' ? `${r.note} add kar diya. ` : `Added ${r.note}. `);
        }
        if (I.deny || I.done) { this.pending = null; this.S.events.push({ type: 'SUGGESTION_DECLINED', sku_id: P.sku }); return this.readback(this.t('declineOk') + ' '); }
        return null;
      }
      if (P.type === 'finalQ') {
        this.pending = null;
        const items = segs.some(s => s.nums.length || s.brand || s.variants.length);
        if (I.affirm && !I.deny && !items) return this.afterDone();
        if (I.deny && !items) return this.say(this.t('whatElse'));
        return null;
      }
      if (P.type === 'offerHuman') {
        this.pending = null;
        if (I.affirm) { this.S.T.request_human({ reason: 'Agent could not understand retailer' }); return this.close('human', {}, 'ESCALATED'); }
        this.misses = 0; return this.say(this.t('fallback'));
      }
      return null;
    }
    startComplaint(text, norm) {
      this.complained = true;
      const segs = segments(norm || '');
      if (segs.some(s => (s.brand || s.variants.length) && (s.nums.length || s.rejected.length))) return this.finishComplaint(text, norm);
      this.pending = { type: 'complaint' };
      return this.say(this.t('complaintAsk'));
    }
    finishComplaint(text, norm) {
      const last = (this.idx.history[this.S.rid] || []).slice().sort((a, b) => a.Days_Since_Last_Order - b.Days_Since_Last_Order)[0];
      const seg = segments(norm)[0];
      const c = seg ? candidates(this.idx, seg, null) : [];
      const direct = !this.pending || this.pending.type !== 'complaint';
      const res = this.S.T.log_complaint({ category: 'Previous order - wrong quantity/item', details: text, sku_id: c.length === 1 ? c[0].SKU_ID : null,
        last_order_date: last ? last.Last_Order_Date : null });
      this.pending = null; this.stage = 'ordering';
      return this.say(this.t('complaintLogged', { sorry: direct, ticket: res.ticket }));
    }
    answerInfo(norm, I) {
      const seg = segments(norm)[0];
      if (I.price && (!seg || !(seg.brand || seg.variants.length || seg.size))) {
        const P = this.pending, sku = (P && P.sku) || this.lastSku, p = sku && this.idx.products[sku];
        if (p) {
          const hiL = this.S.lang === 'hi';
          const tail = P && P.type === 'suggest' ? (hiL ? ` ${P.qty} bhej doon?` : ` Shall I add ${P.qty}?`) : P && P.type === 'qty' ? (hiL ? ' Kitne bhejun?' : ' How many should I send?') : '';
          return this.say(this.t('price', { item: p.Short, bill: inr(p.Distributor_Billing_Price_INR), mrp: inr(p.MRP_INR), margin: inr(p.MRP_INR - p.Distributor_Billing_Price_INR) }) + tail);
        }
      }
      if (!seg) return null;
      const c = candidates(this.idx, seg, this.ctxBrand);
      if (I.sizes && seg.brand) return this.say(this.t('sizes', { brand: seg.brand, list: this.sizeOptions(seg.brand) }) + ' ' + this.t('anythingElse'));
      if (I.price && c.length === 1) {
        const p = c[0];
        this.lastSku = p.SKU_ID;
        return this.say(this.t('price', { item: p.Short, bill: inr(p.Distributor_Billing_Price_INR), mrp: inr(p.MRP_INR), margin: inr(p.MRP_INR - p.Distributor_Billing_Price_INR) }));
      }
      if (I.price && c.length > 1 && (seg.brand || seg.variants.length)) {
        this.pending = { type: 'size', options: c.slice(0, 4).map(p => p.SKU_ID) };
        return this.say(this.t('askSize', { brand: c[0].Brand, options: this.sizeOptions(c[0].Brand, c.slice(0, 4)) }));
      }
      return null;
    }
    repeatLast() {
      const lines = this.ctxBrand ? this.S.plan.basket.filter(b => b.brand === this.ctxBrand && !b.lapsed).slice(0, 2) : this.S.plan.lead;
      // lines that fit in stock go first, so one stock question never drops the other lines
      const fits = b => { const st = stockOf(this.idx, this.S.dist, b.sku); return !!st && st.available >= b.lastQty; };
      const ordered = lines.filter(fits).concat(lines.filter(b => !fits(b)));
      const notes = [], qs = [];
      for (const b of ordered) { const r = this.addLine(b.sku, b.lastQty, 'retailer_request'); if (r.question) { qs.push(r.question); break; } notes.push(r.note); }
      const hi = this.S.lang === 'hi';
      if (qs.length) return this.say((notes.length ? (hi ? joinList(notes, 'hi') + ' note kar liya. ' : 'Noted ' + joinList(notes, 'en') + '. ') : '') + qs[0]);
      return this.say(this.t('added', { items: joinList(notes, this.S.lang) }));
    }
    afterDone(prefix) {
      prefix = prefix || '';
      if (!this.S.cart.length) {
        if (this.humanAsked || this.complained) return this.close('noOrderClose', {}, this.humanAsked ? 'ESCALATED' : 'COMPLAINT_LOGGED');
        this.S.events.push({ type: 'NO_ORDER', reason: 'Nothing ordered' });
        return this.close('noOrderClose', {}, 'NO_ORDER');
      }
      if (!this.suggested && !this.complained) {
        const s = this.pickSuggestion();
        this.suggested = true;
        if (s) {
          this.pending = { type: 'suggest', sku: s.sku, qty: s.qty, source: s.source };
          return this.say(prefix + s.text);
        }
      }
      return this.readback(prefix);
    }
    pickSuggestion() {
      // ONE suggestion per call: (1) validated cross-sell/replenishment hint, else (2) best due line from a brand not yet ordered
      const p = this.S.plan, inCart = new Set(this.S.cart.map(l => l.sku));
      const cross = p.cross.pick;
      const lang = this.S.lang;
      if (cross && !inCart.has(cross.sku) && (cross.type !== 'trade-up' || this.S.cart.some(l => l.sku.startsWith('P00')))) {
        const prod = this.idx.products[cross.sku];
        const avail = stockOf(this.idx, this.S.dist, cross.sku).available;
        const qty = Math.min(cross.qty, avail);
        if (qty > 0) {
          if (cross.type === 'replenishment') {
            const h = this.idx.history[this.S.rid].find(x => x.SKU_ID === cross.sku);
            return { sku: cross.sku, qty, source: 'agent_recommendation', text: this.t('suggestRepl', { item: prod.Short, last: h.Last_Order_Qty, qty }) };
          }
          if (cross.type === 'trade-up') {
            const m = s => inr(this.idx.products[s].MRP_INR - this.idx.products[s].Distributor_Billing_Price_INR);
            return { sku: cross.sku, qty, source: 'cross_sell', text: this.t('suggestTrade', { m500: m('P003'), m200: m('P002'), qty }) };
          }
          const peer = Math.round(this.idx.peer(this.S.r.Segment, cross.sku) * 100);
          const why = lang === 'hi' ? (peer >= 20 ? `Aap jaisi ${peer}% dukaanein ise rakhti hain.` : `Ye aapke yahan abhi nahi hai aur trial pack chhota hai.`) : (peer >= 20 ? `${peer}% of similar stores stock it.` : `You don't stock it yet and the trial pack is small.`);
          return { sku: cross.sku, qty, source: 'cross_sell', text: this.t('suggestNew', { item: prod.Short, qty, why }) };
        }
      }
      const due = p.basket.filter(b => !inCart.has(b.sku) && b.due && !b.lapsed && b.stock > 0 && b.value >= 0.08 * p.pref.Typical_Order_Value_INR &&
        !this.S.cart.some(l => this.idx.products[l.sku].Brand === b.brand));
      if (due.length) {
        const b = due[0];
        return { sku: b.sku, qty: b.suggestedQty, source: 'agent_recommendation', text: this.t('suggestRepl', { item: b.name, last: b.lastQty, qty: b.suggestedQty }) };
      }
      return null;
    }
    readback(prefix) {
      prefix = prefix || '';
      this.stage = 'readback'; this.pending = null;
      const sum = this.S.T.get_order_summary();
      const lines = linesPhrase(sum.lines.map(l => ({ name: l.product, qty: l.quantity })), this.S.lang);
      return this.say(prefix + this.t('readback', { lines, total: inr(sum.order_value_inr) }));
    }
    confirm(text) {
      const r = this.S.T.confirm_order({ retailer_confirmation: text });
      if (r.error === 'READBACK_REQUIRED') return this.readback();
      if (r.error) return this.say(this.t('fallback'));
      return this.close('confirmed', { oid: r.order_id }, 'ORDER_CONFIRMED');
    }
  }

  return { buildIndex, planCall, dailyCallPlan, stockOf, createSession, Conversation, normalize, segments, intents, candidates, inr, TX, W, SHORT };
});
