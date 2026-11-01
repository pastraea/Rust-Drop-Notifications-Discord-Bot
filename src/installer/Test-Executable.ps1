#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$executable = & (Join-Path $PSScriptRoot 'Build-Executable.ps1')
$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($executable))
$payload = $assembly.GetManifestResourceStream('BotPayload')
$archive = New-Object IO.Compression.ZipArchive $payload, ([IO.Compression.ZipArchiveMode]::Read)
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$passed = 0
function Assert-Package([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:passed++
}
try {
    $metadata = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    Assert-Package ($metadata.CompanyName -ceq 'studio bijou') 'Executable company metadata is incorrect.'
    Assert-Package ($metadata.FileVersion -eq "$version.0" -and $metadata.ProductVersion -eq $version) 'Executable version metadata must match the package.'
    $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('/', '\') })
    foreach ($required in @('package.json', 'package-lock.json', '.env.example', 'src\index.ts',
        'src\installer\Start-Installer.ps1', 'src\installer\WindowsInstall.psm1', 'src\installer\WindowsUninstall.psm1')) {
        Assert-Package ($names -contains $required) "Missing embedded file: $required"
    }
    Assert-Package (@($names | Where-Object {
        $_ -match '(^|\\)(node_modules|data|\.git|artifacts)(\\|$)|(^|\\)\.env$|\.db($|-)|\.log$|\.test\.ts$'
    }).Count -eq 0) 'Executable includes private data or development/build outputs.'
    foreach ($entry in $archive.Entries) {
        $input = $entry.Open()
        $copy = New-Object IO.MemoryStream
        try {
            $input.CopyTo($copy)
            $expected = [IO.File]::ReadAllBytes((Join-Path $root $entry.FullName.Replace('/', '\')))
            Assert-Package ([Convert]::ToBase64String($copy.ToArray()) -ceq [Convert]::ToBase64String($expected)) "Embedded content differs: $($entry.FullName)"
        } finally { $input.Dispose(); $copy.Dispose() }
    }
} finally { $archive.Dispose(); $payload.Dispose() }

$before = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'RustDropNotificationsSetup-*' |
    ForEach-Object { $_.FullName })
$oldPath = $env:PATH
$oldLocalAppData = $env:LOCALAPPDATA
$isolatedSettings = Join-Path ([IO.Path]::GetTempPath()) ('rust-setup-preferences-' + [guid]::NewGuid())
$launcher = $null
$child = $null
try {
    # Neither Node.js nor npm is available to the executable during this test.
    $env:PATH = Join-Path $env:WINDIR 'System32'
    $env:LOCALAPPDATA = $isolatedSettings
    $verification = Start-Process -FilePath $executable -ArgumentList '--verify-package' -PassThru
    Assert-Package ($verification.WaitForExit(20000)) 'Embedded package verification did not exit.'
    Assert-Package ($verification.ExitCode -eq 0) 'Embedded package verification failed.'
    $launcher = Start-Process -FilePath $executable -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($launcher.Id)" |
            Where-Object { $_.Name -eq 'powershell.exe' })
        if ($children.Count -eq 1) {
            # A short-lived helper process can exit between listing and inspection; if so, look again.
            $candidate = Get-Process -Id $children[0].ProcessId -ErrorAction SilentlyContinue
            if ($null -ne $candidate) {
                $child = $candidate
                $child.Refresh()
                if ($child.MainWindowHandle -ne [IntPtr]::Zero -and
                    $child.MainWindowTitle -eq 'Rust Drop Notifications Discord Bot Setup') { break }
            }
        }
        Start-Sleep -Milliseconds 100
    } while (-not $launcher.HasExited -and [DateTime]::UtcNow -lt $deadline)
    Assert-Package ($null -ne $child -and $child.MainWindowHandle -ne [IntPtr]::Zero) 'Packaged setup did not open a desktop window without Node/npm.'
    Assert-Package ($child.MainWindowTitle -eq 'Rust Drop Notifications Discord Bot Setup') 'Executable did not open the expected setup window.'
    Assert-Package ($child.CloseMainWindow()) 'Packaged window could not close normally.'
    Assert-Package ($launcher.WaitForExit(15000)) 'Launcher did not exit after closing setup.'
    Assert-Package ($launcher.ExitCode -eq 0) 'Packaged setup exited unsuccessfully.'
    $after = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'RustDropNotificationsSetup-*' |
        Where-Object { $before -notcontains $_.FullName })
    Assert-Package ($after.Count -eq 0) 'Executable did not clean up its temporary source copy.'
    $child.Dispose()
    $child = $null
    $launcher.Dispose()
    $launcher = $null

    # Compile a temporary bootstrap with a fake download helper; no GitHub requests or real installs occur.
    $fixtureRoot = Join-Path $isolatedSettings 'bootstrap-fixture'
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    $install = Import-Module (Join-Path $PSScriptRoot 'WindowsInstall.psm1') -PassThru
    & $install { param($Source, $Destination) Copy-BundledBot $Source $Destination } $root $fixtureRoot
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $fixtureExecutable = Join-Path $fixtureRoot "artifacts\Rust-Drop-Notifications-Discord-Bot-Setup-$version.exe"
    $fakeUpdater = @'
param($Mode, $CurrentVersion, $WorkDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $WorkDirectory -Force | Out-Null
Add-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'handoff-count.txt') -Value 'checked'
$source = '__FIXTURE_EXE__'
$destination = Join-Path $WorkDirectory 'verified-fixture.exe'
Copy-Item -LiteralPath $source -Destination $destination -Force
Write-Output $destination
'@
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\installer\Invoke-Updater.ps1'),
        $fakeUpdater.Replace('__FIXTURE_EXE__', $fixtureExecutable.Replace("'", "''")))
    $null = & (Join-Path $fixtureRoot 'src\installer\Build-Executable.ps1')
    $launcher = Start-Process -FilePath $fixtureExecutable -PassThru
    $replacement = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $replacements = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($launcher.Id)" |
            Where-Object { $_.Name -eq 'verified-fixture.exe' })
        if ($replacements.Count -eq 1) {
            $replacement = Get-Process -Id $replacements[0].ProcessId
            $windows = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($replacement.Id)" |
                Where-Object { $_.Name -eq 'powershell.exe' })
            if ($windows.Count -eq 1) {
                $child = Get-Process -Id $windows[0].ProcessId
                $child.Refresh()
                if ($child.MainWindowTitle -eq 'Rust Drop Notifications Discord Bot Setup') { break }
            }
        }
        Start-Sleep -Milliseconds 100
    } while (-not $launcher.HasExited -and [DateTime]::UtcNow -lt $deadline)
    Assert-Package ($null -ne $child -and $child.MainWindowTitle -eq 'Rust Drop Notifications Discord Bot Setup') 'Updated setup did not reopen through the bootstrap handoff.'
    Assert-Package (@(Get-Content -LiteralPath (Join-Path $isolatedSettings 'handoff-count.txt')).Count -eq 1) 'Setup handoff performed recursive update checks.'
    Assert-Package ($child.CloseMainWindow()) 'Updated setup did not close normally.'
    Assert-Package ($launcher.WaitForExit(15000) -and $launcher.ExitCode -eq 0) 'Original setup did not exit after the replacement closed.'
    $replacement.Dispose()
    Assert-Package (Test-Path -LiteralPath (Join-Path $isolatedSettings 'RustDropsBot-Updater\setup\verified-fixture.exe')) 'Verified setup cache was not retained.'
    $remainingExtractions = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'RustDropNotificationsSetup-*' |
        Where-Object { $before -notcontains $_.FullName })
    Assert-Package ($remainingExtractions.Count -eq 0) 'Automatic handoff left temporary source extractions behind.'
} finally {
    $env:PATH = $oldPath
    $env:LOCALAPPDATA = $oldLocalAppData
    if ($null -ne $child) {
        $child.Refresh()
        if (-not $child.HasExited) { [void]$child.CloseMainWindow(); [void]$child.WaitForExit(10000) }
        $child.Dispose()
    }
    if ($null -ne $launcher) { $launcher.Dispose() }
    Assert-Package (-not (Test-Path -LiteralPath (Join-Path $isolatedSettings 'RustDropsBot-Updater\settings.json'))) 'Opening setup enabled updates without consent.'
    if (Test-Path -LiteralPath $isolatedSettings) { Remove-Item -LiteralPath $isolatedSettings -Recurse -Force }
}
Write-Output "Passed $passed executable packaging assertions, including a real UI launch without Node.js/npm."
