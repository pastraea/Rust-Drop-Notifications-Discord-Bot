Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-NormalizedPath([string]$Path) {
    return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path)).TrimEnd('\')
}

function Test-ChildPath([string]$Path, [string]$Parent) {
    $full = Get-NormalizedPath $Path
    $root = Get-NormalizedPath $Parent
    return $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-PlainPath([string]$Path) {
    $current = Get-NormalizedPath $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a symbolic link or junction: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Get-LauncherRepository([string]$ScriptPath) {
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { return $null }
    Assert-PlainPath $ScriptPath
    $content = Get-Content -LiteralPath $ScriptPath -Raw
    $match = [regex]::Match($content, '(?im)^\s*Set-Location\s+"([^"\r\n]+)"\s*$')
    if (-not $match.Success -or $content -notmatch '(?im)^\s*npm(?:\.cmd)?\s+run\s+start\b') {
        throw "The launcher is not the recognized RustDropsBot setup. No removal is allowed."
    }
    return Get-NormalizedPath $match.Groups[1].Value
}

function Get-BotDataPaths([string]$Repository) {
    $database = Join-Path $Repository 'data\bot.db'
    $envPath = Join-Path $Repository '.env'
    if (Test-Path -LiteralPath $envPath -PathType Leaf) {
        Assert-PlainPath $envPath
        $lines = @(Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*(?:export\s+)?DATABASE_PATH\s*=' })
        if ($lines.Count -gt 1) { throw "Multiple DATABASE_PATH entries; resolve them before uninstalling." }
        if ($lines.Count -eq 1) {
            $value = ($lines[0] -replace '^\s*(?:export\s+)?DATABASE_PATH\s*=\s*', '').Trim()
            if ($value.StartsWith('"') -or $value.StartsWith("'")) {
                $quote = $value.Substring(0, 1)
                $end = $value.IndexOf($quote, 1)
                if ($end -lt 1 -or $value.Substring($end + 1).Trim() -notmatch '^(#.*)?$') {
                    throw "Unsupported DATABASE_PATH quoting; no removal is allowed."
                }
                $value = $value.Substring(1, $end - 1)
            } else {
                $value = ($value -split '#', 2)[0].Trim()
            }
            if (-not $value -or $value.Contains('$') -or $value.Contains('`')) {
                throw "Empty or dynamic DATABASE_PATH; no removal is allowed."
            }
            if ([IO.Path]::IsPathRooted($value)) { $database = $value }
            else { $database = Join-Path $Repository $value }
        }
    }
    $database = Get-NormalizedPath $database
    if (-not (Test-ChildPath $database $Repository)) {
        throw "The database is outside the installation: $database. Move or back it up and update DATABASE_PATH before uninstalling."
    }
    if ([IO.Path]::GetExtension($database) -notin @('.db', '.sqlite', '.sqlite3')) {
        throw "DATABASE_PATH must identify a .db, .sqlite, or .sqlite3 file before automatic data removal is supported."
    }
    foreach ($path in @($database, "$database-wal", "$database-shm", $envPath)) {
        Assert-PlainPath $path
    }
    return @($envPath, $database, "$database-wal", "$database-shm")
}

function Get-BotProcesses([string]$Repository, [string]$Launcher, [switch]$IgnoreLauncher) {
    $all = @(Get-CimInstance Win32_Process)
    $selected = @{}
    foreach ($process in $all) {
        $command = [string]$process.CommandLine
        $launcherCommand = -not $IgnoreLauncher -and $process.Name -match '^(powershell|pwsh)\.exe$' -and
            $command -match ('(?i)(?:^|\s)-File\s+"?' + [regex]::Escape($Launcher) + '"?(?=\s|$)')
        $entryPath = Join-Path $Repository 'dist\index.js'
        $nodeCommand = $process.Name -eq 'node.exe' -and
            $command -match ('(?i)(?:^|[\s"])' + [regex]::Escape($entryPath) + '(?=["\s]|$)')
        if ($launcherCommand -or $nodeCommand) { $selected[[int]$process.ProcessId] = $process }
    }
    do {
        $count = $selected.Count
        foreach ($process in $all) {
            if ($selected.ContainsKey([int]$process.ParentProcessId)) {
                $selected[[int]$process.ProcessId] = $process
            }
        }
    } while ($selected.Count -gt $count)
    return @($selected.Values)
}

function Get-BotInstallation([string]$Repository, [switch]$ManualFolder) {
    $startup = Join-Path $env:ProgramData 'RustDropsBot'
    $launcher = Join-Path $startup 'start-rust-bot.ps1'
    Assert-PlainPath $startup
    $tasks = @()
    if (-not $ManualFolder) { $tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -eq 'RustDropsBot' }) }
    if ($tasks.Count -gt 1) { throw "Multiple RustDropsBot tasks found. Resolve the ambiguity before uninstalling." }
    $detectedRepo = $null
    if (-not $ManualFolder) { $detectedRepo = Get-LauncherRepository $launcher }
    if ($tasks.Count -eq 1) {
        $actions = @($tasks[0].Actions)
        if ($actions.Count -ne 1 -or
            [IO.Path]::GetFileName($actions[0].Execute) -notmatch '^(powershell|pwsh)(\.exe)?$' -or
            $actions[0].Arguments -notmatch ('(?i)-File\s+"?' + [regex]::Escape($launcher) + '"?\s*$')) {
            throw "RustDropsBot task has an unrecognized action. It will not be removed."
        }
        if (-not $detectedRepo) { throw "The task exists but its launcher is missing. Restore or inspect it manually." }
    }
    if ($Repository) {
        $Repository = Get-NormalizedPath $Repository
        if ($detectedRepo -and $Repository -ne $detectedRepo) {
            throw "Selected folder differs from the task's installation: $detectedRepo"
        }
    } else { $Repository = $detectedRepo }
    if (-not $Repository) {
        return [pscustomobject]@{
            Repository = ''; FolderExists = $false; Task = $null
            Launcher = $launcher; Startup = $startup
            DataPaths = @(); Processes = @(); Found = $false
        }
    }
    Assert-PlainPath $Repository
    $exists = Test-Path -LiteralPath $Repository -PathType Container
    if ($exists) {
        $manifest = Join-Path $Repository 'package.json'
        Assert-PlainPath $manifest
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Not a recognized bot folder: package.json missing." }
        $package = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if ($package.name -ne 'rust-drops-reminder-bot') { throw "Not a Rust Drops bot installation." }
    }
    $task = $null
    if ($tasks.Count -eq 1) { $task = $tasks[0] }
    return [pscustomobject]@{
        Repository = $Repository
        FolderExists = $exists
        Task = $task
        Launcher = $launcher
        Startup = $startup
        DataPaths = @(Get-BotDataPaths $Repository)
        Processes = @(Get-BotProcesses $Repository $launcher -IgnoreLauncher:$ManualFolder)
        Found = ($exists -or $null -ne $task -or (-not $ManualFolder -and (Test-Path -LiteralPath $launcher)))
        ManualFolder = [bool]$ManualFolder
    }
}

function Assert-RemovableFolder([string]$Repository, [string]$ProtectedRepository) {
    $root = Get-NormalizedPath $Repository
    $protected = Get-NormalizedPath $ProtectedRepository
    if ($root -eq $protected -or (Test-ChildPath $protected $root)) {
        throw "Cannot delete the running installer or its working installation folder."
    }
    $protectedRoots = @($env:USERPROFILE, $env:ProgramData, $env:WINDIR, $env:ProgramFiles,
        ${env:ProgramFiles(x86)}, [IO.Path]::GetPathRoot($root))
    foreach ($path in $protectedRoots) {
        if ($path -and $root -eq (Get-NormalizedPath $path)) { throw "Protected folder: $root" }
    }
    if (Test-Path -LiteralPath (Join-Path $root '.git')) {
        throw "This development folder is protected. Back up your changes and remove it manually."
    }
    Assert-PlainPath $root
    $allowed = @('node_modules', 'dist', 'src', 'docs', '.github', 'data', 'coverage', 'installer',
        '.env', '.env.example', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json',
        'README.md', 'CHANGELOG.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'VERSIONING.md',
        '.rust-drops-install.json')
    foreach ($item in @(Get-ChildItem -LiteralPath $root -Force)) {
        if ($allowed -notcontains $item.Name) { throw "Unrecognized content must be backed up or removed first: $($item.FullName)" }
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $root -Force -Recurse)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Folder contains a symbolic link or junction: $($item.FullName)"
        }
    }
}

