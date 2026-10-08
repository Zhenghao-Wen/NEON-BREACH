# ===========================================================================
#  NEON BREACH - launcher (Windows PowerShell)
#
#  Usage:
#     .\start.ps1                     start and open the browser
#     .\start.ps1 -Port 8080          prefer a different port
#     .\start.ps1 -NoOpen             do not open a browser
#     .\start.ps1 -Vendor             serve three.js from .\threejs
#
#  If script execution is blocked, run this once in the same window:
#     Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#  or simply use start.bat instead.
# ===========================================================================
[CmdletBinding()]
param(
  [int]$Port = 5180,
  [switch]$NoOpen,
  [switch]$NoInstall,
  [switch]$Vendor
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root

try {
  Write-Host ''
  Write-Host '  NEON BREACH' -ForegroundColor Cyan

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host '  [x] Node.js was not found on PATH.' -ForegroundColor Red
    Write-Host '      Install Node.js 18 or newer from https://nodejs.org/'
    exit 1
  }

  $args = @('tools/launch.mjs', '--port', "$Port")
  if ($NoOpen) { $args += '--no-open' }
  if ($NoInstall) { $args += '--no-install' }
  if ($Vendor) { $args += '--vendor' }

  & node @args
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
