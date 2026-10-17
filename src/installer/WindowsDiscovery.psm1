Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ConfirmedBotFolder([string]$Path) {
    if (-not $Path -or -not [IO.Path]::IsPathRooted($Path)) { return $null }
    $current = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
    for ($level = 0; $level -lt 5 -and $current; $level++) {
        $manifest = Join-Path $current 'package.json'
        if (Test-Path -LiteralPath $manifest -PathType Leaf) {
            $package = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
            if ($package.PSObject.Properties['name'] -and $package.name -eq 'rust-drops-reminder-bot') {
                return $current.TrimEnd('\')
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $null
}

function Get-CommandBotFolder([string]$Command, [string]$WorkingDirectory = '') {
    if ($WorkingDirectory) {
        $folder = Get-ConfirmedBotFolder $WorkingDirectory
        if ($folder) { return $folder }
    }
    foreach ($match in [regex]::Matches($Command, '"([^"]+)"|([A-Za-z]:\\[^\s"]+)')) {
        $path = $match.Groups[1].Value
        if (-not $path) { $path = $match.Groups[2].Value }
        # Quoted arguments can contain URLs, JSON, or command fragments rather than file paths.
        if ($path -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\?]+\\)' -or
            $path.IndexOfAny([IO.Path]::GetInvalidPathChars()) -ge 0 -or
            $path -match '[*?]' -or $path.Substring(2).Contains(':')) { continue }
        $folder = Get-ConfirmedBotFolder $path
        if ($folder) { return $folder }
        if ([IO.Path]::GetExtension($path) -eq '.ps1' -and (Test-Path -LiteralPath $path -PathType Leaf)) {
            # Read only: never execute a discovered launcher.
            $text = Get-Content -LiteralPath $path -Raw
            $location = [regex]::Match($text, '(?im)^\s*Set-Location\s+"([^"\r\n]+)"\s*$')
            if ($location.Success) {
                $folder = Get-ConfirmedBotFolder $location.Groups[1].Value
                if ($folder) { return $folder }
            }
        }
    }
    return $null
}

function Get-WindowsStartupEntries {
    param([Collections.Generic.List[string]]$Issues)
    $legacyLauncher = Join-Path $env:ProgramData 'RustDropsBot\start-rust-bot.ps1'
    try {
        if (Test-Path -LiteralPath $legacyLauncher -PathType Leaf) {
            [pscustomobject]@{
                Kind = 'Launcher'; Location = $legacyLauncher
                Command = '"' + $legacyLauncher + '"'; WorkingDirectory = ''
            }
        }
    } catch { $Issues.Add('The original bot launcher could not be inspected.') }
    try {
        foreach ($task in @(Get-ScheduledTask)) {
            foreach ($action in @($task.Actions)) {
                if (-not $action.PSObject.Properties['Execute']) { continue }
                $working = ''
                if ($action.PSObject.Properties['WorkingDirectory']) { $working = [string]$action.WorkingDirectory }
                [pscustomobject]@{
                    Kind = 'Scheduled task'; Location = $task.TaskPath + $task.TaskName
                    Command = "$($action.Execute) $($action.Arguments)"; WorkingDirectory = $working
                }
            }
        }
    } catch { $Issues.Add("Scheduled tasks could not be fully read: $($_.Exception.Message)") }
    try {
        foreach ($service in @(Get-CimInstance Win32_Service)) {
            [pscustomobject]@{
                Kind = 'Windows service'; Location = $service.Name
                Command = [string]$service.PathName; WorkingDirectory = ''
            }
            # NSSM keeps its actual application and working directory outside the service image path.
            $parameters = "Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\$($service.Name)\Parameters"
            try {
                if (Test-Path -LiteralPath $parameters) {
                    $values = Get-ItemProperty -LiteralPath $parameters
                    if ($values.PSObject.Properties['Application']) {
                        $working = ''
                        $arguments = ''
                        if ($values.PSObject.Properties['AppDirectory']) { $working = [string]$values.AppDirectory }
                        if ($values.PSObject.Properties['AppParameters']) { $arguments = [string]$values.AppParameters }
                        [pscustomobject]@{
                            Kind = 'Service launcher'; Location = $service.Name
                            Command = "$($values.Application) $arguments"; WorkingDirectory = $working
                        }
                    }
                }
            } catch { $Issues.Add("Service launcher settings could not be read: $($service.Name)") }
        }
    } catch { $Issues.Add("Windows services could not be fully read: $($_.Exception.Message)") }
    $hives = @('Registry::HKEY_LOCAL_MACHINE', 'Registry::HKEY_CURRENT_USER')
    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    try {
        $hives += @(Get-ChildItem 'Registry::HKEY_USERS' | Where-Object { $_.PSChildName -match '^S-1-5-21-[\d-]+$' -and $_.PSChildName -ne $currentUserSid } |
            ForEach-Object { 'Registry::HKEY_USERS\' + $_.PSChildName })
    } catch { $Issues.Add("Loaded user startup settings could not be read: $($_.Exception.Message)") }
    foreach ($hive in $hives) {
        foreach ($key in @('Software\Microsoft\Windows\CurrentVersion\Run', 'Software\Microsoft\Windows\CurrentVersion\RunOnce',
            'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run', 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce')) {
            $path = "$hive\$key"
            try {
                if (-not (Test-Path -LiteralPath $path)) { continue }
                $registry = Get-Item -LiteralPath $path
                foreach ($name in $registry.GetValueNames()) {
                    [pscustomobject]@{
                        Kind = 'Registry startup'; Location = "$path\$name"
                        Command = [string]$registry.GetValue($name); WorkingDirectory = ''
                    }
                }
            } catch { $Issues.Add("Startup registry location could not be read: $path") }
        }
    }
    $startupFolders = @([Environment]::GetFolderPath('CommonStartup'))
    try {
        foreach ($profile in @(Get-CimInstance Win32_UserProfile)) {
            if ($profile.LocalPath) {
                $startupFolders += Join-Path $profile.LocalPath 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
            }
        }
    } catch { $Issues.Add("User profile startup folders could not be enumerated: $($_.Exception.Message)") }
    foreach ($folder in @($startupFolders | Select-Object -Unique)) {
        if (-not $folder) { continue }
        try {
            if (-not (Test-Path -LiteralPath $folder)) { continue }
            foreach ($file in @(Get-ChildItem -LiteralPath $folder -File -Force)) {
                $command = $file.FullName
                $working = ''
                if ($file.Extension -eq '.lnk') {
                    $shell = New-Object -ComObject WScript.Shell
                    try {
                        $link = $shell.CreateShortcut($file.FullName)
                        try {
                            $command = '"' + $link.TargetPath + '" ' + $link.Arguments
                            $working = $link.WorkingDirectory
                        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($link) }
                    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
                } elseif ($file.Extension -in @('.cmd', '.bat', '.ps1', '.vbs')) {
                    $command = Get-Content -LiteralPath $file.FullName -Raw
                }
                [pscustomobject]@{
                    Kind = 'Startup folder'; Location = $file.FullName
                    Command = $command; WorkingDirectory = $working
                }
            }
        } catch { $Issues.Add("Startup folder could not be fully read: $folder") }
    }
    try {
        foreach ($process in @(Get-CimInstance Win32_Process)) {
            [pscustomobject]@{
                Kind = 'Running process'; Location = "PID $($process.ProcessId)"
                Command = [string]$process.CommandLine; WorkingDirectory = ''
            }
        }
    } catch { $Issues.Add("Running processes could not be read: $($_.Exception.Message)") }
}

function Get-BotSearchRoots([bool]$DeepScan) {
    if ($DeepScan) {
        return @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | ForEach-Object { $_.DeviceID + '\' })
    }
    $roots = @($env:ProgramData, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA,
        $env:APPDATA, $env:USERPROFILE)
    foreach ($profile in @(Get-CimInstance Win32_UserProfile)) {
        if ($profile.LocalPath) { $roots += $profile.LocalPath }
    }
    return @($roots | Where-Object { $_ } | Select-Object -Unique)
}

function Find-BotFolders {
    param(
        [string[]]$Roots, [int]$MaxDepth,
        [Collections.Generic.List[string]]$Issues
    )
    $queue = New-Object 'Collections.Generic.Queue[object]'
    $seen = @{}
    foreach ($root in $Roots) { $queue.Enqueue(@($root, 0)) }
    while ($queue.Count -gt 0) {
        $next = $queue.Dequeue()
        $path = [string]$next[0]
        $depth = [int]$next[1]
        if ($seen.ContainsKey($path)) { continue }
        $seen[$path] = $true
        try {
            if (-not (Test-Path -LiteralPath $path -PathType Container)) { continue }
            $directory = Get-Item -LiteralPath $path -Force
            if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                $Issues.Add("Link or junction not followed: $path")
                continue
            }
            $manifest = Join-Path $path 'package.json'
            if (Test-Path -LiteralPath $manifest -PathType Leaf) {
                $package = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
                if ($package.PSObject.Properties['name'] -and $package.name -eq 'rust-drops-reminder-bot') {
                    $path
                    continue
                }
            }
            if ($depth -ge $MaxDepth) { continue }
            foreach ($child in @(Get-ChildItem -LiteralPath $path -Directory -Force)) {
                if ($child.Name -in @('node_modules', '.git', '$Recycle.Bin', 'System Volume Information')) { continue }
                $queue.Enqueue(@($child.FullName, ($depth + 1)))
            }
        } catch { $Issues.Add("Folder could not be fully checked: $path ($($_.Exception.Message))") }
    }
}

function Find-WindowsBotInstallations {
    param([switch]$DeepScan, [switch]$StartupOnly)
    $issues = New-Object 'Collections.Generic.List[string]'
    $findings = New-Object 'Collections.Generic.List[object]'
    $folders = @{}
    $entries = @(Get-WindowsStartupEntries -Issues $issues)
    foreach ($entry in $entries) {
        try {
            $folder = Get-CommandBotFolder $entry.Command $entry.WorkingDirectory
            if ($folder -or ($entry.Location + ' ' + $entry.Command) -match '(?i)RustDropsBot|Rust-Drop-Notifications-Discord-Bot|start-rust-bot|rust-drops-reminder-bot') {
                if ($folder) { $folders[$folder] = $true }
                $findings.Add([pscustomobject]@{ Kind = $entry.Kind; Location = $entry.Location; Folder = $folder })
            }
        } catch { $issues.Add("Could not identify target of $($entry.Kind): $($entry.Location)") }
    }
    $startupIssueCount = $issues.Count
    if (-not $StartupOnly) {
        try {
            $depth = 4
            if ($DeepScan) { $depth = [int]::MaxValue }
            foreach ($folder in @(Find-BotFolders -Roots (Get-BotSearchRoots ([bool]$DeepScan)) -MaxDepth $depth -Issues $issues)) {
                $folders[$folder] = $true
            }
        } catch { $issues.Add("Search roots could not be enumerated: $($_.Exception.Message)") }
    }
    return [pscustomobject]@{
        Folders = @($folders.Keys | Sort-Object)
        Findings = @($findings.ToArray())
        Issues = @($issues.ToArray())
        StartupIncomplete = ($startupIssueCount -gt 0)
        DeepScan = [bool]$DeepScan
        Scope = 'Tasks, services/NSSM, loaded-user and machine Run/RunOnce keys, profile Startup folders, running processes, and local folders. Unloaded user registry hives, remote drives, container contents, and custom service-manager state are not inspected.'
    }
}

function Assert-SupportedBotRemoval {
    param($Scan, [string]$Folder, [bool]$LegacyTask)
    if ($Scan.StartupIncomplete) {
        throw 'Startup checks are incomplete. Run as administrator and resolve the reported scan issues before removal.'
    }
    $blockers = @($Scan.Findings | Where-Object {
        $_.Kind -ne 'Running process' -and
        (-not $_.Folder -or $_.Folder -eq $Folder) -and
        -not ($LegacyTask -and (
            ($_.Kind -eq 'Scheduled task' -and $_.Location -eq '\RustDropsBot') -or
            ($_.Kind -eq 'Launcher' -and $_.Location -eq (Join-Path $env:ProgramData 'RustDropsBot\start-rust-bot.ps1'))
        ))
    })
    if ($blockers.Count -gt 0) {
        throw ("Other startup entries need manual removal before automatic uninstall:`r`n" +
            (($blockers | ForEach-Object { "$($_.Kind): $($_.Location)" }) -join "`r`n"))
    }
}

Export-ModuleMember -Function Find-WindowsBotInstallations, Find-BotFolders, Get-CommandBotFolder, Assert-SupportedBotRemoval
