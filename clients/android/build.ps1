# Build the Wall Panel APK using only the Android SDK build-tools.
# No Gradle, no Maven, no network. Produces inkyoled.apk (debug-signed).
#
# Run:  powershell -File build.ps1            # shipping build  (no WebView debug socket)
#       powershell -File build.ps1 -Debuggable  # debuggable build (chrome://inspect works)
#
# -Debuggable passes aapt2's --debug-mode, which sets android:debuggable in the linked manifest.
# MainActivity reads ApplicationInfo.FLAG_DEBUGGABLE and only then calls
# WebView.setWebContentsDebuggingEnabled(true), so the default build never asks for the
# devtools socket and there is nothing to remember to turn off before release.
#
# That is a statement about this build, not about the device it lands on: Chromium's WebView
# force-enables its devtools server on userdebug/eng ROMs whatever the app passes, and the
# target tablet is one. See "Residual risk: the devtools socket" in INTERACTIVE.md.
#
# The SDK location comes from ANDROID_SDK_ROOT / ANDROID_HOME when they are set (that is how
# CI finds it) and falls back to the default Windows install path.

param(
    [switch]$Debuggable,
    [string]$SdkRoot,
    [string]$BuildToolsVersion = '36.0.0',
    [string]$Platform = 'android-36'
)

$ErrorActionPreference = 'Stop'

if (-not $SdkRoot) {
    foreach ($candidate in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, "$env:LOCALAPPDATA\Android\Sdk")) {
        if ($candidate -and (Test-Path $candidate)) { $SdkRoot = $candidate; break }
    }
}
if (-not $SdkRoot) {
    throw "No Android SDK found. Set ANDROID_SDK_ROOT / ANDROID_HOME, or pass -SdkRoot."
}

$SDK  = $SdkRoot
$BT   = "$SDK\build-tools\$BuildToolsVersion"
$PLAT = "$SDK\platforms\$Platform\android.jar"
$ROOT = $PSScriptRoot
$OUT  = "$ROOT\build"

Write-Host "=== sdk ==="
Write-Host "  root:        $SDK"
Write-Host "  build-tools: $BuildToolsVersion"
Write-Host "  platform:    $Platform"
Write-Host "  variant:     $(if ($Debuggable) { 'DEBUGGABLE (WebView devtools socket ON)' } else { 'shipping (no debug socket)' })"

foreach ($p in @("$BT\aapt2.exe", "$BT\d8.bat", "$BT\zipalign.exe", "$BT\apksigner.bat", $PLAT)) {
    if (-not (Test-Path $p)) {
        $have = if (Test-Path "$SDK\build-tools") {
            (Get-ChildItem "$SDK\build-tools" -Directory | ForEach-Object { $_.Name }) -join ', '
        } else { '(none)' }
        throw "Missing build tool: $p`n  build-tools present in this SDK: $have`n  Install with: sdkmanager `"build-tools;$BuildToolsVersion`" `"platforms;$Platform`""
    }
}

