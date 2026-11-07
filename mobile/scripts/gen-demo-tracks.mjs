// Generates royalty-free demo drum loops at known BPMs so the music engine works
// before you have real tracks. Run: node scripts/gen-demo-tracks.mjs
// Output: assets/music/loop_<bpm>.wav (2 bars, loops seamlessly)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 22050;
const BPMS = [120, 140, 160, 175];
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "music");
mkdirSync(outDir, { recursive: true });

function render(bpm) {
  const beat = (60 / bpm) * SR;
  const beats = 8;
  const n = Math.round(beat * beats);
  const buf = new Float32Array(n);
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

  const add = (start, len, fn) => {
    for (let i = 0; i < len && start + i < n; i++) buf[start + i] += fn(i / SR);
  };
  const kick = (t) => Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9) * 0.9;
  const snare = (t) => (noise() * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 18) * 0.5;
  const hat = (t) => noise() * Math.exp(-t * 60) * 0.18;

  for (let b = 0; b < beats; b++) {
    const s = Math.round(b * beat);
    add(s, SR * 0.4, kick);
    if (b % 2 === 1) add(s, SR * 0.25, snare);
    add(s, SR * 0.08, hat);
    add(Math.round(s + beat / 2), SR * 0.08, hat);
  }

  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

for (const bpm of BPMS) {
  const file = join(outDir, `loop_${bpm}.wav`);
  writeFileSync(file, render(bpm));
  console.log("wrote", file);
}
