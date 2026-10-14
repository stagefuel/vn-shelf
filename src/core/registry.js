'use strict';
// Registry saves (Windows). A few games keep their saves (or system data such as cleared routes) in
// the registry under HKEY_CURRENT_USER\Software\<maker>\<game> instead of in files. Such a key is
// exported as plain JSON and synced as a pretend file named __registry__.json next to the save
// files, so conflicts, History and Restore work exactly as they do for files.
//
// Safety rules, enforced here and not just in the UI:
//   * only HKEY_CURRENT_USER (this Windows user), never anything machine-wide
//   * only a key at least two levels below Software (Software\Maker\Game)
//   * never a Windows, Microsoft or other system area
// An export is checked to be complete and well-formed before anything in the registry is touched.

const { execFile } = require('child_process');
const crypto = require('crypto');

const KINDS = new Set(['String', 'ExpandString', 'MultiString', 'DWord', 'QWord', 'Binary', 'None']);
// Second-level keys under Software that belong to Windows or other programs, never to a game.
const FORBIDDEN = new Set([
  'microsoft', 'windows', 'classes', 'clients', 'policies', 'wow6432node', 'registeredapplications',
  'appdatalow', 'intel', 'nvidia corporation', 'amd', 'google', 'mozilla', 'valve', 'microsoft corporation',
  'wow64', 'appx', 'chromium', 'oracle', 'python', '7-zip', 'winrar', 'vn shelf',
]);

class RegistryKeyNotAllowed extends Error {
  constructor(message) {
    super(message);
    this.code = 'registry-not-allowed';
  }
}

/**
 * 'HKCU\Software\Maker\Game', 'HKEY_CURRENT_USER\Software\Maker\Game' or 'Software\Maker\Game'
 * -> 'Software\Maker\Game'. Throws RegistryKeyNotAllowed for anything outside the safe area.
 */
function normalizeKey(input) {
  let k = String(input || '').trim().replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/^\\|\\$/g, '');
  const upper = k.toUpperCase();
  for (const root of ['HKEY_CURRENT_USER\\', 'HKCU\\', 'HKCU:\\']) {
    if (upper.startsWith(root)) { k = k.slice(root.length); break; }
  }
  if (/^(HKLM|HKEY_LOCAL_MACHINE|HKCR|HKEY_CLASSES_ROOT|HKU|HKEY_USERS|HKCC|HKEY_CURRENT_CONFIG)\b/i.test(k)) {
    throw new RegistryKeyNotAllowed('Only keys under HKEY_CURRENT_USER\\Software\\<maker>\\<game> can be synced.');
  }
  const parts = k.split('\\').filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== 'software' || parts.some((p) => p === '..' || p === '.')) {
    throw new RegistryKeyNotAllowed('Only keys under HKEY_CURRENT_USER\\Software\\<maker>\\<game> can be synced.');
  }
  if (FORBIDDEN.has(parts[1].toLowerCase())) {
    throw new RegistryKeyNotAllowed(`HKEY_CURRENT_USER\\Software\\${parts[1]} belongs to Windows or another program, so it can't be synced.`);
  }
  parts[0] = 'Software';
  return parts.join('\\');
}

function display(key) { return `HKEY_CURRENT_USER\\${key}`; }

/** The same contents always give the same text (and so the same fingerprint). */
function canonical(data) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(data), null, 1);
}

/** Is this a complete, well-formed export? Checked before the registry is touched. */
function valid(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 32) return false;
  if (!data.values || typeof data.values !== 'object' || !data.keys || typeof data.keys !== 'object') return false;
  for (const v of Object.values(data.values)) {
    if (!v || !KINDS.has(v.kind)) return false;
    if (v.kind === 'MultiString' ? !Array.isArray(v.data) || v.data.some((x) => typeof x !== 'string') : !['string', 'number'].includes(typeof v.data)) return false;
    if ((v.kind === 'Binary' || v.kind === 'None') && !/^[0-9A-Fa-f]*$/.test(String(v.data))) return false;
    if (v.kind === 'DWord' && !(Number(v.data) >= 0 && Number(v.data) <= 0xffffffff)) return false;
    if (v.kind === 'QWord' && !/^\d+$/.test(String(v.data))) return false;
  }
  return Object.values(data.keys).every((sub) => valid(sub, depth + 1));
}

