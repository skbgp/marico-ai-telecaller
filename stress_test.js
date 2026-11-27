// Stress test: node stress_test.js
// 1) the simple order flow for all 100 retailers, in Hindi and in English
// 2) the same flow in each retailer's own words for yes / no / that's all (all 10 languages)
// 3) 1,500 random calls (half start with identity confirmed and try to close the order)
// Checks on every call: no crash, no broken reply, no line above distributor stock,
// no discount applied, and no order placed without a read-back.
// Checks on every line Asha says: a regional-language line is really in that language's script,
// has no Hindi left in it, and carries a complete English version (no regional script left in it).
const A = require('./agent_core.js');
const LG = require('./languages.js');
const DATA = require('./marico_data.json');

const POOL = ['Haan bataiye', 'Haan, bol raha hoon', 'Parachute 500 ml ke 15 aur 200 ml ke 10', 'Saffola Gold 1 litre ke 20', '2 box bhej do', 'Nahi, 10 nahi 15 kar do',
  'Bahut mehenga hai', 'Bas itna hi', 'Haan, confirm kar dijiye', 'Thoda discount do', 'Can we speak in English?', 'Abhi busy hoon, 5 baje ke baad call karna',
  'Pichhli baar ka order galat aaya tha', 'Mujhe sales representative se baat karni hai', 'Stock full hai, Dabur scheme de raha hai', 'Kitna hua total?', 'Haan bhej do',
  'Kitne ka hai?', 'Nahi rehne do', 'Jane do', 'Pata nahi', 'Pichhli baar jitna', 'Sharma ji abhi dukaan pe nahi hain', 'Aap kaun?', 'Kya bola?', '10', 'Das',
  'Nihar 100 ml ke 20', 'Livon serum ke 5', 'Ek box mein 24 hote hain', 'Haan', 'Nahi', '200 ml hata do', 'Order cancel kar do', 'Delivery kab tak hogi?',
  'Aap robot ho kya?', 'Hindi mein bolo', 'Saffola Gold 5 litre', '2', 'Haan theek hai', 'ok', 'Yes please place it', 'No', 'Parachute 500 ml 1000 pieces', 'teen sau',
  '[inaudible]', 'He is not at the shop right now', 'Haan, baaki baad mein bhej dena', 'Yes, send the rest later', 'The last order came wrong',
  // the retailer's own languages, and asking for one by name
  'Aamaa', 'Illai', 'Podhum', 'Avunu', 'Vaddu', 'చాలు', 'Haudu', 'Saaku', 'Athe', 'Mathi', 'হ্যাঁ', 'লাগবে না', 'Chalel', 'Nako', 'Haa', 'Atlu j', 'Hau', 'Etiki', 'Hoi', 'ইমানেই',
  'Tamil please', 'Please speak in Telugu', 'Kannada', 'Speak in Bengali', 'Marathi madhe bola', 'Gujarati ma bolo', 'Odia re kuhantu please', 'Assamese please',
  'Hindi nahi aati', 'I don\'t know Hindi', 'English please', 'Parachute 500 ml ௧௫ pieces', '১২ pieces', 'Say that again', 'What is the total?', 'How much is it?',
  'I am busy, call me after 5', 'Too expensive', 'When will the delivery come?', 'Make it 20 instead of 10', 'Is Saffola Gold 1 litre available?'];
let seed = 20261127;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const BROKEN = /undefined|NaN|\[object|null/;
const INDIC = /[ऀ-෿]/;
// Hindi phrasing that must never show up inside a regional-language line or its English version
const HINDI_LEFT = /\b(aur|kar diya|kar liya|bhej doon|bhejun|koi baat nahi|maaf kijiye|ji zaroor|theek hai|hata diya|pieces ke|ke \d+ pieces?)\b/i;
const stock = A.buildIndex(DATA);
const problems = [];
let localLines = 0;

function checkLine(rid, said, o) {
  if (!o || !o.text || BROKEN.test(o.text)) { problems.push(`${rid} | ${said} -> ${o && o.text}`); return; }
  if (LG.LOCAL[o.lang]) {
    localLines++;
    if (!LG.SCRIPT[o.lang].test(o.text)) problems.push(`${rid} | ${o.lang} line not in its script: ${o.text}`);
    if (HINDI_LEFT.test(o.text)) problems.push(`${rid} | Hindi left in ${o.lang} line: ${o.text}`);
    if (!o.en) problems.push(`${rid} | ${o.lang} line has no English version: ${o.text}`);
    else if (INDIC.test(o.en) || BROKEN.test(o.en) || HINDI_LEFT.test(o.en)) problems.push(`${rid} | English version incomplete: ${o.en}`);
  } else if (o.lang === 'en' && /[஀-෿ঀ-৿઀-୿]/.test(o.text.replace(/\([^)]*\)/g, ''))) problems.push(`${rid} | regional script in an English line: ${o.text}`);
}
function check(c, rid) {
  const rec = c.S.record();
  if (!rec.order) return;
  if (!c.S.toolLog.some(t => t.name === 'get_order_summary')) problems.push(rid + ': order placed without read-back');
  for (const l of rec.order.lines) { const st = A.stockOf(stock, c.S.dist, l.sku_id); if (st && l.quantity > st.available) problems.push(`${rid}: ${l.sku_id} ${l.quantity} > stock ${st.available}`); }
  if (rec.order.discount_applied_inr) problems.push(rid + ': discount applied');
}
function say(c, rid, text, noisy) {
  try { checkLine(rid, text, c.hear(text, noisy && rnd() < 0.08 ? { confidence: 0.4 } : {})); }
  catch (e) { problems.push(`${rid} | ${text} | crash: ${e.message}`); }
}
function open(rid) { const c = new A.Conversation(A.buildIndex(DATA), rid); checkLine(rid, '(start)', c.start()); return c; }

