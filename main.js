const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const os = require('os');

// Native direct WASAPI streaming to virtual cable (exe -> driver -> game mic, no Browser mixer)
let RtAudio = null, RtAudioApi = null, RtAudioFormat = null;
let rtAudio = null, nativeStream = null, nativeQueue = [], nativeMaxQueue = 48;
let nativeDeviceId = null, nativeIsLive = false;
try {
  const audify = require('audify');
  RtAudio = audify.RtAudio; RtAudioApi = audify.RtAudioApi; RtAudioFormat = audify.RtAudioFormat;
  console.log('[NativeCable] audify loaded');
} catch (e) { console.warn('[NativeCable] audify not available, falling back to WebAudio setSinkId', e.message); }

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  createWindow();
  // Auto-ensure own virtual device exists (rename CABLE -> RVB if needed)
  try {
    const ps = `Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render' | ForEach-Object { $p=Get-ItemProperty "$($_.PSPath)\\Properties" -ErrorAction SilentlyContinue; $n=$p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'; if($n -eq 'CABLE Input'){ Write-Output 'NEEDS_RENAME' } }`;
    exec(`powershell -NoProfile -Command "${ps}"`, (err, stdout) => {
      if (stdout && stdout.includes('NEEDS_RENAME')) {
        console.log('[VirtualDevice] CABLE found but not yet RVB — will auto-rename on first GO LIVE (requires UAC).');
      }
    });
  } catch(e){}
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ===== Window controls =====
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// ===== File / folder selection =====
ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0] || null;
});

ipcMain.handle('get-folder-audio', async (event, folderPath) => {
  try {
    const audioExts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma'];
    const out = [];
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (audioExts.includes(path.extname(e.name).toLowerCase())) {
          out.push({ name: e.name, path: full, ext: path.extname(e.name).toLowerCase() });
        }
      }
    };
    walk(folderPath);
    return out;
  } catch (e) {
    return [];
  }
});

// ===== Safe audio read (returns a transferable ArrayBuffer) =====
ipcMain.handle('read-audio', async (event, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    // Slice to the exact bytes owned by this Buffer (avoids pool offset bugs).
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return ab;
  } catch (e) {
    console.error('[read-audio] failed:', e);
    return null;
  }
});

// ===== Save a recorded blob to disk =====
ipcMain.handle('save-recording', async (event, arrayBuffer, defaultName) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName || 'RVB-Recording.webm',
      filters: [{ name: 'WebM Audio', extensions: ['webm'] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, Buffer.from(arrayBuffer));
    return result.filePath;
  } catch (e) {
    console.error('[save-recording] failed:', e);
    return null;
  }
});

ipcMain.handle('get-app-version', () => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version;
  } catch (e) {
    return '0.0.0';
  }
});

// ===== VIRTUAL AUDIO DEVICE (Voicemod-style) =====
// Creates / manages a Windows audio device that other apps see as a microphone.
// Strategy:
//  1. If VB-Audio Virtual Cable is already installed (present on this machine),
//     we rename its endpoints to "Rust Voice Booster" so Windows shows an OWN device.
//  2. If not installed, we download + silently install VB-CABLE and then rename.
//  3. All operations are via PowerShell (registry + pnputil). Renaming needs admin
//     so we relaunch PowerShell with -Verb RunAs when required.

function execPs(cmd) {
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${cmd.replace(/"/g, '`"')}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err ? err.code : 0 });
    });
  });
}

function execPsElevated(cmd) {
  // Launches PowerShell elevated via Start-Process -Verb RunAs and waits.
  const b64 = Buffer.from(cmd, 'utf16le').toString('base64');
  const wrapper = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -EncodedCommand ${b64}'`;
  return execPs(wrapper);
}

