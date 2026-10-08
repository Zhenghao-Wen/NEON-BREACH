# =============================================================================
#  push-to-github.ps1
#
#  Initialises the repository (if needed), commits everything and pushes it to
#  the given remote. Run this OUTSIDE the sandbox, from the project folder:
#
#      cd C:\Users\seewo\game
#      .\push-to-github.ps1
#
#  Common variations:
#
#      .\push-to-github.ps1 -Message "Add weapon balancing"
#      .\push-to-github.ps1 -Branch main
#      .\push-to-github.ps1 -RemoteUrl git@github.com:Zhenghao-Wen/game1.git
#      .\push-to-github.ps1 -DryRun          # show what would happen, change nothing
#
#  If PowerShell refuses to run the file, allow it for this window only:
#
#      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# =============================================================================
[CmdletBinding()]
param(
  [string]$RemoteUrl = 'https://github.com/Zhenghao-Wen/game1.git',
  [string]$Branch    = 'main',
  [string]$Message   = 'NEON BREACH: procedural 3D first-person shooter',
  [string]$UserName  = '',
  [string]$UserEmail = '',
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Head($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  [warn] $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "  [fail] $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "         $text" -ForegroundColor DarkGray }

function Invoke-Git {
  # The parameter is deliberately not named $Args: that is a PowerShell automatic
  # variable and shadowing it makes these calls confusing.
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  if ($DryRun -and $GitArgs[0] -in @('commit', 'push', 'add', 'init', 'remote', 'branch', 'checkout')) {
    Write-Info "would run: git $($GitArgs -join ' ')"
    return @()
  }
  $output = Invoke-GitCapture @GitArgs
  if ($script:LastGitExit -ne 0) {
    throw "git $($GitArgs -join ' ') failed (exit $script:LastGitExit):`n$($output -join "`n")"
  }
  return $output
}

$script:LastGitExit = 0

<#
  Run git and capture its output without letting a non-zero exit abort the
  script. $ErrorActionPreference = 'Stop' turns a native command's stderr into a
  terminating error, which would kill the run before any branch could report a
  useful message, so it is lowered for the duration of the call only.
#>
function Invoke-GitCapture {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git @GitArgs 2>&1
    $script:LastGitExit = $LASTEXITCODE
    return @($output | Where-Object { $_ -ne $null })
  } finally {
    $ErrorActionPreference = $saved
  }
}

function Get-GitLines {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  $out = Invoke-GitCapture @GitArgs
  if ($script:LastGitExit -ne 0) { return @() }
  return @($out | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
}

function Test-InRepo {
  Invoke-GitCapture rev-parse --git-dir > $null
  return ($script:LastGitExit -eq 0)
}

function Test-HasCommit {
  Invoke-GitCapture rev-parse --verify HEAD > $null
  return ($script:LastGitExit -eq 0)
}

Write-Host ''
Write-Host '  NEON BREACH  ->  GitHub' -ForegroundColor Cyan
Write-Ok "target: $RemoteUrl ($Branch)"

# -----------------------------------------------------------------------------
# 1. preconditions
# -----------------------------------------------------------------------------
Write-Head '1. Checking the environment'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Err 'git was not found on PATH.'
  Write-Info 'Install Git for Windows from https://git-scm.com/download/win and reopen the terminal.'
  exit 1
}
Write-Ok ("git " + ((& git --version) -replace '^git version ', ''))

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
Write-Ok "project: $root"

# sanity: this must be the game, not some other folder
foreach ($required in @('index.html', 'package.json', 'src\main.js', 'tools\serve.mjs')) {
  if (-not (Test-Path (Join-Path $root $required))) {
    Write-Err "this does not look like the NEON BREACH project (missing $required)."
    exit 1
  }
}
Write-Ok 'project files present'

# -----------------------------------------------------------------------------
# 2. identity
# -----------------------------------------------------------------------------
Write-Head '2. Checking the git identity'

$name  = if ($UserName)  { $UserName }  else { (Get-GitLines config --global user.name) -join '' }
$email = if ($UserEmail) { $UserEmail } else { (Get-GitLines config --global user.email) -join '' }

if (-not $name) {
  if ($DryRun) { Write-Warn2 'no global user.name (dry run, continuing)' }
  else {
    Write-Warn2 'git has no user.name configured.'
    $name = Read-Host '  Your name for commits'
    if (-not $name) { Write-Err 'a name is required.'; exit 1 }
    & git config --global user.name $name
    Write-Ok "set user.name = $name"
  }
} else { Write-Ok "user.name  = $name" }

if (-not $email) {
  if ($DryRun) { Write-Warn2 'no global user.email (dry run, continuing)' }
  else {
    Write-Warn2 'git has no user.email configured.'
    $email = Read-Host '  Your email for commits'
    if (-not $email) { Write-Err 'an email is required.'; exit 1 }
    & git config --global user.email $email
    Write-Ok "set user.email = $email"
  }
} else { Write-Ok "user.email = $email" }

# -----------------------------------------------------------------------------
# 3. repository
# -----------------------------------------------------------------------------
Write-Head '3. Preparing the repository'

if (Test-Path (Join-Path $root '.git')) {
  Write-Ok 'existing git repository'
} elseif ($DryRun) {
  Write-Info 'would run: git init'
} else {
  Invoke-Git init | Out-Null
  Write-Ok 'git init'
}

# default branch
$current = (Get-GitLines rev-parse --abbrev-ref HEAD) -join ''
if ($DryRun) {
  Write-Info "would run: git checkout -B $Branch"
} elseif ($current -ne $Branch) {
  Invoke-Git checkout -B $Branch | Out-Null
  Write-Ok "branch: $Branch"
} else {
  Write-Ok "branch: $Branch"
}

# -----------------------------------------------------------------------------
# 4. what will be committed
# -----------------------------------------------------------------------------
Write-Head '4. Staging files'

$repoReady = Test-InRepo
if (-not $repoReady) {
  Write-Warn2 'no repository yet — staging is skipped in this mode'
}

if ($repoReady) {
  Invoke-Git add -A | Out-Null

  # Safety net: node_modules must never be committed
  $tracked = Get-GitLines ls-files
  $junk = $tracked | Where-Object { $_ -match '^(node_modules|\.npm-cache)/' }
  if ($junk) {
    Write-Warn2 "found $($junk.Count) tracked files that should be ignored; removing from the index"
    Invoke-GitCapture rm -r --cached --quiet node_modules .npm-cache > $null
  }

  $staged = Get-GitLines diff --cached --name-only
} else {
  # Dry run before `git init`: there is no index to query yet. Walk the working
  # tree and ask git which paths its ignore rules would exclude, using
  # `check-ignore --no-index --stdin` so no repository is created and nothing on
  # disk is modified.
  try {
    $all = @(
      Get-ChildItem -Path $root -Recurse -File -Force -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/' } |
        Where-Object { $_ -and $_ -notmatch '^\.git/' }
    )
    if ($all.Count -eq 0) {
      $staged = @()
    } else {
      # git is asked which paths its ignore rules would exclude. The list goes
      # through a temp file fed over stdin: passing paths as arguments overflows
      # the Windows command line at this size, and `--stdin` needs plain LF
      # without a BOM, which Set-Content -Encoding ascii would add.
      $ignoreSet = @{}
      $tmpList = Join-Path ([System.IO.Path]::GetTempPath()) (
        'nb-paths-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.txt')
      $saved = $ErrorActionPreference
      try {
        [System.IO.File]::WriteAllText($tmpList, ($all -join "`n") + "`n", [System.Text.Encoding]::ASCII)
        $ErrorActionPreference = 'Continue'
        $hit = & cmd /c "git check-ignore --no-index --stdin < `"$tmpList`"" 2>$null
        foreach ($h in $hit) {
          $name = $h.ToString().Trim()
          if ($name) { $ignoreSet[$name] = $true }
        }
      } catch {
        Write-Warn2 "ignore-rule lookup failed ($($_.Exception.Message)); assuming nothing is ignored"
      } finally {
        $ErrorActionPreference = $saved
        Remove-Item -Force $tmpList -ErrorAction SilentlyContinue
      }
      $staged = @($all | Where-Object { -not $ignoreSet.ContainsKey($_) })
      Write-Info "(previewed: $($staged.Count) of $($all.Count) files, $($ignoreSet.Count) ignored)"
    }
  } catch {
    Write-Warn2 "could not preview the file list: $($_.Exception.Message)"
    $staged = @()
  }
}

