#Requires -Version 5.1
param(
    [Parameter(Mandatory)][ValidateSet('Setup', 'Bot')][string]$Mode,
    [Parameter(Mandatory)][string]$CurrentVersion,
    [Parameter(Mandatory)][string]$WorkDirectory,
    [string]$Repository = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WindowsUpdate.psm1') -Force
$mutex = New-Object Threading.Mutex($false, 'Local\RustDropNotificationsUpdater')
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Another update is in progress. Wait until it finishes and launch again.' }
    $settings = Get-UpdateSettings
    if (-not $settings.Enabled) { exit 0 }
    if ($Mode -eq 'Bot' -and $settings.Repository -ine $Repository) { throw 'Updater installation identity does not match this bot.' }
    $release = Get-StableUpdate $CurrentVersion
    if ($null -eq $release) { Write-UpdateLog "$Mode is current ($CurrentVersion)."; exit 0 }
    $install = Import-Module (Join-Path $PSScriptRoot 'WindowsInstall.psm1') -PassThru
    & $install { param($Path) Assert-PlainPath $Path } $WorkDirectory
    New-Item -ItemType Directory -Path $WorkDirectory -Force | Out-Null
    & $install { param($Path) Set-PrivateInstallDirectory $Path } $WorkDirectory
    $executable = Save-VerifiedUpdate $release $WorkDirectory
    if ($Mode -eq 'Setup') {
        Write-UpdateLog "Verified newer setup $($release.Version)."
        Write-Output $executable
    } else {
        Update-InstalledBot $Repository $WorkDirectory $release $executable
    }
} catch {
    Write-UpdateLog "$Mode update failed. $($_.Exception.Message)"
    if ($_.Exception.Data.Contains('StopLaunch')) { exit 2 }
    if (-not $acquired) { exit 2 }
    exit 1
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
