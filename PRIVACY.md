# VN Shelf privacy policy

VN Shelf is a desktop app that runs entirely on your own computer. It has no server, no account
system and no analytics. The developer never receives any of your data.

## What the app accesses

- **Your save files and game folders**, on your own computer, to copy saves between your PCs.
- **Google Drive, only if you choose to sign in with Google.** VN Shelf asks for the
  `drive.file` permission. That lets it see and change only the files and folders VN Shelf itself
  created in your Drive (your synced save files). It cannot see anything else in your Drive.
- **VNDB (vndb.org)**, when you search for a game, import a folder of games or refresh a game's info.
  The search text (a title or folder name) is sent to VNDB's public API, and covers are downloaded
  from VNDB's image server.
- **Your VNDB list, only if you connect your VNDB account** (Settings → VNDB). VN Shelf then reads
  your list and its labels and sends VNDB changes to the reading status, labels, rating and
  started/finished dates of the VNs in your library. It never reads or sends your list notes.
- **GitHub (github.com)**, to check for a newer version of VN Shelf when the app starts and when you
  press Check now, and to download an update you choose to install. You can turn the automatic
  check off in Settings → Updates. Only GitHub's public release list is requested; nothing about
  you or your games is sent.
- **Programs you add as companion tools** are started on your computer only when you play a game
  you enabled them for.

## What is stored, and where

- The Google sign-in token is stored on your computer, encrypted with your operating system's
  credential protection. Signing out in Settings deletes it. You can also revoke access at any
  time at <https://myaccount.google.com/permissions>.
- A VNDB token, if you connect one, is stored the same way on that computer only. It is never
  put in your sync location. Disconnecting in Settings deletes it, and you can also delete the token
  on vndb.org (My Profile → Applications).
- Your save files are stored in your own Google Drive, or in whatever folder you chose for syncing.
- Settings and the game library are stored in the app's folder on your computer and in your
  chosen sync location.

## Sharing

VN Shelf does not sell, share or transfer any data to anyone. Data from Google APIs is used only to
store and retrieve your own save files, in line with the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including its Limited Use requirements.

## Contact

Questions: open an issue at <https://github.com/stagefuel/vn-shelf/issues>.
