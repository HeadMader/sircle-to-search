// Win+Space is owned by the Windows shell (input-language switcher), so
// RegisterHotKey fails with ERROR_HOTKEY_ALREADY_REGISTERED. This helper takes
// the combo with a WH_KEYBOARD_LL hook instead: swallow Space while Win is
// held, inject a dummy key so releasing Win does not open the Start menu, and
// report the press on stdout for the Electron main process to consume.
using System;
using System.Runtime.InteropServices;
using System.Threading;

static class HotkeyHelper
{
    const int WH_KEYBOARD_LL = 13;
    const int WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104;
    const int VK_SPACE = 0x20, VK_LWIN = 0x5B, VK_RWIN = 0x5C;

    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }

    static IntPtr hook;
    static readonly LowLevelKeyboardProc proc = HookProc; // held so the GC never collects the delegate

    static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = wParam.ToInt32();
            if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
            {
                int vk = Marshal.ReadInt32(lParam); // KBDLLHOOKSTRUCT.vkCode
                bool winDown = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0
                            || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
                if (vk == VK_SPACE && winDown)
                {
                    SendDummyKey();
                    Console.WriteLine("HOTKEY");
                    Console.Out.Flush();
                    return (IntPtr)1; // swallow: no language switch
                }
            }
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }

    // A benign key while Win is held makes the shell treat it as a used combo,
    // so the following Win keyup does not toggle the Start menu.
    static void SendDummyKey()
    {
        var inputs = new INPUT[2];
        inputs[0].type = 1; // INPUT_KEYBOARD
        inputs[0].U.ki.wVk = 0xFF; // VK__none_
        inputs[1].type = 1;
        inputs[1].U.ki.wVk = 0xFF;
        inputs[1].U.ki.dwFlags = 2; // KEYEVENTF_KEYUP
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Main()
    {
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, IntPtr.Zero, 0);
        if (hook == IntPtr.Zero)
        {
            Console.WriteLine("HOOK_FAILED");
            return;
        }
        Console.WriteLine("READY");
        Console.Out.Flush();

        // Exit when the parent (Electron) dies and our stdin pipe closes,
        // otherwise the hook would keep eating Win+Space with no consumer.
        new Thread(() => { Console.In.Read(); Environment.Exit(0); }) { IsBackground = true }.Start();

        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) != 0) { }
    }
}
