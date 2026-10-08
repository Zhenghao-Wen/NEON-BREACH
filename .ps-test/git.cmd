param([Parameter(ValueFromRemainingArguments=$true)][string[]]$a)
$joined = $a -join ' '
switch ($a[0]) {
  '--version' { 'git version 2.43.0.mock'; exit 0 }
  'config'    { if ($joined -match 'user.name') { 'Mock User'; exit 0 } if ($joined -match 'user.email') { 'mock@example.com'; exit 0 } exit 0 }
  'init'      { exit 0 }
  'rev-parse' { if ($joined -match 'abbrev-ref') { 'main' } else { 'deadbeef'; exit 0 }; exit 0 }
  'add'       { exit 0 }
  'remote'    { if ($joined -eq 'remote') { 'origin' } elseif ($joined -match 'get-url') { 'https://github.com/old/repo.git' } else { exit 0 }; exit 0 }
  'diff'      { "index.html`npackage.json`nsrc/main.js`ntools/serve.mjs`nthreejs/three.module.js`nREADME.md"; exit 0 }
  'ls-files'  { "index.html`npackage.json`nsrc/main.js"; exit 0 }
  'log'       { 'abc1234  NEON BREACH: procedural 3D first-person shooter'; exit 0 }
  'commit'    { exit 0 }
  'checkout'  { exit 0 }
  'push'      { 'To https://github.com/Zhenghao-Wen/game1.git'; ' * [new branch]      main -> main'; exit 0 }
  default     { exit 0 }
}
