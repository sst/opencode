# Restores the npm-installed `opencode` (stable) and `opencode2` (beta)
# binaries that install-windows.ps1 replaced.
#
# Usage (from the repository root):
#   powershell -ExecutionPolicy Bypass -File docs/rtl/restore-windows.ps1

$ErrorActionPreference = "Stop"

$targets = @(
  (Join-Path $env:APPDATA "npm\node_modules\opencode-ai\bin\opencode.exe"),
  (Join-Path $env:APPDATA "npm\node_modules\@opencode-ai\cli\bin\opencode2.exe")
)

foreach ($target in $targets) {
  $backup = "$target.original-backup"
  if (-not (Test-Path $backup)) {
    Write-Host "No backup found for: $target"
    continue
  }
  try {
    Copy-Item $backup $target -Force
    Write-Host "Restored: $target"
  } catch {
    Move-Item -LiteralPath $target -Destination "$target.rtl-build" -Force
    Copy-Item $backup $target -Force
    Write-Host "Restored (renamed running binary): $target"
  }
}

Write-Host ""
Write-Host "Done. Restart any running OpenCode window to pick up the original build."
