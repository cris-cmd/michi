/**
 * harness/latency.ts — live model-latency probe for the streaming turn path.
 *
 *   MICHI_MODEL=claude-opus-5   npx vite-node harness/latency.ts
 *   MICHI_MODEL=claude-sonnet-5 npx vite-node harness/latency.ts
 *   EFFORT=low|medium to vary effort (default low, same as the app).
 *
 * Per representative turn it reports:
 *   ttftMs        — first raw token of the structured output
 *   firstPhraseMs — first SPEAKABLE phrase assembled (what the avatar can
 *                   start saying; the number that drives perceived latency)
 *   totalMs       — full validated response
 * Text-only: no ElevenLabs, no Perxona — this isolates the model's share.
 */
import { agentTurn } from '../src/agent/core';
import { ReplyStreamExtractor } from '../src/agent/streamExtract';
import { PhraseAssembler } from '../src/conversation/phrases';
import type { ChatTurn } from '../src/agent/client';

const TURNS: { label: string; history: ChatTurn[] }[] = [
  {
    label: 'initial request',
    history: [
      {
        role: 'user',
        content:
          "We have about four hours before dinner. It's raining and our eight-month-old is with us. We'd like something genuinely local and cultural, around ¥15,000. Nothing too crowded.",
      },
    ],
  },
  {
    label: 'revision (quiet↑)',
    history: [
      {
        role: 'user',
        content:
          "We have about four hours before dinner. It's raining and our eight-month-old is with us. Something local and cultural please.",
      },
      {
        role: 'assistant',
        content:
          '{"language":"en","tone":"warm","reply":"Rainy afternoons are made for this. I\'d start with a private tea ceremony, a wagashi workshop, or an indoor craft studio.","stage":"suggest","constraints":{"time_available_minutes":240,"infants":1},"candidates":["a001","a002","a012"],"excluded":[{"id":"a006","reason":"Taiko drumming is the loudest hour in Tokyo — not with a baby along."}],"selection":null,"question":null,"motion":null,"plan_intent":null}',
      },
      { role: 'user', content: 'Actually, the baby just fell asleep. Quiet matters more than the budget now.' },
    ],
  },
  {
    label: 'quick confirmation',
    history: [
      {
        role: 'user',
        content:
          "We have about four hours before dinner. It's raining and our eight-month-old is with us. Something local and cultural please.",
      },
      {
        role: 'assistant',
        content:
          '{"language":"en","tone":"warm","reply":"Rainy afternoons are made for this. I\'d start with a private tea ceremony, a wagashi workshop, or an indoor craft studio.","stage":"suggest","constraints":{"time_available_minutes":240,"infants":1},"candidates":["a001","a002","a012"],"excluded":[{"id":"a006","reason":"Taiko drumming is the loudest hour in Tokyo — not with a baby along."}],"selection":null,"question":null,"motion":null,"plan_intent":null}',
      },
      { role: 'user', content: 'The first one sounds great — book it.' },
    ],
  },
];

async function probe(label: string, history: ChatTurn[]) {
  const extractor = new ReplyStreamExtractor();
  const assembler = new PhraseAssembler();
  const t0 = performance.now();
  let ttft = 0;
  let firstPhrase = 0;
  let phrase = '';
  const response = await agentTurn(history, {
    onRawDelta: (delta) => {
      if (!ttft) ttft = performance.now() - t0;
      const ev = extractor.push(delta);
      if (ev.replyDelta && !firstPhrase) {
        const phrases = assembler.push(ev.replyDelta);
        if (phrases.length) {
          firstPhrase = performance.now() - t0;
          phrase = phrases[0];
        }
      }
    },
  });
  const total = performance.now() - t0;
  console.log(
    `  ${label.padEnd(20)} ttft=${ttft.toFixed(0).padStart(5)}ms  firstPhrase=${firstPhrase
      .toFixed(0)
      .padStart(5)}ms  total=${total.toFixed(0).padStart(5)}ms  stage=${response.stage}  "${phrase.slice(0, 48)}"`,
  );
  return { ttft, firstPhrase, total };
}

const model = process.env.MICHI_MODEL ?? 'claude-sonnet-5 (default)';
console.log(`\nmodel=${model} effort=${process.env.EFFORT ?? 'low'}`);
console.log('warm-up call (writes the prompt cache)…');
await probe('warm-up', TURNS[0].history);
console.log('measured (cache warm):');
const results = [];
for (const t of TURNS) results.push(await probe(t.label, t.history));
const avg = (k: 'ttft' | 'firstPhrase' | 'total') =>
  Math.round(results.reduce((s, r) => s + r[k], 0) / results.length);
console.log(`  ${'AVERAGE'.padEnd(20)} ttft=${avg('ttft')}ms  firstPhrase=${avg('firstPhrase')}ms  total=${avg('total')}ms`);
