# Brainstorm: Field Upload Utility (BioChoco SD-card → Drive)

**Date:** 2026-06-15
**Status:** Explored — ready for planning
**Topic:** A reliable, self-installing tool to replace the failing Google Drive desktop app for uploading camera-trap images and audio recordings from the field laptop.

## Problem

The BioChoco field team copies camera-trap images and audio-recorder files off SD cards onto a MacBook (the "Macbook Neo"), into the **pre-made Google Drive deployment folders**, and relies on the **Google Drive desktop app** to sync them up. The Drive app gets stuck loading folders and the sync silently never completes, so uploads are badly behind. The field team is **not technical**.

Key context from research (`drive-client.ts`, `shared-drives.ts`, `audio-sync-internals.ts`):
- The portal **creates the deployment folders itself** via the Drive API; ingestion is **read-only** (nightly scan). So the field team's only job is getting files into the right existing folder. **No portal pipeline change is required.**
- Expected structure per deployment: `<DeploymentID>/{camaras_trampas, grabadores_de_audio, ibutton}`. Subfolder names are hardcoded. Images vs audio are separable by file extension.
- BioChoco is on Shared Drive(s); the service account must be a **Content Manager member** of the drive(s), with `supportsAllDrives: true` on every call.

## What We're Building

A **cross-platform desktop tray app that wraps `rclone`** ("FCAT Uploader"). The field team:
1. Copies an SD card (deployment known from the **labeled bag**) to a folder on the laptop.
2. Opens the app, picks/auto-matches the deployment, drags the folder in, clicks **Subir** (one click).
3. The app routes files to `camaras_trampas` / `grabadores_de_audio` / `ibutton` **by file extension** (team never sees subfolder names), then uploads in the **background**.
4. They can close the window / sleep the laptop overnight; a **tray icon** shows progress over hours/days.
5. On completion the app runs a **checksum verification** (`rclone check`) and shows "✅ N archivos verificados en Drive."

This replaces only the broken transport layer. The portal discovers the files on its next scan, exactly as today.

## Why This Approach

Driven by the confirmed constraints:
- **40 GB / ~10,000 files / multi-day, unattended** → rules out a browser uploader. Browsers can't reliably hold a multi-day transfer (sleep, tab/OS restarts, browser updates, queue state). `rclone` is purpose-built for this: resumable, auto-retry, checksum verify, low memory, runs for days.
- **Multi-day** → a **background tray job** beats a foreground window the user must keep open/awake.
- **Self-installing, non-technical, one drop + one click** → a packaged app with extension-based routing removes both config and wrong-subfolder errors.
- **Count + checksum verification** → `rclone check` gives this natively, closing the "did it actually sync?" trust gap that defines the current pain.
- **Cross-platform (Mac now, Windows later)** → cheap, because `rclone` is one static binary on every OS; only the thin GUI wrapper + per-platform code-signing differ.

### Approaches considered
- **A′ — Cross-platform tray app wrapping rclone (CHOSEN).** Best fit on every confirmed constraint.
- **B — Portal browser upload page.** Zero install, but a browser is the wrong tool for multi-day 40 GB transfers; the robust direct-to-Drive resumable version is *more* engineering than A and leans on portal/droplet uptime (and the droplet already had a disk-full outage). Rejected for this workload.
- **C — Pure background watch-folder daemon.** Good engine, but "drop into the correctly-named local folder" reintroduces navigation/naming errors and silent-failure invisibility (today's exact problem). Its resilient-background idea is folded into A′; its weaker per-upload confirmation is not.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport engine | **rclone** (bundled static binary) | Built for resumable, verified, multi-day bulk transfer |
| Form factor | **Background tray app**, one-click start | Survives sleep/network drops over multi-day jobs |
| Platform | **Cross-platform** (Mac now, Windows-ready) | rclone is cross-platform; only wrapper + signing differ |
| Destination | **Existing Drive folders, unchanged** | Portal already creates folders + scans read-only |
| File routing | **By file extension** into the 3 subfolders | Team never deals with `camaras_trampas` vs `grabadores_de_audio` |
| Verification | **Checksum verify (`rclone check`)** + clear ✅ | Directly fixes the "did it sync?" trust gap |
| Credential | **Baked-in scoped, write-only, revocable service account** | Zero login for the team; revoke if a laptop is lost |
| Deployment selection | From **labeled-bag ID** — pick from a live list or auto-match the dropped folder name | Bag is the human source of truth |
| Portal impact | **None to the ingestion pipeline** | De-risks the build entirely |

## Open Questions (for the plan)

1. **Wrapper tech:** Tauri vs Electron vs Go-GUI for the cross-platform tray app — weigh bundle size, signing ease, and maintenance.
2. **Code-signing / notarization:** Apple Developer ID ($99/yr) for macOS notarization + a Windows code-signing cert vs. a documented one-time "allow this app" bypass for a handful of trusted machines.
3. **Credential security in depth:** Dedicated SA scoped to only the camera-trap drives; key-at-rest protection on the laptop; revocation/rotation runbook if a laptop is lost or replaced.
4. **Deployment list source:** Does the app read the live deployment-folder list directly from Drive (using the bundled SA) or from a small portal API? Auto-match the dropped folder's name to a deployment vs. always pick from a list.
5. **Resume & integrity across days:** Confirm rclone flags for resume + checksum (`--checksum`, `--retries`, `--low-level-retries`), partial-file handling, and that interrupted multi-day runs resume cleanly without re-uploading verified files.
6. **What counts as "done":** Whether to also surface success in the portal (heartbeat / upload log) on top of the local ✅.
7. **Auto-update:** How the team gets new versions without technical help.
8. **Edge cases:** Wrong-deployment selection guardrails; duplicate re-uploads (idempotent — Drive + portal dedupe on `(deploymentId, driveFileId)`); non-media junk files on cards (`.DS_Store`, Thumbs.db); very large single video files.

## Next Step

Run `/workflows:plan` to turn this into an implementation plan (it should auto-detect this brainstorm).
