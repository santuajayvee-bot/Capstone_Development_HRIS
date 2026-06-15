using System;
using System.Linq;
using System.Reflection;

class ZkReflector
{
    static void Main(string[] args)
    {
        var path = args.Length > 0 ? args[0] : @"C:\Windows\System32\libzkfpcsharp.dll";
        try
        {
            var asm = Assembly.LoadFrom(path);
            Console.WriteLine(asm.FullName);
            foreach (var type in asm.GetTypes())
            {
                Console.WriteLine("TYPE " + type.FullName);
                foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly).OrderBy(m => m.Name))
                {
                    Console.WriteLine("  " + method);
                }
            }
        }
        catch (ReflectionTypeLoadException ex)
        {
            Console.WriteLine(ex.Message);
            foreach (var loader in ex.LoaderExceptions) Console.WriteLine(loader.Message);
        }
        catch (Exception ex)
        {
            Console.WriteLine(ex.GetType().FullName + ": " + ex.Message);
        }
    }
}
