using System;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class Win32Resizer {
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  
  public static IntPtr FindWindowBySubstring(string substring) {
      IntPtr found = IntPtr.Zero;
      EnumWindows((hWnd, lParam) => {
        int length = GetWindowTextLength(hWnd);
        if (length > 0) {
          System.Text.StringBuilder sb = new System.Text.StringBuilder(length + 1);
          GetWindowText(hWnd, sb, sb.Capacity);
          if (sb.ToString().Contains(substring)) {
            found = hWnd;
            return false; // Stop enumerating
          }
        }
        return true;
      }, IntPtr.Zero);
      return found;
  }
  
  [DllImport("user32.dll", SetLastError = true)]
  static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  
  [DllImport("user32.dll", SetLastError = true)]
  static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  
  [DllImport("user32.dll", SetLastError = true)]
  static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

  [DllImport("user32.dll")]
  static extern bool GetCursorPos(out POINT lpPoint);
  
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
      public int X;
      public int Y;
  }
  
  [DllImport("user32.dll")]
  static extern IntPtr WindowFromPoint(POINT Point);
  
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool SetForegroundWindow(IntPtr hWnd);

  const uint SWP_SHOWWINDOW = 0x0040;
  
  public static void Main(string[] args) {
     if (args.Length > 0 && args[0] == "--daemon") {
         Console.WriteLine("DAEMON_STARTED");
         // Infinite loop polling mouse position
         IntPtr lastHoveredHwnd = IntPtr.Zero;
         while(true) {
             System.Threading.Thread.Sleep(100);
             POINT p;
             if (GetCursorPos(out p)) {
                 IntPtr hoverHwnd = WindowFromPoint(p);
                 if (hoverHwnd != IntPtr.Zero && hoverHwnd != lastHoveredHwnd) {
                     // Check if it's a valid window before bringing to foreground
                     int length = GetWindowTextLength(hoverHwnd);
                     if (length > 0) {
                         SetForegroundWindow(hoverHwnd);
                     }
                     lastHoveredHwnd = hoverHwnd;
                 }
             }
         }
     }
     
     if (args.Length > 0 && args[0] == "--virtual-desktop") {
         // Simulate Ctrl + Win + D
         keybd_event(0x11, 0, 0, UIntPtr.Zero); // Ctrl
         keybd_event(0x5B, 0, 0, UIntPtr.Zero); // Win
         keybd_event(0x44, 0, 0, UIntPtr.Zero); // D
         keybd_event(0x44, 0, 0x0002, UIntPtr.Zero);
         keybd_event(0x5B, 0, 0x0002, UIntPtr.Zero);
         keybd_event(0x11, 0, 0x0002, UIntPtr.Zero);
         Console.WriteLine("VIRTUAL_DESKTOP_CREATED");
         return;
     }

     if (args.Length > 0 && args[0] == "--switch-desktop") {
         // Simulate Ctrl + Win + Right
         keybd_event(0x11, 0, 0, UIntPtr.Zero); // Ctrl
         keybd_event(0x5B, 0, 0, UIntPtr.Zero); // Win
         keybd_event(0x27, 0, 0, UIntPtr.Zero); // Right
         keybd_event(0x27, 0, 0x0002, UIntPtr.Zero);
         keybd_event(0x5B, 0, 0x0002, UIntPtr.Zero);
         keybd_event(0x11, 0, 0x0002, UIntPtr.Zero);
         Console.WriteLine("VIRTUAL_DESKTOP_SWITCHED");
         return;
     }
     
     if(args.Length < 6) {
         Console.WriteLine("Usage: resizer.exe <WindowTitle> <X> <Y> <W> <H> <ZOrder>");
         return;
     }
     
     string title = args[0];
     int x = int.Parse(args[1]);
     int y = int.Parse(args[2]);
     int w = int.Parse(args[3]);
     int h = int.Parse(args[4]);
     string zOrderStr = args[5].ToUpper();
     
     IntPtr hwnd = IntPtr.Zero;
     
     // Poll for window up to 2.5 seconds (25 attempts * 100ms)
     for(int i = 0; i < 25; i++) {
         hwnd = FindWindowBySubstring(title);
         if(hwnd != IntPtr.Zero) break;
         System.Threading.Thread.Sleep(100);
     }
     
     if(hwnd == IntPtr.Zero) {
         Console.WriteLine("HWND_NOT_FOUND");
         Environment.Exit(1);
     }
     
     IntPtr zOrder = zOrderStr == "TOP" ? new IntPtr(0) : new IntPtr(1); // HWND_TOP=0, HWND_BOTTOM=1
     
     // Remove window borders if it's very small
     if (w < 400) {
         int style = GetWindowLong(hwnd, -16);
         style &= unchecked((int)~0x00CF0000); // WS_OVERLAPPEDWINDOW
         SetWindowLong(hwnd, -16, style);
     }
     
     bool result = SetWindowPos(hwnd, zOrder, x, y, w, h, SWP_SHOWWINDOW);
     
     if(result) {
         Console.WriteLine("SUCCESS");
     } else {
         Console.WriteLine("FAILED");
         Environment.Exit(1);
     }
  }
}
