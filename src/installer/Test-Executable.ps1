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
$launcher = $null
$child = $null
try {
    # Neither Node.js nor npm is available to the executable during this test.
    $env:PATH = Join-Path $env:WINDIR 'System32'
    $verification = Start-Process -FilePath $executable -ArgumentList '--verify-package' -PassThru
    Assert-Package ($verification.WaitForExit(20000)) 'Embedded package verification did not exit.'
    Assert-Package ($verification.ExitCode -eq 0) 'Embedded package verification failed.'
    $launcher = Start-Process -FilePath $executable -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($launcher.Id)" |
            Where-Object { $_.Name -eq 'powershell.exe' })
        if ($children.Count -eq 1) {
            $child = Get-Process -Id $children[0].ProcessId -ErrorAction Stop
            $child.Refresh()
            if ($child.MainWindowHandle -ne [IntPtr]::Zero) { break }
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
} finally {
    $env:PATH = $oldPath
    if ($null -ne $child) {
        $child.Refresh()
        if (-not $child.HasExited) { [void]$child.CloseMainWindow(); [void]$child.WaitForExit(10000) }
        $child.Dispose()
    }
    if ($null -ne $launcher) { $launcher.Dispose() }
}
Write-Output "Passed $passed executable packaging assertions, including a real UI launch without Node.js/npm."
