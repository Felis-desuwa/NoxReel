using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyCompany("NoxReel")]
[assembly: AssemblyProduct("NoxReel")]
[assembly: AssemblyCopyright("Copyright © NoxReel contributors")]
[assembly: AssemblyVersion("0.6.2.0")]
[assembly: AssemblyFileVersion("0.6.2.0")]
#if SIGNAL_SERVER
[assembly: AssemblyTitle("NoxReel Signaling Server")]
[assembly: AssemblyDescription("NoxReel signaling server launcher")]
#else
[assembly: AssemblyTitle("NoxReel")]
[assembly: AssemblyDescription("NoxReel desktop launcher")]
#endif

internal static class NoxReelLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        try
        {
            string executable = Assembly.GetExecutingAssembly().Location;
            string root = Path.GetDirectoryName(executable);
#if SIGNAL_SERVER
            string scriptName = "launch-signal.ps1";
            string displayName = "NoxReel 信令服务器";
#else
            string scriptName = "launch.ps1";
            string displayName = "NoxReel";
#endif
            string script = Path.Combine(root, "scripts", scriptName);
            if (!File.Exists(script))
            {
#if !SIGNAL_SERVER
                string installed = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs", "NoxReel", "NoxReel.exe");
                if (File.Exists(installed) && !String.Equals(installed, executable, StringComparison.OrdinalIgnoreCase))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = installed,
                        Arguments = JoinArguments(args),
                        WorkingDirectory = Path.GetDirectoryName(installed),
                        UseShellExecute = true,
                    });
                    return 0;
                }
#endif
                MessageBox.Show(
                    "启动文件不完整，且没有找到已经安装的 NoxReel。\n\n缺少：\n" + script,
                    displayName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 2;
            }

            string powerShell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(powerShell)) powerShell = "powershell.exe";

            // Used by automated verification without opening Electron or the server.
            // It still launches a real PowerShell child, so process creation is covered.
            if (args.Length == 1 && args[0] == "--self-test")
            {
                if (!File.Exists(script) || (powerShell != "powershell.exe" && !File.Exists(powerShell))) return 3;
                var probeStart = new ProcessStartInfo
                {
                    FileName = powerShell,
                    Arguments = "-NoLogo -NoProfile -Command \"exit 0\"",
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (Process probe = Process.Start(probeStart))
                {
                    if (probe == null) return 4;
                    probe.WaitForExit();
                    return probe.ExitCode;
                }
            }

            var command = new List<string>
            {
                "-NoLogo",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script,
            };
            command.AddRange(args);

            var start = new ProcessStartInfo
            {
                FileName = powerShell,
                Arguments = JoinArguments(command),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = false,
            };

            using (Process process = Process.Start(start))
            {
                if (process == null) throw new InvalidOperationException("无法创建启动进程");
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "无法启动 NoxReel：\n\n" + error.Message,
                "NoxReel",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string JoinArguments(IEnumerable<string> values)
    {
        var result = new StringBuilder();
        foreach (string value in values)
        {
            if (result.Length > 0) result.Append(' ');
            result.Append(QuoteArgument(value ?? string.Empty));
        }
        return result.ToString();
    }

    // Windows CommandLineToArgvW compatible quoting. This keeps paths and future
    // command-line options intact even when they contain spaces or quotation marks.
    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;

        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                output.Append('\\', slashes * 2 + 1);
                output.Append('"');
                slashes = 0;
                continue;
            }
            output.Append('\\', slashes);
            slashes = 0;
            output.Append(character);
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }
}
