# Changelog

All notable changes to VN Shelf. Download any version from the
[Releases page](https://github.com/stagefuel/vn-shelf/releases). From 0.3.0 on, VN Shelf can
update itself (Settings → Updates).

## 0.9.1

Auto-detect can now use VNDB to find the save folder of a game whose engine it can't recognise from
the files.

### New
- **Engine hint from VNDB.** When VN Shelf can't tell a game's engine from its files and the game is
  linked to VNDB, it asks VNDB which engine the game's release uses. It then suggests that engine's
  usual save folder, marked "VNDB says this game uses …, which usually saves here".
  - The official Japanese Windows release counts first, then other official Windows releases. Fan
    ports and console versions are skipped.
  - Only the most likely engine is used. If VN Shelf doesn't know that engine, there's no hint, so
    a fan port's engine is never suggested instead.
  - The known engines are KiriKiri, Ren'Py, RPG Maker (2000 to MZ), SiglusEngine, BGI/Ethornell,
    CatSystem2, AliceSoft System 4, Artemis, YU-RIS, NScripter, Unity and rUGP. VNDB's spellings
    ("KiriKiri Z", "AliceSoft System4.X"…) are matched.
- **Engine (VNDB)** in the game page header, for games whose engine VN Shelf couldn't tell from the
  files. Point at it to see every engine VNDB lists for the game.
- Bulk import uses the hint too, when it sets save folders automatically.

### How it behaves
- It's only a hint. An engine recognised from the game's files always wins, and VNDB isn't asked
  at all in that case. A save folder that already has files in it still ranks above the hint.
  Folders you set yourself are never changed.
- It takes one request to VNDB per game, kept on that PC for a week (the last copy is used when
  VNDB can't be reached). If VNDB can't be reached and nothing is cached, auto-detect works as
  before. No VNDB account is needed.

## 0.9.0

Game pages now show more from VNDB: screenshots, related VNs, characters and staff. You can also
open everything a writer, artist or brand has made.

### New
- **Screenshots.** A gallery on each game page linked to VNDB. Click one to view it full size;
  ← and → move between them, and Escape or a click outside closes the viewer.
  - Only the Japanese release's screenshots are shown. If VNDB has none from a Japanese release,
    the English release's are shown instead. If there are neither, no screenshots are shown
    (screenshots from other languages' releases never are).
- **Related VNs:** prequels, sequels, fandiscs, side stories, same series or setting, alternative
  versions and so on, each with its cover and year.
  - Each one is marked **In your library**, with its statuses on your VNDB list, or **On your VNDB
    list**.
  - Click one to open its page in VN Shelf (if it's in your library) or on vndb.org. **+ Add** puts it
    in your library.
  - Unofficial relations are marked as such.
- **Characters:** protagonists first, then main, side and minor characters, with their pictures.
  - Click a character for their details: role, sex, age, birthday, height and blood type, the
    description (spoilers hidden until clicked) and traits by group (hair, personality…).
  - Characters whose existence is a spoiler, and spoiler traits, are hidden until you choose
    **Show spoiler characters** or **Show spoiler traits**. **Show spoiler tags** on the game also
    shows spoiler characters.
- **Staff and brand:** the brand, director, scenario, character design, art, music and songs, with
  everyone else (translators, editors, QA…) under **Other staff**. Point at a name to see their
  notes for this game (which routes they wrote, for example).
- **Everything by a person or brand.** Click any name under Staff to see all the VNs they worked on,
  newest first, with their role in each, which ones are in your library, and **+ Add** for the rest.
  **Back** returns to the game.

### How it loads
- These need only two requests to VNDB per game (three for a person's page). They're kept on this PC
  for a week, so pages open instantly after the first time, and the last copy is used when VNDB
  can't be reached. Nothing is added to your shared storage.
- No VNDB account is needed. A connected account is only used to show which VNs are on your list.

## 0.8.1

Reading statuses now work like labels on VNDB.

### Changed
- **A game can have more than one reading status**, the same way a VN on VNDB can be both Playing
  and Finished (re-reading something, for example).
  - The status button on a game's page opens a list of checkboxes: Reading, Plan to read, On hold,
    Finished and Dropped. Each one is ticked or unticked on its own, and the others stay as they
    are.
  - When VN Shelf syncs with your VNDB list, only the label you ticked or unticked changes on VNDB.
    Your other status labels are never removed. 0.8.0 removed the other status labels whenever the
    status changed.
  - Statuses merge one by one, like categories and labels. One ticked or unticked on either side
    carries over, and changes made to different statuses on each side are all kept. On a game's
    first sync, if VN Shelf and VNDB have different statuses, the newer side's statuses are used.
  - A game is listed under each of its statuses in the sidebar. Its cover shows the main status
    (in the order Finished, Reading, On hold, Dropped, Plan to read) and "+1" for each other one;
    point at it to see them all.
  - Playing a game for the first time adds **Reading** when it has no status or only **Plan to
    read**. It no longer replaces Plan to read; untick that yourself if you want.
  - Ticking **Reading** or **Finished** fills in the Started or Finished date, as before.
- Older versions on your other PCs still show the main status. If you change a status there, that
  change wins on this PC too.

## 0.8.0

VN Shelf now syncs with your VNDB list. Your reading status, categories, rating and dates stay the
same in VN Shelf and on vndb.org, whichever side you change them on.

### New
- **Connect your VNDB account** in **Settings → VNDB**.
  1. On vndb.org, open **My Profile → Applications** and create a token with **Access to my
     list** and **Edit my list** ticked.
  2. Paste the token into VN Shelf and press **Connect**.

  The token is kept on this PC only, encrypted with Windows' credential protection. It is never
  put in your shared storage or copied by **Copy settings from another PC**, so connect on each
  PC where you want the sync. **Disconnect** deletes it. A token that can only read your list
  works too: changes then come from VNDB but aren't sent back.
- **What syncs, for every game linked to VNDB:**
  - **Reading status** with VNDB's Playing, Finished, Stalled, Dropped and Wishlist labels (shown
    in VN Shelf as Reading, Finished, On hold, Dropped and Plan to read). When you change the status,
    the old status label is taken off on VNDB, so a VN never ends up both Playing and Finished.
  - **Categories** whose name matches one of your own VNDB labels, ignoring upper and lower case.
    For example, a "Favourites" category and a "favourites" label sync with each other. Categories
    without a matching label stay in VN Shelf only. Matching categories show a small **VNDB**
    mark on the game page.
  - **Your rating** (1–10) and the **Started** and **Finished** dates, in the new **Your rating &
    dates** box on each game's page.
  - **Notes never sync.** Blacklisted VNs are left alone.
  - VNDB doesn't let apps clear a date. If you clear Started or Finished in VN Shelf, it stays cleared
    here, but the date on VNDB stays until you remove it on vndb.org. A rating can be cleared on
    both sides.
- **Dates fill themselves in.** Setting a game to Reading (or playing it for the first time) fills
  in **Started** with today's date if it was empty. Setting it to Finished fills in **Finished**.
  This works with or without VNDB.
- **Your VNDB list** in the sidebar shows the VNs on your VNDB list that aren't in your library,
  with their cover, status and rating, and a filter by status.
  - **+ Add** puts one in your library with its VNDB info and cover. Find its program on its page
    when it's on this PC.
  - **Link to "…"** appears when a game in your library has the same name but isn't linked to VNDB
    yet. It links them, so the game's status and labels sync from then on.
  - Click a cover to open the VN on vndb.org.
- **When it syncs:**
  - when VN Shelf starts
  - every 15 minutes
  - about 5 seconds after you change a status, category, rating or date
  - when you press **Sync with VNDB now** (in Settings → VNDB or on the list page)

  Usually this is a single request: VN Shelf asks only for entries changed since last time, and
  re-reads the whole list every few hours to notice VNs removed on the website.

### How changes are merged
- Each field is compared with what both sides agreed on last time. If only one side changed it,
  that change wins. If both changed the same field, the **newer change wins**, without asking.
  Different fields changed on each side are both kept.
- Categories and labels merge one by one: one added on either side is added on the other, and one
  removed on either side is removed on the other. The first time a game syncs, nothing is taken
  away: categories and labels from both sides are kept, and an empty field takes the other
  side's value.
- A VN removed from your VNDB list has its status, rating and dates cleared in VN Shelf too. Anything
  you changed in VN Shelf since the last sync is kept, and puts the VN back on the list.
- If VNDB can't be reached, or rejects a change, nothing is lost: the change is sent at the next
  sync. VN Shelf keeps under VNDB's request limits, sending at most one request a second and waiting
  when VNDB asks it to.

## 0.7.0

Setting up a new game is now just pressing Play. Registry saves sync, games get a reading status,
colours and fonts are yours to choose, and two PCs uploading at the same moment are handled safely.

**Update every PC.** 0.7.0 keeps each upload in a folder of its own in synced-folder mode. An older
version on your other PC can't read uploads made this way: it says "Still downloading" (and loses
nothing) until it's updated too.

### New
- **The save folder is found while you play.** For a game with no save folder, Play now just starts
  the game. When it closes, VN Shelf asks **Where does this game save?** and lists the places that
  changed while it ran, best match ticked:
  - the game folder, AppData (Roaming, Local, LocalLow), Documents and Saved Games
  - registry keys named after the game (see below)

  Pick one and the first upload follows straight away. If your other PC already uploaded saves for
  the game, you choose which to keep. **Ask me next time** if you didn't save, and **Somewhere else…**
  to choose the folder yourself. The separate **Save once** button is gone; this replaces it.
  Detection now also ignores more noise (browsers, LunaTranslator, Textractor, meikipop, Magpie,
  shader caches and similar) and notices files copied in with an old date.
- **Registry saves (Windows).** Some games keep their saves or cleared routes in the registry, under
  `HKEY_CURRENT_USER\Software\<maker>\<game>`. These sync now, as a small file next to the save
  files, so conflicts, History and Restore work as usual.
  - Add one from the list after playing, or with **Type a path…** (`HKCU\Software\Maker\Game`).
  - For safety, only keys at least two levels inside `HKEY_CURRENT_USER\Software` are allowed.
    Windows' and Microsoft's areas and anything machine-wide are refused.
  - An export is checked to be complete before anything is written into the registry.
- **Reading status:** Plan to read, Reading, On hold, Finished or Dropped, chosen on the game's
  page. It syncs between PCs.
  - It shows under the cover and as a filter in the sidebar, and there's a **Sort by → Reading
    status**.
  - Playing a game for more than a minute marks it **Reading** if it had no status yet (or was
    Plan to read).
  - The values match VNDB's list labels, ready for syncing with your VNDB list later.
- **Colours.** **Settings → Look** has six themes (Night, Midnight, Sakura, Matcha, Ink, and a light
  Paper). Change any of the nine main colours with a colour picker or a `#RRGGBB` code. The window
  updates as you go, and VN Shelf warns you if some text would be hard to read.
- **Fonts.** Choose a font for the English interface and one for Japanese. Each fills in characters
  the other doesn't have. Pick from the fonts installed on your PC, or add a `.ttf` / `.otf` file.
- **Copy settings from another PC** (Settings → General). Each PC now shares its look and
  preferences through your storage. One click copies the other PC's theme, fonts, background
  picture, language, sorting and similar settings. Where saves are kept, the PC's name and its
  programs and tools stay as they are.
- **Titles from the game's window.** A game that isn't linked to VNDB, and still has the title
  guessed from its folder name, takes the name its window shows while you play. Version numbers,
  "trial" markers and engine names are removed. Titles you typed and VNDB titles are never replaced.
- **Show play statistics on covers** can be turned off (Settings → Look).

### Safer
- **Two PCs uploading at the same moment.**
  - In folder mode, each upload goes into its own folder, so a sync app merging two uploads can
    never mix their files.
  - Every sync record lists the uploads it grew from. If this PC's upload was replaced by the
    other PC's, you get the "saves changed on both PCs" choice instead of a download over your saves.
  - VN Shelf re-checks shortly after uploading, so you hear about it straight away.
  - A replaced upload is moved into History after a day, where it can still be restored.
- **Two games, one save folder.** Adding a location that another game on this PC already syncs (the
  same folder, one inside or around it, or the same registry key) asks first.
- **Wait for it to close.** When saves can't come down because the game is open (started outside VN
  Shelf), you can let VN Shelf wait. It syncs by itself as soon as the game closes, and counts the
  time it was open.

## 0.6.0

Speed and safety. Google Drive mode now checks your whole library in a fraction of the time, VN
Shelf notices changes from your other PC by itself, play time is accurate and shared between PCs,
and several situations that could lose or mix up saves are now handled.

### Faster
- **Sync badges no longer cost any Google Drive requests.** Each game used to be checked
  separately (5 requests per game). Measured on a 33-game library, checking every game took about
  15 s and 163 requests. VN Shelf now reads every game's record, sync state and "open on another PC"
  marker in **one** listing, so all the badges fill in in about 4 milliseconds with no extra requests.
- **Game pages open without waiting for Drive.** They use the same listing (at most 20 seconds old).
  Your own changes show straight away. Anything that actually syncs saves (Play, Sync now, Restore)
  always reads the latest from Drive first.
- **Save files aren't re-read to check them.** VN Shelf remembers each save file's fingerprint along
  with its size and modified time (in `hash-cache.json` in VN Shelf's settings folder). Unchanged
  files are no longer read again on every check, or on every upload in Google Drive mode. A file
  changed in the last few seconds is always read, since some drives (FAT32, exFAT) only record
  modified times to the nearest 2 seconds.
- **Synced-folder mode reads the library in parallel**, which helps on slow network shares.
- The search box redraws at most once per frame while you type.

### New
- **Changes from your other PC show up by themselves.** VN Shelf checks for them every 20 seconds
  while its window is open, and every 2 minutes from the tray. Games added on the other PC appear,
  and badges update when it uploads saves. In Google Drive mode each check is a single small
  request. In folder mode it compares file sizes and times, without reading anything.
- **Saves made outside VN Shelf are uploaded.** At start-up and every 5 minutes, VN Shelf uploads
  saves for any game that changed on this PC since it last synced. That covers games started from a
  desktop shortcut and uploads that had to wait while you were offline. It only uploads, and only
  when the cloud copy hasn't changed meanwhile: it never downloads or asks you anything in the
  background. A notice lists the games it uploaded.
- **Accurate play time, shared between PCs.** Play time now counts only the time the game itself
  was running. The wait for a launcher to start the real game, the few seconds VN Shelf waits after
  the game closes, and time the PC spent asleep don't count. Each PC adds its own time to the game's
  shared record, so every PC shows the total; hover over it on the game page to see each PC's share.
  Time counted by earlier versions is carried over. "Last played" is now the latest on any PC.
- **Games that need administrator rights.** Windows refuses to start these normally (error 740).
  VN Shelf now shows Windows' own permission prompt instead. If you answer No, it says so and
  changes nothing. While such a game runs, VN Shelf follows it by its process, because Windows hides
  an administrator program's details from normal programs.

### Safer
- **One sync at a time per game.** The background upload, Play, Sync now, Restore and Import saves
  can no longer copy the same game's files at the same moment. Different games don't wait for each
  other.
- **Saves never come down while the game is open.** If you started a game some other way and it's
  still running, VN Shelf won't replace its saves: the open game could write its older saves back
  over them later. You're asked to close it and try again. This is checked only when saves are about
  to be downloaded, so it doesn't slow down anything else.
- **An empty save folder never wipes the cloud copy.** If a game's save folder is missing or empty
  (a drive that isn't plugged in, a reinstalled game), VN Shelf now brings the saves back down.
  Before, it could treat the empty folder as "all saves deleted" and upload that.
- **A half-downloaded sync record is refused.** In folder mode, a sync app can be partway through
  downloading a game's `state.json`. VN Shelf now says "try again in a moment" instead of treating it
  as missing and uploading over it.
- **Sync apps' duplicate copies are ignored.** A game folder that Dropbox or Google Drive duplicated
  ("… (1)", "… (conflicted copy)", "競合コピー") no longer appears as a second game, and duplicated
  backup folders are skipped in History.
- **Files a game still holds open are retried.** A game (or antivirus) can keep a save file locked for
  a moment after closing. Copying and reading now retry for about a second before giving up.
- **Quitting waits for syncs to finish**, for up to 2 minutes, so saves are never left half-copied.
- **Leftover upload folders are cleaned up.** A push interrupted by a crash or power cut could leave
  an `.incoming-…` folder in the shared folder; ones older than a day are now removed.
- **Unexpected errors are logged** to `error.log` in VN Shelf's settings folder instead of closing the
  app.

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
