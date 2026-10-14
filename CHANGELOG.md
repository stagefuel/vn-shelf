# Changelog

All notable changes to VN Shelf. Download any version from the
[Releases page](https://github.com/stagefuel/vn-shelf/releases). From 0.3.0 on, VN Shelf can
update itself (Settings → Updates).

## 0.5.0

VN Shelf can now run in the tray and start with Windows. This version also brings a new Home page,
a tabbed Settings window, search suggestions, sync progress bars and faster game pages.

### New
- **Start with Windows.** **Settings → General → Start VN Shelf when Windows starts.** VN Shelf
  then starts quietly in the tray when you sign in and keeps your saves in sync: anything waiting
  to upload goes up, and it checks again every few minutes. It's off by default and set separately
  on each PC.
- **Runs in the tray.** Closing the window now keeps VN Shelf running in the tray, so saves still
  sync and games you started keep being tracked.
  - Click the tray icon to open VN Shelf, or right-click it and choose **Quit**.
  - To make the window's X quit instead, change **Settings → General → When you close the window**.
  - The first time you close the window, a notification says where VN Shelf went.
- **A progress bar while saves sync.** Big syncs show how far along they are, on the game's cover,
  on Home and on the game page. For example: "Downloading saves… 3 / 12 files · 4.1 MB of 9.8 MB".
  It covers uploads, the backup taken before a download, and downloads. Syncs that finish in under
  a second don't show a bar, so it doesn't flicker.
- **Search suggestions.** As you type in the search box, a list suggests:
  - matching games (opens the game page)
  - VNDB tags (lists every game with that tag)
  - developers
  - your categories

  Use the mouse, or **↑** / **↓** and **Enter**.
- **Patch notes and the GitHub page in Settings.** **Settings → Updates & about** shows this
  version's patch notes (and every earlier version's, if you want them) and links to the project
  on GitHub.

### Changed
- **New Home page.** The game you played last now gets a large section at the top. It shows its
  cover, title, developer, release year, time played, when you last played and the start of its
  description, with a big **Play** button. Your other recent games are in the row below.
- **Settings has tabs:** General, Saves & sync, Games & tools, Look, and Updates & about. The
  first-run setup still shows everything on one page.
- **Game pages open instantly.** Opening a game used to show the previous game's page for a moment
  while the new one loaded. The new page now appears at once with everything that's already known
  (cover, description, notes, launch options). Save folders, history and companion tools fill in a
  moment later, and they now load at the same time instead of one after another.
- **Clicking "VN Shelf"** in the top-left corner goes to Home.
- **Updates keep the version in the file name.** Updating used to keep the old name, so
  `VN-Shelf-0.4.1-portable.exe` stayed named 0.4.1 after updating. The update is now saved as
  `VN-Shelf-<new version>-portable.exe` and the old file is removed. If you renamed the exe
  yourself (to a name without a version in it), it keeps your name. If you start VN Shelf with
  Windows, that entry follows the new file.
- **The update window** now just says "Current version …". Its patch notes are formatted properly:
  headings, bold text and nested lists used to show as raw text with `**` and `-` marks.
- **Google Drive setup:** "Saves will be kept in a "VN Shelf" folder in your Google Drive" now sits
  right under the Google Drive option, and the "Nothing else to install" note is gone.

### Fixed
- The update was also more careful about when to replace the exe: it now waits for the portable
  launcher as well as VN Shelf itself to close.

## 0.4.1

Faster start-up in Google Drive mode, and a clearer Play button while saves are checked.

### Changed
- **The library appears straight away.** VN Shelf keeps a copy of your library from the last time it
  ran and shows it the moment the window opens. It then fetches the current list in the background
  and swaps it in, so games added or changed on another PC still show up a moment later.
- **Google Drive mode loads much faster.** Measured on a 33-game library:
  - before: about 15 s, because each game's details were downloaded one after another
  - now: about 3 s on a first run, and about 1 s after that
  
  Two changes make this happen. Game details are downloaded 8 at a time. They're also cached on
  this PC (`drive-cache.json` in VN Shelf's settings folder) together with the fingerprint Drive
  gives each file, so only the games that changed since last time are downloaded again.
- **Sync badges fill in faster.** Up to 6 games are checked at once, instead of one at a time.
- **Play shows that it's checking saves right away.** Pressing Play straight after start-up used to
  look like nothing was happening for a few seconds while VN Shelf reached Google Drive. Now:
  - the game's badge reads **Syncing**
  - the game page's button reads **Syncing saves…**
  - the button can't be pressed again until the newest saves are down and the game starts
  
  Extra clicks during that time are ignored, so the game can't start twice.
- **The ← Back button only shows where it's needed:** on game pages and on a list of games with a
  tag. Home, All games and your categories are always one click away in the sidebar, so the
  button is hidden there. The mouse's back button and **Alt+←** still go back from anywhere.

### Fixed
- A launcher test could fail on GitHub's Windows machines because of timing. It now adapts to how
  the game was started. This only affected the automated tests, not the app.

## 0.4.0

A cleaner look: one slim top bar, a simpler home page, background images, and mouse back/forward.

### New
- **Back and forward.** VN Shelf remembers where you've been: Home, the library (including the
  category or tag you filtered by) and game pages. You can move through that history with:
  - the mouse's side buttons
  - **Alt+←** / **Alt+→**
  - the **← Back** button
- **Background image.** **Settings → Background (this PC)** lets you pick any picture to show behind
  the app, with **Darken** and **Blur** sliders that preview live. The top bar and sidebar become
  see-through over it. The image is copied into VN Shelf's settings, so moving or deleting the
  original doesn't matter, and each PC can have its own.

### Changed
- **One slim top bar on Windows.** The separate black Windows title bar is gone. The minimise,
  maximise and close buttons now sit in VN Shelf's own bar, which you can drag to move the window
  and double-click to maximise. The bar is also shorter. (Linux keeps its normal window frame.)
- **Home is just your recent games.** One row of the games you played most recently, stretched to the
  window's width. Before you've played anything, it shows your newest games. The separate rows and
  play-time line are gone.
- **Add game** is now a compact **+** button, with "Add game" as its tooltip.
- The sidebar no longer shows the hint text under Categories.
- The README and wiki now have screenshots.

### Fixed
- Two settings saved at the same instant (for example, moving both background sliders) could fail
  with a "no such file" error, because both used the same temporary file. Every save now uses its
  own.

## 0.3.1

### Fixed
- **In-app updates now finish on Windows.** In 0.3.0, the helper that swaps in the new version
  hung in the background, so VN Shelf closed but wasn't replaced. The helper now runs in its own
  (minimised) console window, so it keeps running after VN Shelf closes:
  1. It waits for the old version to exit.
  2. It replaces the `.exe`.
  3. It starts the new version.
  Each step is logged to `vnshelf-update-<number>.log` in your Temp folder.
  - This was tested on Windows 10 with the real 0.3.0 download.
  - A Windows-only automated test now checks it on every build.
- A half-finished update no longer leaves a stray `VN Shelf.exe.new` behind: it's cleaned up at
  the next start.
- **Import folder** cleans up more folder names before searching VNDB:
  - dates (`…_2025_08_29`)
  - `_win` and `_eng` style suffixes
  - `- Copy`
  - `_game`

**If you're on 0.3.0:** download 0.3.1 from the Releases page once by hand. Updates work from
then on.

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
