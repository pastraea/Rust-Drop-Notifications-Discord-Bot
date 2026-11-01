Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WindowsUninstall.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'WindowsDiscovery.psm1') -Force

function Assert-InstallAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal $identity
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open PowerShell as administrator, then launch setup again. Installation manages the shared bot launcher and scheduled task.'
    }
}

function Set-PrivateInstallDirectory([string]$Path) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,
        (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'),
        (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Invoke-InstallCommand([string]$Executable, [string[]]$Arguments, [string]$Directory, [string]$Label) {
    $environmentKeys = @('DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DISCORD_PUBLIC_KEY',
        'DATABASE_PATH', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_MOCK_DROPS', 'KICK_MOCK_DROPS', 'CHECK_INTERVAL_MS', 'LOG_LEVEL')
    $previous = @{}
    foreach ($key in $environmentKeys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    Push-Location -LiteralPath $Directory
    try {
        # Output may contain credentials (especially Discord REST failures). Do not echo it into the UI or logs.
        try { $result = @(& $Executable @Arguments 2>&1) }
        catch { throw "$Label failed. Command output was suppressed to protect credentials. Check prerequisites or credentials and retry." }
        if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE). Old data backups, if any, were preserved. Check prerequisites or credentials and retry." }
    } finally {
        Pop-Location
        foreach ($key in $environmentKeys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
    }
}

function Get-InstallNodeTools([bool]$AllowNodeInstall) {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $compatible = $false
    if ($node -and $npm) {
        $version = & $node.Source -p 'process.versions.node'
        if ($LASTEXITCODE -eq 0) {
            $compatible = [version]$version -ge [version]'22.12.0'
        }
    }
    if (-not $compatible -and $AllowNodeInstall) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) { throw 'Windows App Installer (winget) is unavailable. Install Node.js LTS manually and reopen setup.' }
        Invoke-InstallCommand $winget.Source @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget',
            '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity') $env:TEMP 'Node.js LTS installation'
        $env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')
        return Get-InstallNodeTools $false
    }
    if (-not $compatible) { throw 'Node.js 22.12 or newer and npm are required. Enable the Node.js download option or install a current Node.js LTS release and reopen setup.' }
    return [pscustomobject]@{ Node = $node.Source; Npm = $npm.Source }
}

function Get-PreserveEnvironmentOption($Options) {
    # An absent value means the safe default: keep an existing .env.
    if ($Options.PSObject.Properties['PreserveEnvironment']) { return [bool]$Options.PreserveEnvironment }
    return $true
}

function Get-EnvironmentFingerprint($Plan) {
    if ($null -ne $Plan.PreservedEnvironment) { return 'file:' + [Convert]::ToBase64String([byte[]]$Plan.PreservedEnvironment.Bytes) }
    return 'text:' + [string]$Plan.Environment
}

# Appends options that exist in the bundled .env.example but not in the user's file, as commented-out lines.
# The original bytes are never modified, reordered or re-encoded; only a trailing block is added.
function Add-NewEnvironmentKeys([byte[]]$Bytes, [string]$ExampleText) {
    $encoding = New-Object Text.UTF8Encoding $false
    $existing = $encoding.GetString($Bytes).TrimStart([char]0xFEFF)
    $additions = @()
    foreach ($line in ($ExampleText -split "`r?`n")) {
        if ($line -notmatch '^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$') { continue }
        $key = $Matches[1]
        $default = $Matches[2].Trim()
        if ($existing -match ('(?im)^[ \t]*(?:export[ \t]+)?#?[ \t]*' + [regex]::Escape($key) + '[ \t]*=')) { continue }
        $additions += ('# ' + $key + '=' + $default)
    }
    if ($additions.Count -eq 0) { return ,$Bytes }
    $newline = "`n"
    if ($existing.Contains("`r`n")) { $newline = "`r`n" }
    $block = ''
    if ($Bytes.Length -gt 0 -and -not $existing.EndsWith("`n")) { $block += $newline }
    $block += $newline + '# Added by setup: new options in this version (disabled; remove the leading # to use).' + $newline
    $block += ($additions -join $newline) + $newline
    $extra = $encoding.GetBytes($block)
    $combined = New-Object byte[] ($Bytes.Length + $extra.Length)
    [Array]::Copy($Bytes, 0, $combined, 0, $Bytes.Length)
    [Array]::Copy($extra, 0, $combined, $Bytes.Length, $extra.Length)
    return ,$combined
}

function Update-StagedEnvironment([string]$Stage) {
    $envPath = Join-Path $Stage '.env'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { return }
    $examplePath = Join-Path $Stage '.env.example'
    $example = ''
    if (Test-Path -LiteralPath $examplePath -PathType Leaf) { $example = [IO.File]::ReadAllText($examplePath) }
    $bytes = [IO.File]::ReadAllBytes($envPath)
    $updated = Add-NewEnvironmentKeys $bytes $example
    if ($updated.Length -ne $bytes.Length) { [IO.File]::WriteAllBytes($envPath, $updated) }
}

function Assert-PreservedDatabasePath([string]$Text) {
    $lines = @($Text -split "`r?`n" | Where-Object { $_ -match '^\s*(?:export\s+)?DATABASE_PATH\s*=' })
    if ($lines.Count -eq 0) { return }
    if ($lines.Count -gt 1) { throw 'The existing .env has several DATABASE_PATH entries. Resolve them, or turn off Preserve .env to create a new file.' }
    $value = ($lines[0] -replace '^\s*(?:export\s+)?DATABASE_PATH\s*=\s*', '').Trim()
    if ($value.StartsWith('"') -or $value.StartsWith("'")) {
        $quote = $value.Substring(0, 1)
        $end = $value.IndexOf($quote, 1)
        if ($end -lt 1) { throw 'The existing .env has an unsupported DATABASE_PATH. Resolve it, or turn off Preserve .env.' }
        $value = $value.Substring(1, $end - 1)
    } else { $value = ($value -split '#', 2)[0].Trim() }
    if (($value.Replace('\', '/')) -notin @('./data/bot.db', 'data/bot.db')) {
        throw 'The existing .env sets a custom DATABASE_PATH. Installer-managed copies keep their database at ./data/bot.db. Edit the file to use that path, or turn off Preserve .env.'
    }
}

# Returns $null when there is nothing to preserve, otherwise the exact bytes for the new installation's .env.
function Get-PreservedEnvironment($Options, [string]$Source) {
    if (-not (Get-PreserveEnvironmentOption $Options) -or -not $Options.ReuseFolder) { return $null }
    $path = Join-Path $Options.ReuseFolder '.env'
    Assert-PlainPath $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    if ((Get-Item -LiteralPath $path -Force).Length -gt 1MB) { throw 'The existing .env is unexpectedly large. Review it before installing.' }
    if ($Options.Token -or $Options.ClientId -or $Options.GuildId) {
        throw 'Preserve .env keeps your existing file unchanged, so the entered token or IDs would not be used. Clear those fields, or turn off Preserve .env to create a new file.'
    }
    $bytes = [IO.File]::ReadAllBytes($path)
    $text = (New-Object Text.UTF8Encoding $false).GetString($bytes)
    Assert-PreservedDatabasePath $text
    if ($Options.RegisterCommands) {
        foreach ($key in @('DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID')) {
            if ($text -notmatch ('(?m)^[ \t]*(?:export[ \t]+)?' + $key + '[ \t]*=[ \t]*[^\s#]')) {
                throw "Registering commands needs $key, which the existing .env does not set. Add it to that file, or turn off command registration."
            }
        }
    }
    $examplePath = Join-Path $Source '.env.example'
    $example = ''
    if (Test-Path -LiteralPath $examplePath -PathType Leaf) { $example = [IO.File]::ReadAllText($examplePath) }
    return [pscustomobject]@{ Bytes = [byte[]](Add-NewEnvironmentKeys $bytes $example); Folder = [string]$Options.ReuseFolder }
}

function New-InstallEnvironment($Options) {
    $values = @{}
    foreach ($pair in @(@('DISCORD_TOKEN', $Options.Token), @('DISCORD_CLIENT_ID', $Options.ClientId), @('DISCORD_GUILD_ID', $Options.GuildId))) {
        if ($pair[1]) { $values[$pair[0]] = [string]$pair[1] }
    }
    if (-not $values.ContainsKey('DISCORD_TOKEN') -or [string]::IsNullOrWhiteSpace($values.DISCORD_TOKEN)) {
        throw 'Enter a bot token, or keep an existing installation with Preserve .env turned on.'
    }
    if ($values.DISCORD_TOKEN -match '^\d+$') { throw 'The bot token cannot be an application ID. Enter the secret token from the Bot page.' }
    if ($Options.RegisterCommands) {
        foreach ($key in @('DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID')) {
            if (-not $values.ContainsKey($key) -or $values[$key] -notmatch '^\d{15,22}$') {
                throw 'Application ID and server ID are required to register commands.'
            }
        }
    }
    $defaults = @{
        DATABASE_PATH = './data/bot.db'; CHECK_INTERVAL_MS = '300000'
        TWITCH_MOCK_DROPS = 'false'; KICK_MOCK_DROPS = 'false'
    }
    foreach ($key in $defaults.Keys) {
        if (-not $values.ContainsKey($key)) { $values[$key] = $defaults[$key] }
    }
    # The new installation always owns its own database, even when the old configuration used another filename.
    $values.DATABASE_PATH = './data/bot.db'
    $allowed = @('DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_GUILD_ID', 'DATABASE_PATH',
        'CHECK_INTERVAL_MS', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_MOCK_DROPS', 'KICK_MOCK_DROPS')
    $lines = @()
    foreach ($key in $allowed) {
        if (-not $values.ContainsKey($key)) { continue }
        if ([string]$values[$key] -match '[\r\n`"$]' -or [string]$values[$key] -match "'") {
            throw 'Configuration values cannot contain newlines, quotes, or dynamic expressions.'
        }
        $lines += $key + '="' + $values[$key] + '"'
    }
    return ($lines -join "`r`n") + "`r`n"
}

function Get-InstallationPlan {
    param($Options, [string]$Source, [string[]]$KnownFolders = @(), [switch]$DeepScan)
    $sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd('\')
    if (-not $Options.Destination -or $Options.Destination -notmatch '^[A-Za-z]:\\' -or
        $Options.Destination -match '["`$]') { throw 'Choose an absolute local installation folder without quote or expression characters.' }
    $destination = [IO.Path]::GetFullPath($Options.Destination).TrimEnd('\')
    Assert-PlainPath $destination
    if ($destination -eq $sourcePath -or (Test-ChildPath $sourcePath $destination) -or (Test-ChildPath $destination $sourcePath)) {
        throw 'Choose a destination outside the running setup folder.'
    }
    if ($destination -eq [IO.Path]::GetPathRoot($destination).TrimEnd('\') -or
        $destination -in @($env:USERPROFILE, $env:ProgramData, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:WINDIR)) {
        throw 'Choose a dedicated bot subfolder, not a shared or system folder.'
    }
    $manifest = Get-Content -LiteralPath (Join-Path $sourcePath 'package.json') -Raw | ConvertFrom-Json
    if ($manifest.name -ne 'rust-drops-reminder-bot') { throw 'Bundled bot files are missing or invalid.' }
    $scan = Find-WindowsBotInstallations -DeepScan:$DeepScan
    if ($scan.StartupIncomplete) { throw 'Startup scan is incomplete. Run setup as administrator and resolve scan warnings before installing.' }
    $candidates = @($scan.Folders + $KnownFolders | Select-Object -Unique)
    $plans = @()
    $preserved = @()
    $launcher = Join-Path $env:ProgramData 'RustDropsBot\start-rust-bot.ps1'
    $startup = Split-Path $launcher -Parent
    Assert-PlainPath $startup
    if (Test-Path -LiteralPath $startup) {
        foreach ($item in @(Get-ChildItem -LiteralPath $startup -Force)) {
            if ($item.Name -notin @('start-rust-bot.ps1', 'bot-out.log', 'bot-err.log')) {
                throw 'The shared bot launcher folder contains unrecognized files. Back them up and resolve them before installing.'
            }
            Assert-PlainPath $item.FullName
        }
    }
    $legacy = $null
    if (Test-Path -LiteralPath $launcher) { $legacy = Get-LauncherRepository $launcher }
    foreach ($folder in $candidates) {
        $folder = [IO.Path]::GetFullPath($folder).TrimEnd('\')
        if ($folder -eq $sourcePath) {
            Assert-SupportedBotRemoval -Scan $scan -Folder $folder -LegacyTask:($legacy -eq $folder)
            if (@($scan.Findings | Where-Object { $_.Folder -eq $folder -and $_.Kind -ne 'Running process' }).Count -gt 0) {
                throw 'This setup copy is itself configured to start the bot. Stop and remove its startup setup before installing from it.'
            }
            $preserved += $folder
            continue
        }
        if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw "A previously detected installation changed or disappeared: $folder. Scan again." }
        Assert-SupportedBotRemoval -Scan $scan -Folder $folder -LegacyTask:($legacy -eq $folder)
        Assert-RemovableFolder $folder $sourcePath
        $plans += Get-BotInstallation $folder -ManualFolder:($legacy -ne $folder)
    }
    # Unresolved references are blockers even when the target folder has disappeared.
    Assert-SupportedBotRemoval -Scan $scan -Folder '' -LegacyTask:([bool]$legacy)
    if ((Test-Path -LiteralPath $destination) -and
        @($plans | Where-Object { $_.Repository -eq $destination }).Count -eq 0 -and
        @(Get-ChildItem -LiteralPath $destination -Force).Count -gt 0) {
        throw 'The destination is not empty and is not a confirmed old bot installation.'
    }
    foreach ($old in $plans) {
        if ((Test-ChildPath $destination $old.Repository) -or (Test-ChildPath $old.Repository $destination)) {
            throw 'The destination and an old installation cannot be nested inside one another.'
        }
    }
    $preserveEnvironment = Get-PreserveEnvironmentOption $Options
    if ($Options.ReuseDatabase -and -not $Options.ReuseFolder) { throw 'Select an installation to reuse its database.' }
    if ($Options.ReuseFolder -and ($Options.ReuseDatabase -or $preserveEnvironment)) {
        if ($candidates -notcontains $Options.ReuseFolder) { throw 'Select a configuration/database source found by the scan.' }
        Assert-PlainPath $Options.ReuseFolder
        if ((Get-CommandBotFolder '' $Options.ReuseFolder) -ne $Options.ReuseFolder) { throw 'The reuse source is not a confirmed bot installation.' }
    }
    if ($Options.ReuseDatabase) {
        $paths = @(Get-BotDataPaths $Options.ReuseFolder)
        if (-not (Test-Path -LiteralPath $paths[1] -PathType Leaf)) { throw 'The selected installation has no database to reuse.' }
    }
    $preservedEnvironment = Get-PreservedEnvironment $Options $sourcePath
    $environment = $null
    if ($null -eq $preservedEnvironment) { $environment = New-InstallEnvironment $Options }
    # With Preserve off, every old .env is deleted without a recovery copy; list them for explicit confirmation.
    $discarded = @()
    if (-not $preserveEnvironment) {
        $discarded = @($plans | Where-Object { Test-Path -LiteralPath (Join-Path $_.Repository '.env') -PathType Leaf } |
            ForEach-Object { Join-Path $_.Repository '.env' })
    }
    return [pscustomobject]@{
        Source = $sourcePath; Destination = $destination; Removals = @($plans)
        Preserved = @($preserved); Environment = $environment; Options = $Options
        PreservedEnvironment = $preservedEnvironment; PreserveEnvironment = [bool]$preserveEnvironment
        DiscardedEnvironments = @($discarded)
        KnownFolders = @($candidates); ScanIssues = @($scan.Issues); DeepScan = [bool]$DeepScan
    }
}

function Copy-BundledBot([string]$Source, [string]$Destination) {
    foreach ($name in @('package.json', 'package-lock.json', 'tsconfig.json', 'src', 'LICENSE', 'README.md', '.env.example')) {
        $path = Join-Path $Source $name
        Assert-PlainPath $path
        if (-not (Test-Path -LiteralPath $path)) { throw "Bundled file missing: $name" }
        if (Test-Path -LiteralPath $path -PathType Container) {
            foreach ($item in @(Get-ChildItem -LiteralPath $path -Force -Recurse)) { Assert-PlainPath $item.FullName }
        }
        Copy-Item -LiteralPath $path -Destination $Destination -Recurse
    }
}

function Write-InstallLauncher([string]$Destination, $Tools) {
    $startup = Join-Path $env:ProgramData 'RustDropsBot'
    Assert-PlainPath $startup
    if (-not (Test-Path -LiteralPath $startup)) { New-Item -ItemType Directory -Path $startup | Out-Null }
    Set-PrivateInstallDirectory $startup
    $launcher = Join-Path $startup 'start-rust-bot.ps1'
    $nodeDirectory = Split-Path $Tools.Node -Parent
    $escaped = $nodeDirectory.Replace("'", "''")
    $content = @(
        '$ErrorActionPreference = "Stop"'
        "Set-Location `"$Destination`""
        "`$env:PATH = '$escaped;' + `$env:PATH"
        'foreach ($key in @("DISCORD_TOKEN","DISCORD_CLIENT_ID","DISCORD_GUILD_ID","DISCORD_PUBLIC_KEY","DATABASE_PATH","TWITCH_CLIENT_ID","TWITCH_CLIENT_SECRET","TWITCH_MOCK_DROPS","KICK_MOCK_DROPS","CHECK_INTERVAL_MS","LOG_LEVEL")) { [Environment]::SetEnvironmentVariable($key, $null, "Process") }'
        '$mutex = New-Object Threading.Mutex($false, "Local\RustDropsBot")'
        'if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }'
        'try {'
        '$updateModule = Join-Path (Get-Location) "src\installer\WindowsUpdate.psm1"'
        'if (Test-Path -LiteralPath $updateModule) {'
        'Import-Module $updateModule -Force'
        '$updateSettings = Get-UpdateSettings'
        'if ($updateSettings.Enabled) {'
        '$version = (Get-Content -LiteralPath ".\package.json" -Raw | ConvertFrom-Json).version'
        '$repository = (Get-Location).Path'
        '$updateScript = Join-Path (Get-Location) "src\installer\Invoke-Updater.ps1"'
        '$updateWork = Join-Path (Split-Path (Get-Location).Path -Parent) (".rust-drops-update-" + [guid]::NewGuid().ToString())'
        'Set-Location (Split-Path $repository -Parent)'
        '[Environment]::CurrentDirectory = (Get-Location).Path'
        '& (Join-Path $PSHOME "powershell.exe") -NoProfile -ExecutionPolicy Bypass -File $updateScript -Mode Bot -CurrentVersion $version -Repository $repository -WorkDirectory $updateWork'
        '$updateExitCode = $LASTEXITCODE'
        'Set-Location $repository'
        'if ($updateExitCode -eq 2) { throw "Update requires recovery or another update is running. See the updater log in LOCALAPPDATA\RustDropsBot-Updater." }'
        'if ($updateExitCode -ne 0) { Write-Warning "Update failed; starting the retained bot. See LOCALAPPDATA\RustDropsBot-Updater\updater.log." }'
        '}'
        '}'
        'npm run start 1>> "' + (Join-Path $startup 'bot-out.log') + '" 2>> "' + (Join-Path $startup 'bot-err.log') + '"'
        '$botExitCode = $LASTEXITCODE'
        '} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }'
        'exit $botExitCode'
    ) -join "`r`n"
    [IO.File]::WriteAllText($launcher, $content)
    return $launcher
}

function Register-InstallStartup([string]$Launcher) {
    if (@(Get-ScheduledTask | Where-Object { $_.TaskName -eq 'RustDropsBot' }).Count -gt 0) {
        throw 'A RustDropsBot task still exists. Refusing to overwrite it.'
    }
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
    Register-ScheduledTask -TaskName 'RustDropsBot' -Action $action -Trigger $trigger -Principal $principal -Settings $settings |
        Out-Null
}

function Get-InstallShortcutPaths($Options) {
    $paths = @()
    if ($Options.DesktopShortcut) { $paths += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Rust Drop Notifications Discord Bot.lnk' }
    if ($Options.StartMenuShortcut) { $paths += Join-Path ([Environment]::GetFolderPath('Programs')) 'Rust Drop Notifications Discord Bot.lnk' }
    return $paths
}

function New-InstallShortcuts([string]$Destination, [string]$Launcher, [string[]]$Paths) {
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($path in $Paths) {
            if (Test-Path -LiteralPath $path) { throw "Shortcut path is occupied: $path" }
            $parent = Split-Path $path -Parent
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
            $link = $shell.CreateShortcut($path)
            try {
                $link.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
                $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""
                $link.WorkingDirectory = $Destination
                $link.Description = 'Start Rust Drop Notifications Discord Bot'
                $link.Save()
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($link) }
        }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Start-InstalledBot([string]$Launcher, [bool]$Startup) {
    if ($Startup) {
        Start-ScheduledTask -TaskName 'RustDropsBot'
        Start-Sleep -Seconds 4
        if ((Get-ScheduledTask -TaskName 'RustDropsBot').State -ne 'Running') {
            throw 'Installation completed, but the bot task did not stay running. Check the launcher logs and credentials.'
        }
        return
    }
    $process = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`"" -PassThru
    Start-Sleep -Seconds 4
    $process.Refresh()
    if ($process.HasExited) { throw 'Installation completed, but the bot exited. Check launcher logs and credentials.' }
}

function Install-WindowsBot($Plan) {
    $result = Invoke-BotMaintenance { Install-WindowsBotCore $Plan }
    if ($Plan.Options.StartNow) {
        try { Start-InstalledBot (Join-Path $env:ProgramData 'RustDropsBot\start-rust-bot.ps1') $Plan.Options.RunOnLogon }
        catch { throw "$result`r`nStarting the installed bot failed: $($_.Exception.Message)" }
    }
    return $result
}

function Install-WindowsBotCore($Plan) {
    Assert-InstallAdministrator
    # Repeat discovery and all path checks immediately before any destructive action.
    $fresh = Get-InstallationPlan -Options $Plan.Options -Source $Plan.Source -KnownFolders $Plan.KnownFolders -DeepScan:$Plan.DeepScan
    $oldFolders = @($Plan.Removals | ForEach-Object { $_.Repository } | Sort-Object)
    $newFolders = @($fresh.Removals | ForEach-Object { $_.Repository } | Sort-Object)
    if (($oldFolders -join '|') -ne ($newFolders -join '|')) { throw 'Installations changed since confirmation. Review a fresh scan before installing.' }
    if ((Get-EnvironmentFingerprint $fresh) -cne (Get-EnvironmentFingerprint $Plan)) { throw 'Configuration changed since confirmation. Review installation settings again.' }
    if ([bool]$Plan.Options.RunOnLogon -or [bool]$Plan.Options.StartNow) {
        # The setup copy may be a source for reuse, but must not run a second bot alongside the new one.
        $processes = @(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -eq 'node.exe' -and [string]$_.CommandLine -match ('(?i)' + [regex]::Escape((Join-Path $fresh.Source 'dist\index.js')))
        })
        if ($processes.Count -gt 0) { throw 'Stop the bot running from the setup folder before installing another running copy.' }
    }
    foreach ($path in @(Get-InstallShortcutPaths $Plan.Options)) {
        if (Test-Path -LiteralPath $path) {
            $owner = @($fresh.Removals | Where-Object {
                $marker = Join-Path $_.Repository '.rust-drops-install.json'
                if (Test-Path -LiteralPath $marker) {
                    $metadata = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
                    $metadata.PSObject.Properties['Shortcuts'] -and $metadata.Shortcuts -contains $path
                }
            })
            if ($owner.Count -eq 0) { throw "An unrelated shortcut occupies: $path" }
        }
    }
    $tools = Get-InstallNodeTools $Plan.Options.AllowNodeInstall
    $work = Join-Path $env:LOCALAPPDATA ('RustDropsBot-Setup\' + [guid]::NewGuid().ToString())
    Assert-PlainPath $work
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Set-PrivateInstallDirectory $work
    $stage = Join-Path $work 'prepared'
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        Copy-BundledBot $fresh.Source $stage
        # Install scripts are skipped because npm would otherwise compile better-sqlite3 from source, which
        # fails without C++ build tools even though the package ships prebuilt binaries. ffmpeg-static is the
        # only dependency whose install step is needed at runtime, so just that step is run afterwards.
        Invoke-InstallCommand $tools.Npm @('ci', '--ignore-scripts', '--no-audit', '--no-fund') $stage 'Dependency installation'
        Invoke-InstallCommand $tools.Npm @('rebuild', 'ffmpeg-static') $stage 'Media tools installation'
        Invoke-InstallCommand $tools.Npm @('run', 'build') $stage 'Bot build'
        if (-not (Test-Path -LiteralPath (Join-Path $stage 'dist\index.js'))) { throw 'Build did not produce the bot entry point.' }
        $validation = Join-Path $stage 'src\installer\validateConfiguration.cjs'
        if ($null -ne $fresh.PreservedEnvironment) {
            [IO.File]::WriteAllBytes((Join-Path $stage '.env'), [byte[]]$fresh.PreservedEnvironment.Bytes)
        } else {
            [IO.File]::WriteAllText((Join-Path $stage '.env'), $fresh.Environment, (New-Object Text.UTF8Encoding $false))
        }
        Invoke-InstallCommand $tools.Node @($validation) $stage 'Configuration validation'
        if ($Plan.Options.RegisterCommands) {
            Invoke-InstallCommand $tools.Node @('dist\commands\registerCommands.js') $stage 'Discord command registration'
        }
        $reuseBackup = $null
        $index = 0
        foreach ($old in $fresh.Removals) {
            $backup = Join-Path $work ("old-data-" + $index)
            $null = Remove-BotInstallation -Plan $old -DeleteData $true -DeleteFolder $true `
                -BackupDataDirectory $backup -ProtectedRepository $fresh.Source `
                -SkipEnvironmentBackup:(-not $fresh.PreserveEnvironment)
            if ($old.Repository -eq $Plan.Options.ReuseFolder) { $reuseBackup = $backup }
            $index++
        }
        if ($Plan.Options.ReuseDatabase) {
            if (-not $reuseBackup) {
                # The running setup copy is never removed. SQLite's online backup API handles a live WAL database.
                $dataPaths = @(Get-BotDataPaths $Plan.Options.ReuseFolder)
                New-Item -ItemType Directory -Path (Join-Path $stage 'data') -Force | Out-Null
                Invoke-InstallCommand $tools.Node @((Join-Path $stage 'src\installer\backupDatabase.cjs'), $dataPaths[1], (Join-Path $stage 'data\bot.db')) $stage 'Database backup'
            } else {
                if (-not (Test-Path -LiteralPath (Join-Path $reuseBackup 'bot.db'))) {
                    throw 'The selected database disappeared before backup. Recovery files were kept; verify them before retrying.'
                }
                New-Item -ItemType Directory -Path (Join-Path $stage 'data') -Force | Out-Null
                foreach ($name in @('bot.db', 'bot.db-wal', 'bot.db-shm')) {
                    $path = Join-Path $reuseBackup $name
                    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $stage 'data') }
                }
            }
        }
        $parent = Split-Path $fresh.Destination -Parent
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if (Test-Path -LiteralPath $fresh.Destination) {
            if (@(Get-ChildItem -LiteralPath $fresh.Destination -Force).Count -gt 0) { throw 'Destination changed during installation. Prepared files and backups were preserved.' }
            Remove-Item -LiteralPath $fresh.Destination
        }
        Move-Item -LiteralPath $stage -Destination $fresh.Destination
        Set-PrivateInstallDirectory $fresh.Destination
        $launcher = Write-InstallLauncher $fresh.Destination $tools
        if ($Plan.Options.RunOnLogon) { Register-InstallStartup $launcher }
        $shortcuts = @(Get-InstallShortcutPaths $Plan.Options)
        [IO.File]::WriteAllText((Join-Path $fresh.Destination '.rust-drops-install.json'),
            ([ordered]@{ Version = 1; Shortcuts = $shortcuts } | ConvertTo-Json))
        New-InstallShortcuts $fresh.Destination $launcher $shortcuts
        Import-Module (Join-Path $PSScriptRoot 'WindowsUpdate.psm1') -Force
        $autoUpdates = $Plan.Options.PSObject.Properties['AutoUpdates'] -and [bool]$Plan.Options.AutoUpdates
        Set-UpdateSettings -Enabled $autoUpdates -Repository $fresh.Destination -PreserveEnvironment $fresh.PreserveEnvironment
        $environmentNote = 'The new .env keeps your previous file unchanged; any new options were added as commented-out lines.'
        if ($null -eq $fresh.PreservedEnvironment) { $environmentNote = 'A new .env was created from the values entered in setup.' }
        if (-not $fresh.PreserveEnvironment) { $environmentNote += ' Previous .env files were deleted without recovery copies.' }
        return "Installed to $($fresh.Destination).`r`n$environmentNote`r`nRun at user sign-in: $($Plan.Options.RunOnLogon).`r`nOld credentials/database backups (sensitive): $work`r`nThese backups are intentionally retained for recovery; remove them manually after verifying the new installation.`r`nA running process is not proof of Discord connectivity; check bot status and launcher logs."
    } catch {
        throw "Installation stopped: $($_.Exception.Message)`r`nRecovery/prepared files: $work`r`nSome prior steps may have completed. No automatic rollback is claimed. Backups may contain credentials; keep them private."
    }
}

Export-ModuleMember -Function Get-InstallationPlan, Install-WindowsBot, New-InstallEnvironment, Add-NewEnvironmentKeys