if (-not $staged) { $staged = @() }
$staged = @($staged | Where-Object { $_ })

if (-not $staged -or $staged.Count -eq 0) {
  Write-Warn2 'nothing staged — the working tree matches the last commit.'
  if (Test-HasCommit) {
    Write-Info 'will still ensure the remote and push.'
  }
} else {
  Write-Ok "$($staged.Count) file(s) staged"
  $byTop = $staged | ForEach-Object { ($_ -split '[\\/]')[0] } | Group-Object | Sort-Object Count -Descending
  foreach ($g in $byTop | Select-Object -First 8) {
    Write-Info ("{0,5}  {1}" -f $g.Count, $g.Name)
  }
  if ($byTop.Count -gt 8) { Write-Info "  ... and $($byTop.Count - 8) more top-level entries" }

  # a quick size sanity check so nobody commits a gigabyte by accident
  $totalMb = 0
  foreach ($f in $staged) {
    $p = Join-Path $root $f
    if (Test-Path $p) { $totalMb += (Get-Item $p).Length }
  }
  $totalMb = [math]::Round($totalMb / 1MB, 1)
  Write-Ok "staged payload: $totalMb MB"
  if ($totalMb -gt 150) {
    Write-Warn2 'that is large for a source repository — check .gitignore before continuing.'
    if (-not $Force -and -not $DryRun) {
      $answer = Read-Host '  Continue anyway? [y/N]'
      if ($answer -notmatch '^(y|Y)') { Write-Err 'aborted.'; exit 1 }
    }
  }
}

