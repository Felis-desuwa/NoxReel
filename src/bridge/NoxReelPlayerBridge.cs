// NoxReel 外部播放器桥。
//
// 为什么要有这个小程序：PotPlayer 和 MPC-BE 只能靠 Windows 窗口消息遥控
// （SendMessage / WM_COPYDATA），而 NoxReel 不引任何原生 Node 模块。
// 于是把这些 Win32 调用集中到一个随包附带的小程序里，主进程通过 stdin/stdout
// 的 NDJSON 跟它对话。
//
// 安全边界：
// - 指令只从 stdin 来，不开任何端口；stdin 关闭就退出。
// - 只对 allow 登记过的进程（以及它的直接子进程）的窗口发消息。
// - 发往播放器的消息一律 SendMessageTimeout + SMTO_ABORTIFHUNG，
//   PotPlayer 跳转时会停止处理消息，裸 SendMessage 会把桥卡死。
//
// 只能用 C# 5 语法：编译器是 .NET Framework 自带的 csc v4.0.30319。
// 源码里刻意不写反斜杠转义，换行用 (char)10 表示。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace NoxReel
{
  internal static class Native
  {
    public const int WM_USER = 0x0400;
    public const int WM_COPYDATA = 0x004A;
    public const int WM_CLOSE = 0x0010;
    public const int WM_APP = 0x8000;
    public const uint SMTO_BLOCK = 0x0001;
    public const uint SMTO_ABORTIFHUNG = 0x0002;
    public const uint GW_HWNDPREV = 3;
    public const uint GA_ROOTOWNER = 3;
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOPMOST = 0x00000008;
    public const uint MONITOR_DEFAULTTONEAREST = 2;
    public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const int DWMWA_CLOAKED = 14;
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint EVENT_SYSTEM_MOVESIZESTART = 0x000A;
    public const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
    public const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
    public const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    public const uint EVENT_OBJECT_DESTROY = 0x8001;
    public const uint EVENT_OBJECT_SHOW = 0x8002;
    public const uint EVENT_OBJECT_HIDE = 0x8003;
    public const uint EVENT_OBJECT_REORDER = 0x8004;
    public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    public const uint TH32CS_SNAPPROCESS = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct COPYDATASTRUCT { public IntPtr dwData; public int cbData; public IntPtr lpData; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32
    {
      public uint dwSize;
      public uint cntUsage;
      public uint th32ProcessID;
      public IntPtr th32DefaultHeapID;
      public uint th32ModuleID;
      public uint cntThreads;
      public uint th32ParentProcessID;
      public int pcPriClassBase;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")]
    public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")]
    public static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    public static extern int DwmGetWindowAttributeInt(IntPtr hWnd, int attr, out int value, int size);
    [DllImport("shell32.dll")]
    public static extern int SHQueryUserNotificationState(out int state);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
  }

  /// <summary>只收消息的隐藏窗口：MPC-BE 的 /slave 回报和 PotPlayer 的字符串回包都送到这里。</summary>
  internal sealed class BridgeWindow : NativeWindow
  {
    private static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);
    public readonly Queue<Action> Pending = new Queue<Action>();

    public BridgeWindow()
    {
      CreateParams cp = new CreateParams();
      cp.Caption = "NoxReelPlayerBridge";
      cp.Parent = HWND_MESSAGE;
      CreateHandle(cp);
    }

    /// <summary>把工作排到 UI 线程上做（WinEvent 钩子必须装在有消息循环的线程上）。</summary>
    public void Post(Action action)
    {
      lock (Pending) Pending.Enqueue(action);
      Native.PostMessage(Handle, Native.WM_APP + 1, IntPtr.Zero, IntPtr.Zero);
    }

    protected override void WndProc(ref Message m)
    {
      if (m.Msg == Native.WM_COPYDATA)
      {
        Program.OnCopyData(m.WParam, m.LParam);
        m.Result = new IntPtr(1);
        return;
      }
      if (m.Msg == Native.WM_APP + 1)
      {
        while (true)
        {
          Action next = null;
          lock (Pending) { if (Pending.Count > 0) next = Pending.Dequeue(); }
          if (next == null) break;
          try { next(); } catch (Exception e) { Program.Log("ui-task: " + e.Message); }
        }
        return;
      }
      base.WndProc(ref m);
    }
  }

  internal static class Program
  {
    internal const string Version = "1";
    private static readonly string NL = ((char)10).ToString();
    private static readonly object OutLock = new object();
    private static TextWriter Out;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static BridgeWindow Window;
    private static readonly HashSet<uint> AllowedPids = new HashSet<uint>();

    // 窗口跟踪
    private static IntPtr Tracked = IntPtr.Zero;
    private static uint TrackedPid = 0;
    private static readonly List<IntPtr> Hooks = new List<IntPtr>();
    private static Native.WinEventProc HookProc; // 必须常驻引用，否则被 GC 回收后回调会崩
    private static System.Windows.Forms.Timer Heartbeat;
    private static System.Windows.Forms.Timer Debounce;
    private static string LastWinState = null;

    [STAThread]
    private static int Main(string[] args)
    {
      Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
      ((StreamWriter)Out).AutoFlush = true;
      Json.MaxJsonLength = 4 * 1024 * 1024;

      if (args.Length > 0 && args[0] == "--selftest") return SelfTest();

      Window = new BridgeWindow();
      Thread reader = new Thread(ReadLoop);
      reader.IsBackground = true;
      reader.Start();

      Dictionary<string, object> ready = new Dictionary<string, object>();
      ready["ev"] = "ready";
      ready["version"] = Version;
      ready["hwnd"] = Window.Handle.ToInt64();
      ready["pid"] = Process.GetCurrentProcess().Id;
      Emit(ready);

      Application.Run();
      return 0;
    }

    private static void ReadLoop()
    {
      StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      string line;
      while ((line = input.ReadLine()) != null)
      {
        line = line.Trim();
        if (line.Length == 0) continue;
        Dictionary<string, object> msg = null;
        try { msg = Json.Deserialize<Dictionary<string, object>>(line); }
        catch (Exception e) { Log("bad json: " + e.Message); continue; }
        if (msg == null) continue;
        Dispatch(msg);
      }
      // 父进程没了（或主动关了 stdin）：跟着退出，不留孤儿。
      Window.Post(delegate { Unhook(); Application.ExitThread(); });
    }

    private static void Dispatch(Dictionary<string, object> msg)
    {
      object idObj;
      long id = msg.TryGetValue("id", out idObj) ? ToLong(idObj) : 0;
      string cmd = Str(msg, "cmd");
      try
      {
        switch (cmd)
        {
          case "ping": Reply(id, "pong"); break;
          case "allow": lock (AllowedPids) AllowedPids.Add((uint)ToLong(msg["pid"])); Reply(id, true); break;
          case "forget": lock (AllowedPids) AllowedPids.Remove((uint)ToLong(msg["pid"])); Reply(id, true); break;
          case "findWindow": Reply(id, FindWindow((uint)ToLong(msg["pid"]), StrList(msg, "classes")).ToInt64()); break;
          case "pot": ThreadPool.QueueUserWorkItem(delegate { SafeReply(id, delegate { return PotBatch(msg); }); }); break;
          case "potString": ThreadPool.QueueUserWorkItem(delegate { SafeReply(id, delegate { return PotGetString(msg); }); }); break;
          case "potSetString": ThreadPool.QueueUserWorkItem(delegate { SafeReply(id, delegate { return PotSetString(msg); }); }); break;
          case "mpc": ThreadPool.QueueUserWorkItem(delegate { SafeReply(id, delegate { return MpcCommand(msg); }); }); break;
          case "mpcOsd": ThreadPool.QueueUserWorkItem(delegate { SafeReply(id, delegate { return MpcOsd(msg); }); }); break;
          case "close": Reply(id, PostClose(msg)); break;
          case "foreground": Reply(id, Foreground(msg)); break;
          case "track": Window.Post(delegate { SafeReply(id, delegate { return Track(msg); }); }); break;
          case "untrack": Window.Post(delegate { Unhook(); Tracked = IntPtr.Zero; Reply(id, true); }); break;
          case "winState": Window.Post(delegate { SafeReply(id, delegate { return WinState(ToPtr(msg["hwnd"])); }); }); break;
          default: ReplyError(id, "unknown command: " + cmd); break;
        }
      }
      catch (Exception e)
      {
        ReplyError(id, e.Message);
      }
    }

    /* ------------------------------ 权限 ------------------------------ */

    private static uint PidOf(IntPtr hwnd)
    {
      uint pid;
      Native.GetWindowThreadProcessId(hwnd, out pid);
      return pid;
    }

    /// <summary>目标窗口必须属于 allow 过的进程，或它的直接子进程（PotPlayer64.exe 会再拉起 Mini 版）。</summary>
    private static void RequireAllowed(IntPtr hwnd)
    {
      if (!Native.IsWindow(hwnd)) throw new Exception("window gone");
      uint pid = PidOf(hwnd);
      lock (AllowedPids)
      {
        if (AllowedPids.Contains(pid)) return;
        uint parent = ParentPid(pid);
        if (parent != 0 && AllowedPids.Contains(parent)) return;
      }
      throw new Exception("window not allowed");
    }

    private static uint ParentPid(uint pid)
    {
      IntPtr snap = Native.CreateToolhelp32Snapshot(Native.TH32CS_SNAPPROCESS, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return 0;
      try
      {
        Native.PROCESSENTRY32 entry = new Native.PROCESSENTRY32();
        entry.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32));
        if (!Native.Process32FirstW(snap, ref entry)) return 0;
        do
        {
          if (entry.th32ProcessID == pid) return entry.th32ParentProcessID;
        } while (Native.Process32NextW(snap, ref entry));
        return 0;
      }
      finally { Native.CloseHandle(snap); }
    }

    private static HashSet<uint> PidFamily(uint pid)
    {
      HashSet<uint> family = new HashSet<uint>();
      family.Add(pid);
      IntPtr snap = Native.CreateToolhelp32Snapshot(Native.TH32CS_SNAPPROCESS, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return family;
      try
      {
        Native.PROCESSENTRY32 entry = new Native.PROCESSENTRY32();
        entry.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32));
        if (!Native.Process32FirstW(snap, ref entry)) return family;
        do
        {
          if (entry.th32ParentProcessID == pid) family.Add(entry.th32ProcessID);
        } while (Native.Process32NextW(snap, ref entry));
      }
      finally { Native.CloseHandle(snap); }
      return family;
    }

    /* ------------------------------ 找窗口 ------------------------------ */

    private static string ClassOf(IntPtr hwnd)
    {
      StringBuilder sb = new StringBuilder(256);
      Native.GetClassName(hwnd, sb, sb.Capacity);
      return sb.ToString();
    }

    private static IntPtr FindWindow(uint pid, List<string> classes)
    {
      lock (AllowedPids)
      {
        if (!AllowedPids.Contains(pid)) throw new Exception("pid not allowed");
      }
      HashSet<uint> family = PidFamily(pid);
      IntPtr best = IntPtr.Zero;
      long bestArea = -1;
      Native.EnumWindows(delegate (IntPtr hwnd, IntPtr lp)
      {
        if (!Native.IsWindowVisible(hwnd)) return true;
        if (!family.Contains(PidOf(hwnd))) return true;
        if (classes.Count > 0 && !classes.Contains(ClassOf(hwnd))) return true;
        Native.RECT r;
        Native.GetWindowRect(hwnd, out r);
        long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        if (area > bestArea) { bestArea = area; best = hwnd; }
        return true;
      }, IntPtr.Zero);
      return best;
    }

    /* ------------------------------ PotPlayer ------------------------------ */

    /// <summary>一批 WM_USER 查询/设置。每条都带超时，结果按顺序返回 {v} 或 {err}。</summary>
    private static object PotBatch(Dictionary<string, object> msg)
    {
      IntPtr hwnd = ToPtr(msg["hwnd"]);
      RequireAllowed(hwnd);
      uint timeout = msg.ContainsKey("timeout") ? (uint)ToLong(msg["timeout"]) : 300;
      List<object> results = new List<object>();
      foreach (object item in (System.Collections.ArrayList)msg["calls"])
      {
        System.Collections.ArrayList pair = (System.Collections.ArrayList)item;
        int code = (int)ToLong(pair[0]);
        long value = pair.Count > 1 ? ToLong(pair[1]) : 0;
        IntPtr result;
        IntPtr ok = Native.SendMessageTimeout(hwnd, Native.WM_USER, new IntPtr(code), new IntPtr(value),
          Native.SMTO_ABORTIFHUNG | Native.SMTO_BLOCK, timeout, out result);
        Dictionary<string, object> r = new Dictionary<string, object>();
        if (ok == IntPtr.Zero) r["err"] = Marshal.GetLastWin32Error();
        else r["v"] = (long)(int)result.ToInt64(); // DWORD_PTR 按 32 位有符号解读：停止状态会是 -1
        results.Add(r);
      }
      return results;
    }

    /// <summary>字符串查询：PotPlayer 会反过来给我们的窗口发 WM_COPYDATA，结果从 copydata 事件里拿。</summary>
    private static object PotGetString(Dictionary<string, object> msg)
    {
      IntPtr hwnd = ToPtr(msg["hwnd"]);
      RequireAllowed(hwnd);
      int code = (int)ToLong(msg["code"]);
      IntPtr result;
      IntPtr ok = Native.SendMessageTimeout(hwnd, Native.WM_USER, new IntPtr(code), Window.Handle,
        Native.SMTO_ABORTIFHUNG | Native.SMTO_BLOCK, 400, out result);
      if (ok == IntPtr.Zero) throw new Exception("send failed: " + Marshal.GetLastWin32Error());
      return true;
    }

    private static object PotSetString(Dictionary<string, object> msg)
    {
      IntPtr hwnd = ToPtr(msg["hwnd"]);
      RequireAllowed(hwnd);
      byte[] data = Encoding.UTF8.GetBytes(Str(msg, "text"));
      return SendCopyData(hwnd, ToLong(msg["code"]), data, 400);
    }

    /* ------------------------------ MPC-BE ------------------------------ */

    private static object MpcCommand(Dictionary<string, object> msg)
    {
      IntPtr hwnd = ToPtr(msg["hwnd"]);
      RequireAllowed(hwnd);
      string arg = Str(msg, "arg");
      // MPC-BE 要求以 NUL 结尾的 UTF-16，最后一个 WCHAR 不是 0 就整条丢弃。
      byte[] data = Encoding.Unicode.GetBytes(arg + (char)0);
      return SendCopyData(hwnd, ToLong(msg["code"]), data, 400);
    }

    private static object MpcOsd(Dictionary<string, object> msg)
    {
      IntPtr hwnd = ToPtr(msg["hwnd"]);
      RequireAllowed(hwnd);
      // struct MPC_OSDDATA { int nMsgPos; int nDurationMS; WCHAR strMsg[128]; }，整体先清零。
      byte[] data = new byte[4 + 4 + 128 * 2];
      BitConverter.GetBytes((int)ToLong(msg["pos"])).CopyTo(data, 0);
      BitConverter.GetBytes((int)ToLong(msg["ms"])).CopyTo(data, 4);
      string text = Str(msg, "text");
      if (text.Length > 127) text = text.Substring(0, 127);
      Encoding.Unicode.GetBytes(text).CopyTo(data, 8);
      return SendCopyData(hwnd, 0xA0005000L, data, 400);
    }

    private static object SendCopyData(IntPtr hwnd, long code, byte[] data, uint timeout)
    {
      IntPtr buffer = Marshal.AllocHGlobal(Math.Max(1, data.Length));
      IntPtr cdsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.COPYDATASTRUCT)));
      try
      {
        Marshal.Copy(data, 0, buffer, data.Length);
        Native.COPYDATASTRUCT cds = new Native.COPYDATASTRUCT();
        // 命令码按 32 位无符号传：0xA000xxxx 当成 int 会被符号扩展成 0xFFFFFFFFA000xxxx，MPC-BE 认不出来
        cds.dwData = new IntPtr(code & 0xFFFFFFFFL);
        cds.cbData = data.Length;
        cds.lpData = buffer;
        Marshal.StructureToPtr(cds, cdsPtr, false);
        IntPtr result;
        IntPtr ok = Native.SendMessageTimeout(hwnd, Native.WM_COPYDATA, Window.Handle, cdsPtr,
          Native.SMTO_ABORTIFHUNG | Native.SMTO_BLOCK, timeout, out result);
        if (ok == IntPtr.Zero) throw new Exception("send failed: " + Marshal.GetLastWin32Error());
        return result.ToInt64();
      }
      finally
      {
        Marshal.FreeHGlobal(cdsPtr);
        Marshal.FreeHGlobal(buffer);
      }
    }

    /// <summary>
    /// 收到 WM_COPYDATA。MPC-BE 的通知码在 0x50000000 段、内容是 UTF-16；
    /// PotPlayer 的字符串回包是 UTF-8。带上发送方 PID，由主进程决定信不信。
    /// </summary>
    internal static void OnCopyData(IntPtr sender, IntPtr lParam)
    {
      try
      {
        Native.COPYDATASTRUCT cds = (Native.COPYDATASTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.COPYDATASTRUCT));
        long code = cds.dwData.ToInt64() & 0xFFFFFFFFL;
        int len = Math.Max(0, Math.Min(cds.cbData, 1024 * 1024));
        byte[] data = new byte[len];
        if (len > 0 && cds.lpData != IntPtr.Zero) Marshal.Copy(cds.lpData, data, 0, len);
        string text;
        if (code >= 0x50000000L && code < 0x60000000L) text = Encoding.Unicode.GetString(data).TrimEnd((char)0);
        else text = Encoding.UTF8.GetString(data).TrimEnd((char)0);
        Dictionary<string, object> ev = new Dictionary<string, object>();
        ev["ev"] = "copydata";
        ev["from"] = sender.ToInt64();
        ev["pid"] = sender == IntPtr.Zero ? 0 : (long)PidOf(sender);
        ev["code"] = code;
        ev["text"] = text;
        Emit(ev);
      }
      catch (Exception e) { Log("copydata: " + e.Message); }
    }

    /* ------------------------------ 窗口控制 ------------------------------ */

    private static object PostClose(Dictionary<string, object> msg)
    {
      IntPtr hwnd = ToPtr(msg["hwnd"]);
      RequireAllowed(hwnd);
      return Native.PostMessage(hwnd, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }

    private static object Foreground(Dictionary<string, object> msg)
    {
      IntPtr hwnd = ToPtr(msg["hwnd"]);
      RequireAllowed(hwnd);
      return Native.SetForegroundWindow(hwnd);
    }

    /* ------------------------------ 窗口跟踪 ------------------------------ */

    private static object Track(Dictionary<string, object> msg)
    {
      IntPtr hwnd = ToPtr(msg["hwnd"]);
      RequireAllowed(hwnd);
      Unhook();
      Tracked = hwnd;
      TrackedPid = PidOf(hwnd);
      LastWinState = null;
      HookProc = OnWinEvent;
      // 前台切换和 Z 序变化来自别的进程，只能全局挂；位置、显隐、最小化只挂播放器进程。
      Hooks.Add(Native.SetWinEventHook(Native.EVENT_SYSTEM_FOREGROUND, Native.EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, HookProc, 0, 0, Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS));
      Hooks.Add(Native.SetWinEventHook(Native.EVENT_OBJECT_REORDER, Native.EVENT_OBJECT_REORDER, IntPtr.Zero, HookProc, 0, 0, Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS));
      Hooks.Add(Native.SetWinEventHook(Native.EVENT_SYSTEM_MOVESIZESTART, Native.EVENT_SYSTEM_MOVESIZEEND, IntPtr.Zero, HookProc, TrackedPid, 0, Native.WINEVENT_OUTOFCONTEXT));
      Hooks.Add(Native.SetWinEventHook(Native.EVENT_SYSTEM_MINIMIZESTART, Native.EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, HookProc, TrackedPid, 0, Native.WINEVENT_OUTOFCONTEXT));
      Hooks.Add(Native.SetWinEventHook(Native.EVENT_OBJECT_DESTROY, Native.EVENT_OBJECT_HIDE, IntPtr.Zero, HookProc, TrackedPid, 0, Native.WINEVENT_OUTOFCONTEXT));
      Hooks.Add(Native.SetWinEventHook(Native.EVENT_OBJECT_LOCATIONCHANGE, Native.EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, HookProc, TrackedPid, 0, Native.WINEVENT_OUTOFCONTEXT));

      if (Debounce == null)
      {
        Debounce = new System.Windows.Forms.Timer();
        Debounce.Interval = 16;
        Debounce.Tick += delegate { Debounce.Stop(); EmitWinState(false); };
      }
      if (Heartbeat == null)
      {
        // 钩子偶尔会漏事件（比如 DWM 合成层面的变化），250ms 兜底轮询一次，没变化就不发。
        Heartbeat = new System.Windows.Forms.Timer();
        Heartbeat.Interval = 250;
        Heartbeat.Tick += delegate { EmitWinState(false); };
      }
      Heartbeat.Start();
      EmitWinState(true);
      return true;
    }

    private static void OnWinEvent(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
      if (Tracked == IntPtr.Zero) return;
      if (idObject != 0) return; // 只关心窗口本身（OBJID_WINDOW），不关心光标、滚动条之类
      if (Debounce != null && !Debounce.Enabled) Debounce.Start();
    }

    private static void Unhook()
    {
      foreach (IntPtr h in Hooks) if (h != IntPtr.Zero) Native.UnhookWinEvent(h);
      Hooks.Clear();
      if (Heartbeat != null) Heartbeat.Stop();
      if (Debounce != null) Debounce.Stop();
    }

    private static void EmitWinState(bool force)
    {
      if (Tracked == IntPtr.Zero) return;
      Dictionary<string, object> state = WinState(Tracked);
      string key = Json.Serialize(state);
      if (!force && key == LastWinState) return;
      LastWinState = key;
      state["ev"] = "win";
      Emit(state);
      if (!(bool)state["alive"]) Unhook();
    }

    private static long[] RectArr(Native.RECT r) { return new long[] { r.Left, r.Top, r.Right, r.Bottom }; }

    private static Dictionary<string, object> WinState(IntPtr hwnd)
    {
      Dictionary<string, object> s = new Dictionary<string, object>();
      s["hwnd"] = hwnd.ToInt64();
      bool alive = Native.IsWindow(hwnd);
      s["alive"] = alive;
      if (!alive) return s;

      Native.RECT frame;
      if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(Native.RECT))) != 0)
        Native.GetWindowRect(hwnd, out frame);
      s["rect"] = RectArr(frame);

      Native.RECT client;
      Native.GetClientRect(hwnd, out client);
      Native.POINT origin = new Native.POINT();
      Native.ClientToScreen(hwnd, ref origin);
      s["client"] = new long[] { origin.X, origin.Y, origin.X + client.Right, origin.Y + client.Bottom };

      uint dpi = 96;
      try { dpi = Native.GetDpiForWindow(hwnd); } catch (EntryPointNotFoundException) { }
      s["dpi"] = dpi;

      Native.MONITORINFO mi = new Native.MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
      Native.GetMonitorInfo(Native.MonitorFromWindow(hwnd, Native.MONITOR_DEFAULTTONEAREST), ref mi);
      s["monitor"] = RectArr(mi.rcMonitor);

      bool minimized = Native.IsIconic(hwnd);
      s["minimized"] = minimized;
      s["visible"] = Native.IsWindowVisible(hwnd);
      int cloaked;
      s["cloaked"] = Native.DwmGetWindowAttributeInt(hwnd, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
      long exStyle = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64();
      s["topmost"] = (exStyle & Native.WS_EX_TOPMOST) != 0;

      IntPtr fg = Native.GetForegroundWindow();
      bool foreground = false;
      if (fg != IntPtr.Zero)
      {
        IntPtr root = Native.GetAncestor(fg, Native.GA_ROOTOWNER);
        uint fgPid = PidOf(root == IntPtr.Zero ? fg : root);
        foreground = fg == hwnd || root == hwnd || fgPid == PidOf(hwnd);
      }
      s["foreground"] = foreground;

      Native.RECT win;
      Native.GetWindowRect(hwnd, out win);
      s["fullscreenLike"] = !minimized && win.Left <= mi.rcMonitor.Left && win.Top <= mi.rcMonitor.Top
        && win.Right >= mi.rcMonitor.Right && win.Bottom >= mi.rcMonitor.Bottom;

      int notify;
      s["fse"] = foreground && Native.SHQueryUserNotificationState(out notify) == 0 && notify == 3;

      // 紧贴在它上面的几个可见窗口，主进程拿来核对覆盖窗是不是在正确的层上。
      List<object> above = new List<object>();
      IntPtr prev = Native.GetWindow(hwnd, Native.GW_HWNDPREV);
      int guard = 0;
      while (prev != IntPtr.Zero && above.Count < 4 && guard++ < 512)
      {
        if (Native.IsWindowVisible(prev))
        {
          Dictionary<string, object> w = new Dictionary<string, object>();
          w["hwnd"] = prev.ToInt64();
          w["pid"] = (long)PidOf(prev);
          w["cls"] = ClassOf(prev);
          above.Add(w);
        }
        prev = Native.GetWindow(prev, Native.GW_HWNDPREV);
      }
      s["above"] = above;
      return s;
    }

    /* ------------------------------ 自检 ------------------------------ */

    private static int SelfTest()
    {
      try
      {
        Window = new BridgeWindow();
        string parsed = null;
        Dictionary<string, object> sample = new Dictionary<string, object>();
        sample["a"] = new int[] { 1, 2 };
        sample["b"] = "中文";
        Dictionary<string, object> probe = Json.Deserialize<Dictionary<string, object>>(Json.Serialize(sample));
        if (Str(probe, "b") != "中文") throw new Exception("json roundtrip failed");

        // 自己给自己发一条 MPC-BE 格式的 WM_COPYDATA，确认收发和解码都通。
        TextWriter real = Out;
        StringWriter capture = new StringWriter();
        Out = capture;
        AllowedPids.Add((uint)Process.GetCurrentProcess().Id);
        Thread sender = new Thread(delegate ()
        {
          try
          {
            // 一条走 MPC-BE 的 UTF-16 解码；另一条用 0xA 段的高位码，确认没有被符号扩展。
            SendCopyData(Window.Handle, 0x50000007L, Encoding.Unicode.GetBytes("12.345" + (char)0), 1000);
            SendCopyData(Window.Handle, 0xA0003004L, Encoding.UTF8.GetBytes("abc"), 1000);
          }
          catch (Exception e) { parsed = "send error: " + e.Message; }
        });
        sender.Start();
        DateTime deadline = DateTime.UtcNow.AddSeconds(3);
        while (sender.IsAlive && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(5); }
        Out = real;
        if (parsed != null) throw new Exception(parsed);
        string captured = capture.ToString();
        if (captured.IndexOf("12.345", StringComparison.Ordinal) < 0) throw new Exception("copydata not received: " + captured);
        if (captured.IndexOf("2684366852", StringComparison.Ordinal) < 0) throw new Exception("high command code was sign-extended: " + captured);

        Dictionary<string, object> state = WinState(Window.Handle);
        if (!(bool)state["alive"]) throw new Exception("winState failed");

        Dictionary<string, object> ok = new Dictionary<string, object>();
        ok["selftest"] = "ok";
        ok["version"] = Version;
        Emit(ok);
        return 0;
      }
      catch (Exception e)
      {
        Dictionary<string, object> bad = new Dictionary<string, object>();
        bad["selftest"] = "failed";
        bad["error"] = e.Message;
        Emit(bad);
        return 1;
      }
    }

    /* ------------------------------ 输出 ------------------------------ */

    private delegate object Work();

    private static void SafeReply(long id, Work work)
    {
      try { Reply(id, work()); }
      catch (Exception e) { ReplyError(id, e.Message); }
    }

    private static void Reply(long id, object result)
    {
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["id"] = id;
      r["ok"] = true;
      r["result"] = result;
      Emit(r);
    }

    private static void ReplyError(long id, string error)
    {
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["id"] = id;
      r["ok"] = false;
      r["error"] = error;
      Emit(r);
    }

    internal static void Log(string text)
    {
      Dictionary<string, object> r = new Dictionary<string, object>();
      r["ev"] = "log";
      r["text"] = text;
      Emit(r);
    }

    private static void Emit(Dictionary<string, object> obj)
    {
      string line = Json.Serialize(obj);
      lock (OutLock)
      {
        Out.Write(line);
        Out.Write(NL);
        Out.Flush();
      }
    }

    private static long ToLong(object o) { return Convert.ToInt64(o, System.Globalization.CultureInfo.InvariantCulture); }
    private static IntPtr ToPtr(object o) { return new IntPtr(ToLong(o)); }

    private static string Str(Dictionary<string, object> msg, string key)
    {
      object v;
      if (!msg.TryGetValue(key, out v) || v == null) return "";
      return Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static List<string> StrList(Dictionary<string, object> msg, string key)
    {
      List<string> list = new List<string>();
      object v;
      if (!msg.TryGetValue(key, out v) || v == null) return list;
      foreach (object o in (System.Collections.ArrayList)v) list.Add(Convert.ToString(o));
      return list;
    }
  }
}
