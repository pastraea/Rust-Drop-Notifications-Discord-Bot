Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WindowsUninstall.psm1')

function Get-UpdateSettingsPath {
    return Join-Path $env:LOCALAPPDATA 'RustDropsBot-Updater\settings.json'
}

function Get-UpdateSettings {
    $path = Get-UpdateSettingsPath
    Assert-PlainPath $path
    if (-not (Test-Path -LiteralPath $path)) {
        return [pscustomobject]@{ Enabled = $false; Repository = '' }
    }
    $settings = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($settings.Enabled -isnot [bool] -or $settings.Repository -isnot [string]) {
        throw 'Updater settings are invalid. Review the automatic update setting in setup.'
    }
    return $settings
}

function Set-UpdateSettings([bool]$Enabled, [string]$Repository) {
    $path = Get-UpdateSettingsPath
    Assert-PlainPath $path
    $directory = Split-Path $path -Parent
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,
        (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'),
        (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid,
            'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    [IO.Directory]::SetAccessControl($directory, $acl)
    $temporary = Join-Path $directory ([guid]::NewGuid().ToString() + '.json')
    try {
        [IO.File]::WriteAllText($temporary, ([ordered]@{ Enabled = $Enabled; Repository = $Repository } | ConvertTo-Json))
        Move-Item -LiteralPath $temporary -Destination $path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}

function Write-UpdateLog([string]$Message) {
    $path = Join-Path $env:LOCALAPPDATA 'RustDropsBot-Updater\updater.log'
    Assert-PlainPath $path
    New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 1MB) {
        Remove-Item -LiteralPath $path
    }
    Add-Content -LiteralPath $path -Value ("{0:o} {1}" -f [DateTime]::UtcNow, $Message)
}

function Get-StableUpdate([string]$CurrentVersion) {
    if ($CurrentVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Installed version is not a stable semantic version.' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/pastraea/Rust-Drop-Notifications-Discord-Bot/releases/latest' `
        -Headers @{ 'User-Agent' = 'RustDropNotificationsUpdater'; Accept = 'application/vnd.github+json' } -TimeoutSec 15
    if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v(\d+\.\d+\.\d+)$') {
        throw 'GitHub did not return a stable published release.'
    }
    $version = $Matches[1]
    if ([version]$version -le [version]$CurrentVersion) { return $null }
    $name = "Rust-Drop-Notifications-Discord-Bot-Setup-$version.exe"
    $assets = @($release.assets | Where-Object { $_.name -ceq $name })
    if ($assets.Count -ne 1) { throw 'The stable release does not contain exactly one expected setup executable.' }
    $asset = $assets[0]
    $expected = "https://github.com/pastraea/Rust-Drop-Notifications-Discord-Bot/releases/download/v$version/$name"
    if ($asset.browser_download_url -cne $expected -or $asset.size -le 0 -or $asset.size -gt 50MB -or
        -not $asset.PSObject.Properties['digest'] -or $asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
        throw 'Release asset URL, size, or SHA-256 digest is invalid. Automatic update was refused.'
    }
    return [pscustomobject]@{ Version = $version; Url = $expected; Hash = $Matches[1]; Size = [long]$asset.size; Name = $name }
}

function Save-VerifiedUpdate($Release, [string]$Directory) {
    Assert-PlainPath $Directory
    $path = Join-Path $Directory $Release.Name
    Assert-PlainPath $path
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -eq $Release.Size -and
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ieq $Release.Hash) { return $path }
    $partial = Join-Path $Directory ([guid]::NewGuid().ToString() + '.partial')
    try {
        Invoke-WebRequest -Uri $Release.Url -OutFile $partial -UseBasicParsing -TimeoutSec 120 | Out-Null
        if ((Get-Item -LiteralPath $partial).Length -ne $Release.Size -or
            (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $Release.Hash) {
            throw 'Downloaded update size or SHA-256 verification failed. It was not used.'
        }
        Move-Item -LiteralPath $partial -Destination $path -Force
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
    }
    return $path
}

function Expand-UpdatePayload([string]$Executable, [string]$Destination, [string]$Version) {
    Add-Type -AssemblyName System.IO.Compression
    $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Executable))
    $stream = $assembly.GetManifestResourceStream('BotPayload')
    if ($null -eq $stream) { throw 'Downloaded setup has no embedded bot payload.' }
    $archive = New-Object IO.Compression.ZipArchive $stream, ([IO.Compression.ZipArchiveMode]::Read)
    $seen = @{}
    try {
        $expandedSize = ($archive.Entries | Measure-Object -Property Length -Sum).Sum
        if ($archive.Entries.Count -gt 2000 -or $expandedSize -gt 100MB) { throw 'Downloaded payload exceeds extraction limits.' }
        foreach ($entry in $archive.Entries) {
            $relative = $entry.FullName.Replace('/', '\')
            $allowed = $relative -in @('package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'README.md', '.env.example') -or
                $relative -match '^src\\(?:[A-Za-z0-9_-]+\\)*[A-Za-z0-9_.-]+\.ts$' -or
                $relative -match '^src\\installer\\[A-Za-z0-9_.-]+\.(?:ps1|psm1|cjs)$'
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
            if (-not $allowed -or -not (Test-ChildPath $target $Destination) -or $seen.ContainsKey($target)) {
                throw 'Downloaded payload contains an unsupported or duplicate path.'
            }
            $seen[$target] = $true
            New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
            $input = $entry.Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
            try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
        }
    } finally { $archive.Dispose(); $stream.Dispose() }
    $package = Get-Content -LiteralPath (Join-Path $Destination 'package.json') -Raw | ConvertFrom-Json
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
    $lock = $serializer.DeserializeObject([IO.File]::ReadAllText((Join-Path $Destination 'package-lock.json')))
    if ($package.name -ne 'rust-drops-reminder-bot' -or $package.version -cne $Version -or
        $lock['version'] -cne $Version -or $lock['packages']['']['version'] -cne $Version) {
        throw 'Downloaded package identity/version does not match its release.'
    }
}

function Assert-IdleUpdateTarget([string]$Repository) {
    $entry = [regex]::Escape((Join-Path $Repository 'dist\index.js'))
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and (
            [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -or
            [string]$_.CommandLine -match ("(?i)(?:^|[\s`"])$entry(?=[`"\s]|$)") -or
            [string]$_.CommandLine -match '(?i)(?:^|[\s"])(?:\.\\|\.\/)?(?:dist[\\/]+index\.js|src[\\/]+index\.ts)(?=["\s]|$)')
    })
    if ($processes.Count -gt 0) { throw 'A bot is already running or cannot be attributed safely. Update deferred until a clean launch.' }
}