function countValues(data) {
  if (!data) return 0;
  return Object.keys(data.values || {}).length + Object.values(data.keys || {}).reduce((n, s) => n + countValues(s), 0);
}

function sha1(text) { return crypto.createHash('sha1').update(text).digest('hex'); }

// ------------------------------------------------------------------ Windows

const PS_PRELUDE = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference="Stop"; ';

const PS_EXPORT = PS_PRELUDE + `
function Dump($k) {
  $vals = @{}; $subs = @{}
  foreach ($n in $k.GetValueNames()) {
    $kind = [string]$k.GetValueKind($n)
    $v = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
    switch ($kind) {
      'Binary' { $v = [BitConverter]::ToString([byte[]]$v).Replace('-', '') }
      'None' { if ($v) { $v = [BitConverter]::ToString([byte[]]$v).Replace('-', '') } else { $v = '' } }
      'DWord' { $v = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$v), 0) }
      'QWord' { $v = [string][BitConverter]::ToUInt64([BitConverter]::GetBytes([long]$v), 0) }
      'MultiString' { $v = @($v) }
      default { $v = [string]$v }
    }
    $vals[$n] = @{ kind = $kind; data = $v }
  }
  foreach ($s in $k.GetSubKeyNames()) { $sk = $k.OpenSubKey($s); $subs[$s] = Dump $sk; $sk.Close() }
  @{ values = $vals; keys = $subs }
}
$out = @{}
foreach ($key in ($env:VNS_KEYS -split "\`n" | Where-Object { $_ })) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)
  if ($k) { $out[$key] = Dump $k; $k.Close() } else { $out[$key] = $null }
}
[Console]::Out.Write((ConvertTo-Json -InputObject $out -Depth 64 -Compress))
`;

const PS_IMPORT = PS_PRELUDE + `
$data = Get-Content -LiteralPath $env:VNS_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
function Hex($s) { $b = New-Object byte[] ($s.Length / 2); for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = [Convert]::ToByte($s.Substring($i * 2, 2), 16) }; ,$b }
function Write-Key($k, $d) {
  foreach ($p in $d.values.PSObject.Properties) {
    $kind = [Microsoft.Win32.RegistryValueKind]$p.Value.kind
    $v = $p.Value.data
    switch ($p.Value.kind) {
      'Binary' { $v = Hex ([string]$v) }
      'None' { $v = Hex ([string]$v) }
      'DWord' { $v = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$v), 0) }
      'QWord' { $v = [BitConverter]::ToInt64([BitConverter]::GetBytes([uint64]$v), 0) }
      'MultiString' { $v = [string[]]@($v) }
      default { $v = [string]$v }
    }
    $k.SetValue($p.Name, $v, $kind)
  }
  foreach ($p in $d.keys.PSObject.Properties) { $sk = $k.CreateSubKey($p.Name); Write-Key $sk $p.Value; $sk.Close() }
}
$cu = [Microsoft.Win32.Registry]::CurrentUser
$cu.DeleteSubKeyTree($env:VNS_KEY, $false)
$k = $cu.CreateSubKey($env:VNS_KEY)
Write-Key $k $data
$k.Close()
[Console]::Out.Write('OK')
`;