ipcMain.handle('check-virtual-cable', async () => {
  // Returns status of virtual cable devices
  const ps = `
$render = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty "$($_.PSPath)\\Properties" -ErrorAction SilentlyContinue
  $n = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
  if ($n) { "$($_.PSChildName)=$n" }
}
$capture = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty "$($_.PSPath)\\Properties" -ErrorAction SilentlyContinue
  $n = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
  if ($n) { "$($_.PSChildName)=$n" }
}
$pnp = Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*CABLE*' -or $_.FriendlyName -like '*Rust*Booster*' } | ForEach-Object { $_.FriendlyName + '|' + $_.InstanceId + '|' + $_.Status }
Write-Output "RENDER:"
$render | ForEach-Object { Write-Output $_ }
Write-Output "CAPTURE:"
$capture | ForEach-Object { Write-Output $_ }
Write-Output "PNP:"
$pnp | ForEach-Object { Write-Output $_ }
# check VBCABLE driver file
$drv = Test-Path "$env:SystemRoot\\System32\\DriverStore\\FileRepository\\vb*"
Write-Output "DRIVER:$drv"
`;
  const r = await execPs(ps);
  const out = r.stdout || '';
  const hasCableRender = out.includes('CABLE Input') || out.includes('Rust Voice Booster');
  const hasCableCapture = out.includes('CABLE Output') || out.includes('Rust Voice Booster');
  const isRvbNamed = out.includes('Rust Voice Booster');
  return {
    raw: out,
    hasCableRender,
    hasCableCapture,
    isRvbNamed,
    installed: hasCableRender && hasCableCapture,
    hasOwnDevice: isRvbNamed,
  };
});

