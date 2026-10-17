# RIGS JSON-lines helper. All user data is parsed as JSON, never as PowerShell source.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Web.Extensions
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
public static class RigsControl {
  static readonly System.Collections.Concurrent.BlockingCollection<string> lines = new System.Collections.Concurrent.BlockingCollection<string>();
  static volatile bool stopping;
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  delegate bool EnumProc(IntPtr h, IntPtr data);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] input, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder text,uint length,out uint needed);
  static HashSet<ushort> heldKeys = new HashSet<ushort>();
  static HashSet<string> heldButtons = new HashSet<string>();
  public static void Init() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    // Read independently of the action thread: stop can interrupt a long Unicode typing request.
    var reader = new System.Threading.Thread(delegate() {
      var json = new System.Web.Script.Serialization.JavaScriptSerializer(); string line;
      try {
        while((line=Console.ReadLine())!=null) {
          try { var req=json.Deserialize<Dictionary<string,object>>(line); object op; if(req.TryGetValue("op",out op) && (string)op=="stop") stopping=true; } catch {}
          lines.Add(line);
        }
      } finally { stopping=true; lines.CompleteAdding(); }
    }); reader.IsBackground=true; reader.Start();
  }
  public static string NextLine() { try { return lines.Take(); } catch(InvalidOperationException) { return null; } }
  public static bool Locked() {
    IntPtr h = OpenInputDesktop(0,false,1);
    if(h == IntPtr.Zero) return true;
    try { var s=new StringBuilder(256); uint n; return !GetUserObjectInformation(h,2,s,512,out n) || !String.Equals(s.ToString(),"Default",StringComparison.OrdinalIgnoreCase); }
    finally { CloseDesktop(h); }
  }
  static void Send(INPUT i) { if(SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("SendInput refused (secure/elevated desktop or UIPI)"); }
  static void Keyboard(ushort vk,ushort scan,uint flags) { INPUT i=new INPUT(); i.type=1; i.u.key.vk=vk; i.u.key.scan=scan; i.u.key.flags=flags; Send(i); }
  static ushort Vk(string name) {
    var names=new Dictionary<string,ushort>{{"ctrl",17},{"alt",18},{"shift",16},{"super",91},{"enter",13},{"tab",9},{"esc",27},{"space",32},{"backspace",8},{"delete",46},{"insert",45},{"up",38},{"down",40},{"left",37},{"right",39},{"home",36},{"end",35},{"pageup",33},{"pagedown",34},{"capslock",20},{"printscreen",44},{"menu",93}};
    if(names.ContainsKey(name)) return names[name];
    int f; if(name.StartsWith("f") && Int32.TryParse(name.Substring(1),out f) && f>=1 && f<=24) return (ushort)(111+f);
    if(name.Length==1 && Char.IsLetterOrDigit(name[0])) return (ushort)Char.ToUpperInvariant(name[0]);
    throw new Exception("unsupported key; use typeText for characters");
  }
  public static void Key(string name,bool down) { if(down && stopping) throw new Exception("Control stopped"); ushort v=Vk(name); if(down) heldKeys.Add(v); Keyboard(v,0,down?0u:2u); if(!down) heldKeys.Remove(v); }
  public static void Type(string text,int delay) {
    foreach(char c in text) { if(stopping) throw new Exception("Control stopped"); Keyboard(0,c,4); Keyboard(0,c,6); if(delay>0) System.Threading.Thread.Sleep(delay); }
  }
  public static void Move(int x,int y) { Cursor.Position=new Point(x,y); }
  public static void Button(string name,bool down) {
    uint flag=name=="left" ? down?2u:4u : name=="right" ? down?8u:16u : down?32u:64u;
    if(down && stopping) throw new Exception("Control stopped"); if(down) heldButtons.Add(name); INPUT i=new INPUT(); i.u.mouse.flags=flag; Send(i); if(!down) heldButtons.Remove(name);
  }
  public static void Scroll(int dx,int dy) { foreach(int axis in new int[]{0,1}) { int n=axis==0?dy:dx; if(n==0) continue; INPUT i=new INPUT(); i.u.mouse.flags=axis==0?0x800u:0x1000u; i.u.mouse.data=unchecked((uint)(n*120*(axis==0?-1:1))); Send(i); } }
  public static void Release() {
    foreach(ushort k in new List<ushort>(heldKeys)) { try { Keyboard(k,0,2); } catch {} } heldKeys.Clear();
    foreach(string b in new List<string>(heldButtons)) { try { Button(b,false); } catch {} } heldButtons.Clear();
  }
  public static object[] Windows() {
    var result=new List<object>();
    EnumWindows(delegate(IntPtr h,IntPtr data) {
      if(!IsWindowVisible(h)) return true;
      var title=new StringBuilder(4096); GetWindowText(h,title,title.Capacity); if(title.Length==0) return true;
      RECT r; GetWindowRect(h,out r); uint pid; GetWindowThreadProcessId(h,out pid);
      string app=""; try { app=System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
      result.Add(new {id="0x"+h.ToInt64().ToString("x"), title=title.ToString(), app=app,pid=pid,display=Screen.FromHandle(h).DeviceName,bounds=new {x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top},focused=h==GetForegroundWindow(),minimized=IsIconic(h)}); return true;
    },IntPtr.Zero); return result.ToArray();
  }
  public static void Focus(string id) {
    IntPtr h=new IntPtr(Convert.ToInt64(id.StartsWith("0x")?id.Substring(2):id,id.StartsWith("0x")?16:10));
    uint pid; uint other=GetWindowThreadProcessId(GetForegroundWindow(),out pid), self=GetCurrentThreadId();
    bool attached=other!=self && AttachThreadInput(self,other,true);
    try { ShowWindow(h,9); if(!SetForegroundWindow(h)) throw new Exception("Windows foreground lock refused focus"); }
    finally { if(attached) AttachThreadInput(self,other,false); }
  }
  public static void Shot(string file,int x,int y,int width,int height,int maxWidth,string format,int quality) {
    using(var image=new Bitmap(width,height)) {
      using(var g=Graphics.FromImage(image)) g.CopyFromScreen(x,y,0,0,new Size(width,height));
      int w=maxWidth>0?Math.Min(width,maxWidth):width, h=Math.Max(1,(int)Math.Round((double)height*w/width));
      using(var scaled=new Bitmap(image,new Size(w,h))) {
        if(format=="jpeg") { var enc=Array.Find(ImageCodecInfo.GetImageEncoders(), e=>e.MimeType=="image/jpeg"); using(var p=new EncoderParameters(1)) { p.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,(long)quality); scaled.Save(file,enc,p); } }
        else scaled.Save(file,ImageFormat.Png);
      }
    }
  }
}
'@
[RigsControl]::Init()
function Displays {
  @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{id=$_.DeviceName;name=$_.DeviceName;x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height;scale=1;primary=$_.Primary} })
}
try {
  while ($null -ne ($line = [RigsControl]::NextLine())) {
    $req = $null
    try {
      $req = $line | ConvertFrom-Json
      $result = @{}
      switch ($req.op) {
        'probe' { $result = @{locked=[RigsControl]::Locked();displays=@(Displays)} }
        'locked' { $result = @{locked=[RigsControl]::Locked()} }
        'windows' { $result = @([RigsControl]::Windows()) }
        'focus' { [RigsControl]::Focus([string]$req.windowId); $result=@{ok=$true} }
        'move' {
          $ds=@(Displays); $d=$ds | Where-Object {$_.id -eq $req.display} | Select-Object -First 1
          if(!$d) { $d=$ds | Where-Object {$_.primary} | Select-Object -First 1 }
          [RigsControl]::Move([int]($d.x+$req.x),[int]($d.y+$req.y))
        }
        'button' { [RigsControl]::Button([string]$req.button,[bool]$req.down) }
        'scroll' { [RigsControl]::Scroll([int]$req.dx,[int]$req.dy) }
        'key' { [RigsControl]::Key([string]$req.key,[bool]$req.down) }
        'type' { [RigsControl]::Type([string]$req.text,[int]$req.delayMs); $result=@{typed=$req.text.Length;via='unicode'} }
        'shot' {
          $ds=@(Displays); $d=$ds | Where-Object {$_.id -eq $req.display} | Select-Object -First 1
          if(!$d) { $d=$ds | Where-Object {$_.primary} | Select-Object -First 1 }
          $x=$d.x; $y=$d.y; $w=$d.width; $h=$d.height
          if($req.window) { throw 'Window capture unavailable; pass a region' }
          if($req.region) { $x+=$req.region.x; $y+=$req.region.y; $w=$req.region.width; $h=$req.region.height }
          [RigsControl]::Shot([string]$req.file,$x,$y,$w,$h,[int]$req.maxWidth,[string]$req.format,[int]$req.quality)
          $result=@{file=$req.file;display=$d.id;sourceWidth=$w;sourceHeight=$h}
        }
        'release' { [RigsControl]::Release() }
        'stop' { [RigsControl]::Release() }
        default { throw "Unsupported operation: $($req.op)" }
      }
      [Console]::WriteLine((@{id=$req.id;ok=$true;result=$result} | ConvertTo-Json -Compress -Depth 12))
      if ($req.op -eq 'stop') { break }
    } catch {
      [RigsControl]::Release()
      [Console]::WriteLine((@{id=$req.id;ok=$false;error=@{code='unsupported';message=$_.Exception.Message}} | ConvertTo-Json -Compress -Depth 5))
    }
  }
} finally { [RigsControl]::Release() }