// Keys under Software\<maker>\<game> (and one level below) last written at or after a moment.
const PS_WRITTEN = PS_PRELUDE + `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class VnsRegTime {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegQueryInfoKey(SafeRegistryHandle k, IntPtr a, IntPtr b, IntPtr c, IntPtr d, IntPtr e, IntPtr f, IntPtr g, IntPtr h, IntPtr i, IntPtr j, out long t);
  public static long Get(Microsoft.Win32.RegistryKey k) { long t; return RegQueryInfoKey(k.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out t) == 0 ? t : 0; }
}
"@
$since = [long]$env:VNS_SINCE
$skip = $env:VNS_SKIP -split ','
$sw = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software')
$found = New-Object System.Collections.Generic.List[string]
foreach ($m in $sw.GetSubKeyNames()) {
  if ($skip -contains $m.ToLower()) { continue }
  try { $mk = $sw.OpenSubKey($m) } catch { continue }
  if (-not $mk) { continue }
  foreach ($g in $mk.GetSubKeyNames()) {
    try { $gk = $mk.OpenSubKey($g) } catch { continue }
    if (-not $gk) { continue }
    $t = [VnsRegTime]::Get($gk)
    foreach ($s in $gk.GetSubKeyNames()) { try { $sk = $gk.OpenSubKey($s); $t = [Math]::Max($t, [VnsRegTime]::Get($sk)); $sk.Close() } catch {} }
    if ($t -ge $since) { $found.Add("Software\\$m\\$g") }
    $gk.Close()
  }
  $mk.Close()
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($found) -Compress))
`;

function runPs(script, env, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, ...env }, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Registry access failed: ${String(stderr || err.message).trim().split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}

/** The real registry, through Windows PowerShell and .NET's registry classes. */
class WindowsRegistry {
  /** Several keys at once (one PowerShell). Returns Map(key -> export, or null if it doesn't exist). */
  async exportKeys(keys) {
    if (!keys.length) return new Map();
    const out = JSON.parse((await runPs(PS_EXPORT, { VNS_KEYS: keys.join('\n') })) || '{}');
    return new Map(keys.map((k) => [k, out[k] || null]));
  }

  /** Replace the key's contents with `data` (the caller backs up the old contents first). */
  async importKey(key, data, tmpFile) {
    if (!valid(data)) throw new Error('damaged registry export');
    require('fs').writeFileSync(tmpFile, JSON.stringify(data), 'utf8');
    try {
      const r = await runPs(PS_IMPORT, { VNS_KEY: normalizeKey(key), VNS_FILE: tmpFile });
      if (!String(r).includes('OK')) throw new Error('Registry import didn\'t finish.');
    } finally { require('fs').rmSync(tmpFile, { force: true }); }
  }

  /** Software\<maker>\<game> keys written at or after `sinceMs`. */
  async writtenSince(sinceMs) {
    const filetime = (BigInt(Math.floor(sinceMs)) + 11644473600000n) * 10000n;
    const out = JSON.parse((await runPs(PS_WRITTEN, { VNS_SINCE: String(filetime), VNS_SKIP: [...FORBIDDEN].join(',') }, 60000)) || '[]');
    return (Array.isArray(out) ? out : [out]).filter(Boolean);
  }
}

/** An in-memory registry with the same interface, for tests (and platforms without one). */
class MemoryRegistry {
  constructor() { this.keys = new Map(); this.written = new Map(); }

  set(key, data) { this.keys.set(normalizeKey(key), JSON.parse(JSON.stringify(data))); this.written.set(normalizeKey(key), Date.now()); }

  async exportKeys(keys) { return new Map(keys.map((k) => [k, this.keys.has(k) ? JSON.parse(JSON.stringify(this.keys.get(k))) : null])); }

  async importKey(key, data) {
    if (!valid(data)) throw new Error('damaged registry export');
    this.set(key, data);
  }

  async writtenSince(sinceMs) { return [...this.written].filter(([, t]) => t >= sinceMs).map(([k]) => k); }
}

module.exports = {
  normalizeKey, display, canonical, valid, countValues, sha1, WindowsRegistry, MemoryRegistry, RegistryKeyNotAllowed, FORBIDDEN,
};