ipcMain.handle('rename-cable-to-rvb', async (event, undo) => {
  const oldR = undo ? 'Rust Voice Booster' : 'CABLE Input';
  const newR = undo ? 'CABLE Input' : 'Rust Voice Booster';
  const oldC = undo ? 'Rust Voice Booster' : 'CABLE Output';
  const newC = undo ? 'CABLE Output' : 'Rust Voice Booster';
  const oldR2 = undo ? 'Rust Voice Booster' : 'CABLE Input (VB-Audio Virtual Cable)';
  const newR2 = undo ? 'CABLE Input (VB-Audio Virtual Cable)' : 'Rust Voice Booster';
  const oldC2 = undo ? 'Rust Voice Booster (VB-Audio Virtual Cable)' : 'CABLE Output (VB-Audio Virtual Cable)';
  const newC2 = undo ? 'CABLE Output (VB-Audio Virtual Cable)' : 'Rust Voice Booster (VB-Audio Virtual Cable)';
  // This uses .NET Registry with SeRestorePrivilege to bypass TrustedInstaller ACL (proven working)
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Priv2 {
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr h, int acc, out IntPtr tok);
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool LookupPrivilegeValue(string host, string name, out LUID luid);
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool AdjustTokenPrivileges(IntPtr tok, bool dis, ref TOKEN_PRIVILEGES tp, int len, IntPtr prev, IntPtr ret);
 [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attr; }
 [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct TOKEN_PRIVILEGES { public uint Count; public LUID_AND_ATTRIBUTES LuidAndAttr; }
 public const int TOKEN_ADJUST_PRIVILEGES=0x20, TOKEN_QUERY=0x8; public const uint SE_PRIVILEGE_ENABLED=0x2;
 public static bool Enable(string name){ IntPtr tok; if(!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES|TOKEN_QUERY, out tok)) return false; LUID luid; if(!LookupPrivilegeValue(null, name, out luid)) return false; TOKEN_PRIVILEGES tp=new TOKEN_PRIVILEGES(); tp.Count=1; tp.LuidAndAttr.Luid=luid; tp.LuidAndAttr.Attr=SE_PRIVILEGE_ENABLED; return AdjustTokenPrivileges(tok,false,ref tp,0,IntPtr.Zero,IntPtr.Zero); }
}
"@
[Priv2]::Enable('SeRestorePrivilege')|Out-Null; [Priv2]::Enable('SeTakeOwnershipPrivilege')|Out-Null; [Priv2]::Enable('SeBackupPrivilege')|Out-Null
function Set-MM($mmPath,$old,$nw){
  Get-ChildItem $mmPath -ErrorAction SilentlyContinue | ForEach-Object {
    $sub=$_.PSPath -replace 'Microsoft.PowerShell.Core\\\\Registry::HKEY_LOCAL_MACHINE\\\\',''
    $p=Get-ItemProperty "$($_.PSPath)\\Properties" -ErrorAction SilentlyContinue
    $n=$p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    if($n -eq $old){
      try{ $rk=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($sub+"\\Properties",[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::SetValue); $rk.SetValue('{a45c254e-df1c-4efd-8020-67d146a850e0},2',$nw,[Microsoft.Win32.RegistryValueKind]::String); $rk.Close(); Write-Output "RENAMED $old -> $nw at $($_.PSChildName)" }catch{ Write-Output "FAIL $old $_" }
    }
  }
}
function Set-Enum($path,$nw){
  try{ $rk=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($path,[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::SetValue); $rk.SetValue('FriendlyName',$nw,[Microsoft.Win32.RegistryValueKind]::String); $rk.Close(); Write-Output "ENUM $path -> $nw" }catch{ Write-Output "ENUM FAIL $path $_" }
}
Set-MM 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render' '${oldR}' '${newR}'
Set-MM 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render' '${oldR2}' '${newR2}'
Set-MM 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture' '${oldC}' '${newC}'
Set-MM 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture' '${oldC2}' '${newC2}'
# Also rename the Enum\\SWD endpoints (what Get-PnpDevice and games show)
Set-Enum 'SYSTEM\\CurrentControlSet\\Enum\\SWD\\MMDEVAPI\\{0.0.0.00000000}.{4367a044-340c-4509-b76f-f50e11f01d38}' '${newR}'
Set-Enum 'SYSTEM\\CurrentControlSet\\Enum\\SWD\\MMDEVAPI\\{0.0.1.00000000}.{3107411C-472D-495A-8869-7CC438DE9488}' '${newC}'
# Parent device
try{ $rk=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Enum\\ROOT\\MEDIA\\0000',[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::SetValue); $rk.SetValue('FriendlyName','${undo ? "VB-Audio Virtual Cable" : "Rust Voice Booster Virtual Audio"}',[Microsoft.Win32.RegistryValueKind]::String); $rk.Close(); Write-Output "PARENT renamed" }catch{}
# MediaCategories for future devices
try{ Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\MediaCategories\\{B961F7FD-8C2D-4378-9DA3-5A3A89511B74}' -Name 'Name' -Value '${newR}' -Force; Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\MediaCategories\\{B961F7FC-8C2D-4378-9DA3-5A3A89511B74}' -Name 'Name' -Value '${newC}' -Force; Write-Output "MEDIACAT updated" }catch{}
try{ Restart-Service -Name Audiosrv -Force; Write-Output "AUDIO_RESTARTED" }catch{ Write-Output "RESTART_FAIL $_" }
`;
  let r = await execPs(ps);
  // Already runs elevated (we are admin) and uses .NET bypass, so no need for Elevated fallback, but keep it
  if (r.stdout.includes('RENAMED') || r.stdout.includes('ENUM') || r.stdout.includes('AUDIO_RESTARTED')) {
    return { success: true, stdout: r.stdout, elevated: false };
  }
  r = await execPsElevated(ps);
  return { success: !r.err, stdout: r.stdout, stderr: r.stderr, elevated: true };
});

ipcMain.handle('install-virtual-cable', async () => {
  // Downloads VB-CABLE and installs silently. Requires admin.
  const ps = `
$ErrorActionPreference='Stop'
$zip = "$env:TEMP\\VBCABLE_Driver_Pack43.zip"
$url = 'https://download.vb-audio.com/Download_CABLEDriver/VBCABLE_Driver_Pack43.zip'
$dest = "$env:TEMP\\VBCABLE"
Write-Output "DOWNLOAD $url -> $zip"
if (!(Test-Path $zip)) {
  try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing; Write-Output "DL_OK" } catch { Write-Output "DL_FAIL $_"; exit 1 }
} else { Write-Output "ZIP_EXISTS" }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
Expand-Archive -Path $zip -DestinationPath $dest -Force
Write-Output "EXTRACTED"
$setup = Get-ChildItem $dest -Recurse -Filter "VBCABLE_Setup_x64.exe" | Select-Object -First 1
if (!$setup) { Write-Output "SETUP_NOT_FOUND"; exit 1 }
Write-Output "SETUP $($setup.FullName)"
# Silent install: -i -h  (install + hide GUI)
Start-Process -FilePath $setup.FullName -ArgumentList "-i","-h" -Wait -Verb RunAs
Write-Output "INSTALL_LAUNCHED"
Start-Sleep -Seconds 3
# Verify
$pnp = Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*CABLE*' }
if ($pnp) { Write-Output "INSTALLED $($pnp.FriendlyName)" } else { Write-Output "NOT_FOUND_AFTER_INSTALL" }
`;
  const r = await execPsElevated(ps);
  return { stdout: r.stdout, stderr: r.stderr, err: r.err ? r.err.message : null };
});

ipcMain.handle('open-sound-settings', async () => {
  exec('rundll32.exe shell32.dll,Control_RunDLL mmsys.cpl,,0', () => {});
  return true;
});

ipcMain.handle('get-virtual-cable-info', async () => {
  const ps = `
Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*CABLE*' -or $_.FriendlyName -like '*Rust*Booster*' -or $_.FriendlyName -like '*VB-Audio*' } | Select-Object FriendlyName,InstanceId,Status,Class | ConvertTo-Json -Compress
`;
  const r = await execPs(ps);
  try { return JSON.parse(r.stdout); } catch { return r.stdout; }
});

// ===== NATIVE DIRECT CABLE STREAM (exe -> WASAPI -> virtual driver -> game mic) =====
// This pushes raw Float32 PCM straight from the Electron process to the virtual cable
// without going through Windows mixer, exactly like a dedicated Audio Cable app.
function findNativeCableDevice() {
  if (!RtAudio) return null;
  try {
    const rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
    const devs = rt.getDevices();
    // Prefer Rust Voice Booster named device, fallback to CABLE Input
    let d = devs.find(x => /rust.*booster/i.test(x.name)) || devs.find(x => /cable\s*input/i.test(x.name));
    return d || null;
  } catch(e) { console.error('[NativeCable] find failed', e); return null; }
}

ipcMain.handle('cable-native-status', async () => {
  const dev = findNativeCableDevice();
  return {
    hasAudify: !!RtAudio,
    isLive: nativeIsLive,
    device: dev ? { id: dev.id, name: dev.name, outCh: dev.outputChannels } : null,
    queue: nativeQueue.length,
    hasStream: !!nativeStream
  };
});

ipcMain.handle('cable-native-start', async (event, opts) => {
  if (!RtAudio) return { ok: false, error: 'audify not installed' };
  if (nativeIsLive) return { ok: true, already: true };
  const dev = findNativeCableDevice();
  if (!dev) return { ok: false, error: 'No CABLE Input / Rust Voice Booster device found (install VB-CABLE first)' };
  nativeDeviceId = dev.id;
  nativeQueue = [];
  try {
    rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
    // 48kHz stereo float32, 512 frames (~10ms) — WASAPI shared mode
    const outParams = { deviceId: dev.id, nChannels: 2, firstChannel: 0 };
    const sampleRate = 48000;
    const bufferFrames = 512;
    nativeStream = rtAudio.openStream(
      outParams, null, RtAudioFormat.RTAUDIO_FLOAT32, sampleRate, bufferFrames, "RVB Direct Cable",
      (input, output, nFrames) => {
        // Fill output from queue, else silence
        if (!nativeIsLive) { output.fill(0); return; }
        let need = nFrames * 2;
        let written = 0;
        while (written < need && nativeQueue.length) {
          const chunk = nativeQueue[0];
          const avail = chunk.length - (chunk._off || 0);
          const take = Math.min(avail, need - written);
          for (let i = 0; i < take; i++) output[written + i] = chunk[(chunk._off || 0) + i];
          written += take;
          if ((chunk._off || 0) + take >= chunk.length) nativeQueue.shift();
          else chunk._off = (chunk._off || 0) + take;
        }
        // zero-fill remainder
        for (let i = written; i < need; i++) output[i] = 0;
      },
      null, { highPriority: true }
    );
    rtAudio.start();
    nativeIsLive = true;
    console.log('[NativeCable] LIVE direct to', dev.name, 'id', dev.id);
    return { ok: true, device: dev.name, id: dev.id };
  } catch (e) {
    console.error('[NativeCable] start failed', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cable-native-stop', async () => {
  nativeIsLive = false;
  nativeQueue = [];
  try { if (rtAudio) { rtAudio.stop(); rtAudio.closeStream(); } } catch(e){}
  rtAudio = null; nativeStream = null;
  console.log('[NativeCable] stopped');
  return { ok: true };
});

ipcMain.handle('cable-native-push', async (event, float32ArrayBuffer) => {
  if (!nativeIsLive || !nativeStream) return { ok: false, error: 'not live' };
  try {
    // float32ArrayBuffer is ArrayBuffer of interleaved stereo float32
    const arr = new Float32Array(float32ArrayBuffer);
    // Clone because ArrayBuffer is transferred
    const copy = new Float32Array(arr.length);
    copy.set(arr);
    copy._off = 0;
    nativeQueue.push(copy);
    if (nativeQueue.length > nativeMaxQueue) nativeQueue.splice(0, nativeQueue.length - nativeMaxQueue);
    return { ok: true, queued: nativeQueue.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('create-rvb-clone-device', async () => {
  // Attempts to create a second virtual device instance named "RustVoiceBooster" alongside CABLE
  // Uses same VB-CABLE driver but new PnP instance ROOT\\MEDIA\\xxxx
  const ps = `
$ErrorActionPreference='Stop'
# Check if RVB device already exists
$existing = Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*Rust*Booster*' }
if ($existing) { Write-Output "ALREADY_EXISTS $($existing.FriendlyName)"; exit 0 }
# Try to create new device via pnputil/devcon using existing driver
$inf = Get-ChildItem "$env:SystemRoot\\System32\\DriverStore\\FileRepository\\vbmmecable*" -Filter "*.inf" | Select-Object -First 1
if (!$inf) { Write-Output "NO_INF"; exit 1 }
Write-Output "INF $($inf.FullName)"
# Use pnputil to ensure driver is published (already is)
# Create device: use devcon-like via Add-PnpDevice (Windows 10 2004+ has pnputil /add-device)
try {
  # Try Windows 10 pnputil add-device (requires instanceId)
  # Fallback: use Device Manager trick - install via rundll32
  $hw = "VBAudioVACWDM"
  $out = pnputil /add-device "ROOT\\MEDIA\\0000" /hardwareid $hw 2>&1
  Write-Output "PNPUTIL_ADD $out"
} catch { Write-Output "CREATE_FAILED $_" }
Start-Sleep 2
Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*CABLE*' -or $_.FriendlyName -like '*RVB*' } | ForEach-Object { Write-Output "DEV $($_.FriendlyName) $($_.Status)" }
`;
  const r = await execPsElevated(ps);
  return { stdout: r.stdout, stderr: r.stderr };
});
