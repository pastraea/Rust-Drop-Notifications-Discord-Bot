#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName System.Windows.Forms
Import-Module (Join-Path $PSScriptRoot 'WindowsUninstall.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'WindowsDiscovery.psm1') -Force
. (Join-Path $PSScriptRoot 'InstallScreen.ps1')
$protectedRepository = Split-Path $PSScriptRoot -Parent
$script:scan = $null
$script:worker = $null
$script:operation = $null
$script:stopRequest = $null
$script:openedEnvironmentCopies = @{}

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Rust Drops Bot Setup" Width="740" Height="520" MinWidth="700" MinHeight="480"
        WindowStartupLocation="CenterScreen" Background="#F5F6F8">
  <Grid Margin="28">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>
    <StackPanel>
      <TextBlock FontSize="26" FontWeight="SemiBold">Rust Drops Bot</TextBlock>
      <TextBlock Margin="0,6,0,22" Foreground="#555555">Check, install, or remove Rust Drops Bot.</TextBlock>
    </StackPanel>
    <UniformGrid Grid.Row="1" Columns="3" Margin="0,0,0,18">
      <Button x:Name="Check" Padding="8,14" Margin="0,0,8,0">Check installation</Button>
      <Button x:Name="Uninstall" Padding="8,14" Margin="0,0,8,0" ToolTip="Choose uninstall only or open the reinstall screen.">Uninstall / Reinstall</Button>
      <Button x:Name="Install" Padding="8,14" ToolTip="Choose an installation folder and settings.">Install</Button>
    </UniformGrid>
    <TextBlock x:Name="Status" Grid.Row="2" Margin="0,0,0,10" TextWrapping="Wrap">Ready. Check installation to search this computer.</TextBlock>
    <ComboBox x:Name="Installations" Grid.Row="3" Margin="0,0,0,12" Visibility="Collapsed"/>
    <TextBox x:Name="Report" Grid.Row="4" IsReadOnly="True" TextWrapping="Wrap" BorderBrush="#DDDDDD"
             Padding="10" VerticalScrollBarVisibility="Auto"
             Text="Checking does not change your computer. Installation options are reviewed before any changes."/>
    <Expander Grid.Row="5" Header="More options" Margin="0,16,0,0">
      <StackPanel Margin="0,10,0,0">
        <CheckBox x:Name="DeepScan" Margin="0,0,0,8">Deep scan all local fixed drives (may take a long time)</CheckBox>
        <CheckBox x:Name="OpenEnvironment" Margin="0,0,0,8" IsChecked="False"
                  ToolTip="Opens the selected installation's .env as an editable, unsaved copy. It may contain secret tokens. The original is not changed.">Open a found .env as an unsaved text copy (contains secrets)</CheckBox>
        <Button x:Name="Browse" HorizontalAlignment="Left" Padding="10,5">Check a specific folder...</Button>
      </StackPanel>
    </Expander>
  </Grid>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$reader.Close()
$controls = @{}
foreach ($name in @('Check', 'Install', 'Uninstall', 'Status', 'Installations', 'Report', 'DeepScan', 'OpenEnvironment', 'Browse')) {
    $controls[$name] = $window.FindName($name)
}

function Set-Busy([bool]$Busy) {
    $controls.Check.IsEnabled = -not $Busy -or $script:operation -eq 'scan'
    $controls.Check.Content = 'Check installation'
    if ($Busy -and $script:operation -eq 'scan') { $controls.Check.Content = 'Cancel scan' }
    $controls.Browse.IsEnabled = -not $Busy
    $controls.DeepScan.IsEnabled = -not $Busy
    $controls.OpenEnvironment.IsEnabled = -not $Busy
    $controls.Installations.IsEnabled = -not $Busy
    $controls.Install.IsEnabled = -not $Busy
    $controls.Uninstall.IsEnabled = -not $Busy
}

function Start-BackgroundOperation([scriptblock]$Code, [object[]]$Arguments, [string]$Operation) {
    $script:worker = [PowerShell]::Create()
    [void]$script:worker.AddScript($Code.ToString())
    foreach ($argument in $Arguments) { [void]$script:worker.AddArgument($argument) }
    $script:operation = $Operation
    Set-Busy $true
    $script:pending = $script:worker.BeginInvoke()
    $timer.Start()
}

function New-EnvironmentCopyWindow([string]$Path) {
    $copyWindow = New-Object Windows.Window
    $copyWindow.Title = 'Unsaved .env copy - ' + (Split-Path $Path -Parent)
    $copyWindow.Width = 760
    $copyWindow.Height = 540
    if ($window.IsLoaded) { $copyWindow.Owner = $window }
    $copyWindow.WindowStartupLocation = 'CenterOwner'
    $panel = New-Object Windows.Controls.DockPanel
    $panel.Margin = New-Object Windows.Thickness 16
    $notice = New-Object Windows.Controls.TextBlock
    $notice.Text = "Unsaved copy - contains credentials. Changes do not affect the original.`r`nCopy any text you want to keep before closing; closing discards this copy."
    $notice.TextWrapping = 'Wrap'
    $notice.Margin = New-Object Windows.Thickness 0,0,0,12
    [Windows.Controls.DockPanel]::SetDock($notice, 'Top')
    [void]$panel.Children.Add($notice)
    $editor = New-Object Windows.Controls.TextBox
    $editor.Name = 'EnvironmentText'
    $editor.AcceptsReturn = $true
    $editor.AcceptsTab = $true
    $editor.VerticalScrollBarVisibility = 'Auto'
    $editor.HorizontalScrollBarVisibility = 'Auto'
    $editor.FontFamily = New-Object Windows.Media.FontFamily 'Consolas'
    $editor.Text = [IO.File]::ReadAllText($Path)
    [void]$panel.Children.Add($editor)
    $copyWindow.Content = $panel
    return $copyWindow
}

function Open-EnvironmentCopyWindow([string]$Path) {
    $copyWindow = New-EnvironmentCopyWindow $Path
    $copyWindow.Show()
}

function Show-SelectedEnvironmentCopy {
    if (-not $controls.OpenEnvironment.IsChecked -or $null -eq $script:scan -or
        $null -eq $controls.Installations.SelectedItem) { return }
    $folder = [string]$controls.Installations.SelectedItem
    if ($script:scan.Folders -notcontains $folder) { return }
    $envPath = Join-Path $folder '.env'
    if ($script:openedEnvironmentCopies.ContainsKey($envPath)) { return }
    try {
        if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
            $controls.Report.AppendText("`r`nNo .env file was found in the selected installation.")
            return
        }
        # Never follow a replaced installation or credential-file junction after discovery.
        $current = Get-Item -LiteralPath $envPath -Force
        while ($null -ne $current) {
            if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Linked credential paths are not supported.'
            }
            if ($current -is [IO.FileInfo]) { $current = $current.Directory }
            else { $current = $current.Parent }
        }
        if ((Get-CommandBotFolder '' $folder) -ne $folder) {
            throw 'The selected folder is no longer a confirmed installation.'
        }
        Open-EnvironmentCopyWindow $envPath
        $script:openedEnvironmentCopies[$envPath] = $true
    } catch {
        # Do not put file contents or arbitrary parser errors into the scan report.
        $controls.Report.AppendText("`r`nThe .env copy could not be opened. Check read permissions, folder identity, and whether the path is a link. The original was not changed.")
    }
}

