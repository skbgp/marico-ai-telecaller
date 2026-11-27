/* Shared scenario definitions: used by run_tests.js (Node) and by the in-page test runner (index.html). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.ScenarioFactory = factory;
})(typeof self !== 'undefined' ? self : this, function (A, DATA) {
const T = (say, confidence) => ({ say, confidence });
const line = (rec, sku) => rec.order && rec.order.lines.find(l => l.sku_id === sku);
const ev = (rec, type) => rec.events.filter(e => e.type === type);
const agentSaid = (conv, re) => conv.transcript.some(t => t.who === 'agent' && re.test(t.text));

const TESTS = [
  { id: 'CS01', name: 'Interested retailer (case PDF dialogue)', rid: 'R042',
    turns: [T('Haan bataiye. Parachute ka stock thoda kam hai.'), T('500 ml ke 15 aur 200 ml ke 10 de dijiye.'), T('Bas itna hi.'),
      T('Haan, 10 litre bhej dena.'), T('Haan, confirm kar dijiye.')],
    checks: (c, r) => [
      ['Order confirmed', r.outcome === 'ORDER_CONFIRMED'],
      ['Parachute 500 ml = 15', line(r, 'P003') && line(r, 'P003').quantity === 15],
      ['Parachute 200 ml = 10', line(r, 'P002') && line(r, 'P002').quantity === 10],
      ['Saffola Gold 10 L -> 10 x 1 L pouches', line(r, 'P006') && line(r, 'P006').quantity === 10],
      ['Read back before confirmation', agentSaid(c, /order dohra|read back/i)],
      ['Order value uses billing price', r.order && r.order.order_value_inr === 15 * 196 + 10 * 84 + 10 * 182]] },
  { id: 'CS02', name: 'Busy retailer', rid: 'R003',
    turns: [T('Abhi busy hoon, shaam 5 baje ke baad call karna.')],
    checks: (c, r) => [['Callback created for 17:00', ev(r, 'CALLBACK_SCHEDULED').some(e => /T17:00/.test(e.when))], ['No order', !r.order], ['Did not push an order', !agentSaid(c, /kitna bhejun|how much/i)]] },
  { id: 'CS03', name: 'Out-of-stock SKU (Nihar Shanti 100 ml = 0 at D001)', rid: 'R042',
    turns: [T('Haan ji.'), T('Nihar Shanti 100 ml ke 20 chahiye.'), T('Nahi, rehne do.'), T('Parachute 500 ml ke 10.'), T('Bas.'), T('Nahi.'), T('Haan, place kar do.')],
    checks: (c, r) => [['Unavailability explained + in-stock alternative offered', agentSaid(c, /out of stock.*300 ml/i)], ['No unavailable SKU in order', !line(r, 'P012')],
      ['Order placed with the in-stock line', line(r, 'P003') && line(r, 'P003').quantity === 10]] },
  { id: 'CS04', name: 'Quantity changed 10 -> 15', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 10 bhej do.'), T('Nahi, 10 nahi 15 kar do.'), T('Bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['Final order shows 15', line(r, 'P003') && line(r, 'P003').quantity === 15], ['Single line, no duplicate', r.order && r.order.lines.filter(l => l.sku_id === 'P003').length === 1]] },
  { id: 'CS05', name: 'Language switch Hindi -> English', rid: 'R042',
    turns: [T('Haan ji boliye.'), T('Actually can we speak in English? I need 12 pieces of Parachute 500 ml.'), T("That's all."), T('No thanks.'), T('Yes, please place it.')],
    checks: (c, r) => [['Switched to English', c.transcript.filter(t => t.who === 'agent').slice(-1)[0].lang === 'en'], ['Context kept (order captured)', line(r, 'P003') && line(r, 'P003').quantity === 12],
      ['Order confirmed', r.outcome === 'ORDER_CONFIRMED']] },
  { id: 'CS06', name: 'Previous order complaint', rid: 'R042',
    turns: [T('Haan main hi hoon. Pichhli baar ka order galat aaya tha, Parachute 500 ml 12 ki jagah 10 hi aaye.'), T('Haan, Parachute 500 ml ke 12 bhej do.'), T('Bas.'), T('Haan.')],
    checks: (c, r) => [['Complaint recorded', ev(r, 'COMPLAINT').length === 1], ['Escalated to sales officer', ev(r, 'HUMAN_ESCALATION').length >= 1], ['Acknowledged, not ignored', agentSaid(c, /shikayat|complaint/i)]] },
  { id: 'CS07', name: 'Box versus piece', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 200 ml ke 2 box bhej do.'), T('24 pieces.'), T('Bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['Asked to clarify units', agentSaid(c, /kitne pieces honge|how many pieces would/i)], ['Did not guess a conversion', c.snap[1].cart.length === 0], ['Quantity clarified before order', line(r, 'P002') && line(r, 'P002').quantity === 24]] },
  { id: 'CS08', name: 'Discount request', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 10.'), T('Thoda discount do na, 5 percent extra chahiye.'), T('Theek hai, bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['No discount promised', agentSaid(c, /vaada nahi kar sakti|can't promise/i)], ['No unauthorised discount applied', r.order && r.order.discount_applied_inr === 0],
      ['Request logged for human', ev(r, 'DISCOUNT_REQUEST').length === 1 && ev(r, 'DISCOUNT_REQUEST')[0].granted === false]] },
  { id: 'CS09', name: 'Not interested', rid: 'R004',
    turns: [T('Haan main bol raha hoon.'), T('Nahi, abhi kuch nahi chahiye.')],
    checks: (c, r) => [['No order created', !r.order], ['Closed politely', r.outcome === 'NO_ORDER' && agentSaid(c, /dhanyavaad|thanks/i)]] },
  { id: 'CS10', name: 'Human request', rid: 'R004',
    turns: [T('Haan.'), T('Mujhe kisi sales representative se baat karni hai.'), T('Nahi, bas.')],
    checks: (c, r) => [['Human escalation recorded', ev(r, 'HUMAN_ESCALATION').length === 1], ['Not obstructed (callback offered at once)', /representative/i.test(c.transcript.filter(t => t.who === 'agent')[2].text)]] },
  { id: 'CS11', name: 'Ambiguous quantity', rid: 'R042',
    turns: [T('Haan.'), T('Send a few more Parachute 500 ml than last time.'), T('15 pieces.'), T("That's all."), T('No.'), T('Yes.')],
    checks: (c, r) => [['Asked a clarifying question', agentSaid(c, /exact/i)], ['No order line until clarified', c.snap[1].cart.length === 0], ['Clarified quantity used', line(r, 'P003') && line(r, 'P003').quantity === 15]] },
  { id: 'CS12', name: 'SKU ambiguity: "Parachute small bottle"', rid: 'R042',
    turns: [T('Haan.'), T('Parachute ki chhoti bottle ke 10 bhej do.'), T('200 ml wali.'), T('Bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['Clarified pack size', agentSaid(c, /100 ml ya 200 ml|100 ml or 200 ml/i)], ['Nothing added before clarification', c.snap[1].cart.length === 0], ['Correct SKU selected', line(r, 'P002') && line(r, 'P002').quantity === 10 && !line(r, 'P001')]] },
  { id: 'CS13', name: 'Stock constraint (Saffola Gold 1 L: 13 at D001)', rid: 'R042',
    turns: [T('Haan.'), T('Saffola Gold 1 litre ke 20 pouch.'), T('Abhi 13 bhej do, baaki follow up kar lena.'), T('Bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['Stated available quantity', agentSaid(c, /sirf 13|only 13/i)], ['Order does not exceed stock', line(r, 'P006') && line(r, 'P006').quantity === 13], ['Follow-up for balance', ev(r, 'BACKORDER_FOLLOWUP').some(e => e.quantity === 7)]] },
  { id: 'CS14', name: 'Cross-sell opportunity', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 12.'), T('Bas.'), T('Nahi, abhi nahi.'), T('Haan.')],
    checks: (c, r) => [['Exactly one recommendation', c.transcript.filter(t => t.who === 'agent' && /suggestion/i.test(t.text)).length === 1],
      ['Relevant (Saffola, from history)', agentSaid(c, /suggestion.*Saffola/i)], ['Refusal accepted', agentSaid(c, /koi baat nahi/i) && !line(r, 'P006')], ['Order still placed', r.outcome === 'ORDER_CONFIRMED']] },
  { id: 'CS15', name: 'Wrong retailer', rid: 'R042',
    turns: [T('Nahi, main Sharma ji nahi hoon. Ye unka number nahi hai.')],
    checks: (c, r) => [['No private data disclosed', !agentSaid(c, /pichhli baar|last time|pieces/i)], ['Account data never fetched', !c.S.toolLog.some(t => t.name === 'get_retailer_context' && !t.result.error)],
      ['Ended politely', r.outcome === 'WRONG_PARTY']] },
  { id: 'CS16', name: 'Do not call again', rid: 'R004',
    turns: [T('Dobara call mat karna.')],
    checks: (c, r) => [['Do-not-call flag recorded', ev(r, 'DNC_SET').length === 1 && c.S.pref.Do_Not_Call_Flag === 'Yes'], ['Call ended', r.outcome === 'DNC_SET']] },
  { id: 'CS17', name: 'Order summary correction', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 15 aur 200 ml ke 8.'), T('Bas.'), T('Nahi.'), T('Nahi, 200 ml 8 nahi 10 chahiye.'), T('Haan sahi hai.')],
    checks: (c, r) => [['Corrected order finalised', line(r, 'P002') && line(r, 'P002').quantity === 10], ['Full summary repeated after correction', c.transcript.filter(t => t.who === 'agent' && /order dohra/i.test(t.text)).length === 2],
      ['Uncorrected value never confirmed', r.order && r.order.lines.every(l => !(l.sku_id === 'P002' && l.quantity === 8))]] },
  { id: 'CS18', name: 'Unclear speech', rid: 'R042',
    turns: [T('Haan.'), T('Parachute [inaudible] ke pieces', 0.35), T('Parachute 500 ml ke 15', 0.7), T('Haan.'), T('Bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['Asked for repetition', agentSaid(c, /aawaz saaf nahi|didn't catch/i)], ['Echo-confirmed medium-confidence line', agentSaid(c, /Kya aapne Parachute 500 ml ke 15 pieces kaha/i)],
      ['No guessed line during unclear turns', c.snap[1].cart.length === 0 && c.snap[2].cart.length === 0], ['Order correct after confirmation', line(r, 'P003') && line(r, 'P003').quantity === 15]] },
  { id: 'CS19', name: 'No order but demand signal', rid: 'R042',
    turns: [T('Haan.'), T('Abhi stock full hai. Waise Dabur wale 1 ke saath 1 free ka scheme de rahe hain.')],
    checks: (c, r) => [['No fabricated order', !r.order], ['Insight noted', ev(r, 'MARKET_INSIGHT').some(e => /Dabur/i.test(e.said))]] },

  /* ---- Surprise scenarios from PART E of the brief ---- */
  { id: 'SX1', name: 'Surprise: Hindi -> English mid-order', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 12.'), T('Also add Saffola Gold 1 litre, 8 pieces please.'), T("That's all."), T('Yes go ahead.')],
    checks: (c, r) => [['Replies in English after switch', c.transcript.filter(t => t.who === 'agent').slice(-1)[0].lang === 'en'], ['Both lines kept', line(r, 'P003') && line(r, 'P006') && line(r, 'P006').quantity === 8]] },
  { id: 'SX2', name: 'Surprise: out-of-stock product, accepts alternative', rid: 'R042',
    turns: [T('Haan.'), T('Nihar Shanti 100 ml ke 10 bhejo.'), T('Haan theek hai.'), T('6.'), T('Bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['OOS line not booked', !line(r, 'P012')], ['Alternative booked only after yes', line(r, 'P013') && line(r, 'P013').quantity === 6 && line(r, 'P013').source === 'agent_alternative']] },
  { id: 'SX3', name: 'Surprise: complaint about previous order', rid: 'R003',
    turns: [T('Haan.'), T('Pichhli baar ka maal galat aaya tha.'), T('Parachute 200 ml 10 kam aaye.'), T('Nahi aaj nahi.')],
    checks: (c, r) => [['Asked for details', agentSaid(c, /kaunse product/i)], ['Complaint ticket', ev(r, 'COMPLAINT').length === 1 && !!ev(r, 'COMPLAINT')[0].ticket]] },
  { id: 'SX4', name: 'Surprise: quantity changed midway (English)', rid: 'R042',
    turns: [T('Yes.'), T('Parachute 500 ml, 20 pieces.'), T('Make it 25 instead of 20.'), T("That's all."), T('No.'), T('Yes.')],
    checks: (c, r) => [['Latest quantity only', line(r, 'P003') && line(r, 'P003').quantity === 25]] },
  { id: 'SX5', name: 'Surprise: 10 boxes instead of 10 pieces', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 10 box.'), T('Box nahi, 10 piece hi chahiye.'), T('Bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['Unit queried, not assumed', agentSaid(c, /kitne pieces honge/i) && c.snap[1].cart.length === 0], ['10 pieces booked', line(r, 'P003') && line(r, 'P003').quantity === 10]] },
  { id: 'SX6', name: 'Surprise: refuses order, agrees to callback', rid: 'R042',
    turns: [T('Haan.'), T('Abhi order nahi dena, kal subah call kar lena.')],
    checks: (c, r) => [['No order', !r.order], ['Callback tomorrow morning', ev(r, 'CALLBACK_SCHEDULED').some(e => /2026-11-21T10:00/.test(e.when))]] },

  /* ---- extra robustness checks ---- */
  { id: 'RX1', name: 'Tamil retailer: greeting in own language', rid: 'R010',
    turns: [T('Yes, speaking.')],
    checks: (c) => [['Greets in Tamil', /Vanakkam/.test(c.transcript[0].text)]] },
  { id: 'RX2', name: 'Price question answered from master data', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ka rate kya hai?')],
    checks: (c) => [['Billing price, MRP and margin quoted', agentSaid(c, /196.*230.*34/)]] },
  { id: 'RX3', name: 'Devanagari input (browser speech in hi-IN)', rid: 'R042',
    turns: [T('हाँ'), T('पैराशूट 500 ml के 15'), T('बस'), T('नहीं'), T('हाँ')],
    checks: (c, r) => [['Parsed Devanagari order', line(r, 'P003') && line(r, 'P003').quantity === 15]] },
  { id: 'RX4', name: 'Confirm blocked if order changed after read-back (tool guard)', rid: 'R042', custom: true,
    run: () => {
      const idx = A.buildIndex(DATA); const S = A.createSession(idx, 'R042');
      S.T.verify_identity({ confirmed: true }); S.T.add_or_update_item({ sku_id: 'P003', quantity: 5 }); S.T.get_order_summary();
      S.T.add_or_update_item({ sku_id: 'P003', quantity: 6 });
      const r1 = S.T.confirm_order({ retailer_confirmation: 'haan' });
      const r2 = S.T.add_or_update_item({ sku_id: 'P006', quantity: 999 });
      const r3 = S.T.add_or_update_item({ sku_id: 'P003', quantity: 2, unit: 'box' });
      const r4 = S.T.add_or_update_item({ sku_id: 'P012', quantity: 2 });
      return [['Confirm refused without fresh read-back', r1.error === 'READBACK_REQUIRED'], ['Over-stock refused', r2.error === 'EXCEEDS_STOCK' && r2.available_units === 13],
        ['Box unit refused (no conversion)', r3.error === 'UNIT_CONVERSION_NOT_SUPPLIED'], ['OOS refused with alternative', r4.error === 'OUT_OF_STOCK' && r4.in_stock_alternative.sku_id === 'P013']];
    } },
  { id: 'RX6', name: 'Price objection: no discount, offers smaller quantity', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml bahut mehenga hai.'), T('Theek hai, 6 bhej do.'), T('Bas.'), T('Nahi.'), T('Haan.')],
    checks: (c, r) => [['Objection recorded', ev(r, 'OBJECTION').length === 1], ['Rate not reduced', agentSaid(c, /Rate main kam nahi kar sakti/) && r.order && r.order.discount_applied_inr === 0], ['Smaller order booked', line(r, 'P003') && line(r, 'P003').quantity === 6]] },
  { id: 'RX7', name: 'Stock question answered from distributor stock', rid: 'R042',
    turns: [T('Haan.'), T('Saffola Gold 1 litre available hai?'), T('10 bhej do.')],
    checks: (c, r) => [['Says only 13 left', agentSaid(c, /sirf 13 pieces/)], ['Follow-up quantity booked', c.S.cart.some(l => l.sku === 'P006' && l.qty === 10)]] },
  { id: 'RX8', name: 'Delivery / credit question: nothing promised', rid: 'R042',
    turns: [T('Haan.'), T('Udhaar pe milega kya? Delivery kab tak aayegi?')],
    checks: (c, r) => [['No date or credit promised', agentSaid(c, /koi date ya credit promise nahi/)], ['Credit ask logged for sales officer', ev(r, 'DISCOUNT_REQUEST').some(e => e.kind === 'credit_terms')]] },
  { id: 'RX9', name: 'Says no at read-back, then yes: reads back again before booking', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 10.'), T('Bas.'), T('Nahi.'), T('Nahi.'), T('Haan.'), T('Haan.')],
    checks: (c, r) => [['Order confirmed in the end', r.outcome === 'ORDER_CONFIRMED'], ['Read back twice (no booking on an ambiguous yes)', c.transcript.filter(t => t.who === 'agent' && /order dohra/.test(t.text)).length === 2]] },
  { id: 'RX10', name: 'Cancels the whole order before confirming', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 10.'), T('Bas.'), T('Nahi.'), T('Nahi, pura order cancel kar do.')],
    checks: (c, r) => [['No order created', !r.order && r.outcome === 'NO_ORDER'], ['Stock not reserved', !Object.keys(c.idx.reserved).length]] },
  { id: 'RX11', name: 'Owner not at the shop: callback booked, nothing disclosed', rid: 'R042',
    turns: [T('Sharma ji abhi dukaan pe nahi hain, 7 baje aayenge.')],
    checks: (c, r) => [['Callback booked for 7 pm', r.outcome === 'CALLBACK_SCHEDULED' && r.events.some(e => e.type === 'CALLBACK_SCHEDULED' && /T19:00/.test(e.when))],
      ['Identity not verified, no account data read', !r.identity_verified && !c.S.toolLog.some(t => t.name === 'get_retailer_context')], ['Not treated as a wrong number', !r.events.some(e => e.type === 'WRONG_PARTY')]] },
  { id: 'RX12', name: 'Asks for English at the greeting: identity asked again in English', rid: 'R042',
    turns: [T('Can we speak in English?'), T('Yes, speaking.'), T('Parachute 500 ml, 10 pieces.')],
    checks: (c, r) => { const a = c.transcript.filter(t => t.who === 'agent'); return [['Identity question repeated in English', /Am I speaking with Ramesh Sharma/.test(a[1].text)],
      ['Order taken in English after identity', /Last time you took/.test(a[2].text)], ['Line booked', c.S.cart.some(l => l.sku === 'P003' && l.qty === 10)]]; } },
  { id: 'RX13', name: '"Rehne do" when stock is short: nothing added', rid: 'R042',
    turns: [T('Haan.'), T('Saffola Gold 1 litre ke 20.'), T('Nahi, rehne do.')],
    checks: (c, r) => [['Saffola Gold not added', !c.S.cart.some(l => l.sku === 'P006')], ['No follow-up booked', !r.events.some(e => e.type === 'BACKORDER_FOLLOWUP')]] },
  { id: 'RX14', name: 'Running total on request, order stays open', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 15 aur 200 ml ke 10.'), T('Kitna hua total?')],
    checks: (c, r) => [['Total read out (15 x 196 + 10 x 84 = 3,780)', /₹3,780/.test(c.transcript[c.transcript.length - 1].text)], ['Nothing placed yet', !r.order && c.stage === 'ordering']] },
  { id: 'RX15', name: 'Price question during the suggestion keeps it open', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 15 aur 200 ml ke 10.'), T('Bas.'), T('Kitne ka hai?'), T('Theek hai, bhej do.'), T('Haan, confirm kar dijiye.')],
    checks: (c, r) => { const a = c.transcript.filter(t => t.who === 'agent'); return [['Margin given, suggestion asked again', /margin/.test(a[4].text) && /bhej doon\?$/.test(a[4].text)],
      ['Suggested item booked after yes', r.order && r.order.lines.some(l => l.source !== 'retailer_request')], ['Order confirmed', r.outcome === 'ORDER_CONFIRMED']]; } },
  { id: 'RX16', name: '"Pichhli baar jitna" for one product adds only that product', rid: 'R042',
    turns: [T('Haan.'), T('Saffola Gold 1 litre bhi chahiye.'), T('Pichhli baar jitna.')],
    checks: (c, r) => { const h = c.idx.history.R042.find(x => x.SKU_ID === 'P006'); return [['Only Saffola Gold 1 litre added, at last quantity', c.S.cart.length === 1 && c.S.cart[0].sku === 'P006' && c.S.cart[0].qty === h.Last_Order_Qty]]; } },
  { id: 'RX17', name: 'Box size not known: asks for pieces, never guesses', rid: 'R042',
    turns: [T('Haan.'), T('Parachute 500 ml ke 2 box bhej do.'), T('Pata nahi.'), T('24.')],
    checks: (c, r) => [['Nothing booked while pieces unknown', c.snap[3].cart.length === 0], ['Asks for pieces with last order as a hint (no repeat of the box question)', /kitne pieces bhejun\? Pichhli baar 12/.test(c.snap[3].text) && !/box conversion/.test(c.snap[3].text)],
      ['Booked 24 pieces once told', c.S.cart.some(l => l.sku === 'P003' && l.qty === 24)]] },
  { id: 'RX18', name: 'Owner away, said in English: no account data shared', rid: 'R042',
    turns: [T('He is not at the shop right now.')],
    checks: (c, r) => [['Identity not verified, account not opened', !r.identity_verified && !c.S.toolLog.some(t => t.name === 'get_retailer_context')], ['Callback booked', r.outcome === 'CALLBACK_SCHEDULED']] },
  { id: 'RX19', name: '"Baaki baad mein bhej dena" splits the order (not a callback)', rid: 'R042',
    turns: [T('Haan.'), T('Saffola Gold 1 litre ke 20.'), T('Haan, baaki baad mein bhej dena.')],
    checks: (c, r) => [['13 available pieces booked', c.S.cart.some(l => l.sku === 'P006' && l.qty === 13)], ['Follow-up for the other 7', r.events.some(e => e.type === 'BACKORDER_FOLLOWUP' && e.quantity === 7)], ['Call still open', !c.S.closed]] },
  { id: 'RX20', name: 'Complaint in English is logged, not booked as an order', rid: 'R042',
    turns: [T('Yes, speaking.'), T('The last order came wrong.'), T('Parachute 200 ml was 5 pieces short.')],
    checks: (c, r) => [['Complaint logged', r.events.some(e => e.type === 'COMPLAINT')], ['Nothing added to the order', c.S.cart.length === 0]] },
  { id: 'RX21', name: 'Yes, no and "that\'s enough" understood in all 10 languages', custom: true,
    run: () => {
      const W = { Hindi: ['R042', 'Haan', 'Nahi', 'Bas'], Tamil: ['R010', 'Aamaa', 'Illai', 'Podhum'], Telugu: ['R013', 'Avunu', 'Vaddu', 'చాలు'],
        Kannada: ['R015', 'Haudu', 'Beda', 'Saaku'], Malayalam: ['R016', 'Athe', 'Venda', 'Mathi'], Bengali: ['R017', 'Hyan', 'Lagbe na', 'Eituku'],
        Marathi: ['R008', 'Chalel', 'Nako', 'Evdhach'], Gujarati: ['R005', 'Barabar', 'Nathi', 'Atlu j'], Odia: ['R018', 'Hau', 'Darkar nahi', 'Etiki'], Assamese: ['R020', 'Hoi', 'Nalage', 'ইমানেই'] };
      const SAY = { P003: 'Parachute 500 ml 10 pieces', P002: 'Parachute 200 ml 10 pieces', P006: 'Saffola Gold 1 litre pouch 10 pieces' };
      return Object.entries(W).map(([lang, [rid, yes, no, enough]]) => {
        const idx = A.buildIndex(DATA), c = new A.Conversation(idx, rid); c.start();
        c.hear(yes); const idOk = c.S.identityVerified;
        const sku = Object.keys(SAY).find(k => { const st = A.stockOf(idx, c.S.dist, k); return st && st.available >= 30; });
        c.hear(SAY[sku]); c.hear(enough);
        if (c.pending && c.pending.type === 'suggest') c.hear(no);
        const atReadback = c.stage === 'readback';
        c.hear(yes);
        return [`${lang}: "${yes}" / "${no}" / "${enough}" understood, order placed`, idOk && atReadback && c.S.record().outcome === 'ORDER_CONFIRMED'];
      });
    } },
  { id: 'RX5', name: 'Planner skips do-not-call retailers', custom: true,
    run: () => { const idx = A.buildIndex(DATA); const plan = A.dailyCallPlan(idx); const dnc = plan.filter(p => p.decision === 'DO_NOT_CALL').map(p => p.rid);
      return [['R001, R025, R082 never called', ['R001', 'R025', 'R082'].every(x => dnc.includes(x)) && dnc.length === 3]]; } },
];


  return { TESTS, run: function () {
    const out = [];
    for (const t of TESTS) {
      let checks, transcript = [], record = null;
      if (t.custom) checks = t.run();
      else {
        const idx = A.buildIndex(DATA);
        const c = new A.Conversation(idx, t.rid);
        c.snap = [c.start()];
        for (const turn of t.turns) c.snap.push(c.hear(turn.say, { confidence: turn.confidence }));
        record = c.S.record(); checks = t.checks(c, record); transcript = c.transcript;
      }
      out.push({ id: t.id, name: t.name, rid: t.rid || null, pass: checks.every(x => !!x[1]), checks: checks.map(([n, v]) => ({ check: n, pass: !!v })), transcript, record });
    }
    return out;
  } };
});
