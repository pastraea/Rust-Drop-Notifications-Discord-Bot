using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Rust Drop Notifications Discord Bot Setup")]
[assembly: AssemblyProduct("Rust Drop Notifications Discord Bot")]
[assembly: AssemblyCompany("studio bijou")]

internal static class SetupLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string workspace = null;
        int exitCode = 0;
        using (var mutex = new Mutex(false, @"Local\RustDropNotificationsDiscordBotSetup"))
        {
            bool acquired = false;
            try
            {
                if (args.Length > 1 || (args.Length == 1 && args[0] != "--verify-package"))
                    throw new ArgumentException("Unsupported setup argument.");
                try { acquired = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired)
                    throw new InvalidOperationException("The setup window is already open. Close it before starting another copy.");

                workspace = Path.Combine(Path.GetTempPath(), "RustDropNotificationsSetup-" + Guid.NewGuid().ToString("N"));
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                foreach (var sid in new[] {
                    WindowsIdentity.GetCurrent().User,
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) })
                    security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                        PropagationFlags.None, AccessControlType.Allow));
                Directory.CreateDirectory(workspace, security);
                using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("BotPayload"))
                {
                    if (resource == null) throw new InvalidDataException("The embedded setup package is missing.");
                    using (var archive = new ZipArchive(resource, ZipArchiveMode.Read))
                    {
                        foreach (var entry in archive.Entries)
                        {
                            string target = Path.GetFullPath(Path.Combine(workspace, entry.FullName));
                            if (!target.StartsWith(workspace + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                                throw new InvalidDataException("The embedded package contains an invalid path.");
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            if (entry.Name.Length > 0)
                                using (var input = entry.Open())
                                using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write))
                                    input.CopyTo(output);
                        }
                    }
                }
                string script = Path.Combine(workspace, @"src\installer\Start-Installer.ps1");
                foreach (string required in new[] {
                    @"src\installer\Start-Installer.ps1", @"src\installer\InstallScreen.ps1",
                    @"src\installer\WindowsInstall.psm1", @"src\installer\WindowsUninstall.psm1",
                    @"src\installer\WindowsDiscovery.psm1", @"src\installer\backupDatabase.cjs",
                    @"src\installer\validateConfiguration.cjs", "package.json", "package-lock.json",
                    "tsconfig.json", @"src\index.ts", ".env.example", "LICENSE", "README.md" })
                    if (!File.Exists(Path.Combine(workspace, required)))
                        throw new InvalidDataException("The embedded setup package is incomplete: " + required);

                if (args.Length == 0)
                {
                    string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                        @"WindowsPowerShell\v1.0\powershell.exe");
                    var start = new ProcessStartInfo(powershell,
                        "-NoProfile -STA -ExecutionPolicy Bypass -File \"" + script + "\"");
                    start.UseShellExecute = false;
                    start.CreateNoWindow = true;
                    start.WorkingDirectory = workspace;
                    using (var process = Process.Start(start))
                    {
                        process.WaitForExit();
                        if (process.ExitCode != 0)
                            throw new InvalidOperationException("The setup window stopped unexpectedly (exit " +
                                process.ExitCode + "). Verify Windows PowerShell 5.1 and .NET Framework are available.");
                    }
                }
            }
            catch (Exception error)
            {
                exitCode = 1;
                MessageBox.Show(error.Message, "Rust Drop Notifications Discord Bot Setup",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (workspace != null && Directory.Exists(workspace))
                {
                    try { Directory.Delete(workspace, true); }
                    catch (Exception error)
                    {
                        exitCode = 1;
                        MessageBox.Show("Temporary setup files could not be removed. Remove this specific folder after closing setup:\r\n" +
                            workspace + "\r\n" + error.Message, "Setup cleanup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                }
                if (acquired) mutex.ReleaseMutex();
            }
        }
        return exitCode;
    }
}
