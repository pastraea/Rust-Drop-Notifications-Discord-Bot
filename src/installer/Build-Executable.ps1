#Requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Import-Module (Join-Path $PSScriptRoot 'WindowsUninstall.psm1') -Force
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version.' }
$output = Join-Path $root 'artifacts'
Assert-PlainPath $output
New-Item -ItemType Directory -Path $output -Force | Out-Null
$executable = Join-Path $output "Rust-Drop-Notifications-Discord-Bot-Setup-$version.exe"
Assert-PlainPath $executable
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('rust-setup-build-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $payload = Join-Path $temporary 'payload.zip'
    $files = @('package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'README.md', '.env.example')
    $files += @('Start-Installer.ps1', 'InstallScreen.ps1', 'WindowsInstall.psm1', 'WindowsUninstall.psm1',
        'WindowsDiscovery.psm1', 'WindowsUpdate.psm1', 'Invoke-Updater.ps1',
        'backupDatabase.cjs', 'validateConfiguration.cjs') | ForEach-Object { 'src\installer\' + $_ }
    $source = Join-Path $root 'src'
    Assert-PlainPath $source
    foreach ($item in @(Get-ChildItem -LiteralPath $source -Recurse -Force)) {
        Assert-PlainPath $item.FullName
        if (-not $item.PSIsContainer -and $item.Extension -eq '.ts' -and $item.Name -notlike '*.test.ts') {
            $files += $item.FullName.Substring($root.Length + 1)
        }
    }
    $stream = [IO.File]::Open($payload, [IO.FileMode]::CreateNew)
    $archive = New-Object IO.Compression.ZipArchive $stream, ([IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relative in $files) {
            $path = Join-Path $root $relative
            Assert-PlainPath $path
            $entry = $archive.CreateEntry($relative.Replace('\', '/'))
            $input = [IO.File]::OpenRead($path)
            $target = $entry.Open()
            try { $input.CopyTo($target) } finally { $target.Dispose(); $input.Dispose() }
        }
    } finally { $archive.Dispose(); $stream.Dispose() }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) {
        $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    }
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
    $versionSource = Join-Path $temporary 'Version.cs'
    [IO.File]::WriteAllText($versionSource, @"
using System.Reflection;
[assembly: AssemblyVersion("$version.0")]
[assembly: AssemblyFileVersion("$version.0")]
[assembly: AssemblyInformationalVersion("$version")]
"@)
    & $compiler /nologo /target:winexe /platform:anycpu /optimize+ `
        /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll `
        "/resource:$payload,BotPayload" "/out:$executable" (Join-Path $PSScriptRoot 'SetupLauncher.cs') $versionSource
    if ($LASTEXITCODE -ne 0) { throw 'Setup executable compilation failed.' }
    Write-Output $executable
} finally {
    if (Test-Path -LiteralPath (Join-Path $temporary 'payload.zip')) { Remove-Item -LiteralPath (Join-Path $temporary 'payload.zip') }
    if (Test-Path -LiteralPath (Join-Path $temporary 'Version.cs')) { Remove-Item -LiteralPath (Join-Path $temporary 'Version.cs') }
    Remove-Item -LiteralPath $temporary
}