Write-Host "=== clean ==="
if (Test-Path $OUT) { Remove-Item $OUT -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$OUT\compiled","$OUT\classes","$OUT\dex" | Out-Null

# --- minimal resources: launcher icon + nothing else -------------------------
$RES = "$OUT\res"
New-Item -ItemType Directory -Force -Path "$RES\mipmap-anydpi-v26","$RES\values" | Out-Null

# simple vector launcher icon so we do not need binary PNGs
@'
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:fillColor="#101418" android:pathData="M0,0h108v108h-108z"/>
    <path android:fillColor="#6DB3F2"
        android:pathData="M26,34h56v6h-56z M26,50h34v6h-34z M26,64h44v6h-44z"/>
</vector>
'@ | Set-Content "$RES\mipmap-anydpi-v26\ic_launcher.xml" -Encoding UTF8

Write-Host "=== aapt2 compile ==="
& "$BT\aapt2.exe" compile --dir $RES -o "$OUT\compiled\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "=== aapt2 link ==="
# --debug-mode is the ONLY thing that sets android:debuggable, and it is what MainActivity
# gates WebView.setWebContentsDebuggingEnabled on. Omitted by default => no devtools socket.
$linkArgs = @(
    'link',
    '-I', $PLAT,
    '--manifest', "$ROOT\AndroidManifest.xml",
    '-A', "$ROOT\assets",
    '--java', "$OUT\gen",
    '-o', "$OUT\base.apk"
)
if ($Debuggable) { $linkArgs += '--debug-mode' }
$linkArgs += "$OUT\compiled\res.zip"
& "$BT\aapt2.exe" @linkArgs
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "=== javac ==="
$srcs = @(Get-ChildItem "$ROOT\src" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$gen  = @()
if (Test-Path "$OUT\gen") { $gen = @(Get-ChildItem "$OUT\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName }) }
$all = @($srcs) + @($gen)
Write-Host "  sources: $($all.Count)"
& javac -nowarn -classpath $PLAT -d "$OUT\classes" $all 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "=== d8 ==="
$classes = @(Get-ChildItem "$OUT\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& "$BT\d8.bat" --lib $PLAT --output "$OUT\dex" $classes 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "=== package ==="
Copy-Item "$OUT\base.apk" "$OUT\unsigned.apk" -Force
Push-Location "$OUT\dex"
& "$BT\aapt2.exe" version | Out-Null
# add classes.dex into the apk zip
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$OUT\unsigned.apk", 'Update')
foreach ($dex in (Get-ChildItem "$OUT\dex" -Filter *.dex)) {
    $entry = $zip.CreateEntry($dex.Name, [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    $fs = [System.IO.File]::OpenRead($dex.FullName)
    $fs.CopyTo($es); $fs.Close(); $es.Close()
    Write-Host "  added $($dex.Name)"
}
$zip.Dispose()
Pop-Location

Write-Host "=== zipalign ==="
& "$BT\zipalign.exe" -f -p 4 "$OUT\unsigned.apk" "$OUT\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "=== sign ==="
$ks = "$ROOT\debug.keystore"
if (-not (Test-Path $ks)) {
    & keytool -genkeypair -keystore $ks -alias inkyoled -storepass android -keypass android `
        -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=InkyOLED,O=Local,C=US" 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "keytool failed to generate $ks" }
}
& "$BT\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android `
    --out "$ROOT\inkyoled.apk" "$OUT\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

Write-Host "`n=== verify ==="
# This used to pipe apksigner into Select-Object and look at nothing: a failed verification
# printed four lines and the build carried on reporting success. Same fail-open class as the
# CI badging check. Capture, check the exit code, then print.
$verify = & "$BT\apksigner.bat" verify --print-certs "$ROOT\inkyoled.apk" 2>&1
if ($LASTEXITCODE -ne 0) {
    # No nested double quotes inside $( ) here: Windows PowerShell 5.1 cannot parse them, and
    # this script has to run under both 5.1 (a plain `powershell -File`) and pwsh 7 (CI).
    $detail = ($verify -join [Environment]::NewLine)
    throw "apksigner verify failed (exit $LASTEXITCODE): $detail"
}
# ASCII only in this file: it is launched as `powershell -File`, and Windows PowerShell 5.1
# reads a UTF-8-without-BOM script as ANSI, which turns an em dash into a parse error.
if (@($verify).Count -eq 0) { throw "apksigner verify produced no output - cannot claim the APK is signed" }
@($verify) | Select-Object -First 4 | Write-Host

$size = [math]::Round((Get-Item "$ROOT\inkyoled.apk").Length / 1KB, 1)
Write-Host "`nBUILT: $ROOT\inkyoled.apk  ($size KB)"
Write-Host "Install with:  adb install -r `"$ROOT\inkyoled.apk`""
