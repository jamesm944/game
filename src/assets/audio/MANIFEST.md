# Audio Asset Manifest (M5-T1)

**Status: PLACEHOLDER TONES.** All clips are synthesized in
`src/audio/placeholder.ts` so the full audio pipeline (buses, voice pool,
panning, scheduling) ships and is testable before asset curation completes.

## Swap steps (real CC0 content)

1. Download the verified-CC0 packs from SPEC §6:
   - UI: Kenney *Interface Sounds*, Kenney *UI Audio* (kenney.nl — site-wide CC0)
   - World/combat: Kenney *Impact Sounds*, *RPG Audio*, *Digital Audio*
   - Jingles: Kenney *Music Jingles*; music beds: FreePD.com (CC0)
   - Ambience: OGA "Nature sounds [CC0]" (Freso)
2. Export mappings below to `src/assets/audio/<clip>.wav` (44.1 kHz mono, ≤2 s
   except ambient loops ≤8 s).
3. In `src/audio/voices.ts` → `loadClip()`, prefer
   `fetch(new URL(\`../assets/audio/${clip}.wav\`, import.meta.url))` with the
   synth call as fallback.
4. Fill the provenance table below per file.

## Clip mapping

| Clip | Source pack / file | License |
|---|---|---|
| ui.click | _(placeholder)_ Kenney Interface Sounds `click_001.ogg` | CC0 |
| ui.order | _(placeholder)_ Kenney Interface Sounds `confirmation_001.ogg` | CC0 |
| act.chop | _(placeholder)_ Kenney Impact Sounds `wood_002.ogg` | CC0 |
| act.mine | _(placeholder)_ Kenney Impact Sounds `stone_001.ogg` | CC0 |
| act.build | _(placeholder)_ Kenney RPG Audio `hammer.ogg` | CC0 |
| combat.strike | _(placeholder)_ Kenney Impact Sounds `metal_003.ogg` | CC0 |
| combat.death | _(placeholder)_ Kenney RPG Audio `death_human.ogg` | CC0 |
| econ.meal | _(placeholder)_ Kenney UI Audio `powerUp_001.ogg` | CC0 |
| age.up | _(placeholder)_ Kenney Music Jingles `jingle_win_001.ogg` | CC0 |
| victory.win | _(placeholder)_ Kenney Music Jingles `jingle_win_002.ogg` | CC0 |
| victory.defeat | _(placeholder)_ Kenney Music Jingles `jingle_lose_001.ogg` | CC0 |
| ambient.day | _(placeholder)_ OGA Freso `birds_day.ogg` (loop) | CC0 |
| ambient.night | _(placeholder)_ OGA Freso `crickets_night.ogg` (loop) | CC0 |

Anything without a verifiable CC0 provenance line never enters this directory
(SPEC §6 rule).
