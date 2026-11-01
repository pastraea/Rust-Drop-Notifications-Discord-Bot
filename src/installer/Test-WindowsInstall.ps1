#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot 'WindowsInstall.psm1') -Force -PassThru
$passed = 0
function Assert-InstallTest([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:passed++
}
function Assert-InstallFailure([scriptblock]$Code, [string]$Pattern) {
    try { & $Code } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        $script:passed++
        return
    }
    throw "Expected install failure: $Pattern"
}
function New-TestOptions([string]$Destination) {
    [pscustomobject]@{
        Destination = $Destination; Token = 'test-only-secret-not-a-real-token'
        ClientId = '123456789012345678'; GuildId = '234567890123456789'
        ReuseFolder = ''; PreserveEnvironment = $true; ReuseDatabase = $false
        RunOnLogon = $false; StartNow = $false; RegisterCommands = $false
        DesktopShortcut = $false; StartMenuShortcut = $false; AllowNodeInstall = $false
        AutoUpdates = $false
    }
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('rust-install-tests-' + [guid]::NewGuid())
$originalLocalAppData = $env:LOCALAPPDATA
$originalProgramData = $env:ProgramData
try {
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $env:LOCALAPPDATA = Join-Path $temporary 'local-appdata'
    $env:ProgramData = Join-Path $temporary 'program-data'
    $source = Join-Path $temporary 'bundle'
    New-Item -ItemType Directory -Path $source | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $source 'src\installer') -Force | Out-Null
    foreach ($name in @('package.json', 'package-lock.json')) {
        '{"name":"rust-drops-reminder-bot","version":"0.1.4"}' | Set-Content (Join-Path $source $name)
    }
    foreach ($name in @('tsconfig.json', 'LICENSE', 'README.md', '.env.example')) { 'fixture' | Set-Content (Join-Path $source $name) }
    'fixture-source' | Set-Content (Join-Path $source 'src\index.ts')
    'do-not-copy' | Set-Content (Join-Path $source '.env')
    New-Item -ItemType Directory -Path (Join-Path $source 'data') | Out-Null
    'do-not-copy' | Set-Content (Join-Path $source 'data\bot.db')
    $nativeNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nativeNode) {
        $helper = Join-Path $temporary 'native-error.cjs'
        [IO.File]::WriteAllText($helper, "console.error('FIXTURE_SECRET_MUST_NOT_LEAK'); process.exit(1);")
        $oldToken = [Environment]::GetEnvironmentVariable('DISCORD_TOKEN', 'Process')
        [Environment]::SetEnvironmentVariable('DISCORD_TOKEN', 'fixture-inherited-token', 'Process')
        try {
            $message = ''
            try { & $module { param($Node, $Script, $Folder) Invoke-InstallCommand $Node @($Script) $Folder 'Fixture command' } $nativeNode.Source $helper $temporary }
            catch { $message = $_.Exception.Message }
            Assert-InstallTest ($message -match 'Fixture command failed' -and $message -notmatch 'FIXTURE_SECRET_MUST_NOT_LEAK') 'Command failure exposed secret stderr.'
            Assert-InstallTest ([Environment]::GetEnvironmentVariable('DISCORD_TOKEN', 'Process') -eq 'fixture-inherited-token') 'Command wrapper did not restore inherited environment.'
        } finally { [Environment]::SetEnvironmentVariable('DISCORD_TOKEN', $oldToken, 'Process') }
        $runtimeConfig = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'dist\config.js'
        if (Test-Path -LiteralPath $runtimeConfig) {
            $configurationFixture = Join-Path $temporary 'verify-configuration.cjs'
            [IO.File]::WriteAllText($configurationFixture, @'
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const env = { ...process.env, DISCORD_TOKEN: "fixture-only-not-a-real-token" };
for (const interval of ["300000", "NaN", "0", "Infinity"]) {
    env.CHECK_INTERVAL_MS = interval;
    const result = spawnSync(process.execPath, [process.argv[2]], { cwd: process.argv[3], env });
    assert.equal(result.status, interval === "300000" ? 0 : 1);
}
'@)
            & $nativeNode.Source $configurationFixture (Join-Path $PSScriptRoot 'validateConfiguration.cjs') $temporary
            Assert-InstallTest ($LASTEXITCODE -eq 0) 'Staged configuration validation did not accept valid settings or reject invalid polling intervals.'
        }
        $databaseModule = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'node_modules\better-sqlite3'
        if (Test-Path -LiteralPath $databaseModule) {
            $backupFixture = Join-Path $temporary 'verify-backup.cjs'
            [IO.File]::WriteAllText($backupFixture, @'
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const D = require(process.argv[2]);
const source = new D(process.argv[4]);
try {
    source.pragma("journal_mode = WAL");
    source.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('retained')");
    const result = spawnSync(process.execPath, [process.argv[3], process.argv[4], process.argv[5]]);
    assert.equal(result.status, 0);
    const copy = new D(process.argv[5], { readonly: true });
    try { assert.equal(copy.prepare("SELECT value FROM fixture").get().value, "retained"); }
    finally { copy.close(); }
    assert.equal(source.prepare("SELECT value FROM fixture").get().value, "retained");
} finally { source.close(); }
'@)
            & $nativeNode.Source $backupFixture $databaseModule (Join-Path $PSScriptRoot 'backupDatabase.cjs') `
                (Join-Path $temporary 'wal-source.db') (Join-Path $temporary 'wal-copy.db')
            Assert-InstallTest ($LASTEXITCODE -eq 0) 'Online SQLite backup lost WAL data or modified its source.'
        }
    }
    $privateFolder = Join-Path $temporary 'private-acl'
    New-Item -ItemType Directory -Path $privateFolder | Out-Null
    & $module { param($Folder) Set-PrivateInstallDirectory $Folder } $privateFolder
    Assert-InstallTest (Get-Acl -LiteralPath $privateFolder).AreAccessRulesProtected 'Recovery directory ACLs must not inherit access from shared folders.'
    $shortcutOptions = New-TestOptions (Join-Path $temporary 'shortcut-name-test')
    $shortcutOptions.DesktopShortcut = $true
    $shortcutOptions.StartMenuShortcut = $true
    $namedShortcuts = @(& $module { param($Options) Get-InstallShortcutPaths $Options } $shortcutOptions)
    Assert-InstallTest ($namedShortcuts.Count -eq 2 -and
        @($namedShortcuts | Where-Object { (Split-Path $_ -Leaf) -ne 'Rust Drop Notifications Discord Bot.lnk' }).Count -eq 0) 'Desktop and Start menu shortcuts must use the requested product name.'
    & $module {
        $script:fixtureScan = [pscustomobject]@{ Folders = @(); Findings = @(); Issues = @(); StartupIncomplete = $false }
        $script:events = @()
        $script:commands = @()
        $script:failLabel = ''
        function script:Find-WindowsBotInstallations { param([switch]$DeepScan) $script:fixtureScan }
        function script:Assert-InstallAdministrator { $script:events += 'administrator' }
        function script:Set-PrivateInstallDirectory { param($Path) $script:events += 'private-directory' }
        function script:Get-CimInstance { param($ClassName) return @() }
        function script:Get-InstallNodeTools {
            param($AllowNodeInstall)
            $script:events += "node-option:$AllowNodeInstall"
            [pscustomobject]@{ Node = 'fixture-node.exe'; Npm = 'fixture-npm.cmd' }
        }
        function script:Invoke-InstallCommand {
            param($Executable, $Arguments, $Directory, $Label)
            $script:events += $Label
            $script:commands += ($Label + ': ' + ($Arguments -join ' '))
            if ($script:failLabel -eq $Label) { throw "$Label fixture failure" }
            if ($Label -eq 'Bot build') {
                New-Item -ItemType Directory -Path (Join-Path $Directory 'dist') | Out-Null
                'fixture-built-bot' | Set-Content (Join-Path $Directory 'dist\index.js')
            }
        }
        function script:Write-InstallLauncher {
            param($Destination, $Tools)
            $script:events += 'launcher'
            return Join-Path $env:ProgramData 'RustDropsBot\start-rust-bot.ps1'
        }
        function script:Register-InstallStartup { param($Launcher) $script:events += 'startup' }
        function script:New-InstallShortcuts { param($Destination, $Launcher, $Paths) $script:events += "shortcuts:$($Paths.Count)" }
        function script:Get-InstallShortcutPaths { param($Options) return @() }
        function script:Start-InstalledBot { param($Launcher, $Startup) $script:events += 'start-now' }
    }
    $options = New-TestOptions (Join-Path $temporary 'installed')
    $envText = New-InstallEnvironment $options
    Assert-InstallTest ($envText -match 'DATABASE_PATH="./data/bot.db"') 'New database path missing.'
    Assert-InstallTest ($envText -match 'TWITCH_MOCK_DROPS="false"') 'Live provider defaults missing.'
    $options.Token = '123456789012345678'
    Assert-InstallFailure { New-InstallEnvironment $options } 'application ID'
    $options.Token = "not-real`nDISCORD_TOKEN=injection"
    Assert-InstallFailure { New-InstallEnvironment $options } 'newlines'
    $options.Token = 'test-only-secret-not-a-real-token'
    $options.RegisterCommands = $true
    $options.AutoUpdates = $true
    $options.GuildId = ''
    Assert-InstallFailure { New-InstallEnvironment $options } 'server ID'
    $options.GuildId = '234567890123456789'
    $options.RegisterCommands = $false

    $options.Destination = $source
    Assert-InstallFailure { Get-InstallationPlan $options $source } 'outside'
    $options.Destination = Join-Path $source 'nested'
    Assert-InstallFailure { Get-InstallationPlan $options $source } 'outside'
    $options.Destination = Join-Path $temporary 'occupied'
    New-Item -ItemType Directory $options.Destination | Out-Null
    'unrelated' | Set-Content (Join-Path $options.Destination 'personal.txt')
    Assert-InstallFailure { Get-InstallationPlan $options $source } 'not empty'
    $options.Destination = Join-Path $temporary 'installed'
    & $module { $script:fixtureScan.StartupIncomplete = $true }
    Assert-InstallFailure { Get-InstallationPlan $options $source } 'incomplete'
    & $module { $script:fixtureScan.StartupIncomplete = $false }

    $old = Join-Path $temporary 'old-bot'
    New-Item -ItemType Directory -Path (Join-Path $old 'data') -Force | Out-Null
    '{"name":"rust-drops-reminder-bot"}' | Set-Content (Join-Path $old 'package.json')
    # Deliberately awkward: comments, quotes, "$", duplicate keys, CRLF and no trailing newline. It must survive untouched.
    $oldEnvironmentText = (@('# my notes', "DISCORD_TOKEN='old-test-token' # keep", 'DISCORD_CLIENT_ID=123456789012345678',
        'DISCORD_GUILD_ID=234567890123456789', 'DATABASE_PATH="./data/bot.db"', 'CUSTOM_SETTING=pa$$word"quoted"',
        'DUPLICATE=1', 'DUPLICATE=2') -join "`r`n")
    $oldEnvironmentBytes = (New-Object Text.UTF8Encoding $false).GetBytes($oldEnvironmentText)
    [IO.File]::WriteAllBytes((Join-Path $old '.env'), $oldEnvironmentBytes)
    'fixture-database' | Set-Content (Join-Path $old 'data\bot.db')
    $options.ReuseFolder = $old
    $options.PreserveEnvironment = $true
    $options.Token = ''
    $options.ClientId = ''
    $options.GuildId = ''
    $options.ReuseDatabase = $true
    & $module {
        param($Old)
        $script:fixtureScan.Folders = @($Old)
        function script:Get-BotInstallation {
            param($Repository, [switch]$ManualFolder)
            [pscustomobject]@{ Repository = $Repository; ManualFolder = [bool]$ManualFolder }
        }
        function script:Remove-BotInstallation {
            param($Plan, $DeleteData, $DeleteFolder, $BackupDataDirectory, $ProtectedRepository, [switch]$SkipEnvironmentBackup)
            $script:events += 'remove-old'
            $script:skipEnv = [bool]$SkipEnvironmentBackup
            if (-not $DeleteData -or -not $DeleteFolder -or -not $BackupDataDirectory) { throw 'Missing cleanup/backup consent.' }
            New-Item -ItemType Directory -Path $BackupDataDirectory | Out-Null
            if (-not $SkipEnvironmentBackup) {
                Copy-Item -LiteralPath (Join-Path $Plan.Repository '.env') -Destination (Join-Path $BackupDataDirectory '.env')
            }
            Copy-Item -LiteralPath (Join-Path $Plan.Repository 'data\bot.db') -Destination (Join-Path $BackupDataDirectory 'bot.db')
            # No real cleanup occurs in the mocked fixture adapter.
        }
    } $old
    $plan = Get-InstallationPlan $options $source
    Assert-InstallTest ($plan.Removals.Count -eq 1) 'Existing installation was not planned for removal.'
    Assert-InstallTest (Test-Path (Join-Path $old '.env')) 'Planning removed original credentials.'
    Assert-InstallTest ((& $module { $script:events.Count }) -eq 0) 'Planning performed system changes.'
    Assert-InstallTest ($plan.PreserveEnvironment -and $null -ne $plan.PreservedEnvironment -and $plan.DiscardedEnvironments.Count -eq 0) 'Default plan must preserve the existing .env and discard nothing.'
    & $module { $script:failLabel = 'Bot build' }
    Assert-InstallFailure { Install-WindowsBot $plan } 'Bot build fixture failure'
    Assert-InstallTest ((& $module { $script:events }) -notcontains 'remove-old') 'Old installation removed before new build succeeded.'
    Assert-InstallTest (-not (Test-Path $options.Destination)) 'Failed staging created final installation.'
    & $module { $script:failLabel = ''; $script:events = @() }
    $options.RunOnLogon = $true
    $options.StartNow = $true
    $options.RegisterCommands = $true
    $plan = Get-InstallationPlan $options $source
    $result = Install-WindowsBot $plan
    $events = @(& $module { $script:events })
    Assert-InstallTest ([array]::IndexOf($events, 'Bot build') -lt [array]::IndexOf($events, 'remove-old')) 'Destructive cleanup preceded build.'
    $commands = @(& $module { $script:commands })
    $dependencyIndex = [array]::IndexOf($commands, 'Dependency installation: ci --ignore-scripts --no-audit --no-fund')
    $mediaIndex = [array]::IndexOf($commands, 'Media tools installation: rebuild ffmpeg-static')
    Assert-InstallTest ($dependencyIndex -ge 0) 'Dependencies must install with --ignore-scripts so better-sqlite3 is never compiled from source (no C++ build tools are required).'
    Assert-InstallTest ($mediaIndex -gt $dependencyIndex) 'The ffmpeg-static install step must run after the script-free dependency install.'
    Assert-InstallTest (@($commands | Where-Object { $_ -match '^Dependency installation: ci ' -and $_ -notmatch '--ignore-scripts' }).Count -eq 0) 'No install may run npm scripts.'
    Assert-InstallTest ([array]::IndexOf($events, 'Discord command registration') -lt [array]::IndexOf($events, 'remove-old')) 'Command registration failure could destroy old installation.'
    Assert-InstallTest ($events -contains 'startup' -and $events -contains 'start-now') 'Selected startup/start options ignored.'
    Assert-InstallTest ([IO.File]::ReadAllText((Join-Path $options.Destination 'data\bot.db')).Trim() -eq 'fixture-database') 'Database not reused.'
    Assert-InstallTest (([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $options.Destination '.env')))) -ceq [Convert]::ToBase64String($oldEnvironmentBytes)) 'A preserved .env must be installed byte-for-byte identical.'
    Assert-InstallTest ((& $module { $script:skipEnv }) -eq $false) 'Preserve mode must keep the .env recovery copy.'
    Assert-InstallTest (Test-Path (Join-Path $options.Destination 'dist\index.js')) 'Built files not installed.'
    Assert-InstallTest (Test-Path (Join-Path $options.Destination '.rust-drops-install.json')) 'Ownership metadata missing.'
    $updateSettings = & $module { Get-UpdateSettings }
    Assert-InstallTest ($updateSettings.Enabled -and $updateSettings.Repository -eq $options.Destination) 'Installer did not save update opt-in and target identity.'
    Assert-InstallTest ((& $module { Get-UpdateSettings }).PreserveEnvironment) 'Installer did not save the .env preservation preference.'
    Assert-InstallTest ($result -notmatch 'old-test-token') 'Install result leaked credentials.'
    Assert-InstallTest ($result -match 'recovery') 'Recovery location missing from result.'
    Assert-InstallTest ([IO.File]::ReadAllText((Join-Path $source '.env')).Trim() -eq 'do-not-copy') 'Source credentials modified.'
    Assert-InstallTest (@(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'RustDropsBot-Setup') -Recurse -Filter '.env' -Force).Count -ge 1) 'Recovery copies not preserved.'

    $options.Destination = Join-Path $temporary 'changed-scan'
    $plan = Get-InstallationPlan $options $source
    $newlyFound = Join-Path $temporary 'newly-found'
    New-Item -ItemType Directory -Path $newlyFound | Out-Null
    '{"name":"rust-drops-reminder-bot"}' | Set-Content (Join-Path $newlyFound 'package.json')
    & $module { param($New) $script:fixtureScan.Folders += $New; $script:events = @() } $newlyFound
    Assert-InstallFailure { Install-WindowsBot $plan } 'changed since confirmation'
    Assert-InstallTest ((& $module { $script:events }) -notcontains 'remove-old') 'Changed scan performed removal.'

    $options.PreserveEnvironment = $true
    $options.ReuseDatabase = $false
    $options.ReuseFolder = ''
    $options.Token = 'fresh-test-token'
    $options.RunOnLogon = $false
    $options.StartNow = $false
    $options.RegisterCommands = $false
    $options.AutoUpdates = $false
    $options.Destination = Join-Path $temporary 'fresh-install'
    & $module { $script:fixtureScan.Folders = @() }
    $plan = Get-InstallationPlan $options $source
    & $module { $script:events = @() }
    $null = Install-WindowsBot $plan
    $events = @(& $module { $script:events })
    Assert-InstallTest ($events -notcontains 'startup' -and $events -notcontains 'start-now' -and $events -notcontains 'Discord command registration') 'Unchecked options caused side effects.'
    Assert-InstallTest (-not (& $module { Get-UpdateSettings }).Enabled) 'Disabling updates in installation options did not save opt-out.'
    Assert-InstallTest (-not (Test-Path (Join-Path $options.Destination 'data\bot.db'))) 'Fresh install copied bundled database.'
    Assert-InstallTest ([IO.File]::ReadAllText((Join-Path $options.Destination '.env')) -notmatch 'do-not-copy') 'Fresh install copied source secrets.'

    # Preserve .env: guards, change detection, and the explicit opt-out.
    function New-FixtureBot([string]$Name, [string]$EnvironmentText) {
        $folder = Join-Path $temporary $Name
        New-Item -ItemType Directory -Path (Join-Path $folder 'data') -Force | Out-Null
        '{"name":"rust-drops-reminder-bot"}' | Set-Content (Join-Path $folder 'package.json')
        [IO.File]::WriteAllText((Join-Path $folder '.env'), $EnvironmentText)
        'fixture-database' | Set-Content (Join-Path $folder 'data\bot.db')
        return $folder
    }
    $guard = New-TestOptions (Join-Path $temporary 'guard-install')
    $guard.PreserveEnvironment = $true
    $guard.Token = ''; $guard.ClientId = ''; $guard.GuildId = ''

    $customDatabase = New-FixtureBot 'custom-database-bot' "DISCORD_TOKEN=x`r`nDATABASE_PATH=D:\elsewhere\bot.db"
    & $module { param($Folder) $script:fixtureScan.Folders = @($Folder) } $customDatabase
    $guard.ReuseFolder = $customDatabase
    Assert-InstallFailure { Get-InstallationPlan $guard $source } 'custom DATABASE_PATH'

    $withoutIds = New-FixtureBot 'no-ids-bot' 'DISCORD_TOKEN=x'
    & $module { param($Folder) $script:fixtureScan.Folders = @($Folder) } $withoutIds
    $guard.ReuseFolder = $withoutIds
    $guard.RegisterCommands = $true
    Assert-InstallFailure { Get-InstallationPlan $guard $source } 'DISCORD_CLIENT_ID'
    $guard.RegisterCommands = $false

    $typed = New-FixtureBot 'typed-credentials-bot' 'DISCORD_TOKEN=x'
    & $module { param($Folder) $script:fixtureScan.Folders = @($Folder) } $typed
    $guard.ReuseFolder = $typed
    $guard.Token = 'typed-token'
    Assert-InstallFailure { Get-InstallationPlan $guard $source } 'would not be used'
    $guard.Token = ''
    Assert-InstallTest ($null -ne (Get-InstallationPlan $guard $source).PreservedEnvironment) 'A valid existing .env was not preserved.'

    $noEnvironment = New-FixtureBot 'no-env-bot' ''
    Remove-Item -LiteralPath (Join-Path $noEnvironment '.env')
    & $module { param($Folder) $script:fixtureScan.Folders = @($Folder) } $noEnvironment
    $guard.ReuseFolder = $noEnvironment
    Assert-InstallFailure { Get-InstallationPlan $guard $source } 'Enter a bot token'
    $guard.Token = 'fresh-token-for-missing-env'
    $freshPlan = Get-InstallationPlan $guard $source
    Assert-InstallTest ($null -eq $freshPlan.PreservedEnvironment -and $freshPlan.Environment -match 'fresh-token-for-missing-env') 'A missing .env must fall back to the entered credentials.'

    $drift = New-FixtureBot 'drift-bot' "DISCORD_TOKEN=drift-original`r`n"
    & $module { param($Folder) $script:fixtureScan.Folders = @($Folder); $script:events = @() } $drift
    $guard.Token = ''
    $guard.ReuseFolder = $drift
    $guard.Destination = Join-Path $temporary 'drift-install'
    $driftPlan = Get-InstallationPlan $guard $source
    [IO.File]::AppendAllText((Join-Path $drift '.env'), "EXTRA=1`r`n")
    Assert-InstallFailure { Install-WindowsBot $driftPlan } 'changed since confirmation'
    Assert-InstallTest ((& $module { $script:events }) -notcontains 'remove-old') 'An edited .env still allowed removal of the old installation.'

    # Opt-out: the old .env is deleted with no recovery copy, and only a freshly entered one is installed.
    & $module { param($Folder) $script:fixtureScan.Folders = @($Folder); $script:events = @(); $script:skipEnv = $null } $old
    $discard = New-TestOptions (Join-Path $temporary 'opt-out-install')
    $discard.ReuseFolder = $old
    $discard.PreserveEnvironment = $false
    $discard.Token = 'new-secret-test-token'
    $discardPlan = Get-InstallationPlan $discard $source
    Assert-InstallTest ($discardPlan.DiscardedEnvironments.Count -eq 1 -and $discardPlan.DiscardedEnvironments[0] -eq (Join-Path $old '.env')) 'The plan must list every .env that would be deleted.'
    Assert-InstallTest ($null -eq $discardPlan.PreservedEnvironment -and -not $discardPlan.PreserveEnvironment) 'Opt-out plan must not carry the old .env.'
    Assert-InstallTest ([IO.File]::ReadAllBytes((Join-Path $old '.env')).Length -eq $oldEnvironmentBytes.Length) 'Planning modified the old .env.'
    $null = Install-WindowsBot $discardPlan
    Assert-InstallTest ((& $module { $script:skipEnv }) -eq $true) 'Opt-out must skip the .env recovery copy.'
    $newEnvironment = [IO.File]::ReadAllText((Join-Path $discard.Destination '.env'))
    Assert-InstallTest ($newEnvironment -match 'new-secret-test-token' -and $newEnvironment -notmatch 'old-test-token') 'Opt-out must install a new .env only.'
    Assert-InstallTest (-not (& $module { Get-UpdateSettings }).PreserveEnvironment) 'Opt-out preference was not saved.'

    # New options from the bundled .env.example are appended as comments without touching existing bytes.
    $utf8 = New-Object Text.UTF8Encoding $false
    $example = "A=1`nB=2`nC=`n# NOTE=ignored`nD=4"
    $original = $utf8.GetBytes("A=custom`r`n#D=9")
    $updated = Add-NewEnvironmentKeys $original $example
    $text = $utf8.GetString($updated)
    Assert-InstallTest ($text.StartsWith($utf8.GetString($original))) 'Existing .env bytes must stay a prefix of the updated file.'
    Assert-InstallTest ($text -match '(?m)^# B=2' -and $text -match '(?m)^# C=' -and $text -notmatch '(?m)^# A=' -and $text -notmatch '(?m)^# D=' -and $text -notmatch 'NOTE') 'Only missing options should be appended, as comments.'
    Assert-InstallTest ($text -match "`r`n# B=2") 'Appended lines must follow the file''s CRLF line endings.'
    Assert-InstallTest (([Convert]::ToBase64String((Add-NewEnvironmentKeys $updated $example))) -ceq [Convert]::ToBase64String($updated)) 'Appending options must be idempotent.'
    Assert-InstallTest (([Convert]::ToBase64String((Add-NewEnvironmentKeys $original 'A=1'))) -ceq [Convert]::ToBase64String($original)) 'A file with every option must be returned unchanged.'
    $bom = [byte[]](0xEF, 0xBB, 0xBF) + $utf8.GetBytes('A=1')
    $withBom = Add-NewEnvironmentKeys $bom 'A=1'
    Assert-InstallTest (([Convert]::ToBase64String($withBom)) -ceq [Convert]::ToBase64String($bom)) 'A BOM must not hide an existing option or be altered.'

    # Reload to exercise actual startup/Node adapters with only the Windows side effects mocked.
    Remove-Module $module.Name -Force
    $module = Import-Module (Join-Path $PSScriptRoot 'WindowsInstall.psm1') -Force -PassThru
    & $module {
        $script:adapterEvents = @()
        $script:registered = $null
        $script:version = '18.0.0'
        function script:fixtureNode { param($p, $Expression) $global:LASTEXITCODE = 0; $script:version }
        function script:Get-Command {
            param($Name, $ErrorAction)
            switch ($Name) {
                'node.exe' { [pscustomobject]@{ Source = 'fixtureNode' } }
                'npm.cmd' { [pscustomobject]@{ Source = 'fixture-npm.cmd' } }
                'winget.exe' { [pscustomobject]@{ Source = 'fixture-winget.exe' } }
            }
        }
        function script:Invoke-InstallCommand {
            param($Executable, $Arguments, $Directory, $Label)
            $script:adapterEvents += ($Executable + ' ' + ($Arguments -join ' '))
            $script:version = '24.0.0'
        }
        function script:Get-ScheduledTask { return @() }
        function script:New-ScheduledTaskAction { param($Execute, $Argument) [pscustomobject]@{ Execute = $Execute; Argument = $Argument } }
        function script:New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) [pscustomobject]@{ Logon = [bool]$AtLogOn; User = $User } }
        function script:New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) [pscustomobject]@{ User = $UserId; LogonType = $LogonType; RunLevel = $RunLevel } }
        function script:New-ScheduledTaskSettingsSet {
            param([switch]$StartWhenAvailable, $MultipleInstances, $ExecutionTimeLimit,
                [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $RestartCount, $RestartInterval)
            [pscustomobject]@{
                Multiple = $MultipleInstances; Limit = $ExecutionTimeLimit
                BatteryStart = [bool]$AllowStartIfOnBatteries; BatteryContinue = [bool]$DontStopIfGoingOnBatteries
                Restarts = $RestartCount
            }
        }
        function script:Register-ScheduledTask {
            param($TaskName, $Action, $Trigger, $Principal, $Settings)
            $script:registered = [pscustomobject]@{ Name = $TaskName; Action = $Action; Trigger = $Trigger; Principal = $Principal; Settings = $Settings }
        }
    }
    Assert-InstallFailure { & $module { Get-InstallNodeTools $false } } 'Node.js 22.12'
    Assert-InstallTest ((& $module { $script:adapterEvents.Count }) -eq 0) 'Node download happened without consent.'
    $originalPath = $env:PATH
    try { $tools = & $module { Get-InstallNodeTools $true } } finally { $env:PATH = $originalPath }
    Assert-InstallTest ($tools.Node -eq 'fixtureNode') 'Node tools not rechecked after installation.'
    Assert-InstallTest ((& $module { $script:adapterEvents[0] }) -match 'OpenJS.NodeJS.LTS.*--source winget') 'Node installation did not use the exact official winget package.'
    $launcher = & $module { param($Target) Write-InstallLauncher $Target ([pscustomobject]@{ Node = 'C:\Program Files\nodejs\node.exe' }) } (Join-Path $temporary 'launcher-target')
    $text = [IO.File]::ReadAllText($launcher)
    Assert-InstallTest ($text -match 'Local\\RustDropsBot' -and $text -match 'ReleaseMutex') 'Launcher lacks duplicate-start protection.'
    Assert-InstallTest ((& $module { param($Path) Get-LauncherRepository $Path } $launcher) -eq (Join-Path $temporary 'launcher-target')) 'New launcher cannot be detected by uninstall.'
    & $module { param($Launcher) Register-InstallStartup $Launcher } $launcher
    $registration = & $module { $script:registered }
    Assert-InstallTest ($registration.Name -eq 'RustDropsBot' -and $registration.Trigger.Logon) 'Scheduled task must start at user logon.'
    Assert-InstallTest ($registration.Principal.RunLevel -eq 'Limited' -and $registration.Principal.LogonType -eq 'Interactive') 'Bot should not run elevated or require saved user passwords.'
    Assert-InstallTest ($registration.Settings.Limit -eq [TimeSpan]::Zero -and $registration.Settings.Multiple -eq 'IgnoreNew') 'Startup task must not time out or launch duplicates.'
    Assert-InstallTest ($registration.Settings.BatteryStart -and $registration.Settings.BatteryContinue -and $registration.Settings.Restarts -eq 3) 'Startup task must support laptops and bounded failure restarts.'
    $shortcutPath = Join-Path $temporary 'fixture-start-shortcut.lnk'
    & $module { param($Target, $Launcher, $Shortcut) New-InstallShortcuts $Target $Launcher @($Shortcut) } `
        (Join-Path $temporary 'launcher-target') $launcher $shortcutPath
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        try {
            Assert-InstallTest ($shortcut.WorkingDirectory -eq (Join-Path $temporary 'launcher-target')) 'Shortcut working directory is wrong.'
            Assert-InstallTest ($shortcut.Arguments.Contains($launcher)) 'Shortcut does not launch the installed bot.'
            Assert-InstallTest ($shortcut.TargetPath -like '*\powershell.exe') 'Shortcut does not use Windows PowerShell.'
            Assert-InstallTest ($shortcut.Description -eq 'Start Rust Drop Notifications Discord Bot') 'Shortcut description must use the requested product name.'
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    Assert-InstallFailure {
        & $module { param($Target, $Launcher, $Shortcut) New-InstallShortcuts $Target $Launcher @($Shortcut) } `
            (Join-Path $temporary 'launcher-target') $launcher $shortcutPath
    } 'occupied'

    Write-Output "Passed $script:passed installation assertions. Node/download, startup, process, shortcut, Discord, and removal operations were mocked."
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:ProgramData = $originalProgramData
    Remove-Module $module.Name -Force
    if (Test-Path -LiteralPath $temporary) {
        foreach ($item in @(Get-ChildItem -LiteralPath $temporary -Force)) {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
        Remove-Item -LiteralPath $temporary
    }
}
