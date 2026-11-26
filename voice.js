/* voice.js - makes the agent's Hindi replies sound natural in browser text-to-speech.
   The agent writes Hindi in Latin letters (Hinglish). Hindi voices read Latin text with an
   English accent, so before speaking we convert known words to Devanagari, read rupee
   amounts and pack sizes the Indian way, drop order IDs, and pick the best Hindi voice. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceHi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const W = {
    // Hindi words used by the agent
    ke: 'के', ka: 'का', ki: 'की', ko: 'को', se: 'से', me: 'में', mein: 'में', par: 'पर', pe: 'पे', tak: 'तक', aur: 'और', ya: 'या', bhi: 'भी', hi: 'ही', to: 'तो', na: 'न', is: 'इस', isi: 'इसी',
    hai: 'है', hain: 'हैं', ho: 'हो', hoon: 'हूँ', tha: 'था', thi: 'थी', the: 'थे', hoga: 'होगा', honge: 'होंगे', hongi: 'होंगी', hoti: 'होती', hona: 'होना', hone: 'होने', rahi: 'रही', raha: 'रहा', rahe: 'रहे',
    main: 'मैं', mujhe: 'मुझे', maine: 'मैंने', meri: 'मेरी', mere: 'मेरे', hum: 'हम', aap: 'आप', aapka: 'आपका', aapki: 'आपकी', aapke: 'आपके', aapko: 'आपको', aapne: 'आपने', aapse: 'आपसे', woh: 'वह', wo: 'वो', ye: 'ये', yeh: 'यह', unka: 'उनका', koi: 'कोई', kisi: 'किसी', kuch: 'कुछ',
    kya: 'क्या', kab: 'कब', kis: 'किस', kaha: 'कहा', kitna: 'कितना', kitne: 'कितने', kitni: 'कितनी', kaunsa: 'कौनसा', kaunse: 'कौनसे', kaunsi: 'कौनसी', jab: 'जब', tab: 'तब', ab: 'अब', abhi: 'अभी', phir: 'फिर', pehle: 'पहले', baad: 'बाद', aage: 'आगे', yahan: 'यहाँ', jaise: 'जैसे', waise: 'वैसे', aisa: 'ऐसा', aisi: 'ऐसी',
    haan: 'हाँ', ji: 'जी', nahi: 'नहीं', nahin: 'नहीं', theek: 'ठीक', bilkul: 'बिलकुल', zaroor: 'ज़रूर', sahi: 'सही', galat: 'ग़लत', bas: 'बस', sirf: 'सिर्फ़', yaani: 'यानी', matlab: 'मतलब', warna: 'वरना', shayad: 'शायद', isliye: 'इसलिए', lekin: 'लेकिन', magar: 'मगर',
    namaste: 'नमस्ते', namaskar: 'नमस्कार', namaskaram: 'नमस्कारम', namaskara: 'नमस्कारा', nomoskar: 'नोमोस्कार', vanakkam: 'वणक्कम', dhanyavaad: 'धन्यवाद', shukriya: 'शुक्रिया', maaf: 'माफ़', maafi: 'माफ़ी', shubh: 'शुभ', din: 'दिन', aaj: 'आज', kal: 'कल', subah: 'सुबह', shaam: 'शाम', baje: 'बजे', samay: 'समय', minute: 'मिनट', minutes: 'मिनट',
    baar: 'बार', pichhli: 'पिछली', pichhle: 'पिछले', liye: 'लिए', liya: 'लिया', lijiye: 'लीजिए', lena: 'लेना', lene: 'लेने', lete: 'लेते', le: 'ले', loon: 'लूँ', diya: 'दिया', di: 'दी', de: 'दे', dena: 'देना', dene: 'देने', denge: 'देंगे', deti: 'देती', dijiye: 'दीजिए', doon: 'दूँ', do: 'दो',
    bhej: 'भेज', bhejun: 'भेजूँ', bheja: 'भेजा', bhejo: 'भेजो', bhejna: 'भेजना', bhejenge: 'भेजेंगे', kar: 'कर', karna: 'करना', karni: 'करनी', karenge: 'करेंगे', karungi: 'करूँगी', karte: 'करते', karwa: 'करवा', kijiye: 'कीजिए', karein: 'करें', bata: 'बता', bataiye: 'बताइए', batayenge: 'बताएँगे', bol: 'बोल', kahein: 'कहें',
    chahiye: 'चाहिए', chahein: 'चाहें', chahenge: 'चाहेंगे', chahti: 'चाहती', sakti: 'सकती', sakte: 'सकते', sakta: 'सकता', gaya: 'गया', gayi: 'गई', gaye: 'गए', jata: 'जाता', jayega: 'जाएगा', jaayega: 'जाएगा', aaya: 'आया', aayi: 'आई', aaye: 'आए', aate: 'आते', aayegi: 'आएगी', chuki: 'चुकी', chuka: 'चुका',
    milega: 'मिलेगा', milegi: 'मिलेगी', lag: 'लग', lagta: 'लगता', rakh: 'रख', rakhun: 'रखूँ', rakhna: 'रखना', daal: 'डाल', hata: 'हटा', badal: 'बदल', badalni: 'बदलनी', badalna: 'बदलना', badhein: 'बढ़ें', paayi: 'पाई', samajh: 'समझ', samajhne: 'समझने', samaapt: 'समाप्त', pahuncha: 'पहुँचा', hazir: 'हाज़िर', madad: 'मदद',
    baat: 'बात', ek: 'एक', dohra: 'दोहरा', kul: 'कुल', chhota: 'छोटा', chhoti: 'छोटी', bada: 'बड़ा', badi: 'बड़ी', naya: 'नया', nayi: 'नई', alag: 'अलग', pura: 'पूरा', poora: 'पूरा', baaki: 'बाकी', bache: 'बचे', kam: 'कम', zyada: 'ज़्यादा', jyada: 'ज़्यादा', kaafi: 'काफ़ी', thoda: 'थोड़ा', bahut: 'बहुत', mehenga: 'महँगा', mehnga: 'महँगा',
    paas: 'पास', saath: 'साथ', jagah: 'जगह', zarurat: 'ज़रूरत', zaroori: 'ज़रूरी', jaankari: 'जानकारी', shikayat: 'शिकायत', darj: 'दर्ज', sampark: 'संपर्क', asuvidha: 'असुविधा', dikkat: 'दिक्कत', aawaz: 'आवाज़', awaaz: 'आवाज़', saaf: 'साफ़', vaada: 'वादा', udhaar: 'उधार', maal: 'माल', dobara: 'दोबारा', mat: 'मत', wale: 'वाले', wala: 'वाला', wali: 'वाली', sabse: 'सबसे', har: 'हर', mahine: 'महीने', hafte: 'हफ़्ते',
    // English trade words, written the way they are said in Hindi
    order: 'ऑर्डर', orders: 'ऑर्डर', piece: 'पीस', pieces: 'पीस', litre: 'लीटर', liter: 'लीटर', pouch: 'पाउच', pouches: 'पाउच', bottle: 'बोतल', box: 'बॉक्स', boxes: 'बॉक्स', pack: 'पैक', packet: 'पैकेट', size: 'साइज़', sizes: 'साइज़',
    distributor: 'डिस्ट्रीब्यूटर', sales: 'सेल्स', assistant: 'असिस्टेंट', officer: 'ऑफ़िसर', representative: 'रिप्रेज़ेंटेटिव', team: 'टीम', stock: 'स्टॉक', price: 'प्राइस', rate: 'रेट', billing: 'बिलिंग', total: 'टोटल', value: 'वैल्यू', discount: 'डिस्काउंट', scheme: 'स्कीम', free: 'फ़्री', offer: 'ऑफ़र',
    place: 'प्लेस', confirm: 'कन्फ़र्म', confirmation: 'कन्फ़र्मेशन', cancel: 'कैंसिल', delivery: 'डिलीवरी', payment: 'पेमेंट', credit: 'क्रेडिट', complaint: 'कंप्लेंट', request: 'रिक्वेस्ट', note: 'नोट', number: 'नंबर', call: 'कॉल', callback: 'कॉल बैक', product: 'प्रोडक्ट', item: 'आइटम', line: 'लाइन', extra: 'एक्स्ट्रा', final: 'फ़ाइनल', available: 'अवेलेबल', regularly: 'रेगुलरली', normal: 'नॉर्मल', trial: 'ट्रायल', try: 'ट्राई', area: 'एरिया', sir: 'सर', madam: 'मैडम', schedule: 'शेड्यूल', terms: 'टर्म्स', booking: 'बुकिंग', suggestion: 'सजेशन', quantity: 'क्वांटिटी',
    add: 'ऐड', time: 'टाइम', margin: 'मार्जिन', conversion: 'कन्वर्ज़न', list: 'लिस्ट', date: 'डेट', promise: 'प्रॉमिस', per: 'प्रति', out: 'आउट', follow: 'फ़ॉलो', up: 'अप', of: 'ऑफ़', reserved: 'रिज़र्व्ड',
    // brands and products
    marico: 'मैरिको', asha: 'आशा', parachute: 'पैराशूट', coconut: 'कोकोनट', oil: 'ऑयल', advansed: 'एडवांस्ड', jasmine: 'जैस्मिन', hair: 'हेयर', saffola: 'सफ़ोला', gold: 'गोल्ड', edible: 'एडिबल', active: 'एक्टिव', masala: 'मसाला', oats: 'ओट्स', nihar: 'निहार', naturals: 'नेचुरल्स', shanti: 'शांति', badam: 'बादाम', amla: 'आंवला', livon: 'लिवॉन', serum: 'सीरम', styler: 'स्टाइलर', gel: 'जेल', set: 'सेट', wet: 'वेट', deodorant: 'डिओडोरेंट', spray: 'स्प्रे', dabur: 'डाबर',
    // shop words and the names in the retailer master
    store: 'स्टोर', stores: 'स्टोर्स', kirana: 'किराना', traders: 'ट्रेडर्स', general: 'जनरल', provision: 'प्रोविज़न', super: 'सुपर', bazaar: 'बाज़ार', mart: 'मार्ट',
    sharma: 'शर्मा', vijay: 'विजय', gupta: 'गुप्ता', kiran: 'किरण', verma: 'वर्मा', suresh: 'सुरेश', yadav: 'यादव', ashok: 'अशोक', patel: 'पटेल', deepak: 'दीपक', shah: 'शाह', mahesh: 'महेश', agarwal: 'अग्रवाल', prakash: 'प्रकाश', patil: 'पाटिल', mohan: 'मोहन', deshmukh: 'देशमुख', rajesh: 'राजेश', murugan: 'मुरुगन', sanjay: 'संजय', selvam: 'सेल्वम', gopal: 'गोपाल', kannan: 'कन्नन', dinesh: 'दिनेश', reddy: 'रेड्डी', manoj: 'मनोज', naidu: 'नायडू', lakshmi: 'लक्ष्मी', gowda: 'गौड़ा', anil: 'अनिल', nair: 'नायर', ravi: 'रवि', das: 'दास', meena: 'मीना', mohanty: 'मोहंती', sunil: 'सुनील', singh: 'सिंह', arun: 'अरुण', bora: 'बोरा', ramesh: 'रमेश', mishra: 'मिश्रा', jain: 'जैन', pandey: 'पांडे', khan: 'ख़ान', desai: 'देसाई', mehta: 'मेहता', tiwari: 'तिवारी', kulkarni: 'कुलकर्णी', jadhav: 'जाधव', arumugam: 'अरुमुगम', rajendran: 'राजेंद्रन', prasad: 'प्रसाद', rao: 'राव', shetty: 'शेट्टी', menon: 'मेनन', ghosh: 'घोष', sahu: 'साहू', chauhan: 'चौहान', gogoi: 'गोगोई', saxena: 'सक्सेना', bansal: 'बंसल', joshi: 'जोशी', pawar: 'पवार', varma: 'वर्मा', hegde: 'हेगड़े', pillai: 'पिल्लई', saha: 'साहा', behera: 'बेहरा', baruah: 'बरुआ', rastogi: 'रस्तोगी'
  };

  function hindiSpeech(text) {
    let t = String(text);
    t = t.replace(/\s*\([^)]*[^\x00-\x7F][^)]*\)/g, '');          // "Namaskar (नमस्कार)" -> "Namaskar"
    t = t.replace(/\b(?:order\s+)?ORD-[\w-]+/gi, 'ऑर्डर');            // order IDs are shown, not read out
    t = t.replace(/\bCMP-[\w-]+\s*/g, '');                          // complaint IDs are shown, not read out
    t = t.replace(/\bdo[- ]not[- ]call\b/gi, 'डू नॉट कॉल').replace(/\bfollow[- ]up\b/gi, 'फ़ॉलो-अप').replace(/\bout of stock\b/gi, 'आउट ऑफ़ स्टॉक');
    t = t.replace(/(\d),(?=\d)/g, '$1');                             // 5,600 -> 5600
    t = t.replace(/(?:₹|Rs\.?\s?)\s?(\d+)/g, '$1 रुपये');            // ₹5600 -> 5600 rupaye
    t = t.replace(/(\d)\s*ml\b/gi, '$1 एमएल').replace(/(\d)\s*kg\b/gi, '$1 किलो').replace(/(\d)\s*g\b/g, '$1 ग्राम').replace(/(\d)\s*L\b/g, '$1 लीटर');
    t = t.replace(/\bAI\b/g, 'ए आई').replace(/\bSKU\b/g, 'एस के यू').replace(/\bMRP\b/g, 'एम आर पी').replace(/\bOK\b/gi, 'ओके');
    t = t.replace(/(\d+)\s*[x×]\s*(?=\d)/g, '$1 गुणा ');
    t = t.replace(/[A-Za-z]+/g, w => W[w.toLowerCase()] || w);
    t = t.replace(/\s*[;|]\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
    return t;
  }
  function englishSpeech(text) {
    let t = String(text);
    t = t.replace(/\s*\([^)]*[^\x00-\x7F][^)]*\)/g, '');
    t = t.replace(/\b(?:order\s+)?ORD-[\w-]+/gi, 'your order');
    t = t.replace(/(\d),(?=\d)/g, '$1').replace(/(?:₹|Rs\.?\s?)\s?(\d+)/g, '$1 rupees');
    t = t.replace(/(\d)\s*ml\b/gi, '$1 ml').replace(/(\d)\s*L\b/g, '$1 litre');
    return t.replace(/\s{2,}/g, ' ').trim();
  }
  function speechText(text, lang) {
    if (!text) return '';
    if (/[ऀ-ॿ]/.test(text) && !/[A-Za-z]{3,}/.test(text)) return text;   // already Devanagari
    return lang === 'en' ? englishSpeech(text) : hindiSpeech(text);
  }
  // split into sentence-sized pieces: Chrome cuts long utterances off after ~15 s
  function chunks(t) {
    const parts = t.split(/(?<=[.!?।])\s+/).filter(Boolean), out = [];
    for (const p of parts) { if (out.length && (out[out.length - 1] + ' ' + p).length < 140) out[out.length - 1] += ' ' + p; else out.push(p); }
    return out;
  }
  // Asha is a woman and her Hindi lines use female forms (bol rahi hoon, samajh gayi, karungi),
  // so a female voice is always preferred; a male voice is used only if nothing else exists.
  const FEMALE = /Swara|Kalpana|Lekha|Neerja|Heera|Veena|Ananya|Aditi|Samantha|Zira|Google|female/i;
  const MALE = /Madhur|Hemant|Prabhat|Rishi|Ravi|Aarav|Kunal|Rehaan|male/i;
  function rankVoice(v, lang) {
    const n = v.name, l = (v.lang || '').replace('_', '-').toLowerCase();
    if (lang === 'en' ? !l.startsWith('en') : !l.startsWith('hi')) return -1;
    if (MALE.test(n) && !/female/i.test(n)) return 0.5;
    let s = 1;
    if (lang === 'en' && l === 'en-in') s += 2;             // Indian English accent preferred among female voices
    if (FEMALE.test(n)) s += 10;
    if (/Natural|Neural|Online/i.test(n)) s += 4;          // Edge: Microsoft Swara / Neerja (Natural)
    if (/Google/i.test(n)) s += 3;                          // Chrome: Google हिन्दी (female)
    return s;
  }
  function pickVoice(lang) {
    if (typeof speechSynthesis === 'undefined') return null;
    let best = null, bs = 0;
    for (const v of speechSynthesis.getVoices()) { const s = rankVoice(v, lang); if (s > bs) { bs = s; best = v; } }
    return best;
  }
  if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.getVoices(); speechSynthesis.addEventListener('voiceschanged', () => speechSynthesis.getVoices()); } catch (e) { } }

  // Some browsers (Chrome, the Claude desktop browser) list no voices until speech is first used.
  // Speaking before the list arrives means the system default voice, which can be male.
  // warmUp() (on the Start call click) starts loading; say() waits for the list (up to 2.5 s).
  function warmUp() {
    if (typeof speechSynthesis === 'undefined') return;
    try { speechSynthesis.getVoices(); const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { }
  }
  function whenVoicesReady(cb, maxMs) {
    if (typeof speechSynthesis === 'undefined' || speechSynthesis.getVoices().length) return cb();
    let fired = false;
    const go = () => { if (fired) return; fired = true; try { speechSynthesis.removeEventListener('voiceschanged', go); } catch (e) { } cb(); };
    try { speechSynthesis.addEventListener('voiceschanged', go); } catch (e) { }
    const t0 = Date.now();
    (function poll() { if (fired) return; if (speechSynthesis.getVoices().length || Date.now() - t0 > (maxMs || 2500)) return go(); setTimeout(poll, 100); })();
  }

  let sayId = 0;
  function stop() { sayId++; if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch (e) { } } }

  // speak with the browser voice. onDone runs once when the last sentence has been spoken
  // (or at once if nothing can be spoken); onVoice gets the name of the voice used ('' if none).
  function say(text, lang, onDone, onVoice) {
    let doneCalled = false;
    const done = () => { if (!doneCalled) { doneCalled = true; if (onDone) onDone(); } };
    if (typeof speechSynthesis === 'undefined' || !text) { if (onVoice) onVoice(''); setTimeout(done, 0); return; }
    const id = ++sayId;
    whenVoicesReady(() => {
      if (id !== sayId) { done(); return; }   // stopped while waiting
      const listed = speechSynthesis.getVoices().length > 0;
      let v = pickVoice(lang === 'en' ? 'en' : 'hi'), t, uLang;
      if (lang === 'en') { t = englishSpeech(text); uLang = v ? v.lang : 'en-IN'; }
      else if (v) { t = speechText(text, 'hi'); uLang = v.lang; }
      else if (!listed) { t = speechText(text, 'hi'); uLang = 'hi-IN'; }   // voice list never arrived: let the system use its Hindi voice
      else { v = pickVoice('en'); t = englishSpeech(text); uLang = v ? v.lang : 'en-IN'; }   // no Hindi voice installed: an English voice reads the Hinglish
      if (onVoice) onVoice(v ? v.name : '');
      speechSynthesis.cancel();
      const parts = chunks(t);
      if (!parts.length) { setTimeout(done, 0); return; }
      parts.forEach((c, i) => {
        const u = new SpeechSynthesisUtterance(c);
        u.lang = uLang; if (v) u.voice = v; u.rate = lang === 'en' ? 1 : 0.95;
        if (i === parts.length - 1) { u.onend = done; u.onerror = done; }
        speechSynthesis.speak(u);
      });
      // safety net: some browsers never fire onend (no audio device); roughly 70 ms per character
      setTimeout(done, 1500 + t.length * 70);
    });
  }
  return { speechText, hindiSpeech, englishSpeech, pickVoice, say, stop, warmUp, chunks, WORDS: W };
});
