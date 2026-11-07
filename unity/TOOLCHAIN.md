# Production Unity toolchain (ticket #185, pinned 2026-11-07)

- **Editor:** Unity **6000.6.6f1** (`d20c9ac777da`), installed at
  `/Applications/Unity/Hub/Editor/6000.6.6f1/`. This resolves the hybrid
  prototype's stale 6000.3.11f1 pin in favour of the installed editor;
  `ProjectSettings/ProjectVersion.txt` is the machine-readable pin.
- **Project location:** `unity/` at the repository root, beside the TS game
  (`src/` remains the behavioral reference during migration).
- **Packages:** pinned exactly in `Packages/manifest.json` (URP 17.6.0,
  glTFast 6.20.0, first-party modules only otherwise); resolved graph in
  `Packages/packages-lock.json`. Ink joins when its integration is production
  work (spike pins recorded in `docs/research/ink-unity-spike.md`).
- **One-command builds** (headless, from repo root):
  `"/Applications/Unity/Hub/Editor/6000.6.6f1/Unity.app/Contents/MacOS/Unity" -batchmode -quit -projectPath unity -executeMethod ProductionBuild.BuildAll`
  → `unity/build/macos/Ageofwind.app` (StandaloneOSX) and
  `unity/build/windows/Ageofwind.exe` (StandaloneWindows64, Mono backend for
  macOS-hosted cross-build). Entry point: `Assets/Editor/ProductionBuild.cs`.
- **Verified 2026-11-07:** both targets `Succeeded, errors=0`
  (macOS 74,271,637 B; Windows 100,600,694 B); macOS app smoke-launched.
