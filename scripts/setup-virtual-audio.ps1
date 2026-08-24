#Requires -RunAsAdministrator
<#
  Rust Voice Booster - Virtual Audio Device Setup
  Mimics Voicemod: creates an OWN Windows audio device that other apps see as microphone.
  Strategy: VB-Audio Virtual Cable is the backend. This script:
    1. Downloads & installs VB-CABLE if missing
    2. Renames its endpoints to "Rust Voice Booster" (Render = Input, Capture = Virtual Mic)
    3. Restarts audio service so names appear instantly
    4. Optionally installs a second instance named strictly RVB (clone driver)

  Usage:
    .\setup-virtual-audio.ps1              # install + rename to RVB
    .\setup-virtual-audio.ps1 -Undo        # restore original CABLE names
    .\setup-virtual-audio.ps1 -Status      # show current devices
#>
param(
  [switch]$Undo,
  [switch]$Status,
  [switch]$InstallOnly
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-CableDevices {
  Write-Host "`n=== Render (speakers / CABLE Input) ===" -ForegroundColor Cyan
  Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render' | ForEach-Object {
    $p = Get-ItemProperty "$($_.PSPath)\Properties" -ErrorAction SilentlyContinue
    $n = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    if ($n) { Write-Host ("  {0,-38} = {1}" -f $_.PSChildName.Substring(0,8), $n) }
  }
  Write-Host "`n=== Capture (mics / CABLE Output) ===" -ForegroundColor Cyan
  Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture' | ForEach-Object {
    $p = Get-ItemProperty "$($_.PSPath)\Properties" -ErrorAction SilentlyContinue
    $n = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    if ($n) { Write-Host ("  {0,-38} = {1}" -f $_.PSChildName.Substring(0,8), $n) }
  }
  Write-Host "`n=== PnP Audio Devices ===" -ForegroundColor Cyan
  Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*CABLE*' -or $_.FriendlyName -like '*Rust*Booster*' -or $_.FriendlyName -like '*VB-Audio*' } | Format-Table FriendlyName, InstanceId, Status -AutoSize
}

if ($Status) { Get-CableDevices; exit 0 }

function Set-Rename($oldName, $newName, $mmPath) {
  $renamed = 0
  Get-ChildItem $mmPath | ForEach-Object {
    $propPath = "$($_.PSPath)\Properties"
    $p = Get-ItemProperty $propPath -ErrorAction SilentlyContinue
    $n = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    if ($n -eq $oldName) {
      try {
        Set-ItemProperty -Path $propPath -Name '{a45c254e-df1c-4efd-8020-67d146a850e0},2' -Value $newName -ErrorAction Stop
        Write-Host "RENAMED: $oldName -> $newName" -ForegroundColor Green
        $renamed++
      } catch { Write-Host "FAILED rename $oldName : $_" -ForegroundColor Red }
    }
  }
  return $renamed
}

if ($Undo) {
  Write-Host "Restoring original CABLE names..." -ForegroundColor Yellow
  $r = 0
  $r += Set-Rename 'Rust Voice Booster' 'CABLE Input' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
  $r += Set-Rename 'Rust Voice Booster (VB-Audio Virtual Cable)' 'CABLE Output (VB-Audio Virtual Cable)' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
  $r += Set-Rename 'Rust Voice Booster' 'CABLE Output' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
  $r += Set-Rename 'CABLE Input (VB-Audio Virtual Cable)' 'CABLE Input' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
  # Full label variants
  Set-Rename 'Rust Voice Booster Input' 'CABLE Input' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render' | Out-Null
  Write-Host "Done ($r renamed). Restarting audio service..."
  Restart-Service -Name Audiosrv -Force -ErrorAction SilentlyContinue
  Get-CableDevices
  exit 0
}

# ---- Install VB-CABLE if missing ----
$hasCable = (Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*CABLE Input*' }).Count -gt 0
if (-not $hasCable) {
  Write-Host "VB-Cable not found — downloading..." -ForegroundColor Yellow
  $zip = "$env:TEMP\VBCABLE_Driver_Pack43.zip"
  $url = 'https://download.vb-audio.com/Download_CABLEDriver/VBCABLE_Driver_Pack43.zip'
  $dest = "$env:TEMP\VBCABLE"
  if (!(Test-Path $zip)) {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Write-Host "Downloaded $zip" -ForegroundColor Green
  }
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  $setup = Get-ChildItem $dest -Recurse -Filter "VBCABLE_Setup_x64.exe" | Select-Object -First 1
  if ($setup) {
    Write-Host "Running $($setup.FullName) -i -h (silent install, UAC)..." -ForegroundColor Yellow
    Start-Process -FilePath $setup.FullName -ArgumentList "-i","-h" -Wait -Verb RunAs
    Start-Sleep -Seconds 4
  } else { Write-Host "Setup exe not found!" -ForegroundColor Red; exit 1 }
} else {
  Write-Host "VB-Cable already installed — skipping download." -ForegroundColor Green
}

if ($InstallOnly) { Get-CableDevices; exit 0 }

# ---- Rename to Rust Voice Booster ----
Write-Host "`nRenaming virtual device to 'Rust Voice Booster' (Voicemod-style)..." -ForegroundColor Yellow
$ren = 0
$ren += Set-Rename 'CABLE Input' 'Rust Voice Booster' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
$ren += Set-Rename 'CABLE Input (VB-Audio Virtual Cable)' 'Rust Voice Booster' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
$ren += Set-Rename 'CABLE Output' 'Rust Voice Booster' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
$ren += Set-Rename 'CABLE Output (VB-Audio Virtual Cable)' 'Rust Voice Booster' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
# Also handle already-partially-renamed variants
$ren += Set-Rename 'VB-Audio Virtual Cable' 'Rust Voice Booster' 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'

if ($ren -eq 0) {
  Write-Host "No CABLE endpoints matched for rename. Current devices:" -ForegroundColor Yellow
  Get-CableDevices
  Write-Host "`nIf you see 'Rust Voice Booster' already, you're done!" -ForegroundColor Green
} else {
  Write-Host "`nRenamed $ren endpoint(s). Restarting Windows Audio..." -ForegroundColor Green
  Restart-Service -Name Audiosrv -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Get-CableDevices
  Write-Host "`nDone! In Discord/Rust/Game, select MICROPHONE = 'Rust Voice Booster'." -ForegroundColor Cyan
  Write-Host "In Rust Voice Booster app, click GO LIVE TO CABLE to route Deck A/B + Mic -> Virtual Mic." -ForegroundColor Cyan
}

Write-Host "`nTip: Run .\setup-virtual-audio.ps1 -Undo to restore original CABLE names." -ForegroundColor DarkGray
