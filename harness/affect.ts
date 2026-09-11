/**
 * harness/affect.ts — offline benchmark of the affect stack (the mission-
 * listener perception). No planning, voice, or avatar APIs: just local ONNX
 * models and deterministic salience/fusion rules.
 *
 *   npx vite-node harness/affect.ts            # behavior + latency
 *
 * Audio cases need the CREMA-D fixtures (auto-skip if absent):
 *   ./scripts/fetch-affect-fixtures.sh
 * Text model downloads (~125 MB, once) into models/.cache/.
 */
import { readFileSync, existsSync } from 'node:fs';
import { handleAffect, prewarmAffect } from '../src/server/affect';
import { fuseListenerDecision } from '../src/conversation/listener/affect/fusion';
import type { AffectRead } from '../src/conversation/listener/affect/types';
import { DeterministicListenerPolicy } from '../src/conversation/listener/policy';
import type { ListenerDecision } from '../src/conversation/listener/types';

let failed = 0;
function check(pass: boolean, label: string, detail?: string) {
  if (pass) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  }
}
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** Minimal RIFF reader for the 16 kHz mono PCM16 fixtures → base64 int16. */
function wavToB64(path: string): string {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${path}: not RIFF`);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size).toString('base64');
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

async function affect(text: string, audioB64?: string): Promise<AffectRead> {
  const r = await handleAffect({ text, ...(audioB64 ? { audioB64 } : {}) });
  if (r.status !== 200) throw new Error(`affect ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json as AffectRead;
}

const policy = new DeterministicListenerPolicy();
function decide(text: string, read: AffectRead): ListenerDecision {
  return fuseListenerDecision(policy.decide(text, 'en'), read);
}

const FIX = 'harness/fixtures/affect';
const fixture = (name: string) => `${FIX}/${name}.wav`;
const hasFixtures = existsSync(fixture('1001_DFA_SAD_XX'));

