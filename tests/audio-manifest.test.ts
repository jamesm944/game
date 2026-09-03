import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { AUDIO_CLIPS } from "../src/audio/intents";

describe("V10: Audio Asset Manifest & CC0 Clips (Issue #81)", () => {
  const audioDir = path.resolve(__dirname, "../src/assets/audio");
  const manifestPath = path.join(audioDir, "MANIFEST.md");

  it("manifest file exists and documents verified CC0 status for all 13 clips", () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifestContent = fs.readFileSync(manifestPath, "utf-8");

    expect(manifestContent).toContain("REAL CC0 AUDIO CLIPS INSTALLED");
    for (const clip of AUDIO_CLIPS) {
      expect(manifestContent).toContain(clip);
    }
  });

  it("all 13 real audio WAV files exist on disk with valid RIFF headers", () => {
    for (const clip of AUDIO_CLIPS) {
      const wavPath = path.join(audioDir, `${clip}.wav`);
      expect(fs.existsSync(wavPath)).toBe(true);

      const buffer = fs.readFileSync(wavPath);
      expect(buffer.length).toBeGreaterThan(44);

      // Check RIFF header
      expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
      expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");
      expect(buffer.toString("ascii", 12, 16)).toBe("fmt ");

      // Check PCM format
      const audioFormat = buffer.readUInt16LE(20);
      expect(audioFormat).toBe(1); // PCM

      // Check channels
      const channels = buffer.readUInt16LE(22);
      expect(channels).toBe(1); // mono

      // Check sample rate
      const sampleRate = buffer.readUInt32LE(24);
      expect(sampleRate).toBe(44100);

      // Check bits per sample
      const bitsPerSample = buffer.readUInt16LE(34);
      expect(bitsPerSample).toBe(16);

      // Check data chunk
      expect(buffer.toString("ascii", 36, 40)).toBe("data");
      const dataSize = buffer.readUInt32LE(40);
      expect(dataSize).toBeGreaterThan(0);
      expect(buffer.length).toBe(44 + dataSize);
    }
  });
});