# -----------------------------------------------------------------------------
# 5. commit
# -----------------------------------------------------------------------------
Write-Head '5. Committing'

$doCommit = $staged -and $staged.Count -gt 0
if ($doCommit) {
  # explain the project in the commit body on the very first commit
  $hasCommit = Test-HasCommit

  $body = @(
    '',
    'Fully offline 3D first-person shooter.',
    '',
    '- Zero build step: native ES modules + import map, three.js served as-is',
    '- Zero external assets: every texture, sound, level and creature model is',
    '  generated procedurally at runtime',
    '- 10-zone facility, 8 enemy types + 2 bosses, 7 weapons, 15 upgrades',
    '- 12-wave survival mode with an intermission armoury',
    '',
    'Verified offline by tools/ (197 automated checks): static module graph,',
    'level connectivity, A* reachability, 4-minute gameplay simulation,',
    'combat lethality, GLSL wiring and the exact bytes the server emits.'
  ) -join "`n"

  $fullMessage = if ($hasCommit) { $Message } else { "$Message`n$body" }
  Invoke-Git commit -m $fullMessage | Out-Null
  Write-Ok "committed: $Message"
} else {
  Write-Ok 'nothing new to commit'
}

# -----------------------------------------------------------------------------
# 6. remote
# -----------------------------------------------------------------------------
Write-Head '6. Configuring the remote'

if ($DryRun -and -not $repoReady) {
  Write-Info "would run: git remote add origin $RemoteUrl"
} else {
  $existing = Get-GitLines remote
  if ($existing -contains 'origin') {
    $currentUrl = (Get-GitLines remote get-url origin) -join ''
    if ($currentUrl -eq $RemoteUrl) {
      Write-Ok "origin = $RemoteUrl"
    } else {
      Write-Warn2 "origin currently points at $currentUrl"
      Invoke-Git remote set-url origin $RemoteUrl | Out-Null
      Write-Ok "origin updated to $RemoteUrl"
    }
  } else {
    Invoke-Git remote add origin $RemoteUrl | Out-Null
    Write-Ok "origin added = $RemoteUrl"
  }
}