function Show-Discovery($Scan) {
    $script:scan = $Scan
    $script:openedEnvironmentCopies = @{}
    $controls.Installations.Items.Clear()
    foreach ($folder in $Scan.Folders) { [void]$controls.Installations.Items.Add($folder) }
    $controls.Installations.Visibility = 'Collapsed'
    if ($Scan.Folders.Count -gt 0) {
        $controls.Installations.Visibility = 'Visible'
        $controls.Installations.SelectedIndex = 0
    }
    $controls.Status.Text = "$($Scan.Folders.Count) confirmed folder(s); $($Scan.Findings.Count) startup/process reference(s)."
    $lines = @()
    foreach ($finding in $Scan.Findings) {
        $lines += "$($finding.Kind): $($finding.Location)"
        if ($finding.Folder) { $lines += "  Installation: $($finding.Folder)" }
        else { $lines += '  Possible bot reference; target could not be confirmed. Manual inspection required.' }
    }
    if ($Scan.Folders.Count -eq 0 -and $Scan.Findings.Count -eq 0) {
        $lines += 'No installation found in the locations checked. Use More options for a deep scan or a specific folder.'
    }
    $lines += @('', 'Select an installation above, then choose Uninstall / Reinstall to review removal options.',
        'Automatic removal currently supports the original scheduled-task setup and inactive folders. Other startup mechanisms are reported for manual cleanup.',
        '', "Scan coverage: $($Scan.Scope)",
        'Common folder search: up to four subfolder levels. Deep scan searches local fixed drives without a depth limit. Links and dependency/system metadata folders are not traversed.')
    if ($Scan.Issues.Count -gt 0) {
        $controls.Status.Text += " Scan incomplete: $($Scan.Issues.Count) location(s) need attention."
        $lines += @('', 'Locations not fully checked (try running as administrator where appropriate):') + $Scan.Issues
    }
    $controls.Report.Text = $lines -join "`r`n"
    Show-SelectedEnvironmentCopy
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
    if (-not $script:pending.IsCompleted) { return }
    $timer.Stop()
    try {
        $output = @($script:worker.EndInvoke($script:pending))
        if ($script:worker.Streams.Error.Count -gt 0) { throw $script:worker.Streams.Error[0] }
        if ($script:operation -eq 'scan') {
            Show-Discovery $output[-1]
        } elseif ($script:operation -eq 'installScan') {
            Show-Discovery $output[-1]
            $script:openSetupAfterScan = $true
        } elseif ($script:operation -eq 'prepareInstall') {
            $script:preparedInstall = $output[-1]
            $script:confirmSetupAfterScan = $true
        } elseif ($script:operation -eq 'install') {
            $controls.Status.Text = 'Installation finished.'
            $controls.Report.Text = $output -join "`r`n"
            $controls.Installations.Items.Clear()
            $script:scan = $null
        } else {
            $controls.Status.Text = 'Removal finished. Check installation again to review remaining items.'
            $controls.Report.Text = $output -join "`r`n"
            $controls.Installations.Items.Clear()
            $script:scan = $null
        }
    } catch {
        $controls.Status.Text = 'Operation stopped.'
        $controls.Report.Text = "$($_.Exception.Message)"
        if ($script:operation -eq 'scan') {
            $controls.Report.Text += "`r`nNo files or startup settings were changed."
        } else {
            $controls.Report.Text += "`r`nSome removal steps may already have completed. Check again before retrying."
        }
        $controls.Installations.Items.Clear()
        $script:scan = $null
    } finally {
        try {
            if ($null -ne $script:stopRequest) { $script:worker.EndStop($script:stopRequest) }
        } finally {
            $script:stopRequest = $null
            $script:worker.Dispose()
            $script:worker = $null
            Set-Busy $false
        }
    }
    if ($script:openSetupAfterScan) {
        $script:openSetupAfterScan = $false
        Show-InstallOptions
    }
    if ($script:confirmSetupAfterScan) {
        $script:confirmSetupAfterScan = $false
        Confirm-InstallPlan $script:preparedInstall
        $script:preparedInstall = $null
    }
})
$script:openSetupAfterScan = $false
$script:confirmSetupAfterScan = $false
$script:preparedInstall = $null

