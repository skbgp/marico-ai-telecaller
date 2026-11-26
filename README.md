# Marico AI Telecaller (prototype)

Marico x IIT Madras, AI-Powered General Trade Telecalling build challenge. Shubham Kumar, M.Tech CSE, IIT Madras (CS25M046).

**Live demo:** https://skbgp.github.io/marico-ai-telecaller/ (open in Chrome or Edge)

**Slides:** [Solution Presentation (5 slides)](slides/Solution_Presentation_Shubham_Kumar_CS25M046.pdf), [Scalability Approach (3 slides)](slides/Scalability_Approach_Shubham_Kumar_CS25M046.pdf)

## How to use the demo

1. Pick a retailer from the call list (sorted by call priority) and click **Start call**. Asha (the AI agent) dials, the retailer picks up, and she speaks first.
2. Answer as the retailer: type, tap the mic and talk (Chrome or Edge, Hindi or English), or click one of the test replies under the box. The test replies change with the stage of the call.
3. Each turn shows what the agent did (identity confirmed, line added, stock short, order read back...) and then her reply. The order builds on the right as lines are booked; the call ends with a summary (order placed, callback booked, complaint logged...).
4. The right panel also has the pre-call analysis (why this retailer, what and how much to suggest), every tool call, the final JSON record, and a **Tests** tab that runs all 45 scenarios in the browser.

Voice: the agent speaks with the browser's own female Hindi or English voice (best in Chrome or Edge; Edge's natural voices sound best). Her Hindi replies are written in Latin letters on screen, so voice.js converts them to Devanagari before speaking, reads ₹ amounts and pack sizes the Indian way, and skips order and complaint IDs. The mic is hands-free: after Asha finishes a reply it listens again, until you tap it off. Note: the built-in browser of the Claude desktop app can only use the computer's default voice (often male), so open the demo in Chrome, Edge or Safari to hear Asha's female voice.

On GitHub Pages the agent runs in rule-based mode (Hinglish + English; the greeting is in the retailer's language). LLM mode (Claude with tool calling, for free speech in any language) is in the same code but needs Claude's runtime, so it is switched off here. Both modes use the same 16 tools and checks.

## Tests

```
node run_tests.js        45 scenarios: CS01-CS19 from the workbook, SX1-SX6 surprise scenarios from the brief, RX1-RX20 extra
node stress_test.js      simple order flow for all 100 retailers in Hindi and English, plus 1,200 random calls
```

Each scenario checks the call record against its pass criteria. The stress test checks every call for crashes, broken replies, lines above distributor stock, discounts, and orders placed without a read-back.

## Files

```
index.html, agent_core.js, scenarios.js, voice.js, marico_data.json   the web app (static, no server needed)
agent_core.js         planner + 16 tools with checks + rule-based dialogue manager
voice.js              Hindi speech: Hinglish to Devanagari, female Hindi voice, sentence-by-sentence playback
scenarios.js          the 45 test scenarios
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
