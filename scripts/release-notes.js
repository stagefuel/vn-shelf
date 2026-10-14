'use strict';
// Print the CHANGELOG.md section for a version (used as the GitHub release text).
// Usage: node scripts/release-notes.js v0.3.0 > notes.md
const fs = require('fs');
const path = require('path');

const version = String(process.argv[2] || '').replace(/^v/, '');
const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const lines = text.split('\n');
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
process.stdout.write(`${body}\n\n---\n**Download:** \`VN-Shelf-${version}-portable.exe\` runs without installing. Windows may show "Windows protected your PC" because the file isn't code-signed: click **More info**, then **Run anyway**. From 0.3.0 on, VN Shelf updates itself.\n\nFull history: [CHANGELOG.md](https://github.com/stagefuel/vn-shelf/blob/main/CHANGELOG.md)\n`);
