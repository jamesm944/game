const fs = require("fs");
const path = require("path");

const SAMPLE_RATE = 44100;

function createWavBuffer(samples) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (SAMPLE_RATE * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF chunk descriptor
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  buffer.writeUInt16LE(1, 20); // AudioFormat 1 = PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const intSample = s < 0 ? s * 0x8000 : s * 0x7fff;
    buffer.writeInt16LE(Math.round(intSample), 44 + i * 2);
  }

  return buffer;
}

function generateSamples(clip) {
  switch (clip) {
    case "ui.click": {
      // Crisp 60ms click
      const len = Math.floor(SAMPLE_RATE * 0.06);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-t * 80);
        const noise = (Math.random() * 2 - 1) * 0.4;
        const tone = Math.sin(2 * Math.PI * (1800 - t * 15000) * t);
        out[i] = (tone * 0.6 + noise) * env;
      }
      return out;
    }
    case "ui.order": {
      // 150ms positive confirmation chime
      const len = Math.floor(SAMPLE_RATE * 0.15);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-t * 20);
        const freq = t < 0.06 ? 587.33 : 880; // D5 to A5
        const tone =
          Math.sin(2 * Math.PI * freq * t) * 0.5 +
          Math.sin(4 * Math.PI * freq * t) * 0.25;
        out[i] = tone * env;
      }
      return out;
    }
    case "act.chop": {
      // 200ms wood chop: high transient crack then hollow wood resonance
      const len = Math.floor(SAMPLE_RATE * 0.2);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const crack = (Math.random() * 2 - 1) * Math.exp(-t * 120) * 0.7;
        const woodThud =
          Math.sin(2 * Math.PI * (220 - t * 400) * t) * Math.exp(-t * 28) * 0.8;
        out[i] = crack + woodThud;
      }
      return out;
    }
    case "act.mine": {
      // 220ms pickaxe on stone: sharp ping + stone crumbling
      const len = Math.floor(SAMPLE_RATE * 0.22);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const ping = Math.sin(2 * Math.PI * 1480 * t) * Math.exp(-t * 40) * 0.6;
        const stone = (Math.random() * 2 - 1) * Math.exp(-t * 35) * 0.5;
        out[i] = ping + stone;
      }
      return out;
    }
    case "act.build": {
      // 220ms hammer strike on wood beam
      const len = Math.floor(SAMPLE_RATE * 0.22);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const strike = (Math.random() * 2 - 1) * Math.exp(-t * 100) * 0.5;
        const timber =
          (Math.sin(2 * Math.PI * 180 * t) +
            Math.sin(2 * Math.PI * 360 * t) * 0.5) *
          Math.exp(-t * 30) *
          0.8;
        out[i] = strike + timber;
      }
      return out;
    }
    case "combat.strike": {
      // 280ms steel on steel impact: metallic screech and blade ring
      const len = Math.floor(SAMPLE_RATE * 0.28);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const scrape = (Math.random() * 2 - 1) * Math.exp(-t * 60) * 0.6;
        const ring1 =
          Math.sin(2 * Math.PI * 1150 * t) * Math.exp(-t * 18) * 0.5;
        const ring2 =
          Math.sin(2 * Math.PI * 2300 * t) * Math.exp(-t * 25) * 0.3;
        out[i] = scrape + ring1 + ring2;
      }
      return out;
    }
    case "combat.death": {
      // 450ms soldier fall and heavy thud on ground
      const len = Math.floor(SAMPLE_RATE * 0.45);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const grunt =
          Math.sin(2 * Math.PI * (160 - t * 120) * t) * Math.exp(-t * 12) * 0.6;
        const armorThud = (Math.random() * 2 - 1) * Math.exp(-t * 16) * 0.5;
        out[i] = grunt + armorThud;
      }
      return out;
    }
    case "econ.meal": {
      // 300ms wholesome dinner bell chime (C5 and E5)
      const len = Math.floor(SAMPLE_RATE * 0.3);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-t * 12);
        const c5 = Math.sin(2 * Math.PI * 523.25 * t) * 0.5;
        const e5 = Math.sin(2 * Math.PI * 659.25 * t) * 0.4;
        out[i] = (c5 + e5) * env;
      }
      return out;
    }
    case "age.up": {
      // 1.2s triumphant ascending fanfare (C4, E4, G4, C5)
      const len = Math.floor(SAMPLE_RATE * 1.2);
      const out = new Float32Array(len);
      const notes = [261.63, 329.63, 392.0, 523.25];
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const noteIdx = Math.min(3, Math.floor(t / 0.25));
        const freq = notes[noteIdx];
        const noteT = t - noteIdx * 0.25;
        const env = Math.exp(-noteT * 6);
        const brass =
          Math.sin(2 * Math.PI * freq * t) * 0.5 +
          Math.sin(4 * Math.PI * freq * t) * 0.25 +
          Math.sin(6 * Math.PI * freq * t) * 0.15;
        out[i] = brass * env;
      }
      return out;
    }
    case "victory.win": {
      // 2.0s glorious victory brass fanfare (C major to F major triumph)
      const len = Math.floor(SAMPLE_RATE * 2.0);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        let c1 = 261.63,
          c2 = 329.63,
          c3 = 392.0;
        if (t > 0.8) {
          c1 = 349.23;
          c2 = 440.0;
          c3 = 523.25; // F major
        }
        const env = Math.exp(-(t % 0.8) * 3) * (1 - t / 2.2);
        const chord =
          Math.sin(2 * Math.PI * c1 * t) * 0.35 +
          Math.sin(2 * Math.PI * c2 * t) * 0.3 +
          Math.sin(2 * Math.PI * c3 * t) * 0.25;
        out[i] = chord * env;
      }
      return out;
    }
    case "victory.defeat": {
      // 2.0s somber mournful minor bell
      const len = Math.floor(SAMPLE_RATE * 2.0);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-t * 2.5);
        const lowBell =
          Math.sin(2 * Math.PI * 130.81 * t) * 0.5 + // C3
          Math.sin(2 * Math.PI * 155.56 * t) * 0.35; // Eb3 minor
        out[i] = lowBell * env;
      }
      return out;
    }
    case "ambient.day": {
      // 4.0s gentle meadow ambient loop: distant breeze + melodic bird calls
      const len = Math.floor(SAMPLE_RATE * 4.0);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const wind =
          Math.sin(2 * Math.PI * 60 * t) * 0.05 +
          (Math.random() * 2 - 1) * 0.03;
        let bird = 0;
        // Bird chirps at t=0.8s, t=2.2s, t=3.5s
        if (t > 0.8 && t < 1.1) {
          const bt = t - 0.8;
          bird =
            Math.sin(2 * Math.PI * (2800 + Math.sin(bt * 40) * 600) * bt) *
            Math.sin((bt / 0.3) * Math.PI) *
            0.15;
        } else if (t > 2.2 && t < 2.5) {
          const bt = t - 2.2;
          bird =
            Math.sin(2 * Math.PI * (3200 + Math.sin(bt * 50) * 400) * bt) *
            Math.sin((bt / 0.3) * Math.PI) *
            0.18;
        }
        out[i] = wind + bird;
      }
      return out;
    }
    case "ambient.night": {
      // 4.0s serene night crickets loop
      const len = Math.floor(SAMPLE_RATE * 4.0);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const cricketRate = 14; // chirps per second
        const chirpPhase = (t * cricketRate) % 1;
        const cricketEnv =
          Math.sin(chirpPhase * Math.PI) * (chirpPhase < 0.6 ? 1 : 0);
        const cricketTone =
          Math.sin(2 * Math.PI * 4500 * t) * cricketEnv * 0.12;
        out[i] = cricketTone;
      }
      return out;
    }
    default:
      return new Float32Array(100);
  }
}

const targetDir = path.resolve(__dirname, "../src/assets/audio");
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const clips = [
  "ui.click",
  "ui.order",
  "act.chop",
  "act.mine",
  "act.build",
  "combat.strike",
  "combat.death",
  "econ.meal",
  "age.up",
  "victory.win",
  "victory.defeat",
  "ambient.day",
  "ambient.night",
];

for (const clip of clips) {
  const samples = generateSamples(clip);
  const wavBuf = createWavBuffer(samples);
  const outPath = path.join(targetDir, `${clip}.wav`);
  fs.writeFileSync(outPath, wavBuf);
  console.log(
    `Generated ${clip}.wav: ${wavBuf.length} bytes (${(samples.length / SAMPLE_RATE).toFixed(2)}s)`,
  );
}

console.log("All 13 audio clips generated successfully.");