# -----------------------------------------------------------------------------
# 7. push
# -----------------------------------------------------------------------------
Write-Head '7. Pushing'

if ($DryRun) {
  Write-Info "would run: git push -u origin $Branch"
  Write-Host ''
  Write-Warn2 'dry run — nothing was committed or pushed.'
  exit 0
}

# HTTPS pushes need credentials. GitHub no longer accepts a password, so if the
# push fails with an auth error, say exactly what to do about it.
$pushOutput = & git push -u origin $Branch 2>&1
$pushCode = $LASTEXITCODE

if ($pushCode -ne 0) {
  $text = $pushOutput -join "`n"
  Write-Host $text -ForegroundColor DarkGray
  Write-Host ''
  if ($text -match 'Authentication failed|could not read Username|terminal prompts disabled|403') {
    Write-Err 'authentication failed.'
    Write-Host ''
    Write-Info 'GitHub does not accept account passwords over HTTPS. Use one of:'
    Write-Host ''
    Write-Host '    1) Personal access token (simplest)' -ForegroundColor White
    Write-Host '       https://github.com/settings/tokens  ->  Generate new token (classic)'
    Write-Host '       scope: repo.  Then push with the token as the password:'
    Write-Host "       git push -u origin $Branch" -ForegroundColor Gray
    Write-Host '       username: Zhenghao-Wen     password: <the token>'
    Write-Host ''
    Write-Host '    2) SSH' -ForegroundColor White
    Write-Host '       ssh-keygen -t ed25519 -C "you@example.com"'
    Write-Host '       add the public key at https://github.com/settings/keys'
    Write-Host '       .\push-to-github.ps1 -RemoteUrl git@github.com:Zhenghao-Wen/game1.git'
    Write-Host ''
    Write-Host '    3) GitHub CLI' -ForegroundColor White
    Write-Host '       gh auth login'
    Write-Host '       gh repo create game1 --public --source . --push'
    Write-Host ''
  } elseif ($text -match 'Repository not found|does not exist') {
    Write-Err 'the remote repository was not found.'
    Write-Info "create it first: https://github.com/new?name=game1"
    Write-Info 'or, with the GitHub CLI:  gh repo create game1 --public --source . --push'
  } elseif ($text -match 'rejected|non-fast-forward|fetch first') {
    Write-Err 'the remote has commits you do not have locally.'
    Write-Info "inspect with:  git fetch origin ; git log --oneline origin/$Branch"
    Write-Info "then either merge, or overwrite with:  git push -u origin $Branch --force-with-lease"
  } elseif ($text -match 'failed to connect|could not resolve host|timed out') {
    Write-Err 'could not reach GitHub.'
    Write-Info 'check the network / proxy, or use SSH if HTTPS is filtered.'
  } else {
    Write-Err 'push failed — see the output above.'
  }
  exit $pushCode
}

Write-Host $pushOutput -ForegroundColor DarkGray
Write-Ok "pushed $Branch to origin"

# -----------------------------------------------------------------------------
# done
# -----------------------------------------------------------------------------
$web = $RemoteUrl -replace '^git@github\.com:', 'https://github.com/' -replace '\.git$', ''
Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
Write-Host "  Repository: $web" -ForegroundColor White
Write-Host ''
$last = & git log -1 --pretty=format:'%h  %s' 2>$null
if ($last) { Write-Host "  Commit:     $last" -ForegroundColor DarkGray }
Write-Host ''
Write-Host '  Useful afterwards:' -ForegroundColor Cyan
Write-Host '    git status                 see what changed'
Write-Host '    .\push-to-github.ps1 -Message "..."   commit and push again'
Write-Host ''
