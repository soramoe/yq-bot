# Download a portable Node.js runtime into runtime\node (Windows x64).
# Used by install.bat when Node.js is missing, and by the release workflow
# to bundle the runtime into the install zip.
#
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
param(
    [string]$Root = "",
    [string]$Version = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Root) {
    $Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$Root = (Resolve-Path -LiteralPath $Root).Path

if (-not $Version) {
    $versionFile = Join-Path $PSScriptRoot "node-version.txt"
    if (Test-Path -LiteralPath $versionFile) {
        $Version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    }
}
if (-not $Version) { $Version = "22.21.1" }
$Version = $Version.TrimStart("v")

$runtime = Join-Path $Root "runtime"
$target = Join-Path $runtime "node"
$nodeExe = Join-Path $target "node.exe"

if (-not $Force -and (Test-Path -LiteralPath $nodeExe)) {
    $installed = & $nodeExe -v 2>$null
    if ($LASTEXITCODE -eq 0) {
        $major = [int](($installed -replace "^v", "").Split(".")[0])
        if ($major -ge 22) {
            Write-Host "[OK] portable Node $installed already present: runtime\node"
            exit 0
        }
    }
}

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$name = "node-v$Version-win-$arch"
$bases = @(
    "https://npmmirror.com/mirrors/node/v$Version",
    "https://nodejs.org/dist/v$Version"
)

$tmpRoot = Join-Path $env:TEMP ("yq-node-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
$zip = Join-Path $tmpRoot "$name.zip"

try {
    $downloaded = $false
    foreach ($base in $bases) {
        try {
            Write-Host "[STEP] downloading $name.zip from $base"
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.zip" -OutFile $zip -TimeoutSec 600

            $sums = Join-Path $tmpRoot "SHASUMS256.txt"
            Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -OutFile $sums -TimeoutSec 60
            $line = Get-Content -LiteralPath $sums |
                Where-Object { $_ -match [regex]::Escape("$name.zip") } |
                Select-Object -First 1
            if (-not $line) { throw "no checksum entry for $name.zip" }
            $expected = (($line -split "\s+")[0]).ToLowerInvariant()
            $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($expected -ne $actual) {
                throw "checksum mismatch: expected $expected, got $actual"
            }
            $downloaded = $true
            break
        } catch {
            Write-Warning $_.Exception.Message
            if (Test-Path -LiteralPath $zip) {
                Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
            }
        }
    }
    if (-not $downloaded) { throw "could not download Node.js $Version" }

    Write-Host "[STEP] extracting"
    $unzip = Join-Path $tmpRoot "unzip"
    Expand-Archive -LiteralPath $zip -DestinationPath $unzip -Force
    $src = Get-ChildItem -LiteralPath $unzip -Directory | Select-Object -First 1
    if (-not $src) { throw "unexpected archive layout" }

    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    Move-Item -LiteralPath $src.FullName -Destination $target

    if (-not (Test-Path -LiteralPath $nodeExe)) {
        throw "node.exe is missing after extraction"
    }
    $installed = & $nodeExe -v
    Write-Host "[OK] portable Node $installed installed: runtime\node"

    $major = [int](($installed -replace "^v", "").Split(".")[0])
    if ($major -lt 22) {
        throw "Node.js 22 or newer is required, got $installed"
    }
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}
