# VN Shelf

A Steam-style library for visual novels that keeps your save files in sync between PCs.

Add your games (one by one or a whole folder at once), and VN Shelf:
- fetches each game's cover, description and tags from VNDB
- finds where the game keeps its saves
- brings newer saves down from your other PC before you play, and uploads yours when you close
  the game

The interface is available in English and 日本語. Nothing AI-based runs inside the app.

**[Download the latest release](https://github.com/stagefuel/vn-shelf/releases)** ·
[Wiki / guide](https://github.com/stagefuel/vn-shelf/wiki) · [Changelog](CHANGELOG.md)

## Where saves are kept

You pick one on first run, and the same one on every PC:

| Option | What you need | Notes |
|---|---|---|
| **Google Drive (sign in)** | A Google account | No Drive app needed. VN Shelf can only see the files it creates (`drive.file` permission). |
| **A synced folder** | Google Drive for desktop, OneDrive, Dropbox, iCloud Drive, MEGA, pCloud, Box, Syncthing, a NAS share or a USB drive | Detected automatically on first run. No sign-in; that service's own app moves the files. |

## Features

### Library
- **Home page:** what you played most recently ("Continue reading") and what you added most
  recently.
- **Categories:** your own groups (Reading, Finished, Favourites…), shown in the sidebar like
  folders. They're saved with each game, so every PC sees them.
- **Sorting:** by title, last played, recently added, release date, VNDB rating, length or time
  played.
- **Search:** matches titles, aliases, developers, categories and VNDB tags. Click a tag on any
  game to list every game with it.
- **VNDB info on each game:**
  - the description (spoilers hidden until clicked)
  - release date, length (VNDB's category plus the average from votes), rating, languages and
    platforms
  - tags, with spoiler tags hidden unless you choose to show them
- **Notes:** a notes box on each game that saves as you type and syncs to your other PCs.

### Adding games
- **Drag a game's `.exe`** onto the window, or use **+ Add game**, and pick the match from VNDB.
- **Import folder…** adds a whole collection at once:
  1. It finds each game's folder and main program, skipping installers, config tools, cracks and
     updaters.
  2. It matches each game on VNDB.
  3. You review the list before anything is added.
  4. Save folders are set automatically wherever one with files in it is found.

### Finding save folders
- **Auto-detect** recognises common engines: KiriKiri, Ren'Py, RPG Maker (2000–MZ), Siglus,
  BGI/Ethornell, CatSystem2, AliceSoft System 4, Artemis, YU-RIS, NScripter, Unity and age's
  rUGP. It also finds folders named after the game in AppData, Documents and Saved Games,
  including inside the developer's folder.
- **Save once** starts the game. You save once and close it, and VN Shelf lists exactly which
  files changed.
- **Choose folder…** or **Type a path…** if you already know it (`%APPDATA%\...` works), and
  **Files…** limits a folder to certain files (for example `Save*.rvdata2`).
- Locations are stored as portable paths like `<appdata>/Nitroplus/Muramasa` or `<game>/savedata`,
  so they work on every PC whatever its username or install drive.

### Playing
- **Press Play.** Newer saves come down first, and yours go up when the game closes. VN Shelf follows
  launchers and Locale Emulator to the real game.
- **Start with this game:** add companion programs once in Settings (a text hooker like
  LunaHook/Textractor, meikipop, Magpie…), then tick which ones start with each game. Each can:
  - start after a delay
  - close when the game closes
  - start with every game

  Options can include `{gameExe}`, `{gameDir}` and `{title}`, which are filled in for each game.
- **Locale Emulator:** set `LEProc.exe` in Settings, then tick it per game.
- **Upload while playing:** optional; pushes saves about 10 s after each save.

### Safety
- Nothing is overwritten without being copied to **History** first. The newest 10 versions are kept
  by default, and each can be restored.
- If both PCs saved since they last synced, you choose which to keep. The other copy goes to History.
- A half-downloaded shared folder is detected and waited for, never copied over a good save.
- A warning appears if the game looks open on the other PC. If storage is unreachable, you can play
  offline and saves upload later.
- **Save-folder limits:**
  - whole drives, system folders and game installs are refused
  - programs, videos, archives, caches, logs and files over 64 MB are never synced
  - a location over 50 MB or 1000 files asks first; one over 500 MB or 5000 files is refused
- **Export saves… / Import saves…** saves a game's saves as a `.zip` or puts them back, with a backup
  to History first.

### Updates
- VN Shelf checks for a new version when it starts (you can turn this off) and shows a pop-up you
  can hide. You can also use **Settings → Updates → Check now**.
- The portable `.exe` updates itself. The download is checked against GitHub's SHA-256, then VN
  Shelf restarts with your settings and library kept.

## Download

Get `VN-Shelf-<version>-portable.exe` from the [Releases page](https://github.com/stagefuel/vn-shelf/releases)
and run it. Nothing needs installing.

The exe isn't code-signed, so Windows SmartScreen may say "Windows protected your PC". Click
**More info**, then **Run anyway**.

## Privacy

VN Shelf talks to three services, and only for the reasons below:
- **VNDB:** to search for games and fetch their info and covers.
- **GitHub:** to check for and download updates. You can turn this off.
- **Google:** only if you choose Google Drive mode.

Your saves go only to the storage you picked. See [PRIVACY.md](PRIVACY.md).

## Development

```
npm install
npm start                                   # run the app
npm test                                    # unit tests (sync, Drive, detection, import, zip, updates, tools…)
npm run dist:win                            # Windows portable .exe + zip into dist/ (works from Linux; Wine embeds the icon)
node scripts/ui-smoke.js shots/             # end-to-end: two PCs, folder mode (needs a display, e.g. Xvfb)
node scripts/ui-smoke-drive.js shots/       # end-to-end: two PCs, Google Drive mode against a fake Drive
node scripts/ui-smoke-features.js shots/    # end-to-end: import, tags, categories, notes, tools, export, updates, Japanese
```

Set `VNS_EXE` to a packaged `VN Shelf.exe` to run the end-to-end checks against a real build.

**Layout:**
- `src/core`: plain Node with no Electron. This holds everything that touches saves, as well as
  detection, import, VNDB, zip and updates.
- `src/main`: the Electron main process and its API.
- `src/renderer`: the UI (no framework), with English and Japanese strings in `i18n.js` and
  `i18n-ja.js`.

**Releases** are built by GitHub Actions (`.github/workflows/release.yml`):
- Every push runs the tests on Windows and Linux.
- Pushing a `v*` tag builds the Windows exe and publishes a release, with notes taken from that
  version's section of [CHANGELOG.md](CHANGELOG.md).

## License

MIT
