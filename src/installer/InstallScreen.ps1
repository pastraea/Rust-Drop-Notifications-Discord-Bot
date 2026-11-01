function New-InstallScreen([Windows.Window]$Owner, [string[]]$Folders) {
    [xml]$markup = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Install Rust Drop Notifications Discord Bot" Width="720" Height="760" MinWidth="650" MinHeight="620"
        WindowStartupLocation="CenterOwner" Background="#F5F6F8">
  <Grid Margin="24">
    <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <StackPanel Margin="0,0,0,16">
      <TextBlock FontSize="24" FontWeight="SemiBold">Install / Reinstall</TextBlock>
      <TextBlock Margin="0,8,0,0" TextWrapping="Wrap">Choose settings, then Install. A fresh scan and removal review run before changes. Cancel leaves the computer unchanged.</TextBlock>
    </StackPanel>
    <ScrollViewer Grid.Row="1" VerticalScrollBarVisibility="Auto">
      <StackPanel Margin="0,0,12,0">
        <TextBlock Margin="0,0,0,6">Installation folder</TextBlock>
        <DockPanel Margin="0,0,0,16">
          <Button x:Name="BrowseDestination" DockPanel.Dock="Right" Padding="12,4" Margin="8,0,0,0">Browse...</Button>
          <TextBox x:Name="Destination" Padding="5"/>
        </DockPanel>
        <TextBlock Margin="0,0,0,6">Existing installation to reuse (optional)</TextBlock>
        <ComboBox x:Name="ReuseFolder" Margin="0,0,0,8"/>
        <CheckBox x:Name="PreserveEnvironment" Margin="0,0,0,8" IsChecked="True"
                  ToolTip="Keeps the selected installation's .env exactly as it is, byte for byte, and only appends new options as commented-out lines. Turn off to delete the old .env with NO backup and create a new one from the fields below.">Preserve my existing .env exactly (recommended)</CheckBox>
        <TextBlock x:Name="PreserveNote" Margin="22,0,0,8" TextWrapping="Wrap" Foreground="#555555"/>
        <CheckBox x:Name="ReuseDatabase" Margin="0,0,0,16">Reuse selected installation's database and preferences</CheckBox>
        <TextBlock Margin="0,0,0,6">Bot token (secret)</TextBlock>
        <PasswordBox x:Name="Token" Padding="5" Margin="0,0,0,10"/>
        <TextBlock Margin="0,0,0,6">Application ID</TextBlock>
        <TextBox x:Name="ClientId" Padding="5" Margin="0,0,0,10"/>
        <TextBlock Margin="0,0,0,6">Discord server ID</TextBlock>
        <TextBox x:Name="GuildId" Padding="5" Margin="0,0,0,16"/>
        <CheckBox x:Name="RunOnLogon" Margin="0,0,0,8" IsChecked="True">Run when this Windows user signs in (not before sign-in)</CheckBox>
        <CheckBox x:Name="StartNow" Margin="0,0,0,8" IsChecked="True">Start the bot after installation</CheckBox>
        <CheckBox x:Name="RegisterCommands" Margin="0,0,0,8" IsChecked="True">Register Discord slash commands (updates the selected server)</CheckBox>
        <CheckBox x:Name="DesktopShortcut" Margin="0,0,0,8">Create a desktop shortcut to start the bot</CheckBox>
        <CheckBox x:Name="StartMenuShortcut" Margin="0,0,0,8">Create a Start menu shortcut to start the bot</CheckBox>
        <CheckBox x:Name="AutoUpdates" Margin="0,0,0,8" IsChecked="False"
                  ToolTip="Checks once when setup or the installed bot opens. Downloads stable releases from this project's GitHub repository. May delay startup; no periodic polling.">Automatically update setup and the bot on launch (opt in)</CheckBox>
        <CheckBox x:Name="AllowNodeInstall" Margin="0,0,0,16">Download/install Node.js LTS with Windows App Installer if missing or incompatible</CheckBox>
        <TextBlock TextWrapping="Wrap" Foreground="#555555">Requires administrator permissions and internet access. Node.js installation may show a Windows consent prompt. Old supported installations will be removed only after a separate confirmation. The running setup folder is preserved. Old database recovery copies are retained privately; the old .env is kept or deleted according to the Preserve setting above.</TextBlock>
      </StackPanel>
    </ScrollViewer>
    <StackPanel Grid.Row="2" Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,20,0,0">
      <Button x:Name="Cancel" Padding="24,8" Margin="0,0,12,0" IsCancel="True">Cancel</Button>
      <Button x:Name="ConfirmInstall" Padding="24,8" IsDefault="True">Install</Button>
    </StackPanel>
  </Grid>
</Window>
'@
    $reader = New-Object System.Xml.XmlNodeReader $markup
    try { $dialog = [Windows.Markup.XamlReader]::Load($reader) } finally { $reader.Close() }
    if ($Owner.IsLoaded) { $dialog.Owner = $Owner }
    $dialog.FindName('Destination').Text = Join-Path $env:LOCALAPPDATA 'RustDropsBot'
    foreach ($folder in $Folders) { [void]$dialog.FindName('ReuseFolder').Items.Add($folder) }
    if ($Folders.Count -gt 0) { $dialog.FindName('ReuseFolder').SelectedIndex = 0 }
    else { $dialog.FindName('ReuseDatabase').IsEnabled = $false }
    # The saved preference is the default; a missing or unreadable setting keeps the safe choice (preserve).
    $preserveDefault = $true
    try { $preserveDefault = [bool](Get-UpdateSettings).PreserveEnvironment } catch { $preserveDefault = $true }
    $dialog.FindName('PreserveEnvironment').IsChecked = $preserveDefault
    # Entered credentials only apply to a newly created .env, so they are locked while an existing file is preserved.
    $refreshPreserve = {
        $selected = [string]$dialog.FindName('ReuseFolder').SelectedItem
        $hasExisting = $false
        if ($selected) { $hasExisting = Test-Path -LiteralPath (Join-Path $selected '.env') -PathType Leaf }
        $preserve = [bool]$dialog.FindName('PreserveEnvironment').IsChecked
        $locked = $preserve -and $hasExisting
        foreach ($name in @('Token', 'ClientId', 'GuildId')) { $dialog.FindName($name).IsEnabled = -not $locked }
        $note = $dialog.FindName('PreserveNote')
        if ($locked) { $note.Text = 'The existing .env will be kept unchanged. New options are added as commented-out lines. The token and ID fields below are not used.' }
        elseif (-not $preserve -and $hasExisting) { $note.Text = 'WARNING: the existing .env will be permanently deleted with no backup. Enter new credentials below.' }
        else { $note.Text = 'No existing .env was found for the selected installation. A new one is created from the fields below.' }
    }.GetNewClosure()
    $dialog.FindName('PreserveEnvironment').Add_Click($refreshPreserve)
    $dialog.FindName('ReuseFolder').Add_SelectionChanged($refreshPreserve)
    & $refreshPreserve
    $dialog.FindName('BrowseDestination').Add_Click({
        $picker = New-Object System.Windows.Forms.FolderBrowserDialog
        try {
            if ($picker.ShowDialog() -eq 'OK') {
                $dialog.FindName('Destination').Text = Join-Path $picker.SelectedPath 'RustDropsBot'
            }
        } finally { $picker.Dispose() }
    }.GetNewClosure())
    $dialog.FindName('ConfirmInstall').Add_Click({
        $dialog.Tag = [pscustomobject]@{
            Destination = $dialog.FindName('Destination').Text.Trim()
            Token = $(if ($dialog.FindName('Token').IsEnabled) { $dialog.FindName('Token').Password } else { '' })
            ClientId = $(if ($dialog.FindName('ClientId').IsEnabled) { $dialog.FindName('ClientId').Text.Trim() } else { '' })
            GuildId = $(if ($dialog.FindName('GuildId').IsEnabled) { $dialog.FindName('GuildId').Text.Trim() } else { '' })
            ReuseFolder = [string]$dialog.FindName('ReuseFolder').SelectedItem
            PreserveEnvironment = [bool]$dialog.FindName('PreserveEnvironment').IsChecked
            ReuseDatabase = [bool]$dialog.FindName('ReuseDatabase').IsChecked
            RunOnLogon = [bool]$dialog.FindName('RunOnLogon').IsChecked
            StartNow = [bool]$dialog.FindName('StartNow').IsChecked
            RegisterCommands = [bool]$dialog.FindName('RegisterCommands').IsChecked
            DesktopShortcut = [bool]$dialog.FindName('DesktopShortcut').IsChecked
            StartMenuShortcut = [bool]$dialog.FindName('StartMenuShortcut').IsChecked
            AllowNodeInstall = [bool]$dialog.FindName('AllowNodeInstall').IsChecked
            AutoUpdates = [bool]$dialog.FindName('AutoUpdates').IsChecked
        }
        $dialog.DialogResult = $true
    }.GetNewClosure())
    return $dialog
}

function Show-InstallScreen([string[]]$Folders) {
    $dialog = New-InstallScreen $window $Folders
    try {
        if ($dialog.ShowDialog()) { return $dialog.Tag }
        return $null
    } finally {
        $dialog.FindName('Token').Clear()
        $dialog.Tag = $null
    }
}