async function main() {
  const rss0 = process.memoryUsage().rss;
  section('model load (cold)');
  const t0 = Date.now();
  prewarmAffect();
  await affect('warm-up sentence, please ignore.'); // forces text model load
  const textLoadMs = Date.now() - t0;
  const t1 = Date.now();
  if (hasFixtures) await affect('warm-up with audio.', wavToB64(fixture('1001_DFA_NEU_XX')));
  const audioLoadMs = Date.now() - t1;
  console.log(`  text-model cold load+first inference: ${textLoadMs} ms`);
  console.log(`  audio-model cold load+first inference: ${hasFixtures ? `${audioLoadMs} ms` : 'skipped (no fixtures)'}`);
  console.log(`  RSS after load: ${Math.round((process.memoryUsage().rss - rss0) / 1e6)} MB over baseline (${Math.round(process.memoryUsage().rss / 1e6)} MB total)`);

  // ── Text behavior cases ────────────────────────────────────────────────
  section('neutral task');
  {
    const read = await affect('Find me somewhere to eat in Shinjuku.');
    const d = decide('Find me somewhere to eat in Shinjuku.', read);
    check(read.socialResponse === 'none', `no social obligation (got ${read.socialResponse})`, JSON.stringify(read.segments.map((s) => s.socialResponse)));
    check(d.ackCategory !== 'compassion' && d.ackCategory !== 'celebration', 'ack stays task-neutral');
    check(read.taskTone === 'neutral', `taskTone neutral (got ${read.taskTone})`);
  }

  section('grief + task ("my cat just died…")');
  {
    const text = "My cat just died and I'm really sad. I want somewhere peaceful.";
    const read = await affect(text);
    const d = decide(text, read);
    check(read.socialResponse === 'compassion', `compassion required (got ${read.socialResponse})`, JSON.stringify(read.segments));
    check(read.salience >= 0.45 && read.confidence >= 0.4, `strong salience/confidence (${read.salience.toFixed(2)}/${read.confidence.toFixed(2)})`);
    check(d.ackCategory === 'compassion', `ack shelf = compassion (got ${d.ackCategory})`);
    check(d.emotion === 'compassionate', `emotion = compassionate (got ${d.emotion})`);
    check(read.taskTone === 'calm', `task tone calm (got ${read.taskTone})`);
  }

  section('mixed emotion (grief BUT fun weekend) — never averaged');
  {
    const text = "My cat died yesterday, which has been awful, but my sister is visiting this weekend and I want somewhere fun.";
    const read = await affect(text);
    const d = decide(text, read);
    check(read.segments.length >= 2, `grief and fun stay separate clauses (got ${read.segments.length})`, JSON.stringify(read.segments.map((s) => s.text)));
    check(read.socialResponse === 'compassion', `loss outranks the fun ask (got ${read.socialResponse})`);
    check(d.ackCategory === 'compassion', `ack = compassion (got ${d.ackCategory})`);
    check(read.taskTone === 'gently_positive', `task tone gently positive (got ${read.taskTone})`);
  }

  section('frustration');
  {
    const text = "I've been looking for somewhere for hours and everything is fucking booked.";
    const read = await affect(text);
    const d = decide(text, read);
    check(read.socialResponse === 'concern' || read.socialResponse === 'warmth', `frustration read (got ${read.socialResponse})`, JSON.stringify(read.segments));
    check(d.emotion === 'concerned' || d.emotion === 'warm', `warm/concerned delivery (got ${d.emotion})`);
    check(d.ackCategory !== 'positive' && d.ackCategory !== 'celebration', 'never cheerful at frustration');
  }

  section('celebration ("I just got promoted!")');
  {
    const text = 'I just got promoted! I want somewhere really nice to celebrate.';
    const read = await affect(text);
    const d = decide(text, read);
    check(read.socialResponse === 'celebration', `celebration (got ${read.socialResponse})`, JSON.stringify(read.segments));
    check(d.ackCategory === 'celebration', `ack shelf = celebration (got ${d.ackCategory})`);
    check(read.taskTone === 'upbeat', `task tone upbeat (got ${read.taskTone})`);
  }

  section('low confidence must under-react');
  {
    const read = await affect('Hmm, somewhere quiet I guess, whatever works.');
    const d = decide('Hmm, somewhere quiet I guess, whatever works.', read);
    check(d.ackCategory !== 'compassion', 'no condolence off weak evidence');
    check(d.emotion !== 'compassionate', `no strong emotional claim (got ${d.emotion})`);
  }

  section('Japanese (segmentation + loss prior)');
  {
    const text = '猫が昨日死んじゃって、本当に悲しいです。でも妹が週末に来るので、楽しい場所に行きたいです。';
    const read = await affect(text);
    check(read.segments.length >= 2, `ja clauses split (got ${read.segments.length})`, JSON.stringify(read.segments.map((s) => s.text)));
    check(read.socialResponse === 'compassion', `ja loss marker → compassion (got ${read.socialResponse})`);
    check(read.taskTone === 'gently_positive' || read.taskTone === 'calm', `ja task tone soft (got ${read.taskTone})`);
  }

  // ── Audio cases ───────────────────────────────────────────────────────
  if (hasFixtures) {
    section('audio sanity: model separates acted emotions');
    {
      for (const [file, want] of [
        ['1076_IEO_SAD_HI', 'sad'],
        ['1001_DFA_HAP_XX', 'hap'],
        ['1001_DFA_ANG_XX', 'ang'],
      ] as const) {
        const read = await affect(`fixture ${file}`, wavToB64(fixture(file)));
        const labels = read.audio?.labels ?? {};
        const top2 = Object.entries(labels).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l]) => l);
        check(top2.includes(want), `${file} → ${want} in top-2`, JSON.stringify(labels));
      }
    }

    section('tone-only sadness (neutral words, sad voice) → gentle');
    {
      const text = 'Can you find somewhere quiet for me?';
      const read = await affect(text, wavToB64(fixture('1076_IEO_SAD_HI')));
      const d = decide(text, read);
      check(d.ackCategory !== 'compassion', 'no spoken condolence from tone alone');
      check(d.emotion === 'warm' || d.emotion === 'concerned' || d.emotion === 'curious', `delivery softens (got ${d.emotion})`);
      check(read.taskTone !== 'upbeat' && read.taskTone !== 'neutral' ? true : read.socialResponse !== 'none', 'read registers the subdued voice', JSON.stringify({ social: read.socialResponse, tone: read.taskTone, audio: read.audio?.labels }));
    }

    section('text/audio disagreement (positive words, clearly sad voice) → no extreme cheer');
    {
      const text = "That's great, I'm so happy about the trip. Anywhere is fine.";
      const read = await affect(text, wavToB64(fixture('1076_IEO_SAD_HI')));
      const d = decide(text, read);
      check(d.emotion !== 'excited', `not extremely cheerful (got ${d.emotion})`);
      check(d.ackCategory !== 'celebration', `no celebration shelf (got ${d.ackCategory})`);
    }
  } else {
    console.log('\n\x1b[33maudio cases skipped — run ./scripts/fetch-affect-fixtures.sh first\x1b[0m');
  }

  // ── Warm latency ──────────────────────────────────────────────────────
  section('warm latency (avg of 5)');
  {
    const textMs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await affect(`warm run ${i}: my flight was delayed and I'm exhausted, but let's still find dinner.`);
      textMs.push(Date.now() - t);
    }
    console.log(`  text (2-clause utterance): ${Math.round(textMs.reduce((a, b) => a + b) / textMs.length)} ms  [${textMs.join(', ')}]`);
    if (hasFixtures) {
      const audioMs: number[] = [];
      const b64 = wavToB64(fixture('1076_IEO_HAP_HI'));
      for (let i = 0; i < 5; i++) {
        const t = Date.now();
        await affect(`warm audio run ${i}, somewhere fun tonight please.`, b64);
        audioMs.push(Date.now() - t);
      }
      console.log(`  text+audio (~2s clip): ${Math.round(audioMs.reduce((a, b) => a + b) / audioMs.length)} ms  [${audioMs.join(', ')}]`);
    }
    console.log(`  RSS total: ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
  }

  console.log(failed ? `\n\x1b[31m${failed} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
  process.exit(failed ? 1 : 0);
}

void main();