function Show-InstallOptions {
    $folders = @()
    if ($null -ne $script:scan) { $folders = @($script:scan.Folders) }
    $options = Show-InstallScreen $folders
    if ($null -eq $options) { return }
    $controls.Status.Text = 'Checking installation settings and scanning before removal...'
    Start-BackgroundOperation {
        param($Module, $Options, $Source, $Known, $Deep)
        $ErrorActionPreference = 'Stop'
        Import-Module $Module -Force
        Get-InstallationPlan -Options $Options -Source $Source -KnownFolders $Known -DeepScan:$Deep
    } @((Join-Path $PSScriptRoot 'WindowsInstall.psm1'), $options, $protectedRepository, $folders, [bool]$controls.DeepScan.IsChecked) 'prepareInstall'
}

function Confirm-InstallPlan($Plan) {
    $paths = @($Plan.Removals | ForEach-Object { $_.Repository })
    $details = "Install to: $($Plan.Destination)`r`n`r`nPermanently remove these old installations and their data:"
    if ($paths.Count -eq 0) { $details += "`r`nNone." }
    else { $details += "`r`n" + ($paths -join "`r`n") }
    $details += "`r`n`r`nThe running setup folder is preserved. Private recovery copies of old credentials/databases will be kept."
    $details += "`r`nRun at sign-in: $($Plan.Options.RunOnLogon); start now: $($Plan.Options.StartNow)."
    if ($Plan.Options.RegisterCommands) { $details += "`r`nDiscord slash commands will be updated for the selected server." }
    if ($Plan.Options.AllowNodeInstall) { $details += "`r`nNode.js LTS may be downloaded/installed if required." }
    if ($Plan.ScanIssues.Count -gt 0) { $details += "`r`n`r`nFolder scan warnings (not all locations were readable):`r`n" + ($Plan.ScanIssues -join "`r`n") }
    if ([Windows.MessageBox]::Show($window, "$details`r`n`r`nProceed?", 'Confirm installation', 'YesNo', 'Warning', 'No') -ne 'Yes') {
        $controls.Status.Text = 'Installation cancelled. No installation changes were made.'
        return
    }
    $controls.Status.Text = 'Preparing files, then removing confirmed old installations and installing...'
    Start-BackgroundOperation {
        param($Module, $Plan)
        $ErrorActionPreference = 'Stop'
        Import-Module $Module -Force
        Install-WindowsBot $Plan
    } @((Join-Path $PSScriptRoot 'WindowsInstall.psm1'), $Plan) 'install'
}