// 1) simple flow, every retailer, two languages
const flows = { hi: ['Haan bataiye', 'Pichhli baar jitna hi bhej do', 'Bas itna hi', 'Nahi', 'Haan, confirm kar dijiye'],
  en: ['Yes, speaking', 'Same as last time please', 'That is all', 'No', 'Yes, please place the order'] };
let placed = 0, simple = 0;
for (const [lang, flow] of Object.entries(flows)) for (const r of DATA.retailers) {
  const c = open(r.Retailer_ID); simple++;
  for (const s of flow) if (!c.S.closed) say(c, r.Retailer_ID, s);
  for (let i = 0; i < 4 && !c.S.closed; i++) say(c, r.Retailer_ID, lang === 'hi' ? 'Haan, theek hai, confirm kar dijiye' : 'Yes, okay, place the order');
  if (c.S.record().outcome === 'ORDER_CONFIRMED') placed++; else problems.push(`${lang} ${r.Retailer_ID}: simple flow ended ${c.S.record().outcome}`);
  check(c, r.Retailer_ID);
}

// 2) the same flow with yes / no / that's all in the retailer's own language
const OWN = { Hindi: ['Haan', 'Nahi', 'Bas'], Tamil: ['Aamaa', 'Illai', 'Podhum'], Telugu: ['Avunu', 'Vaddu', 'చాలు'], Kannada: ['Haudu', 'Beda', 'Saaku'],
  Malayalam: ['Athe', 'Venda', 'Mathi'], Bengali: ['হ্যাঁ', 'লাগবে না', 'Eituku'], Marathi: ['Chalel', 'Nako', 'Evdhach'], Gujarati: ['Haa', 'Nathi joitu', 'Atlu j'],
  Odia: ['Hau', 'Darkar nahi', 'Etiki'], Assamese: ['Hoi', 'Nalage', 'Imanei'] };
let ownPlaced = 0;
for (const r of DATA.retailers) {
  const lang = DATA.preferences.find(p => p.Retailer_ID === r.Retailer_ID).Preferred_Language, [yes, no, enough] = OWN[lang];
  const c = open(r.Retailer_ID);
  for (const s of [yes, 'Same as last time please', enough, no, yes]) if (!c.S.closed) say(c, r.Retailer_ID, s);
  for (let i = 0; i < 4 && !c.S.closed; i++) say(c, r.Retailer_ID, yes);
  if (c.S.record().outcome === 'ORDER_CONFIRMED') ownPlaced++; else problems.push(`own-language ${r.Retailer_ID} (${lang}): flow ended ${c.S.record().outcome}`);
  if (c.home !== 'hi' && c.home !== 'en' && c.transcript.filter(t => t.who === 'agent').some(t => t.lang !== c.home)) problems.push(`${r.Retailer_ID}: left ${lang} without being asked`);
  check(c, r.Retailer_ID);
}

// 3) random calls
const rids = DATA.retailers.map(r => r.Retailer_ID), outcomes = {};
let random = 0;
for (let i = 0; i < 1500; i++) {
  const rid = rids[Math.floor(rnd() * rids.length)];
  const c = open(rid); random++;
  const guided = i % 2 === 1;
  if (guided) say(c, rid, 'Haan bataiye');
  const turns = 3 + Math.floor(rnd() * 9);
  for (let t = 0; t < turns && !c.S.closed; t++) say(c, rid, POOL[Math.floor(rnd() * POOL.length)], true);   // 8% of these lines come with low speech confidence
  if (guided) for (const s of ['Bas itna hi', 'Nahi', 'Haan, confirm kar dijiye']) if (!c.S.closed) say(c, rid, s);
  const o = c.S.record().outcome; outcomes[o] = (outcomes[o] || 0) + 1;
  check(c, rid);
}

console.log(`Simple order flow: ${placed}/${simple} orders placed (100 retailers x Hindi, English)`);
console.log(`Own-language yes / no / that's all: ${ownPlaced}/${DATA.retailers.length} orders placed`);
console.log(`Random calls: ${random}, outcomes ${JSON.stringify(outcomes)}`);
console.log(`Regional-language lines checked: ${localLines}`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + problems.slice(0, 30).join('\n') : 'No problems: no crash, no broken reply, no line above stock, no discount, no order without read-back, every regional line in its script with a full English version.');
process.exit(problems.length ? 1 : 0);
