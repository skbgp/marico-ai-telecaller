# Marico AI Telecaller (prototype)

Marico x IIT Madras, AI-Powered General Trade Telecalling build challenge. Shubham Kumar, M.Tech CSE, IIT Madras.

**Live demo:** https://skbgp.github.io/marico-ai-telecaller/ (open in Chrome or Edge)
**LLM mode (Claude):** https://claude.ai/artifact/Cj3BLD6VCCf2seNrhiK4R1

**Slides:** [Solution Presentation (5 slides)](slides/Solution_Presentation_Shubham_Kumar.pdf), [Scalability Approach (3 slides)](slides/Scalability_Approach_Shubham_Kumar.pdf)

## How to use the demo

1. Pick a retailer from the call list (sorted by call priority) and click **Start call**. The agent speaks first.
2. Act as the retailer: type, use the mic (Chrome/Edge, Hindi or English), or click a sample reply.
3. The right panel shows the order, the pre-call analysis (why this retailer, what and how much to suggest), every tool call, the final JSON record, and a **Tests** tab that runs all 35 scenarios in the browser.

On GitHub Pages the agent runs in rule-based mode (Hinglish + English). LLM mode (Claude with tool calling, all 10 languages) runs on the claude.ai link because it needs Claude.

## Files

```
index.html, agent_core.js, scenarios.js, marico_data.json   the web app (static, no server needed)
agent_core.js         planner + 16 tools with checks + rule-based dialogue manager
scenarios.js          35 test scenarios (CS01-CS19 workbook, SX1-SX6 surprise, RX1-RX10 extra)
run_tests.js          node runner:  node run_tests.js  (add --verbose for transcripts)
test_results.json     last test run with full transcripts
data/raw/             the 3 sheets supplied with the case, unchanged
data/Marico_CaseStudy_Data_Completed.xlsx   supplied sheets + rebuilt sheets + README sheet
slides/               Solution Presentation and Scalability Approach (PDF)
scripts/reconstruct_missing_sheets.py       rebuilds Retailer_Master, Product_Master, Purchase_History (seed 20261125)
```

## Note on data

The shared workbook had only 3 of the 7 sheets described in the brief (Retailer_Preferences, Distributor_Inventory, Call_Scenarios with 19 rows). The other sheets were rebuilt from the supplied ones so the agent can run. All data is synthetic, as stated in the case; prices are illustrative. To use official sheets, put them in the workbook and re-run the script (it also rewrites marico_data.json).
