#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot 'WindowsUpdate.psm1') -Force -PassThru
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('rust-update-tests-' + [guid]::NewGuid())
$originalLocalAppData = $env:LOCALAPPDATA
$passed = 0
function Assert-Update([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:passed++
}
function Assert-UpdateFailure([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        $script:passed++
        return
    }
    throw "Expected updater failure: $Pattern"
}
try {
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $env:LOCALAPPDATA = Join-Path $temporary 'preferences'
    Assert-Update (-not (Get-UpdateSettings).Enabled) 'Updates must default to disabled.'
    $disabledWork = Join-Path $temporary 'disabled-work'
    & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File `
        (Join-Path $PSScriptRoot 'Invoke-Updater.ps1') -Mode Setup -CurrentVersion '0.2.3' -WorkDirectory $disabledWork
    Assert-Update ($LASTEXITCODE -eq 0 -and -not (Test-Path -LiteralPath $disabledWork)) 'Disabled updater performed update work.'
    $repository = Join-Path $temporary 'installed'
    Set-UpdateSettings $true $repository
    Assert-Update ((Get-UpdateSettings).Enabled -and (Get-UpdateSettings).Repository -eq $repository) 'Opt-in preference was not saved.'
    $settingsPath = Join-Path $env:LOCALAPPDATA 'RustDropsBot-Updater\settings.json'
    Assert-Update (Get-Acl -LiteralPath (Split-Path $settingsPath -Parent)).AreAccessRulesProtected 'Update preferences must have private ACLs.'
    Set-UpdateSettings $false $repository
    Assert-Update (-not (Get-UpdateSettings).Enabled) 'Opt-out preference was not saved.'
    '{"Enabled":"true","Repository":""}' | Set-Content -LiteralPath $settingsPath
    Assert-UpdateFailure { Get-UpdateSettings } 'invalid'
    Set-UpdateSettings $false $repository

    $release = [pscustomobject]@{
        draft = $false; prerelease = $false; tag_name = 'v0.10.0'
        assets = @([pscustomobject]@{
            name = 'Rust-Drop-Notifications-Discord-Bot-Setup-0.10.0.exe'
            browser_download_url = 'https://github.com/pastraea/Rust-Drop-Notifications-Discord-Bot/releases/download/v0.10.0/Rust-Drop-Notifications-Discord-Bot-Setup-0.10.0.exe'
            size = 7; digest = ('sha256:' + ('a' * 64))
        })
    }
    & $module {
        param($Fixture)
        $script:releaseFixture = $Fixture
        $script:apiCalls = 0
        function script:Invoke-RestMethod {
            param($Uri, $Headers, $TimeoutSec)
            if ($Uri -cne 'https://api.github.com/repos/pastraea/Rust-Drop-Notifications-Discord-Bot/releases/latest' -or $TimeoutSec -ne 15) {
                throw 'Unexpected API endpoint/timeout.'
            }
            $script:apiCalls++
            return $script:releaseFixture
        }
    } $release
    $candidate = Get-StableUpdate '0.9.9'
    Assert-Update ($candidate.Version -eq '0.10.0' -and $candidate.Hash -eq ('a' * 64)) 'Update version comparison/digest parsing is wrong.'
    Assert-Update ($null -eq (Get-StableUpdate '0.10.0')) 'Equal versions must not update.'
    Assert-Update ($null -eq (Get-StableUpdate '1.0.0')) 'Updater must not downgrade.'
    Assert-UpdateFailure { Get-StableUpdate '0.2.3-beta' } 'stable semantic'
    $release.prerelease = $true
    Assert-UpdateFailure { Get-StableUpdate '0.2.3' } 'stable published'
    $release.prerelease = $false
    $release.draft = $true
    Assert-UpdateFailure { Get-StableUpdate '0.2.3' } 'stable published'
    $release.draft = $false
    $release.assets[0].digest = ''
    Assert-UpdateFailure { Get-StableUpdate '0.2.3' } 'SHA-256'
    $release.assets[0].digest = 'sha256:' + ('a' * 64)
    $release.assets[0].browser_download_url = 'https://example.test/foreign.exe'
    Assert-UpdateFailure { Get-StableUpdate '0.2.3' } 'URL'
    $release.assets[0].browser_download_url = $candidate.Url
    $asset = $release.assets[0]
    $release.assets = @($asset, $asset)
    Assert-UpdateFailure { Get-StableUpdate '0.2.3' } 'exactly one'
    $release.assets = @($asset)
    $asset.size = 51MB
    Assert-UpdateFailure { Get-StableUpdate '0.2.3' } 'size'
    $asset.size = 7
    & $module { function script:Invoke-RestMethod { param($Uri, $Headers, $TimeoutSec) throw 'fixture rate limit' } }
    Assert-UpdateFailure { Get-StableUpdate '0.2.3' } 'rate limit'

    $uninstallModule = Import-Module (Join-Path $PSScriptRoot 'WindowsUninstall.psm1') -PassThru
    $holder = [PowerShell]::Create()
    try {
        [void]$holder.AddScript(@'
$mutex = New-Object Threading.Mutex($false, 'Local\RustDropNotificationsUpdater')
$mutex.WaitOne() | Out-Null
try { Start-Sleep -Seconds 30 } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
'@)
        $running = $holder.BeginInvoke()
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        $busy = $false
        do {
            try { & $uninstallModule { Invoke-BotMaintenance { 'idle' } } | Out-Null }
            catch { if ($_.Exception.Message -match 'in progress') { $busy = $true; break }; throw }
            Start-Sleep -Milliseconds 20
        } while ([DateTime]::UtcNow -lt $deadline)
        Assert-Update $busy 'Install/removal did not respect updater maintenance locking.'
    } finally { $holder.Stop(); $holder.Dispose() }

    $downloadDirectory = Join-Path $temporary 'download'
    New-Item -ItemType Directory -Path $downloadDirectory | Out-Null
    $fixtureDownload = Join-Path $temporary 'fixture.exe'
    [IO.File]::WriteAllText($fixtureDownload, 'fixture')
    $candidate.Hash = (Get-FileHash -LiteralPath $fixtureDownload).Hash
    & $module {
        param($Fixture)
        $script:downloadFixture = $Fixture
        $script:downloads = 0
        function script:Invoke-WebRequest {
            param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
            if ($TimeoutSec -ne 120 -or -not $UseBasicParsing) { throw 'Unexpected download timeout/options.' }
            $script:downloads++
            Copy-Item -LiteralPath $script:downloadFixture -Destination $OutFile
        }
    } $fixtureDownload
    $verified = Save-VerifiedUpdate $candidate $downloadDirectory
    Assert-Update (Test-Path -LiteralPath $verified) 'Verified download missing.'
    $null = Save-VerifiedUpdate $candidate $downloadDirectory
    Assert-Update ((& $module { $script:downloads }) -eq 1) 'Verified cache should avoid downloading twice.'
    $candidate.Hash = '0' * 64
    Assert-UpdateFailure { Save-VerifiedUpdate $candidate $downloadDirectory } 'verification failed'
    Assert-Update (@(Get-ChildItem -LiteralPath $downloadDirectory -Filter '*.partial').Count -eq 0) 'Failed download left a partial executable.'
    $candidate.Hash = (Get-FileHash -LiteralPath $fixtureDownload).Hash
    $candidate.Size = 8
    Assert-UpdateFailure { Save-VerifiedUpdate $candidate $downloadDirectory } 'verification failed'
    $candidate.Size = 7

    # Use the actual package resource when the EXE has already been built.
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $executable = Join-Path $root "artifacts\Rust-Drop-Notifications-Discord-Bot-Setup-$version.exe"
    if (Test-Path -LiteralPath $executable) {
        $expanded = Join-Path $temporary 'expanded'
        New-Item -ItemType Directory -Path $expanded | Out-Null
        & $module { param($Exe, $Target, $Version) Expand-UpdatePayload $Exe $Target $Version } $executable $expanded $version
        Assert-Update (Test-Path -LiteralPath (Join-Path $expanded 'src\installer\WindowsUpdate.psm1')) 'Actual executable payload omitted the updater.'
        Assert-Update (-not (Test-Path -LiteralPath (Join-Path $expanded '.env'))) 'Actual executable payload contained private configuration.'
        $mismatch = Join-Path $temporary 'mismatched'
        New-Item -ItemType Directory -Path $mismatch | Out-Null
        Assert-UpdateFailure { & $module { param($Exe, $Target) Expand-UpdatePayload $Exe $Target '99.0.0' } $executable $mismatch } 'does not match'
        $payloadZip = Join-Path $temporary 'unsafe.zip'
        $zipStream = [IO.File]::Open($payloadZip, [IO.FileMode]::CreateNew)
        $unsafeArchive = New-Object IO.Compression.ZipArchive $zipStream, ([IO.Compression.ZipArchiveMode]::Create)
        try {
            $entry = $unsafeArchive.CreateEntry('../escape.txt')
            $writer = New-Object IO.StreamWriter ($entry.Open())
            try { $writer.Write('must not escape') } finally { $writer.Dispose() }
        } finally { $unsafeArchive.Dispose(); $zipStream.Dispose() }
        $unsafeSource = Join-Path $temporary 'Unsafe.cs'
        'public class UnsafePayloadFixture {}' | Set-Content -LiteralPath $unsafeSource
        $unsafeAssembly = Join-Path $temporary 'unsafe.dll'
        & (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') /nologo /target:library `
            "/out:$unsafeAssembly" "/resource:$payloadZip,BotPayload" $unsafeSource
        if ($LASTEXITCODE -ne 0) { throw 'Unsafe payload test fixture compilation failed.' }
        $unsafeTarget = Join-Path $temporary 'unsafe-target'
        New-Item -ItemType Directory -Path $unsafeTarget | Out-Null
        Assert-UpdateFailure { & $module { param($Exe, $Target) Expand-UpdatePayload $Exe $Target '0.2.3' } $unsafeAssembly $unsafeTarget } 'unsupported'
        Assert-Update (-not (Test-Path -LiteralPath (Join-Path $temporary 'escape.txt'))) 'Payload extraction escaped its destination.'
    }

    $install = Import-Module (Join-Path $PSScriptRoot 'WindowsInstall.psm1') -PassThru
    & $install {
        $script:failUpdateBuild = $false
        function script:Get-InstallNodeTools {
            param($AllowNodeInstall)
            if ($AllowNodeInstall) { throw 'Updater must not install shared Node.js.' }
            [pscustomobject]@{ Node = 'fixture-node'; Npm = 'fixture-npm' }
        }
        function script:Invoke-InstallCommand {
            param($Executable, $Arguments, $Directory, $Label)
            if ($Label -eq 'Update build') {
                if ($script:failUpdateBuild) { throw 'fixture build failure' }
                New-Item -ItemType Directory -Path (Join-Path $Directory 'dist') | Out-Null
                'built' | Set-Content -LiteralPath (Join-Path $Directory 'dist\index.js')
            }
        }
    }
    & $module {
        $script:activeBot = $false
        $script:failActivation = $false
        $script:failRestoration = $false
        $script:fixtureExample = "DISCORD_TOKEN=`nNEW_OPTION=7`n"
        function script:Get-CimInstance {
            param($ClassName)
            if ($script:activeBot) {
                [pscustomobject]@{ Name = 'node.exe'; CommandLine = 'node dist/index.js'; ProcessId = 123 }
            }
        }
        function script:Expand-UpdatePayload {
            param($Executable, $Destination, $Version)
            '{"name":"rust-drops-reminder-bot","version":"0.10.0"}' | Set-Content -LiteralPath (Join-Path $Destination 'package.json')
            [IO.File]::WriteAllText((Join-Path $Destination '.env.example'), $script:fixtureExample)
        }
        function script:Move-UpdateDirectory {
            param($Source, $Destination)
            if ($script:failActivation -and (Split-Path $Source -Leaf) -eq 'prepared') { throw 'fixture activation failure' }
            if ($script:failRestoration -and (Split-Path $Source -Leaf) -eq 'previous') { throw 'fixture restoration failure' }
            [IO.Directory]::Move($Source, $Destination)
        }
    }
    New-Item -ItemType Directory -Path (Join-Path $repository 'data') -Force | Out-Null
    '{"name":"rust-drops-reminder-bot","version":"0.2.3"}' | Set-Content -LiteralPath (Join-Path $repository 'package.json')
    '{"Version":1,"Shortcuts":[]}' | Set-Content -LiteralPath (Join-Path $repository '.rust-drops-install.json')
    'DISCORD_TOKEN=fixture-only-token' | Set-Content -LiteralPath (Join-Path $repository '.env')
    foreach ($name in @('bot.db', 'bot.db-wal', 'bot.db-shm')) { "retained-$name" | Set-Content -LiteralPath (Join-Path $repository "data\$name") }
    $work = Join-Path $temporary 'update-work'
    New-Item -ItemType Directory -Path $work | Out-Null
    & $module { $script:activeBot = $true }
    Assert-UpdateFailure { Update-InstalledBot $repository $work $candidate $fixtureDownload } 'already running'
    Assert-Update (-not (Test-Path -LiteralPath (Join-Path $work 'prepared'))) 'Active bot update performed staging.'
    & $module { $script:activeBot = $false }
    & $install { $script:failUpdateBuild = $true }
    Assert-UpdateFailure { Update-InstalledBot $repository $work $candidate $fixtureDownload } 'build failure'
    Assert-Update ((Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw) -match '0.2.3') 'Build failure changed the old installation.'
    & $install { $script:failUpdateBuild = $false }
    $work = Join-Path $temporary 'activation-failure'
    New-Item -ItemType Directory -Path $work | Out-Null
    & $module { $script:failActivation = $true }
    Assert-UpdateFailure { Update-InstalledBot $repository $work $candidate $fixtureDownload } 'previous installation was restored'
    Assert-Update (Test-Path -LiteralPath (Join-Path $repository '.env')) 'Activation failure lost configuration.'
    $work = Join-Path $temporary 'restoration-failure'
    New-Item -ItemType Directory -Path $work | Out-Null
    & $module { $script:failRestoration = $true }
    $fatal = $null
    try { Update-InstalledBot $repository $work $candidate $fixtureDownload }
    catch { $fatal = $_.Exception }
    Assert-Update ($null -ne $fatal -and $fatal.Data['StopLaunch'] -eq $true) 'Failed restoration must explicitly block bot launch.'
    Assert-Update (Test-Path -LiteralPath (Join-Path $work 'previous\data\bot.db')) 'Failed restoration lost its recovery database.'
    [IO.Directory]::Move((Join-Path $work 'previous'), $repository)
    & $module { $script:failRestoration = $false }
    & $module { $script:failActivation = $false }
    $work = Join-Path $temporary 'success'
    New-Item -ItemType Directory -Path $work | Out-Null
    Update-InstalledBot $repository $work $candidate $fixtureDownload
    Assert-Update ((Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw) -match '0.10.0') 'New version was not activated.'
    Assert-Update ((Get-Content -LiteralPath (Join-Path $repository '.env') -Raw) -match 'fixture-only-token') 'Update lost configuration.'
    foreach ($name in @('bot.db', 'bot.db-wal', 'bot.db-shm')) {
        Assert-Update ((Get-Content -LiteralPath (Join-Path $repository "data\$name") -Raw).Trim() -eq "retained-$name") "Update lost $name."
    }
    Assert-Update (Test-Path -LiteralPath (Join-Path $work 'previous\.env')) 'Previous installation backup was not retained.'
    $updatedEnvironment = [IO.File]::ReadAllText((Join-Path $repository '.env'))
    Assert-Update ($updatedEnvironment.StartsWith('DISCORD_TOKEN=fixture-only-token') -and $updatedEnvironment -match '(?m)^# NEW_OPTION=7' -and $updatedEnvironment -notmatch '(?m)^# DISCORD_TOKEN') 'Update must keep .env and only append new options as comments.'

    # With Preserve .env off the update still carries the file forward, but does not touch or migrate it.
    $beforeBytes = [IO.File]::ReadAllBytes((Join-Path $repository '.env'))
    & $module { $script:fixtureExample = "DISCORD_TOKEN=`nNEW_OPTION=7`nSECOND_OPTION=1`n" }
    Set-UpdateSettings -Enabled $false -Repository $repository -PreserveEnvironment $false
    Assert-Update (-not (Get-UpdateSettings).PreserveEnvironment) 'Preserve preference was not saved as off.'
    Set-UpdateSettings -Enabled $true -Repository $repository
    Assert-Update (-not (Get-UpdateSettings).PreserveEnvironment) 'Changing auto-update reset the Preserve preference.'
    $work = Join-Path $temporary 'preserve-off'
    New-Item -ItemType Directory -Path $work | Out-Null
    Update-InstalledBot $repository $work $candidate $fixtureDownload
    Assert-Update ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $repository '.env'))) -ceq [Convert]::ToBase64String($beforeBytes)) 'Preserve-off update modified .env.'
    Set-UpdateSettings -Enabled $true -Repository $repository -PreserveEnvironment $true
    $work = Join-Path $temporary 'preserve-on'
    New-Item -ItemType Directory -Path $work | Out-Null
    Update-InstalledBot $repository $work $candidate $fixtureDownload
    $migrated = [IO.File]::ReadAllText((Join-Path $repository '.env'))
    Assert-Update ($migrated -match '(?m)^# SECOND_OPTION=1' -and ([regex]::Matches($migrated, 'NEW_OPTION')).Count -eq 1) 'Preserve-on update did not add only the missing option.'
    '{"Enabled":true,"Repository":"x"}' | Set-Content -LiteralPath $settingsPath
    Assert-Update ((Get-UpdateSettings).PreserveEnvironment) 'Settings from before this option existed must default to preserving .env.'
    '{"Enabled":true,"Repository":"x","PreserveEnvironment":"no"}' | Set-Content -LiteralPath $settingsPath
    Assert-UpdateFailure { Get-UpdateSettings } 'invalid'
    Assert-Update ((Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'RustDropsBot-Updater\updater.log') -Raw) -notmatch 'fixture-only-token') 'Updater logged credentials.'
    Write-Output "Passed $passed updater assertions. GitHub, downloads, Node/build and process calls were mocked; only temporary files changed."
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
