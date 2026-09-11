#!/usr/bin/env node
// Build-time assertion: no provider secret or provider fingerprint may
// appear anywhere in dist/. Runs as the last step of `npm run build`.
//
// Checks two classes of leak, reporting variable NAMES / pattern labels only
// — never a secret value:
//   1. the ACTUAL values of every secret-looking var in .env / .env.local
//      (name matches KEY|SECRET|TOKEN|PASSWORD, value ≥ 8 chars);
//   2. recognizable provider fingerprints that should never be client-side:
//      the Anthropic key prefix and the direct-API markers whose presence
//      would mean the browser is authenticating to a provider again.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");

function envSecrets() {
  const out = [];
  for (const file of [".env", ".env.local"]) {
    const p = join(root, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const [, name, rawValue] = m;
      const value = rawValue.replace(/^["']|["']$/g, "");
      if (/KEY|SECRET|TOKEN|PASSWORD/i.test(name) && value.length >= 8) {
        out.push({ label: `${file}:${name} (actual value)`, needle: value });
      }
    }
  }
  return out;
}

const FINGERPRINTS = [
  { label: "Anthropic key prefix 'sk-ant-'", needle: "sk-ant-" },
  { label: "ElevenLabs auth header 'xi-api-key'", needle: "xi-api-key" },
  { label: "direct ElevenLabs host 'api.elevenlabs.io'", needle: "api.elevenlabs.io" },
  { label: "direct Anthropic host 'api.anthropic.com'", needle: "api.anthropic.com" },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

if (!existsSync(dist)) {
  console.error("check-dist-secrets: dist/ not found — run vite build first.");
  process.exit(1);
}

const needles = [...envSecrets(), ...FINGERPRINTS];
const hits = [];
let scanned = 0;
for (const file of walk(dist)) {
  scanned++;
  const content = readFileSync(file, "utf8");
  for (const { label, needle } of needles) {
    if (content.includes(needle)) hits.push({ file: file.slice(root.length + 1), label });
  }
}

if (hits.length) {
  console.error("check-dist-secrets: FAILED — secret material or provider fingerprint in dist/:");
  for (const h of hits) console.error(`  ${h.file}  ←  ${h.label}`);
  process.exit(1);
}
console.log(
  `check-dist-secrets: OK — ${scanned} dist files clean of ${needles.length} patterns (` +
    `${needles.length - FINGERPRINTS.length} env values + ${FINGERPRINTS.length} fingerprints).`,
);
