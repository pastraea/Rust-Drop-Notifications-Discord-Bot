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
        ReuseFolder = ''; ReuseConfiguration = $false; ReuseDatabase = $false
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
    "DISCORD_TOKEN=old-test-token`r`nDISCORD_CLIENT_ID=123456789012345678`r`nDISCORD_GUILD_ID=234567890123456789`r`nDATABASE_PATH=./data/bot.db" |
        Set-Content (Join-Path $old '.env')
    'fixture-database' | Set-Content (Join-Path $old 'data\bot.db')
    $options.ReuseFolder = $old
    $options.ReuseConfiguration = $true
    $options.Token = ''
    $reused = New-InstallEnvironment $options
    Assert-InstallTest ($reused -match 'DISCORD_TOKEN="old-test-token"') 'Reused credentials lost.'
    $options.Token = 'replacement-test-token'
    Assert-InstallTest ((New-InstallEnvironment $options) -match 'DISCORD_TOKEN="replacement-test-token"') 'New fields did not override reused values.'
    $options.ReuseDatabase = $true
    & $module {
        param($Old)
        $script:fixtureScan.Folders = @($Old)
        function script:Get-BotInstallation {
            param($Repository, [switch]$ManualFolder)
            [pscustomobject]@{ Repository = $Repository; ManualFolder = [bool]$ManualFolder }
        }
        function script:Remove-BotInstallation {
            param($Plan, $DeleteData, $DeleteFolder, $BackupDataDirectory, $ProtectedRepository)
            $script:events += 'remove-old'
            if (-not $DeleteData -or -not $DeleteFolder -or -not $BackupDataDirectory) { throw 'Missing cleanup/backup consent.' }
            New-Item -ItemType Directory -Path $BackupDataDirectory | Out-Null
            Copy-Item -LiteralPath (Join-Path $Plan.Repository '.env') -Destination (Join-Path $BackupDataDirectory '.env')
            Copy-Item -LiteralPath (Join-Path $Plan.Repository 'data\bot.db') -Destination (Join-Path $BackupDataDirectory 'bot.db')
            # No real cleanup occurs in the mocked fixture adapter.
        }
    } $old
    $plan = Get-InstallationPlan $options $source
    Assert-InstallTest ($plan.Removals.Count -eq 1) 'Existing installation was not planned for removal.'
    Assert-InstallTest (Test-Path (Join-Path $old '.env')) 'Planning removed original credentials.'
    Assert-InstallTest ((& $module { $script:events.Count }) -eq 0) 'Planning performed system changes.'
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
    Assert-InstallTest ([array]::IndexOf($events, 'Discord command registration') -lt [array]::IndexOf($events, 'remove-old')) 'Command registration failure could destroy old installation.'
    Assert-InstallTest ($events -contains 'startup' -and $events -contains 'start-now') 'Selected startup/start options ignored.'
    Assert-InstallTest ([IO.File]::ReadAllText((Join-Path $options.Destination 'data\bot.db')).Trim() -eq 'fixture-database') 'Database not reused.'
    Assert-InstallTest ([IO.File]::ReadAllText((Join-Path $options.Destination '.env')) -match 'replacement-test-token') 'Installed configuration missing.'
    Assert-InstallTest (Test-Path (Join-Path $options.Destination 'dist\index.js')) 'Built files not installed.'
    Assert-InstallTest (Test-Path (Join-Path $options.Destination '.rust-drops-install.json')) 'Ownership metadata missing.'
    $updateSettings = & $module { Get-UpdateSettings }
    Assert-InstallTest ($updateSettings.Enabled -and $updateSettings.Repository -eq $options.Destination) 'Installer did not save update opt-in and target identity.'
    Assert-InstallTest ($result -notmatch 'replacement-test-token') 'Install result leaked credentials.'
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

    $options.ReuseConfiguration = $false
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
