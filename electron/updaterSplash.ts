import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { escapeXmlText, formatTemplate, getDefaultString } from "../shared/strings/engine.ts";

export interface UpdaterSplashStrings {
  windowTitle?: string;
  brandLine?: string;
  headline?: string;
  extractingMessage?: string;
  footerSafety?: string;
}

export interface UpdaterSplashOptions {
  targetVersion: string;
  darkMode?: boolean;
  themePreset?: string;
  serverPort?: number;
  oldProcessId?: number;
  strings?: UpdaterSplashStrings;
}

function safePsXamlText(value: string): string {
  return escapeXmlText(value).replace(/`/g, "``").replace(/\$/g, "`$");
}

export function launchStandaloneUpdaterSplash(opts: UpdaterSplashOptions): string {
  const version = (opts.targetVersion || "").replace(/^v/i, "").trim();
  const isDark = Boolean(opts.darkMode);
  const theme = opts.themePreset || "default";
  const port = opts.serverPort || 4747;
  const oldPid = opts.oldProcessId || process.pid;

  let accent = isDark ? "#F97316" : "#EA580C";
  let surface = isDark ? "#1E293B" : "#FFF7ED";
  let surfaceBorder = isDark ? "#334155" : "#FED7AA";
  if (theme === "classic-blue") {
    accent = isDark ? "#60A5FA" : "#1D4ED8";
    surface = isDark ? "#1E293B" : "#EFF6FF";
    surfaceBorder = isDark ? "#334155" : "#BFDBFE";
  } else if (theme === "forest-green") {
    accent = isDark ? "#34D399" : "#047857";
    surface = isDark ? "#1E293B" : "#ECFDF5";
    surfaceBorder = isDark ? "#334155" : "#A7F3D0";
  }

  const bg = isDark ? "#0F172A" : "#FFFFFF";
  const border = isDark ? "#334155" : "#E2E8F0";
  const text = isDark ? "#F8FAFC" : "#1E293B";
  const textMuted = isDark ? "#94A3B8" : "#64748B";
  const progressBg = isDark ? "#334155" : "#E2E8F0";

  const windowTitle = safePsXamlText(
    opts.strings?.windowTitle || getDefaultString("updater.splashWindowTitle")
  );
  const brandLine = safePsXamlText(
    opts.strings?.brandLine || getDefaultString("updater.splashBrandLine")
  );
  const defaultHeadline = version
    ? formatTemplate(getDefaultString("updater.splashHeadline"), { version })
    : getDefaultString("updater.splashHeadlineFallback");
  const headlineText = safePsXamlText(opts.strings?.headline || defaultHeadline);
  const extractingText = safePsXamlText(
    opts.strings?.extractingMessage || getDefaultString("updater.splashExtractingMessage")
  );
  const footerSafety = safePsXamlText(
    opts.strings?.footerSafety || getDefaultString("updater.splashFooterSafety")
  );
  const versionBadge = safePsXamlText(version ? `v${version}` : "");

  const ps1 = `Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="${windowTitle}"
        Width="500" Height="320"
        WindowStartupLocation="CenterScreen"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        FlowDirection="RightToLeft"
        FontFamily="Segoe UI, Tahoma, Arial">
    <Border CornerRadius="16" Background="${bg}" BorderBrush="${border}" BorderThickness="1.5" Margin="10">
        <Border.Effect>
            <DropShadowEffect BlurRadius="25" ShadowDepth="4" Opacity="0.45"/>
        </Border.Effect>
        <Grid Margin="26">
            <Grid.RowDefinitions>
                <RowDefinition Height="Auto"/>
                <RowDefinition Height="*"/>
                <RowDefinition Height="Auto"/>
            </Grid.RowDefinitions>

            <!-- Brand row -->
            <StackPanel Grid.Row="0" Orientation="Horizontal">
                <Border Width="46" Height="46" CornerRadius="12" Background="${surface}" BorderBrush="${surfaceBorder}" BorderThickness="1" Margin="0,0,14,0">
                    <Path Data="M 4,6 L 14,6 C 18,6 20,8 20,12 L 20,28 C 18,26 16,25 14,25 L 4,25 Z M 36,6 L 26,6 C 22,6 20,8 20,12 L 20,28 C 22,26 24,25 26,25 L 36,25 Z"
                          Stroke="${accent}" StrokeThickness="2.2" Stretch="Uniform" Width="24" Height="24" HorizontalAlignment="Center" VerticalAlignment="Center"/>
                </Border>
                <StackPanel VerticalAlignment="Center">
                    <TextBlock Text="${brandLine}" FontSize="12.5" FontWeight="SemiBold" Foreground="${textMuted}" Margin="0,0,0,2"/>
                    <TextBlock Text="${headlineText}" FontSize="18" FontWeight="Bold" Foreground="${text}"/>
                </StackPanel>
            </StackPanel>

            <!-- Status block -->
            <Border Grid.Row="1" Margin="0,18,0,0" CornerRadius="10" Background="${surface}" BorderBrush="${border}" BorderThickness="1" Padding="16,14">
                <StackPanel VerticalAlignment="Center">
                    <TextBlock Text="${extractingText}"
                               FontSize="13" Foreground="${text}" TextWrapping="Wrap"/>
                    <ProgressBar Margin="0,14,0,0" Height="6" IsIndeterminate="True" Foreground="${accent}" Background="${progressBg}" BorderThickness="0"/>
                </StackPanel>
            </Border>

            <!-- Footer row -->
            <Grid Grid.Row="2" Margin="0,14,0,0">
                <TextBlock Text="${footerSafety}" FontSize="11.5" Foreground="${textMuted}" HorizontalAlignment="Left" VerticalAlignment="Center"/>
                <TextBlock Text="${versionBadge}" FontSize="11.5" Foreground="${textMuted}" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            </Grid>
        </Grid>
    </Border>
</Window>
"@

$reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($xaml))
$win = [System.Windows.Markup.XamlReader]::Load($reader)

$startTime = [DateTime]::UtcNow
$oldPid = ${oldPid}
$port = ${port}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(600)
$timer.Add_Tick({
    $elapsed = ([DateTime]::UtcNow - $startTime).TotalSeconds
    # Safety timeout after 90 seconds
    if ($elapsed -ge 90) {
        $timer.Stop()
        $win.Close()
        return
    }
    # Ensure the old Electron process has exited (or 12s elapsed) before probing port
    $oldExited = $false
    try {
        $null = [System.Diagnostics.Process]::GetProcessById($oldPid)
    } catch {
        $oldExited = $true
    }
    if (($oldExited -and $elapsed -ge 2.0) -or $elapsed -ge 12.0) {
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $iar = $tcp.BeginConnect("127.0.0.1", $port, $null, $null)
            $wait = $iar.AsyncWaitHandle.WaitOne(250, $false)
            if ($wait -and $tcp.Connected) {
                $tcp.EndConnect($iar)
                $tcp.Close()
                # New server is up! Wait 750ms so new main window renders visibly
                Start-Sleep -Milliseconds 750
                $timer.Stop()
                $win.Close()
                return
            }
            $tcp.Close()
        } catch {}
    }
})
$timer.Start()
$win.ShowDialog() | Out-Null
`;

  const scriptPath = path.join(os.tmpdir(), "otzar-updater-splash.ps1");
  fs.writeFileSync(scriptPath, "\uFEFF" + ps1, "utf8");

  // Launch PowerShell via GUI-subsystem wscript.exe so Windows does NOT terminate
  // detached console-less PowerShell before it creates the WPF splash window.
  const vbsPath = path.join(os.tmpdir(), "otzar-updater-splash.vbs");
  const vbsBody = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & WScript.Arguments(0) & """", 0, False\r\n';
  fs.writeFileSync(vbsPath, vbsBody, "utf8");

  try {
    const child = spawn(
      "wscript.exe",
      [vbsPath, scriptPath],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
  } catch (err) {
    console.error("[UpdaterSplash] Failed to spawn splash:", err);
  }
  return scriptPath;
}