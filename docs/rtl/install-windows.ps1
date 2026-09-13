# Builds the RTL/BiDi dev build and installs it over the npm-installed
# `opencode` (stable) and `opencode2` (beta @opencode-ai/cli) binaries on
# Windows. Original binaries are kept next to the new ones as
# `*.original-backup` so restore-windows.ps1 can roll back.
#
# Usage (from the repository root):
#   powershell -ExecutionPolicy Bypass -File docs/rtl/install-windows.ps1

$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$exe = Join-Path $repo "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"

Write-Host "Building single-platform native binary..."
Push-Location $repo
try {
  bun run --cwd packages/opencode script/build.ts --single --skip-install --skip-embed-web-ui
} finally {
  Pop-Location
}

if (-not (Test-Path $exe)) {
  throw "Build did not produce $exe"
}

$targets = @(
  (Join-Path $env:APPDATA "npm\node_modules\opencode-ai\bin\opencode.exe"),
  (Join-Path $env:APPDATA "npm\node_modules\@opencode-ai\cli\bin\opencode2.exe")
)

foreach ($target in $targets) {
  if (-not (Test-Path $target)) {
    Write-Host "Skipping (not installed): $target"
    continue
  }
  $backup = "$target.original-backup"
  if (-not (Test-Path $backup)) {
    Copy-Item $target $backup -Force
    Write-Host "Backed up: $backup"
  }
  try {
    Copy-Item $exe $target -Force
    Write-Host "Installed: $target"
  } catch {
    # A running instance locks the executable. Windows allows renaming a
    # running image, so move it aside first, then place the new build.
    Move-Item -LiteralPath $target -Destination $backup -Force
    Copy-Item $exe $target -Force
    Write-Host "Installed (renamed running binary): $target"
  }
}

Write-Host ""
Write-Host "Done. Restart any running OpenCode window to pick up the new build."
Write-Host 'Verify with: opencode --version'
