/* Node runner for the shared scenario suite.  Usage: node run_tests.js [--verbose] [--out results.json] */
const fs = require('fs');
const path = require('path');
const A = require('./agent_core.js');
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'marico_data.json'), 'utf8'));
const suite = require('./scenarios.js')(A, DATA);
const verbose = process.argv.includes('--verbose');
const outIdx = process.argv.indexOf('--out');
const results = suite.run();
let pass = 0;
for (const r of results) {
  if (r.pass) pass++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}`);
  r.checks.forEach(c => { if (!c.pass || verbose) console.log(`        ${c.pass ? 'ok ' : 'XX '} ${c.check}`); });
  if (verbose || !r.pass) r.transcript.forEach(x => console.log(`          ${x.who === 'agent' ? 'AGENT   ' : 'RETAILER'}: ${x.text}${x.confidence !== undefined && x.confidence < 1 ? ` (asr ${x.confidence})` : ''}`));
}
console.log(`\n${pass}/${results.length} scenarios passed`);
if (outIdx > 0) fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(results, null, 1));
process.exit(pass === results.length ? 0 : 1);
