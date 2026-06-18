// Rating speed/quality benchmark.
//
// Sweeps the AI rater across several reasoning budgets on a fixed set of sample
// predictions, printing per-call latency and the star rating each budget gives.
// Use it to find the smallest (= fastest) reasoning_budget whose ratings still
// match the high-budget reference — i.e. speed without losing quality.
//
//   NVIDIA_NIM_API_KEY=... node scripts/rating-bench.mjs
//   node scripts/rating-bench.mjs 256 512 1024     # custom budget list
//
// Once you pick a value, set NIM_REASONING_BUDGET in .env (no code change).

import 'dotenv/config';
import { rateWithAI, MODEL } from '../src/nim.js';

const BUDGETS = (process.argv.slice(2).map(Number).filter(Boolean));
const SWEEP = BUDGETS.length ? BUDGETS : [256, 512, 768, 1024];
const RUNS = 2; // repeats per (sample, budget) to expose run-to-run variance

// Samples span the full quality range. `expect` is the human-correct rating —
// the reference a fast budget must still reproduce.
const SAMPLES = [
  {
    name: 'strong-3-EUsummit', expect: 3,
    ctx: {
      title: 'EU Council MFF guidance', category: 'Macro', deadline: '2026-06-19',
      description: 'The Cyprus Presidency delivered the revised MFF 2028-2034 negotiating box with concrete figures on 11 June. The 18-19 June European Council is meant to advance exactly this box; no big new decisions on defense borrowing are expected — mainly political guidance before handing off to the Irish Presidency. This rides the actual process already in motion.',
      eventName: 'June European Council', outcomeName: 'Leaders give guidance on the MFF box, no major new instruments',
    },
  },
  {
    name: 'strong-3-norges', expect: 3,
    ctx: {
      title: 'Norges Bank June decision', category: 'Macro', deadline: '2026-06-18',
      description: 'Norges Bank holds at 4.25% on 18 June, and in MPR 2/26 the end-2026 rate path stays above 4.25% (hawkish bias maintained), consistent with recent inflation prints and post-May guidance.',
      eventName: 'Norges Bank meeting', outcomeName: 'Hold at 4.25% + hawkish path',
    },
  },
  {
    name: 'thin-1', expect: 1,
    ctx: { title: 'BTC', category: 'Crypto', deadline: '2026-07-01', description: 'I think BTC goes up this month, the trend is up.' },
  },
  {
    name: 'clear-2', expect: 2,
    ctx: { title: 'ETH ETF flows', category: 'Crypto', deadline: '2026-07-15', description: 'ETH outperforms BTC this month because spot ETF net inflows have turned positive three weeks running and supply on exchanges is falling.' },
  },
  {
    name: 'zero-question', expect: 0,
    ctx: { title: 'Award show', category: 'Pop', deadline: '2026-07-01', description: 'who else should win?' },
  },
  {
    name: 'zero-restate', expect: 0,
    ctx: { title: 'Fed decision', category: 'Macro', deadline: '2026-07-30', description: 'The Fed will decide on interest rates at the July meeting.' },
  },
];

const ms = (a, b) => Math.round(b - a);
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`Model: ${MODEL}\nBudgets: ${SWEEP.join(', ')} · ${RUNS} runs each\n`);

const summary = {}; // budget -> {matches, total, latencies[]}
for (const b of SWEEP) summary[b] = { matches: 0, total: 0, latencies: [] };

for (const s of SAMPLES) {
  console.log(`\n● ${s.name}  (expected ${s.expect}★)`);
  for (const budget of SWEEP) {
    const stars = [];
    const lats = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      try {
        const r = await rateWithAI(s.ctx, { reasoningBudget: budget, attempts: 1 });
        lats.push(ms(t0, performance.now()));
        stars.push(r.stars);
      } catch (err) {
        lats.push(ms(t0, performance.now()));
        stars.push('ERR');
        console.log(`   (budget ${budget} run ${i + 1} failed: ${err.message.slice(0, 80)})`);
      }
    }
    const ok = stars.every(v => v === s.expect);
    summary[budget].total += 1;
    if (ok) summary[budget].matches += 1;
    summary[budget].latencies.push(...lats.filter(Number.isFinite));
    const flag = ok ? '✓' : '✗';
    console.log(`   budget ${String(budget).padStart(4)} → ${flag} stars=[${stars.join(', ')}]  latency≈${median(lats)}ms`);
  }
}

console.log('\n──── summary ────');
for (const b of SWEEP) {
  const s = summary[b];
  const acc = `${s.matches}/${s.total} samples matched expected`;
  const lat = s.latencies.length ? `${median(s.latencies)}ms median` : 'n/a';
  console.log(`budget ${String(b).padStart(4)}: ${acc} · ${lat}`);
}
console.log('\nPick the smallest budget that still matches expected on every sample, then set NIM_REASONING_BUDGET to it in .env.');
