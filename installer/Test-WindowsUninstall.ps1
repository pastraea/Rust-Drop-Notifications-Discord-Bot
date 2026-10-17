#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot 'WindowsUninstall.psm1') -Force -PassThru
$script:passed = 0
function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
    $script:passed++
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        $script:passed++
        return
    }
    throw "Expected failure matching: $Pattern"
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('rust-uninstall-tests-' + [guid]::NewGuid())
$originalProgramData = $env:ProgramData
try {
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $env:ProgramData = Join-Path $temporary 'program-data'
    $repository = Join-Path $temporary 'old-installation'
    New-Item -ItemType Directory -Path $repository | Out-Null
    '{"name":"rust-drops-reminder-bot"}' | Set-Content -LiteralPath (Join-Path $repository 'package.json')
    $startup = Join-Path $env:ProgramData 'RustDropsBot'
    New-Item -ItemType Directory -Path $startup -Force | Out-Null
    $launcher = Join-Path $startup 'start-rust-bot.ps1'
    @("Set-Location `"$repository`"", 'npm run start 1>> "bot-out.log"') |
        Set-Content -LiteralPath $launcher

    # Mock OS integration inside the module. Tests never access real scheduled tasks or processes.
    & $module {
        $script:testTask = $null
        $script:testProcesses = @()
        $script:events = @()
        $script:testStartupScan = [pscustomobject]@{ StartupIncomplete = $false; Findings = @() }
        function script:Get-RemovalStartupScan {
            $script:testStartupScan
        }
        function script:Get-ScheduledTask { if ($null -ne $script:testTask) { $script:testTask } }
        function script:Get-CimInstance {
            param($ClassName, $Filter)
            if ($Filter) {
                $id = [int]($Filter -replace '\D', '')
                return $script:testProcesses | Where-Object { $_.ProcessId -eq $id }
            }
            return $script:testProcesses
        }
        function script:Disable-ScheduledTask { param($TaskName, $TaskPath) $script:events += 'disable' }
        function script:Stop-ScheduledTask { param($TaskName, $TaskPath) $script:events += 'stop-task' }
        function script:Unregister-ScheduledTask {
            param($TaskName, $TaskPath, $Confirm)
            $script:events += 'unregister'
            $script:testTask = $null
        }
        function script:Stop-Process {
            param($Id, [switch]$Force, $ErrorAction)
            $script:events += "stop-$Id"
            $script:testProcesses = @($script:testProcesses | Where-Object { $_.ProcessId -ne $Id })
        }
    }
    Assert-True ((Get-LauncherRepository $launcher) -eq $repository) 'Launcher path parsing failed.'
    Assert-True (Test-ChildPath (Join-Path $repository 'data\bot.db') $repository) 'Child path rejected.'
    Assert-True (-not (Test-ChildPath ($repository + '-other\data.db') $repository)) 'Sibling path accepted.'
    $data = @(Get-BotDataPaths $repository)
    Assert-True ($data.Count -eq 4) 'Database sidecars missing.'
    'DATABASE_PATH="./data/custom.sqlite" # comment' | Set-Content (Join-Path $repository '.env')
    Assert-True ((Get-BotDataPaths $repository)[1] -eq (Join-Path $repository 'data\custom.sqlite')) 'Quoted database path failed.'
    'DATABASE_PATH=..\outside.db' | Set-Content (Join-Path $repository '.env')
    Assert-Throws { Get-BotDataPaths $repository } 'outside'
    'DATABASE_PATH=package.json' | Set-Content (Join-Path $repository '.env')
    Assert-Throws { Get-BotDataPaths $repository } 'must identify'
    'DATABASE_PATH=data\bot.db' | Set-Content (Join-Path $repository '.env')
    Assert-Throws { Assert-RemovableFolder $repository $repository } 'running installer'
    New-Item -ItemType Directory (Join-Path $repository '.git') | Out-Null
    Assert-Throws { Assert-RemovableFolder $repository $PSScriptRoot } 'development folder'
    Remove-Item -LiteralPath (Join-Path $repository '.git')
    'personal file' | Set-Content (Join-Path $repository 'personal.txt')
    Assert-Throws { Assert-RemovableFolder $repository $PSScriptRoot } 'Unrecognized'
    Remove-Item -LiteralPath (Join-Path $repository 'personal.txt')

    & $module {
        param($Launcher, $Repo)
        $script:testTask = [pscustomobject]@{
            TaskName = 'RustDropsBot'; TaskPath = '\'
            Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`"" })
        }
        $script:testProcesses = @(
            [pscustomobject]@{ ProcessId = 100; ParentProcessId = 1; Name = 'powershell.exe'; CommandLine = "powershell.exe -File `"$Launcher`""; CreationDate = 'one' }
            [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100; Name = 'node.exe'; CommandLine = 'node dist/index.js'; CreationDate = 'two' }
            [pscustomobject]@{ ProcessId = 102; ParentProcessId = 1; Name = 'node.exe'; CommandLine = 'node unrelated.js'; CreationDate = 'three' }
        )
    } $launcher $repository
    $plan = Get-BotInstallation ''
    Assert-True ($plan.Processes.Count -eq 2) 'Process tree must exclude unrelated Node processes.'
    Assert-True ((& $module { $script:events.Count }) -eq 0) 'Detection changed OS state.'
    & $module { $script:testStartupScan.StartupIncomplete = $true }
    Assert-Throws {
        Remove-BotInstallation -Plan $plan -DeleteData $false -DeleteFolder $false -ProtectedRepository $PSScriptRoot
    } 'incomplete'
    Assert-True ((& $module { $script:events.Count }) -eq 0) 'Incomplete startup scan changed OS state.'
    & $module {
        param($Folder)
        $script:testStartupScan.StartupIncomplete = $false
        $script:testStartupScan.Findings = @([pscustomobject]@{ Kind = 'Windows service'; Location = 'fixture-service'; Folder = $Folder })
    } $repository
    Assert-Throws {
        Remove-BotInstallation -Plan $plan -DeleteData $false -DeleteFolder $false -ProtectedRepository $PSScriptRoot
    } 'manual removal'
    Assert-True ((& $module { $script:events.Count }) -eq 0) 'Unsupported service changed OS state.'
    & $module {
        param($Folder)
        $script:testStartupScan.Findings = @([pscustomobject]@{ Kind = 'Running process'; Location = 'PID 999'; Folder = $Folder })
    } $repository
    Assert-Throws {
        Remove-BotInstallation -Plan $plan -DeleteData $false -DeleteFolder $false -ProtectedRepository $PSScriptRoot
    } 'cannot be stopped safely'
    Assert-True ((& $module { $script:events.Count }) -eq 0) 'Unattributed process changed OS state.'
    & $module { $script:testStartupScan.Findings = @() }
    & $module {
        $script:testProcesses += [pscustomobject]@{
            ProcessId = 103; ParentProcessId = 1; Name = 'node.exe'
            CommandLine = 'node dist/index.js'; CreationDate = 'four'
        }
    }
    Assert-Throws {
        Remove-BotInstallation -Plan $plan -DeleteData $true -DeleteFolder $false -ProtectedRepository $PSScriptRoot
    } 'Relative-path'
    Assert-True ((& $module { $script:events.Count }) -eq 0) 'Ambiguous-process rejection changed OS state.'
    & $module { $script:testProcesses = @($script:testProcesses | Where-Object { $_.ProcessId -ne 103 }) }
    $different = Join-Path $temporary 'different'
    Assert-Throws { Get-BotInstallation $different } 'differs'
    & $module { $script:testTask.Actions[0].Arguments = '-File "C:\unrelated.ps1"' }
    Assert-Throws { Get-BotInstallation '' } 'unrecognized action'
    & $module { param($Launcher) $script:testTask.Actions[0].Arguments = "-File `"$Launcher`"" } $launcher
    $plan = Get-BotInstallation ''
    New-Item -ItemType Directory (Join-Path $repository 'data') | Out-Null
    'database' | Set-Content (Join-Path $repository 'data\bot.db')
    'log' | Set-Content (Join-Path $startup 'bot-out.log')
    'leave this' | Set-Content (Join-Path $startup 'unrelated.txt')
    $result = Remove-BotInstallation -Plan $plan -DeleteData $false -DeleteFolder $false -ProtectedRepository $PSScriptRoot
    Assert-True ($result -match 'finished') 'Uninstall result missing.'
    Assert-True (Test-Path (Join-Path $repository '.env')) 'Keep-data uninstall removed credentials.'
    Assert-True (Test-Path (Join-Path $repository 'data\bot.db')) 'Keep-data uninstall removed database.'
    Assert-True (Test-Path (Join-Path $startup 'unrelated.txt')) 'Unrelated startup file removed.'
    Assert-True (-not (Test-Path $launcher)) 'Launcher still exists.'
    Assert-True ((& $module { $script:testProcesses.Count }) -eq 1) 'Unrelated process was stopped.'
    $events = @(& $module { $script:events })
    Assert-True ($events[0] -eq 'disable' -and $events[1] -eq 'stop-task' -and $events[-1] -eq 'unregister') 'Unexpected removal sequence.'
    Assert-True ((@($events | Where-Object { $_ -match '^stop-\d+$' } | Sort-Object) -join ',') -eq 'stop-100,stop-101') 'Unexpected process termination targets.'

    $manual = Get-BotInstallation $repository
    'wal-fixture' | Set-Content (Join-Path $repository 'data\bot.db-wal')
    $backupDirectory = Join-Path $temporary 'private-data-backup'
    Remove-BotInstallation -Plan $manual -DeleteData $true -DeleteFolder $false -BackupDataDirectory $backupDirectory -ProtectedRepository $PSScriptRoot | Out-Null
    Assert-True (Test-Path (Join-Path $backupDirectory '.env')) 'Reinstall backup lost credentials.'
    Assert-True (Test-Path (Join-Path $backupDirectory 'bot.db')) 'Reinstall backup lost database.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $backupDirectory 'bot.db-wal')).Trim() -eq 'wal-fixture') 'Reinstall backup lost WAL sidecar.'
    Assert-True (-not (Test-Path (Join-Path $repository '.env'))) 'Credentials not removed after consent.'
    Assert-True (-not (Test-Path (Join-Path $repository 'data\bot.db'))) 'Database not removed after consent.'
    $manual = Get-BotInstallation $repository
    Remove-BotInstallation -Plan $manual -DeleteData $true -DeleteFolder $true -ProtectedRepository $PSScriptRoot | Out-Null
    Assert-True (-not (Test-Path $repository)) 'Confirmed old installation folder remains.'
    $absent = Get-BotInstallation ''
    Assert-True (-not $absent.Found) 'Absent installation should be reported without an error.'
    Assert-Throws {
        Remove-BotInstallation -Plan $absent -DeleteData $true -DeleteFolder $true -ProtectedRepository $PSScriptRoot
    } 'No recognized installation'

    $discovery = Import-Module (Join-Path $PSScriptRoot 'WindowsDiscovery.psm1') -Force -PassThru
    & $discovery {
        param($Root)
        $script:fixtureRoot = $Root
        function script:Get-ScheduledTask {
            [pscustomobject]@{
                TaskName = 'fixture'; TaskPath = '\'
                Actions = @([pscustomobject]@{ Execute = 'node.exe'; Arguments = 'fixture'; WorkingDirectory = $script:fixtureRoot })
            }
        }
        function script:Get-CimInstance {
            param($ClassName)
            switch ($ClassName) {
                'Win32_Service' { [pscustomobject]@{ Name = 'fixture-service'; PathName = 'nssm.exe' } }
                'Win32_UserProfile' { [pscustomobject]@{ LocalPath = $script:fixtureRoot } }
                'Win32_Process' { [pscustomobject]@{ ProcessId = 123; CommandLine = 'node fixture.js' } }
            }
        }
        function script:Test-Path {
            param($LiteralPath, $PathType)
            if ($LiteralPath -like 'Registry::*') {
                return $LiteralPath -like '*fixture-service\Parameters' -or $LiteralPath -like '*\CurrentVersion\Run'
            }
            if (-not $LiteralPath.StartsWith($script:fixtureRoot, [StringComparison]::OrdinalIgnoreCase)) { return $false }
            $arguments = @{ LiteralPath = $LiteralPath }
            if ($PathType) { $arguments.PathType = $PathType }
            Microsoft.PowerShell.Management\Test-Path @arguments
        }
        function script:Get-ChildItem {
            param($LiteralPath, $Path, [switch]$File, [switch]$Directory, [switch]$Force)
            if ($Path -eq 'Registry::HKEY_USERS' -or $LiteralPath -eq 'Registry::HKEY_USERS') {
                return [pscustomobject]@{ PSChildName = 'S-1-5-21-1-2-3-4' }
            }
            $arguments = @{ LiteralPath = $LiteralPath; Force = $Force }
            if ($File) { $arguments.File = $true }
            if ($Directory) { $arguments.Directory = $true }
            Microsoft.PowerShell.Management\Get-ChildItem @arguments
        }
        function script:Get-ItemProperty {
            param($LiteralPath)
            [pscustomobject]@{ Application = 'node.exe'; AppParameters = 'dist\index.js'; AppDirectory = $script:fixtureRoot }
        }
        function script:Get-Item {
            param($LiteralPath)
            $key = [pscustomobject]@{}
            $key | Add-Member ScriptMethod GetValueNames { return @('RustDropsBot-fixture') }
            $key | Add-Member ScriptMethod GetValue { param($Name) return 'node fixture.js' }
            return $key
        }
    } $temporary
    $startupFixture = Join-Path $temporary 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
    New-Item -ItemType Directory -Path $startupFixture -Force | Out-Null
    'node fixture.js' | Set-Content (Join-Path $startupFixture 'fixture.cmd')
    $rawIssues = New-Object 'Collections.Generic.List[string]'
    $rawEntries = @(& $discovery { param($Issues) Get-WindowsStartupEntries -Issues $Issues } $rawIssues)
    foreach ($kind in @('Scheduled task', 'Windows service', 'Service launcher', 'Startup folder', 'Running process')) {
        Assert-True (@($rawEntries | Where-Object { $_.Kind -eq $kind }).Count -eq 1) "OS enumeration adapter missed $kind."
    }
    Assert-True (@($rawEntries | Where-Object { $_.Kind -eq 'Registry startup' }).Count -eq 6) 'Machine/current-user/loaded-user and 32/64-bit Run keys were not all checked.'
    Assert-True ($rawIssues.Count -eq 0) "OS enumeration adapter issues: $rawIssues"
    # Reload the module so OS adapter mocks do not affect folder-traversal assertions.
    Remove-Module $discovery.Name -Force
    $discovery = Import-Module (Join-Path $PSScriptRoot 'WindowsDiscovery.psm1') -Force -PassThru
    $renamed = Join-Path $temporary 'custom-folder'
    New-Item -ItemType Directory -Path (Join-Path $renamed 'dist') -Force | Out-Null
    '{"name":"rust-drops-reminder-bot"}' | Set-Content (Join-Path $renamed 'package.json')
    $commandFolder = Get-CommandBotFolder ('node.exe "' + (Join-Path $renamed 'dist\index.js') + '"')
    Assert-True ($commandFolder -eq $renamed) 'Absolute command target did not identify a renamed installation.'
    Assert-True ((Get-CommandBotFolder 'npm run start' $renamed) -eq $renamed) 'Working-directory detection failed.'
    Assert-True (-not (Get-CommandBotFolder 'app.exe "https://example.test/" "C:\not-a-path|command" "C:\wildcard\*.exe"')) 'Non-path arguments were mistaken for installation paths.'
    $other = Join-Path $temporary 'RustDropsBot-not-the-bot'
    New-Item -ItemType Directory -Path $other | Out-Null
    '{"name":"unrelated-application"}' | Set-Content (Join-Path $other 'package.json')
    Assert-True (-not (Get-CommandBotFolder ('node.exe "' + (Join-Path $other 'dist\index.js') + '"'))) 'Similar folder name was treated as proof.'
    $deep = Join-Path $temporary 'one\two\three\four\five\deep-bot'
    New-Item -ItemType Directory -Path $deep -Force | Out-Null
    '{"name":"rust-drops-reminder-bot"}' | Set-Content (Join-Path $deep 'package.json')
    $issues = New-Object 'Collections.Generic.List[string]'
    $quick = @(Find-BotFolders -Roots @($temporary) -MaxDepth 4 -Issues $issues)
    Assert-True ($quick -contains $renamed -and $quick -notcontains $deep -and $quick -notcontains $other) "Quick scan ignored depth or identity. Results: $quick. Issues: $issues"
    $full = @(Find-BotFolders -Roots @($temporary) -MaxDepth ([int]::MaxValue) -Issues $issues)
    Assert-True ($full -contains $deep) 'Deep scan missed a nested installation.'

    & $discovery {
        param($Root, $Folder)
        $script:fixtureRoot = $Root
        $script:fixtureFolder = $Folder
        function script:Get-BotSearchRoots { param($DeepScan) return @($script:fixtureRoot) }
        function script:Get-WindowsStartupEntries {
            param($Issues)
            foreach ($kind in @('Scheduled task', 'Windows service', 'Service launcher', 'Registry startup', 'Startup folder', 'Running process')) {
                [pscustomobject]@{
                    Kind = $kind; Location = "$kind fixture"
                    Command = 'node.exe "' + (Join-Path $script:fixtureFolder 'dist\index.js') + '"'
                    WorkingDirectory = ''
                }
            }
            [pscustomobject]@{ Kind = 'Scheduled task'; Location = 'unrelated'; Command = 'node.exe C:\other\server.js'; WorkingDirectory = '' }
            [pscustomobject]@{ Kind = 'Registry startup'; Location = 'RustDropsBot stale'; Command = 'C:\missing\start-rust-bot.ps1'; WorkingDirectory = '' }
        }
    } $temporary $renamed
    $scan = Find-WindowsBotInstallations
    Assert-True ($scan.Folders -contains $renamed) 'Startup reference missing from discovered installations.'
    Assert-True ($scan.Findings.Count -eq 7) 'Discovery missed startup mechanisms or included an unrelated entry.'
    Assert-True ($scan.Findings[-1].Folder -eq $null) 'Unconfirmed startup entry must not acquire an installation folder.'
    Assert-True (-not $scan.StartupIncomplete) 'Successful fixture scan reported incomplete startup coverage.'
    Assert-Throws { Assert-SupportedBotRemoval -Scan $scan -Folder $renamed -LegacyTask $false } 'manual removal'
    Assert-SupportedBotRemoval -Scan ([pscustomobject]@{
        StartupIncomplete = $false
        Findings = @([pscustomobject]@{ Kind = 'Scheduled task'; Location = '\RustDropsBot'; Folder = $renamed })
    }) -Folder $renamed -LegacyTask $true
    $script:passed++
    Assert-Throws {
        Assert-SupportedBotRemoval -Scan ([pscustomobject]@{ StartupIncomplete = $true; Findings = @() }) -Folder $renamed -LegacyTask $true
    } 'incomplete'
    & $discovery {
        function script:Get-WindowsStartupEntries { param($Issues) $Issues.Add('Access denied reading service fixtures') }
    }
    $incomplete = Find-WindowsBotInstallations -StartupOnly
    Assert-True ($incomplete.StartupIncomplete -and $incomplete.Issues.Count -eq 1) 'Access errors must be visible and block removal.'
    Remove-Module $discovery.Name -Force

    foreach ($file in @(Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -in @('.ps1', '.psm1') })) {
        $tokens = $null
        $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
        Assert-True ($errors.Count -eq 0) "PowerShell parse error in $($file.Name): $errors"
    }
    Add-Type -AssemblyName PresentationFramework
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Start-Installer.ps1'), [ref]$tokens, [ref]$errors)
    $xamlToken = $tokens | Where-Object { $_.Kind -eq 'HereStringLiteral' } | Select-Object -First 1
    [xml]$xml = $xamlToken.Value
    $reader = New-Object System.Xml.XmlNodeReader $xml
    $window = [Windows.Markup.XamlReader]::Load($reader)
    try {
        foreach ($name in @('Browse', 'Check', 'Install', 'Report', 'Status', 'Installations', 'DeepScan', 'OpenEnvironment', 'Uninstall')) {
            Assert-True ($null -ne $window.FindName($name)) "Missing WPF control: $name"
        }
        Assert-True $window.FindName('Install').IsEnabled 'Install must open setup options.'
        Assert-True (-not $window.FindName('OpenEnvironment').IsChecked) 'Credential copies must be opt-in.'
        $buttons = @($window.FindName('Check').Parent.Children)
        Assert-True (($buttons.Name -join ',') -eq 'Check,Uninstall,Install') 'Incorrect main button order.'
        Assert-True ($xml.OuterXml -notmatch '(?i)github|git checkout') 'Setup UI must not contain development-hosting terminology.'
    } finally {
        $window.Close()
        $reader.Close()
    }
    $uiSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Start-Installer.ps1') -Raw
    $uiSource = $uiSource.Replace('try { [void]$window.ShowDialog() } finally { $timer.Stop() }', '')
    & {
        param($Source, $Directory, $FixtureRoot)
        $Source = '$PSScriptRoot = ''' + $Directory.Replace("'", "''") + '''' + "`r`n" + $Source
        . ([scriptblock]::Create($Source))
        function Wait-UiOperation {
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while ($null -ne $script:worker -and [DateTime]::UtcNow -lt $deadline) {
                $window.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::Background)
                Start-Sleep -Milliseconds 15
            }
            Assert-True ($null -eq $script:worker) 'Desktop background operation did not finish.'
        }
        try {
            Start-BackgroundOperation {
                [pscustomobject]@{
                    Folders = @('C:\test-only-fixture'); Findings = @(); Issues = @()
                    Scope = 'Test fixtures only'; StartupIncomplete = $false
                }
            } @() 'scan'
            Assert-True ($controls.Check.Content -eq 'Cancel scan') 'Active scan must offer cancellation.'
            Wait-UiOperation
            Assert-True ($controls.Installations.Items.Count -eq 1) 'Background scan results did not populate the UI.'
            Assert-True $controls.Uninstall.IsEnabled 'Confirmed scan result did not enable removal review.'
            Assert-True $controls.Install.IsEnabled 'Completed background scan did not enable setup.'
            Start-BackgroundOperation { Start-Sleep -Seconds 30 } @() 'scan'
            $controls.Check.RaiseEvent((New-Object Windows.RoutedEventArgs ([Windows.Controls.Button]::ClickEvent)))
            Wait-UiOperation
            Assert-True ($controls.Report.Text -match 'No files or startup settings were changed') 'Scan cancellation was not reported safely.'

            $copyFolder = Join-Path $FixtureRoot 'credential-copy-fixture'
            New-Item -ItemType Directory -Path $copyFolder | Out-Null
            '{"name":"rust-drops-reminder-bot"}' | Set-Content (Join-Path $copyFolder 'package.json')
            $credentialPath = Join-Path $copyFolder '.env'
            $fixtureText = "DISCORD_TOKEN=test-only-not-a-real-token`r`nDATABASE_PATH=./data/bot.db`r`n"
            [IO.File]::WriteAllText($credentialPath, $fixtureText)
            $copy = New-EnvironmentCopyWindow $credentialPath
            try {
                $editor = @($copy.Content.Children | Where-Object { $_ -is [Windows.Controls.TextBox] })[0]
                Assert-True ($editor.Text -ceq $fixtureText) 'Unsaved copy must preserve environment text.'
                Assert-True (-not $editor.IsReadOnly -and $editor.AcceptsReturn) 'Unsaved copy must be editable.'
                $editor.Text = 'changed locally'
                Assert-True ([IO.File]::ReadAllText($credentialPath) -ceq $fixtureText) 'Editing copy changed original credentials.'
            } finally { $copy.Close() }
            $script:testOpenedCopies = @()
            function Open-EnvironmentCopyWindow([string]$Path) { $script:testOpenedCopies += $Path }
            $fixtureScan = [pscustomobject]@{
                Folders = @($copyFolder); Findings = @(); Issues = @()
                Scope = 'Test fixtures only'; StartupIncomplete = $false
            }
            Show-Discovery $fixtureScan
            Assert-True ($script:testOpenedCopies.Count -eq 0) 'Scan opened credentials without consent.'
            $controls.OpenEnvironment.IsChecked = $true
            Assert-True ($script:testOpenedCopies.Count -eq 1) 'Checking option after scan did not open the selected environment.'
            Assert-True ($script:testOpenedCopies[0] -eq $credentialPath) 'Wrong credential file was opened.'
            Show-SelectedEnvironmentCopy
            Assert-True ($script:testOpenedCopies.Count -eq 1) 'One scan should not repeatedly open the same environment.'
            Show-Discovery $fixtureScan
            Assert-True ($script:testOpenedCopies.Count -eq 2) 'A new successful scan did not open the requested copy.'
            Assert-True ($controls.Report.Text -notmatch 'test-only-not-a-real-token') 'Credentials leaked into the scan report.'
            Remove-Item -LiteralPath $credentialPath
            Show-Discovery $fixtureScan
            Assert-True ($script:testOpenedCopies.Count -eq 2) 'Missing environment unexpectedly opened a window.'
            Assert-True ($controls.Report.Text -match 'No .env file was found') 'Missing environment was not reported.'
            Assert-True (@(Get-ChildItem -LiteralPath $copyFolder -Force).Count -eq 1) 'Opening an unsaved copy created files.'
            [IO.File]::WriteAllText($credentialPath, $fixtureText)
            '{"name":"unrelated-app"}' | Set-Content (Join-Path $copyFolder 'package.json')
            Show-Discovery $fixtureScan
            Assert-True ($script:testOpenedCopies.Count -eq 2) 'Changed installation identity allowed credentials to open.'
            Assert-True ($controls.Report.Text -match 'could not be opened') 'Credential-copy failure was not reported.'
            Assert-True ($controls.Report.Text -notmatch 'test-only-not-a-real-token') 'Credential-copy failure leaked contents.'
            '{"name":"rust-drops-reminder-bot"}' | Set-Content (Join-Path $copyFolder 'package.json')
            $secondFolder = Join-Path $FixtureRoot 'second-credential-copy'
            New-Item -ItemType Directory -Path $secondFolder | Out-Null
            '{"name":"rust-drops-reminder-bot"}' | Set-Content (Join-Path $secondFolder 'package.json')
            [IO.File]::WriteAllText((Join-Path $secondFolder '.env'), 'TEST_FIXTURE_ONLY=second')
            $fixtureScan.Folders = @($copyFolder, $secondFolder)
            Show-Discovery $fixtureScan
            Assert-True ($script:testOpenedCopies.Count -eq 3) 'Selected environment was not opened for a fresh scan.'
            $controls.Installations.SelectedIndex = 1
            Assert-True ($script:testOpenedCopies.Count -eq 4 -and $script:testOpenedCopies[-1] -eq (Join-Path $secondFolder '.env')) 'Selecting a second discovered installation opened the wrong environment.'
            $controls.OpenEnvironment.IsChecked = $false
            $setup = New-InstallScreen $window @($copyFolder, $secondFolder)
            try {
                foreach ($name in @('Destination', 'BrowseDestination', 'Token', 'ClientId', 'GuildId', 'ReuseFolder',
                    'ReuseConfiguration', 'ReuseDatabase', 'RunOnLogon', 'StartNow', 'RegisterCommands',
                    'DesktopShortcut', 'StartMenuShortcut', 'AllowNodeInstall', 'Cancel', 'ConfirmInstall')) {
                    Assert-True ($null -ne $setup.FindName($name)) "Missing install-screen control: $name"
                }
                Assert-True ($setup.FindName('Token') -is [Windows.Controls.PasswordBox]) 'Token must be masked.'
                Assert-True $setup.FindName('Cancel').IsCancel 'Cancel must dismiss the install screen.'
                Assert-True (-not $setup.FindName('AllowNodeInstall').IsChecked) 'Node installation must require consent.'
                Assert-True ($setup.FindName('ReuseFolder').Items.Count -eq 2) 'Reuse installation choices missing.'
            } finally { $setup.Close() }
        } finally {
            $timer.Stop()
            if ($null -ne $script:worker) {
                $script:worker.Stop()
                $script:worker.Dispose()
                $script:worker = $null
            }
            $window.Close()
        }
    } $uiSource $PSScriptRoot $temporary
    Write-Output "Passed $script:passed Windows uninstall assertions. All OS calls were mocked."
} finally {
    $env:ProgramData = $originalProgramData
    Remove-Module $module.Name -Force
    if (Test-Path -LiteralPath $temporary) {
        foreach ($item in @(Get-ChildItem -LiteralPath $temporary -Force)) {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
        Remove-Item -LiteralPath $temporary
    }
}
& (Join-Path $PSScriptRoot 'Test-WindowsInstall.ps1')