$controls.Install.Add_Click({
    if ($null -ne $script:scan) { Show-InstallOptions; return }
    $controls.Status.Text = 'Checking existing installations before opening setup...'
    Start-BackgroundOperation {
        param($Module, $Deep)
        $ErrorActionPreference = 'Stop'
        Import-Module $Module -Force
        Find-WindowsBotInstallations -DeepScan:$Deep
    } @((Join-Path $PSScriptRoot 'WindowsDiscovery.psm1'), [bool]$controls.DeepScan.IsChecked) 'installScan'
})
$controls.Installations.Add_SelectionChanged({
    if ($null -eq $script:worker) {
        Set-Busy $false
        Show-SelectedEnvironmentCopy
    }
})
$controls.OpenEnvironment.Add_Checked({
    if ($null -eq $script:worker) { Show-SelectedEnvironmentCopy }
})
$controls.Check.Add_Click({
    if ($null -ne $script:worker) {
        $controls.Status.Text = 'Cancelling scan...'
        $script:stopRequest = $script:worker.BeginStop($null, $null)
        $controls.Check.IsEnabled = $false
        return
    }
    $controls.Status.Text = 'Checking Windows startup locations and installation folders...'
    $controls.Report.Text = 'This is read-only. The window stays responsive while the scan runs.'
    $controls.Installations.Items.Clear()
    Start-BackgroundOperation {
        param($Module, $Deep)
        $ErrorActionPreference = 'Stop'
        Import-Module $Module -Force
        Find-WindowsBotInstallations -DeepScan:$Deep
    } @((Join-Path $PSScriptRoot 'WindowsDiscovery.psm1'), [bool]$controls.DeepScan.IsChecked) 'scan'
})
$controls.Browse.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    try {
        if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
        $folder = $dialog.SelectedPath
        Start-BackgroundOperation {
            param($Module, $Folder)
            $ErrorActionPreference = 'Stop'
            Import-Module $Module -Force
            $scan = Find-WindowsBotInstallations -StartupOnly
            $issues = New-Object 'Collections.Generic.List[string]'
            $confirmed = @(Find-BotFolders -Roots @($Folder) -MaxDepth 0 -Issues $issues)
            if ($issues.Count -gt 0) { throw ($issues -join "`r`n") }
            if ($confirmed.Count -eq 0) { throw 'The selected folder is not a confirmed Rust Drops Bot installation.' }
            $scan.Folders = $confirmed
            $scan
        } @((Join-Path $PSScriptRoot 'WindowsDiscovery.psm1'), $folder) 'scan'
    } finally { $dialog.Dispose() }
})
$controls.Uninstall.Add_Click({
    $choice = [Windows.MessageBox]::Show($window,
        'Choose Yes to reinstall with a new folder and settings. Choose No to uninstall only. Cancel makes no changes.',
        'Uninstall / Reinstall', 'YesNoCancel', 'Question', 'Cancel')
    if ($choice -eq 'Cancel') { return }
    if ($choice -eq 'Yes') {
        $controls.Install.RaiseEvent((New-Object Windows.RoutedEventArgs ([Windows.Controls.Button]::ClickEvent)))
        return
    }
    if ($null -eq $controls.Installations.SelectedItem) {
        $controls.Status.Text = 'Run Check installation and select an installation before uninstalling.'
        return
    }
    $folder = [string]$controls.Installations.SelectedItem
    $answer = [Windows.MessageBox]::Show($window,
        "Remove the bot's supported startup setup for this installation?`r`n`r`n$folder`r`n`r`nKeep credentials and database?",
        'Uninstall - data options', 'YesNoCancel', 'Question', 'Cancel')
    if ($answer -eq 'Cancel') { return }
    $deleteData = $answer -eq 'No'
    $deleteFolder = $false
    if ($deleteData) {
        $answer = [Windows.MessageBox]::Show($window,
            "Also permanently delete the installation folder and all its contents?`r`n`r`n$folder`r`n`r`nChoose No to delete only credentials/database and supported startup setup.",
            'Uninstall - folder options', 'YesNoCancel', 'Warning', 'Cancel')
        if ($answer -eq 'Cancel') { return }
        $deleteFolder = $answer -eq 'Yes'
    }
    try {
        # Recheck startup references before offering final confirmation; never trust scan-time state.
        $scan = Find-WindowsBotInstallations -StartupOnly
        $legacyLauncher = Join-Path $env:ProgramData 'RustDropsBot\start-rust-bot.ps1'
        $legacy = $null
        if (Test-Path -LiteralPath $legacyLauncher) { $legacy = Get-LauncherRepository $legacyLauncher }
        $manual = $legacy -ne $folder
        Assert-SupportedBotRemoval -Scan $scan -Folder $folder -LegacyTask:(-not $manual)
        $plan = Get-BotInstallation $folder -ManualFolder:$manual
        if ($deleteFolder) { Assert-RemovableFolder $folder $protectedRepository }
        $details = "Installation: $folder`r`nDelete credentials/database: $deleteData`r`nDelete installation folder: $deleteFolder"
        if ($deleteData) { $details += "`r`nData files:`r`n" + ($plan.DataPaths -join "`r`n") }
        $confirm = [Windows.MessageBox]::Show($window, "$details`r`n`r`nProceed? This cannot be undone.",
            'Confirm uninstall', 'YesNo', 'Warning', 'No')
        if ($confirm -ne 'Yes') { return }
        $controls.Status.Text = 'Removing selected installation...'
        Start-BackgroundOperation {
            param($Module, $Plan, $Data, $Folder, $Protected)
            $ErrorActionPreference = 'Stop'
            Import-Module $Module -Force
            Remove-BotInstallation -Plan $Plan -DeleteData $Data -DeleteFolder $Folder -ProtectedRepository $Protected
        } @((Join-Path $PSScriptRoot 'WindowsUninstall.psm1'), $plan, $deleteData, $deleteFolder, $protectedRepository) 'remove'
    } catch {
        $controls.Report.Text = "Removal not started: $($_.Exception.Message)"
    }
})
$window.Add_Closing({
    param($sender, $eventArgs)
    if ($null -ne $script:worker) {
        $eventArgs.Cancel = $true
        if ($script:operation -eq 'scan') {
            if ($null -eq $script:stopRequest) { $script:stopRequest = $script:worker.BeginStop($null, $null) }
            $controls.Status.Text = 'Cancelling scan. Close the window once cancellation finishes.'
        } else {
            $controls.Status.Text = 'Please wait for removal to finish before closing.'
        }
    }
})
try { [void]$window.ShowDialog() } finally { $timer.Stop() }