function Remove-BotInstallation {
    param(
        [Parameter(Mandatory)]$Plan,
        [bool]$DeleteData,
        [bool]$DeleteFolder,
        [string]$BackupDataDirectory,
        [Parameter(Mandatory)][string]$ProtectedRepository
    )
    if ($DeleteFolder -and -not $DeleteData) { throw "Deleting the installation folder also requires consent to delete data." }
    if (-not $Plan.Found -or -not $Plan.Repository) { throw "No recognized installation was selected." }
    if ($DeleteFolder) { Assert-RemovableFolder $Plan.Repository $ProtectedRepository }
    $manual = $false
    if ($Plan.PSObject.Properties['ManualFolder']) { $manual = $Plan.ManualFolder }
    $fresh = Get-BotInstallation $Plan.Repository -ManualFolder:$manual
    $startupScan = Get-RemovalStartupScan
    Assert-SupportedBotRemoval -Scan $startupScan -Folder $fresh.Repository -LegacyTask:(-not $manual)
    $matchedIds = @($fresh.Processes | ForEach-Object { $_.ProcessId })
    foreach ($reference in @($startupScan.Findings | Where-Object { $_.Kind -eq 'Running process' -and $_.Folder -eq $fresh.Repository })) {
        if ($reference.Location -notmatch '^PID (\d+)$' -or [int]$Matches[1] -notin $matchedIds) {
            throw "A process references this installation but cannot be stopped safely: $($reference.Location). Close it manually and check again."
        }
    }
    $ambiguous = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.ProcessId -notin $matchedIds -and
        [string]$_.CommandLine -match '(?i)(?:^|[\s"])(?:\.\\|\.\/)?(?:dist[\\/]+index\.js|src[\\/]+index\.ts)(?=["\s]|$)'
    })
    if ($ambiguous.Count -gt 0) {
        throw "Relative-path bot processes cannot be attributed safely (PIDs: $(($ambiguous.ProcessId) -join ', ')). Close those bot terminals or stop their service manager, then check again. No removal was started."
    }
    $identity = {
        param($Installation)
        if ($null -eq $Installation.Task) { return '' }
        return ($Installation.Task.TaskPath + $Installation.Task.TaskName + '|' +
            $Installation.Task.Actions[0].Execute + '|' + $Installation.Task.Actions[0].Arguments)
    }
    if ((& $identity $fresh) -ne (& $identity $Plan)) {
        throw "Startup task changed since the check. Check the installation again."
    }
    if (($fresh.DataPaths -join '|') -ne ($Plan.DataPaths -join '|')) {
        throw "Configuration changed since the check. Check the installation again."
    }
    if ($null -ne $fresh.Task) {
        # Disable first so the task cannot restart a process during removal.
        Disable-ScheduledTask -TaskName $fresh.Task.TaskName -TaskPath $fresh.Task.TaskPath | Out-Null
    }
    $processes = @($fresh.Processes)
    if ($null -ne $fresh.Task) {
        Stop-ScheduledTask -TaskName $fresh.Task.TaskName -TaskPath $fresh.Task.TaskPath
    }
    foreach ($process in $processes) {
        $running = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)"
        if ($null -ne $running -and $running.CreationDate -eq $process.CreationDate) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        }
    }
    foreach ($process in $processes) {
        $running = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)"
        if ($null -ne $running -and $running.CreationDate -eq $process.CreationDate) {
            throw "Process $($process.ProcessId) is still stopping. Check the installation again before removing files."
        }
    }
    if ($null -ne $fresh.Task) {
        Unregister-ScheduledTask -TaskName $fresh.Task.TaskName -TaskPath $fresh.Task.TaskPath -Confirm:$false
    }
    if ($BackupDataDirectory) {
        Assert-PlainPath $BackupDataDirectory
        if (Test-Path -LiteralPath $BackupDataDirectory) { throw "Data backup destination already exists." }
        New-Item -ItemType Directory -Path $BackupDataDirectory | Out-Null
        $names = @('.env', 'bot.db', 'bot.db-wal', 'bot.db-shm')
        for ($index = 0; $index -lt $fresh.DataPaths.Count; $index++) {
            $file = $fresh.DataPaths[$index]
            Assert-PlainPath $file
            if (Test-Path -LiteralPath $file -PathType Leaf) {
                Copy-Item -LiteralPath $file -Destination (Join-Path $BackupDataDirectory $names[$index])
            }
        }
    }
    Remove-BotOwnedShortcuts $fresh.Repository
    $launcherFiles = @()
    if (-not $manual) { $launcherFiles = @($fresh.Launcher, (Join-Path $fresh.Startup 'bot-out.log'), (Join-Path $fresh.Startup 'bot-err.log')) }
    foreach ($file in $launcherFiles) {
        Assert-PlainPath $file
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
    }
    if (-not $manual -and (Test-Path -LiteralPath $fresh.Startup) -and
        @(Get-ChildItem -LiteralPath $fresh.Startup -Force).Count -eq 0) {
        Remove-Item -LiteralPath $fresh.Startup
    }
    if ($DeleteData) {
        foreach ($file in $fresh.DataPaths) {
            Assert-PlainPath $file
            if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
        }
    }
    if ($DeleteFolder -and $fresh.FolderExists) {
        Assert-RemovableFolder $fresh.Repository $ProtectedRepository
        # Only the inspected, named children are recursively removed, never the root itself.
        foreach ($item in @(Get-ChildItem -LiteralPath $fresh.Repository -Force)) {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
        Remove-Item -LiteralPath $fresh.Repository
    }
    $remaining = @(Get-BotProcesses $fresh.Repository $fresh.Launcher -IgnoreLauncher:$manual)
    if ($remaining.Count -gt 0) { throw "Bot processes remain. No successful uninstall can be confirmed." }
    if (-not $manual -and @(Get-ScheduledTask | Where-Object { $_.TaskName -eq 'RustDropsBot' }).Count -gt 0) {
        throw "A RustDropsBot startup task remains."
    }
    return "Removal finished for the selected installation. Node.js, npm, other applications, and Discord settings were not changed. Run Check installation again to review remaining copies or startup references."
}

