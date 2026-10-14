# Changelog

All notable changes to VN Shelf. Download any version from the
[Releases page](https://github.com/stagefuel/vn-shelf/releases). From 0.3.0 on, VN Shelf can
update itself (Settings → Updates).

## 0.3.0

A big library update: a home page, VNDB info and tags on every game, categories, bulk import,
companion tools, save export/import, in-app updates and a Japanese interface.

### New
- **Home page.** Opens on your most recently played games ("Continue reading") and your most
  recently added ones, with a count of games and hours played on this PC.
- **Sidebar with categories.** Group games into your own categories (Reading, Finished,
  Favourites…) and open them from the sidebar like folders. Create a category with **+** in the
  sidebar or from a game's page. Rename or delete it from the category's own view. Categories
  are stored with each game, so they appear on every PC.
- **Sorting.** Sort the library by title, last played, recently added, release date, VNDB rating,
  length or time played. Your choice is remembered.
- **VNDB info on game pages.** Linked games show:
  - the VNDB description (spoilers hidden until clicked; links open in your browser)
  - release date, length (VNDB's category plus the average from votes), rating and votes,
    languages and platforms
  - **Refresh from VNDB** to update it later

  Games added before 0.3.0 show a **Get info from VNDB** button.
- **VNDB tags.** The top tags appear on each game, and spoiler tags stay hidden until you choose to
  show them. Click a tag to see every game with it. The search box also matches tags, aliases,
  developers and categories.
- **Bulk import (Import folder…).** Point VN Shelf at a folder such as your VN collection:
  - It finds each game's folder and its main program. Installers, config tools, cracks, updaters
    and patchers are skipped.
  - It cleans folder names (`[brand]` tags, version numbers) and matches each game on VNDB.
  - You review the list before anything is added: untick anything that isn't a game, pick a
    different program, or search VNDB again.
  - Imported games get their cover and info, and the save folder is set automatically when one
    with files in it is found.
- **Notes.** Each game has a notes box (routes done, where you are, anything else). Notes save as
  you type and sync to your other PCs with the game.
- **Companion tools ("Start with this game").** Add programs once in Settings, such as a text
  hooker (LunaHook, Textractor), meikipop or Magpie. Then tick which ones start with each game.
  Each tool can:
  - start after a delay
  - close when the game closes (the whole process tree)
  - start with every game

  Tool options can include `{gameExe}`, `{gameDir}` and `{title}`, which are filled in for each
  game. Tools are per PC, because install locations differ.
- **Save export / import.** **Export saves…** writes this PC's current saves for a game to a `.zip`.
  **Import saves…** puts saves from such a zip back:
  - Your current saves are copied to History first.
  - Only the save locations in the zip are replaced.
  - The result is uploaded so your other PCs get it.

  Save locations are matched by their path, so a zip from the same game added on another PC
  works too.
- **In-app updates.**
  - VN Shelf checks GitHub for a newer version when it starts. You can turn this off, or use
    **Check now** in Settings.
  - A pop-up announces a new version. **Hide** keeps it quiet until the next one, and a pill in the
    top bar stays available either way.
  - **Update and restart** downloads the new portable `.exe`, checks it against GitHub's SHA-256
    checksum, swaps it in and restarts. Settings and the library are kept.
  - The zip version opens the download page instead.
- **Japanese interface (日本語).** Choose Language in Settings: Automatic (follows Windows),
  English or 日本語. Everything is translated, including messages and explanations from the sync
  engine.

### Changed
- The library has a toolbar showing the current view, a game count, filter chips and the sort menu.
- Game pages are rearranged:
  - left column: About, Save locations, Notes
  - right column: Launch, Start with this game, Categories, Save backup, History, Details
- Importing a VN Shelf export, or restoring, writes a "Backup before import" or "Backup before
  restore" entry in History.

### Under the hood
- New core modules, each with tests:
  - `importer` (folder scanning and program choice)
  - `savesio` and `zip` (a small zip reader and writer with UTF-8 names, deflate and CRC checks;
    no new dependencies)
  - `tools` (companion programs)
  - `updater` (release check, verified download, swap script)
  - extended `vndb` (full info, safe description parsing)
- 80 automated tests, plus three end-to-end UI runs (folder mode, Drive mode, and all the new
  features) on Linux and Windows.

## 0.2.1

### Fixed
- **Google Drive mode: a second PC could see an empty library.** On the very first sign-in, two
  parts of VN Shelf could each create a "VN Shelf" folder in Drive at the same moment. The game
  went into one, and other PCs read the other.
  - Root folder lookups are now shared, so only one is created.
  - If duplicates already exist, every one of them is read, so no game is hidden.
- A Windows test of game tracking was timing-sensitive on GitHub's build machines. It now gives
  the stand-in game longer, so a cold PowerShell has time to report it.

## 0.2.0

### New
- **Google Drive mode.** Sign in with Google and VN Shelf syncs straight to Drive, with no Drive app
  needed on the PC.
  - VN Shelf asks only for the `drive.file` permission, so it can see the files it created itself
    and nothing else in your Drive.
  - Sign-in uses the browser with PKCE. The sign-in token is stored encrypted with Windows' own
    credential protection.
  - Saves are stored by content: each file is uploaded once and named by its fingerprint, with a
    small manifest per version. Only changed files upload, the manifest is written last (so a
    half-finished upload is never seen as a save), and old versions cost almost nothing.
- **Save-folder safety limits.** These keep a whole drive, a system folder or a game install from
  being synced by mistake:
  - whole drives, system folders, AppData itself and the shared folder are refused
  - programs, videos, archives, caches, logs and files over 64 MB are never synced
  - a location over 50 MB or 1000 files asks first; one over 500 MB or 5000 files is refused
- Release builds include the Google sign-in client from the repository's secrets, and a release
  is refused without it.

## 0.1.2

- First release built by GitHub Actions. Every push runs the tests on Windows and Linux; a version
  tag builds the Windows portable `.exe` and zip and publishes the release.
- MIT licence.

## 0.1.1

### Changed
- Tested on a real Windows 10 PC, with save-folder detection tuned against a library of 34
  Japanese VNs. 29 of the 34 now get the right save folder suggested first.
- Detection now recognises:
  - age's rUGP games, matched exactly through their `.rio.ici` marker in `Documents\age`
  - RPG Maker 2000/2003 (`Save*.lsd`)
  - save folders such as `faterealtanua_savedata` and `Vmreg`
  - loose `*.save` / `*.sav` files in the game folder
  - folders named after the game one level inside a developer's folder (`AppData\枕\サクラノ刻`,
    `Saved Games\WillPlus\CROSS†CHANNEL`)
- Generic program names (`Game.exe`, `rugp.exe`, EasyRPG players) no longer match another game's
  folder.
- The game's own install folder is never suggested as a save folder.
- `.bat` / `.cmd` games start correctly.
- The game page refreshes after a game closes.
- Game tracking on Windows uses one long-running PowerShell watcher instead of starting PowerShell
  every few seconds.

## 0.1.0

First version.

- **Library:** a Steam-style grid with VNDB covers and sync badges. Add a game by dragging its
  `.exe` onto the window.
- **Syncing:** saves sync through any folder a cloud app keeps in sync. Google Drive, OneDrive,
  Dropbox, iCloud Drive, MEGA, pCloud, Box and Syncthing folders are detected on first run.
- **Play:** newer saves download before a game starts and yours upload when it closes. VN Shelf
  follows launchers and Locale Emulator to the real game.
- **Finding save folders:** auto-detect for common engines and folders named after the game,
  **Save once** (start the game, save, close it, and VN Shelf lists what changed), or choose or type
  the folder yourself, optionally limited to certain files.
- **Safety:**
  - every overwrite is backed up to History, with one-click restore
  - you're asked which side to keep when both PCs saved
  - a half-synced shared folder is refused rather than copied
  - a lock warns when the game looks open on another PC
  - you can still play offline
