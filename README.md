# VN Shelf

A small Steam-style library for visual novels that keeps save files in sync between your PCs.

There are two ways to keep saves, and you pick one on first run:

- **A folder you already sync:** Google Drive, OneDrive, Dropbox, iCloud Drive, MEGA, pCloud, Box,
  Syncthing, a NAS share, a USB stick. VN Shelf finds those on first run. No accounts or API keys.
- **Google Drive directly:** sign in with Google, and no Drive app is needed on the PC. VN Shelf can
  only see the Drive files it created itself (the `drive.file` permission), nothing else in your Drive.

Nothing AI-based runs inside the app. The only other online lookup is VNDB, for covers and titles,
and only when you search.

## Using it

1. **First run:** name this PC and pick where saves are kept. Pick the same service on every PC.
   VN Shelf makes a `VNShelf` folder inside it.
2. **Add a game:** drag its `.exe` onto the window (or **+ Add game**), then pick it from the VNDB
   results to get the cover.
3. **Tell it where the game saves.** The game page suggests folders on its own. You have four options:
   - **Auto-detect** recognises common engines (KiriKiri, Ren'Py, RPG Maker, Siglus, BGI, CatSystem2,
     System 4, Artemis, YU-RIS, NScripter, Unity). It also looks for `save`/`savedata`/`UserData`
     folders and for AppData/Documents folders named after the game or developer.
   - **Save once** starts the game. You save once and close it, and VN Shelf lists what changed in the
     game folder, AppData, Documents and Saved Games.
   - **Choose folder…** or **Type a path…** if you already know it. Paths like `%APPDATA%\...` work.
   - **Files…** limits a folder to certain files (for example `Save*.rvdata2`).
4. **Press Play.** Newer saves from your other PC come down first. When the game closes, yours go up.

On the other PC the game appears as *Not on this PC*. Press Play once and point it at the `.exe`.
Save locations are already set up, because they're stored as portable paths like
`<appdata>/Nitroplus/Muramasa` or `<game>/savedata`.

### Safety

- Nothing is overwritten without being copied to **History** first. The newest 10 versions are kept
  by default, and each can be restored.
- If both PCs saved since they last synced, VN Shelf asks which to keep. The other copy goes to History.
- If the shared folder looks half-downloaded, VN Shelf waits instead of copying a broken save.
- If the game looks open on the other PC, VN Shelf warns before launching.
- If the shared folder isn't reachable, you can still play. Saves upload once it's back.
- Removing a game from the library moves its shared folder to `games/.removed`. Nothing is deleted.
- Save locations can't accidentally sweep up a whole game or drive: whole drives and system folders
  are refused, programs, videos, archives, caches, logs and files over 64 MB are never synced, and a
  folder over 50 MB or 1000 files asks first (over 500 MB or 5000 files is refused).

### Options

- **Locale Emulator:** set `LEProc.exe` in Settings, then tick it per game.
- **Upload while playing:** pushes saves about 10 s after each save, not only when the game closes.
- **Stop tracking:** for a game VN Shelf can't tell has closed. VN Shelf normally watches for any
  program running from the game's folder, which covers launchers and Locale Emulator.

## Shared folder layout

```
VNShelf/games/<game-id>/
  game.json     title, cover, .exe name, save locations, launch options
  cover.jpg
  state.json    which PC uploaded last, when, file hashes
  current/      the latest saves
  history/      older versions
  lock.json     present while the game is open on some PC
```

Each PC also keeps its own settings (install paths, last sync) in `%APPDATA%\VN Shelf\config.json`.

## Download

Get `VN-Shelf-<version>-portable.exe` from the Releases page and run it. Nothing needs installing.
The exe isn't code-signed, so Windows SmartScreen may say "Windows protected your PC": click
**More info**, then **Run anyway**.

## Development

```
npm install
npm start                          # run the app
npm test                           # core tests (sync, paths, detection, launcher)
npm run dist:win                   # Windows portable .exe + zip into dist/ (works from Linux; Wine embeds the icon)
node scripts/ui-smoke.js shots/    # drives two fake PCs through the UI (needs a display, e.g. Xvfb)
```

Layout: `src/core` is plain Node with no Electron, and holds everything that touches saves.
`src/main` is the Electron main process and API. `src/renderer` is the UI (no framework).

Releases are built by GitHub Actions (`.github/workflows/release.yml`). Every push runs the tests on
Windows and Linux, and pushing a `v*` tag builds the Windows exe and publishes a release.

## License

MIT