function Remove-BotOwnedShortcuts([string]$Repository) {
    $marker = Join-Path $Repository '.rust-drops-install.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return }
    Assert-PlainPath $marker
    $metadata = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if (-not $metadata.PSObject.Properties['Shortcuts']) { return }
    $allowed = @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Rust Drops Bot.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'Rust Drops Bot.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Rust Drop Notifications Discord Bot.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'Rust Drop Notifications Discord Bot.lnk')
    )
    foreach ($path in @($metadata.Shortcuts)) {
        if ($allowed -notcontains $path) { throw "Unrecognized shortcut path in installation metadata." }
        Assert-PlainPath $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $shell = New-Object -ComObject WScript.Shell
        try {
            $link = $shell.CreateShortcut($path)
            try {
                $launcher = Join-Path $env:ProgramData 'RustDropsBot\start-rust-bot.ps1'
                if ($link.WorkingDirectory -ne $Repository -or
                    $link.Arguments -notmatch ('(?i)-File\s+"' + [regex]::Escape($launcher) + '"\s*$')) {
                    throw "Shortcut no longer belongs to this installation: $path"
                }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($link) }
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
        Remove-Item -LiteralPath $path -Force
    }
}

function Get-RemovalStartupScan {
    Import-Module (Join-Path $PSScriptRoot 'WindowsDiscovery.psm1') -Force
    Find-WindowsBotInstallations -StartupOnly
}

Import-Module (Join-Path $PSScriptRoot 'WindowsDiscovery.psm1') -Force
Export-ModuleMember -Function Get-BotInstallation, Remove-BotInstallation, Assert-RemovableFolder, Get-LauncherRepository, Get-BotDataPaths, Test-ChildPath, Assert-PlainPath
