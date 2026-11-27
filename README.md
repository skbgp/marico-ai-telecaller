# Marico AI Telecaller (prototype)

Marico x IIT Madras, AI-Powered General Trade Telecalling build challenge. Shubham Kumar, M.Tech CSE, IIT Madras (CS25M046).

**Live demo:** https://skbgp.github.io/marico-ai-telecaller/ (open in Microsoft Edge to hear every language's voice, or Chrome)

**Slides:** [Solution Presentation (5 slides)](slides/Solution_Presentation_Shubham_Kumar_CS25M046.pdf), [Scalability Approach (3 slides)](slides/Scalability_Approach_Shubham_Kumar_CS25M046.pdf)

## How to use the demo

1. Pick a retailer from the call list (sorted by call priority) and click **Start call**. Asha (the AI agent) dials, the retailer picks up, and she speaks first.
2. Answer as the retailer: type, tap the mic and talk (Chrome or Edge), or click one of the test replies under the box. The test replies change with the stage of the call. Asha speaks the retailer's own language (Hindi, English, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati, Odia or Assamese, from the retailer master); under each regional-language line the screen shows its English meaning.
3. Each turn shows what the agent did (identity confirmed, line added, stock short, order read back...) and then her reply. The order builds on the right as lines are booked; the call ends with a summary (order placed, callback booked, complaint logged...).
4. The right panel also has the pre-call analysis (why this retailer, what and how much to suggest), every tool call, the final JSON record, and a **Tests** tab that runs all 52 scenarios in the browser.

Voice: the agent speaks with the browser's own female voice for the call's language. Hindi: her replies are written in Latin letters on screen, so voice.js converts them to Devanagari before speaking, reads ₹ amounts and pack sizes the Indian way, and skips order and complaint IDs. Regional languages: Microsoft Edge has female voices for Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi and Gujarati, so open the demo in **Edge** to hear them. Where the browser has no voice for the language (Chrome on most laptops, and Odia and Assamese everywhere), Asha reads the English meaning of the line instead and the page says so; Marathi falls back to the Hindi voice, which reads Devanagari. The mic is hands-free: after Asha finishes a reply it listens again, until you tap it off. Note: the built-in browser of the Claude desktop app can only use the computer's default voice (often male), so open the demo in Edge, Chrome or Safari.

On GitHub Pages the agent runs in rule-based mode. It speaks the retailer's preferred language for the whole call: all 60 of its lines are written in each of the nine regional languages (languages.js), with product names, pack sizes and numbers kept as retailers say them ("Parachute 500 ml 15 pieces"), and the owner addressed the local way (Murugan sir, Lakshmi garu, Patil saheb, Meena di). It understands yes / no / "that's all" in all 10 languages (for example Tamil "aamaa", "illai", "podhum"; these show as test replies for those retailers), and switches language when asked ("Can we speak in English?", "Tamil please", "Hindi nahi aati"), asking its open question again in the new language and keeping the order. The regional lines are drafted for the prototype; before go-live each language is reviewed by native-speaker sales staff. LLM mode (Claude with tool calling, for free speech in any language) is in the same code but needs Claude's runtime, so it is switched off here. Both modes use the same 16 tools and checks.

## Tests

```
node run_tests.js        52 scenarios: CS01-CS19 from the workbook, SX1-SX6 surprise scenarios from the brief, RX1-RX27 extra
node stress_test.js      order flow for all 100 retailers in Hindi, English and their own words for yes / no, plus 1,500 random calls
```

Each scenario checks the call record against its pass criteria (RX1 and RX22-RX24 run whole calls in the regional languages). The stress test checks every call for crashes, broken replies, lines above distributor stock, discounts, and orders placed without a read-back, and every regional-language line (about 7,500) for the right script, no Hindi left in it, and a complete English meaning.

## Business impact (what the pilot measures)

| Measure | How the agent moves it | Pilot measure |
|---|---|---|
| Retailer engagement | Every due outlet is called in its own window and language, with one useful suggestion and no pushing | pick-up rate, call completion, opt-outs under 1% |
| Calling productivity | Thousands of calls run in parallel; people handle only the 2-3% of calls that need them | calls a day, cost per connected call |
| Order conversion | Calls when the outlet is due, opens with its last order, reads back before confirming | orders per connected call, A/B vs telecallers |
| Average order value | Quantity from the outlet's own run-rate (capped at 1.5x), lapsed lines restarted, one in-stock add-on | AOV vs a control group |
| Assortment penetration | Cross-sells only what 25%+ of similar outlets stock and the distributor has in stock | SKUs per outlet, suggestion acceptance |
| Cost per order | About ₹6 vs ₹18 per connected call (estimate); no orders lost to stock or unit mistakes | call cost divided by conversion |

## From prototype to production

1. **Pilot (weeks 1-6, 2,000 outlets, 1 distributor):** telephony on SIP with DLT-registered 140 / 1600 numbers, Indic speech-to-text and text-to-speech, DMS order API, consent and recording, QA review of calls; shadow mode, then live A/B against telecallers.
2. **Region (months 2-4, 50,000 outlets):** speech models tuned on recorded calls per language, DMS adapters per distributor cluster, CRM tasks, WhatsApp copy of each order.
3. **Multi-region (months 4-6, 2 lakh outlets):** learned suggestion model, price and scheme feeds, live operations dashboard.
4. **National (months 6-9, 5 lakh outlets):** multi-carrier failover, 24x7 monitoring, cost controls, compliance audit reports.

Each stage starts only after the previous one passes its gate (order accuracy, per-language capture rate, cost per order, latency). Details in the Scalability Approach slides.

## Files

```
index.html, agent_core.js, languages.js, scenarios.js, voice.js, marico_data.json   the web app (static, no server needed)
agent_core.js         planner + 16 tools with checks + rule-based dialogue manager
languages.js          Asha's lines in Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati, Odia and Assamese
voice.js              speech: Hinglish to Devanagari for Hindi, a female voice per language, English meaning when none
scenarios.js          the 52 test scenarios
run_tests.js          test runner (add --verbose for transcripts)
stress_test.js        stress test
test_results.json     last test run with full transcripts
data/raw/             the 3 sheets supplied with the case, unchanged
data/Marico_CaseStudy_Data_Completed.xlsx   supplied sheets + rebuilt sheets + README sheet
slides/               Solution Presentation and Scalability Approach (PDF)
scripts/reconstruct_missing_sheets.py       rebuilds Retailer_Master, Product_Master, Purchase_History (seed 20261125)
```

## Note on data

The shared workbook had only 3 of the 7 sheets described in the brief (Retailer_Preferences, Distributor_Inventory, Call_Scenarios with 19 rows). The other sheets were rebuilt from the supplied ones so the agent can run. All data is synthetic, as stated in the case; prices are illustrative. To use official sheets, put them in the workbook and re-run the script (it also rewrites marico_data.json).