function Move-UpdateDirectory([string]$Source, [string]$Destination) {
    [IO.Directory]::Move($Source, $Destination)
}

function Update-InstalledBot([string]$Repository, [string]$Work, $Release, [string]$Executable) {
    Assert-PlainPath $Repository
    Assert-PlainPath $Work
    if ((Test-ChildPath $Work $Repository) -or (Test-ChildPath $Repository $Work) -or $Repository -ieq $Work) {
        throw 'Update work and installed bot directories must be separate.'
    }
    if ([IO.Path]::GetPathRoot($Repository) -ine [IO.Path]::GetPathRoot($Work)) {
        throw 'Update work must be on the installation volume for atomic directory activation.'
    }
    $marker = Join-Path $Repository '.rust-drops-install.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'Only installer-managed bot copies can auto-update.' }
    Assert-RemovableFolder $Repository $Work
    $dataPaths = @(Get-BotDataPaths $Repository)
    if ($dataPaths[1] -ine (Join-Path $Repository 'data\bot.db')) { throw 'Automatic update requires the installer-managed data\bot.db path.' }
    Assert-IdleUpdateTarget $Repository
    if (Test-Path -LiteralPath $Work) {
        if (@(Get-ChildItem -LiteralPath $Work -Force | Where-Object { $_.Name -ne $Release.Name }).Count -gt 0) {
            throw 'Update work directory contains unexpected files. Start a fresh update.'
        }
    }
    $stage = Join-Path $Work 'prepared'
    New-Item -ItemType Directory -Path $stage | Out-Null
    Expand-UpdatePayload $Executable $stage $Release.Version
    $install = Import-Module (Join-Path $PSScriptRoot 'WindowsInstall.psm1') -PassThru
    $tools = & $install { Get-InstallNodeTools $false }
    & $install { param($Tools, $Stage)
        Invoke-InstallCommand $Tools.Npm @('ci', '--no-audit', '--no-fund') $Stage 'Update dependency installation'
        Invoke-InstallCommand $Tools.Npm @('run', 'build') $Stage 'Update build'
    } $tools $stage
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'dist\index.js'))) { throw 'Update build did not produce the bot entry point.' }
    # The bot has not started yet. Recheck before taking a consistent copy of local state.
    Assert-IdleUpdateTarget $Repository
    foreach ($relative in @('.env', 'data', '.rust-drops-install.json')) {
        $path = Join-Path $Repository $relative
        Assert-PlainPath $path
        if (Test-Path -LiteralPath $path) {
            foreach ($item in @(Get-ChildItem -LiteralPath $path -Force -Recurse)) { Assert-PlainPath $item.FullName }
            Copy-Item -LiteralPath $path -Destination (Join-Path $stage $relative) -Recurse
        }
    }
    & $install { param($Tools, $Stage)
        Invoke-InstallCommand $Tools.Node @((Join-Path $Stage 'src\installer\validateConfiguration.cjs')) $Stage 'Updated configuration validation'
    } $tools $stage
    $backup = Join-Path $Work 'previous'
    Assert-IdleUpdateTarget $Repository
    Move-UpdateDirectory $Repository $backup
    try {
        Move-UpdateDirectory $stage $Repository
    } catch {
        try { Move-UpdateDirectory $backup $Repository }
        catch {
            $failure = New-Object InvalidOperationException "Update activation and restoration failed. Stop launch and recover from: $Work"
            $failure.Data['StopLaunch'] = $true
            throw $failure
        }
        throw 'Update activation failed; the previous installation was restored.'
    }
    Write-UpdateLog "Updated bot to $($Release.Version). Private previous-installation backup retained: $backup"
}

Export-ModuleMember -Function Get-UpdateSettings, Set-UpdateSettings, Write-UpdateLog, Get-StableUpdate, Save-VerifiedUpdate, Update-InstalledBot
