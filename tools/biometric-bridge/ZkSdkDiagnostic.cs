using System;
using libzkfpcsharp;

class ZkSdkDiagnostic
{
    static void Main()
    {
        try
        {
            Console.WriteLine("Low-level zkfp2 test");
            int init = zkfp2.Init();
            Console.WriteLine("zkfp2.Init = " + init);
            Console.WriteLine("zkfp2.GetDeviceCount = " + zkfp2.GetDeviceCount());
            IntPtr handle = zkfp2.OpenDevice(0);
            Console.WriteLine("zkfp2.OpenDevice = " + handle);
            if (handle != IntPtr.Zero) zkfp2.CloseDevice(handle);
            zkfp2.Terminate();
        }
        catch (Exception ex)
        {
            Console.WriteLine("Low-level exception: " + ex.Message);
        }

        try
        {
            Console.WriteLine("High-level zkfp test");
            var fp = new zkfp();
            int init = fp.Initialize();
            Console.WriteLine("zkfp.Initialize = " + init);
            Console.WriteLine("zkfp.GetDeviceCount = " + fp.GetDeviceCount());
            int open = fp.OpenDevice(0);
            Console.WriteLine("zkfp.OpenDevice = " + open);
            if (open == 0) fp.CloseDevice();
            fp.Finalize();
        }
        catch (Exception ex)
        {
            Console.WriteLine("High-level exception: " + ex.Message);
        }
    }
}
