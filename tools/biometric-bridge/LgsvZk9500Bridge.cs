using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using libzkfpcsharp;

public class TemplateRecord
{
    public int employee_id { get; set; }
    public string employee_code { get; set; }
    public string employee_name { get; set; }
    public string reference_id { get; set; }
    public string template_base64 { get; set; }
    public bool is_active { get; set; }
    public string enrolled_at { get; set; }
}

public class BridgeStore
{
    public List<TemplateRecord> templates { get; set; }
}

public class ScanRequest
{
    public int employee_id { get; set; }
    public string employee_code { get; set; }
    public string employee_name { get; set; }
    public string scan_type { get; set; }
    public string hris_api_url { get; set; }
    public string auth_token { get; set; }
}

public class BridgeConfig
{
    public string device_reference { get; set; }
    public string hris_attendance_url { get; set; }
    public string auth_header_name { get; set; }
    public string auth_secret { get; set; }
    public bool background_scanner_enabled { get; set; }
    public int duplicate_local_cooldown_seconds { get; set; }
    public int scanner_idle_delay_ms { get; set; }
    public string listener_prefix { get; set; }
}

public class Program
{
    const string DefaultDeviceReference = "ZK9500-LOCAL-001";
    const int TemplateSize = 2048;
    const int CaptureTimeoutSeconds = 20;
    static int imageWidth = 256;
    static int imageHeight = 360;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string StoreDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "LGSV_HR",
        "ZK9500Bridge"
    );
    static readonly string StorePath = Path.Combine(StoreDir, "templates.json");
    static readonly string ConfigPath = Path.Combine(StoreDir, "bridge-config.json");
    static readonly string LogPath = Path.Combine(StoreDir, "bridge-service.log");

    static zkfp device = new zkfp();
    static BridgeConfig config;
    static readonly object DeviceLock = new object();
    static readonly Dictionary<int, DateTime> LastPostedByEmployee = new Dictionary<int, DateTime>();

    public static void Main(string[] args)
    {
        Console.Title = "LGSV HR ZK9500 Biometric Bridge";
        Directory.CreateDirectory(StoreDir);
        config = ReadConfig();
        InitializeDevice();
        LoadTemplatesIntoMatcher();

        if (config.background_scanner_enabled)
        {
            var worker = new Thread(BackgroundScannerLoop);
            worker.IsBackground = true;
            worker.Start();
            Log("Background scanner mode started. Posting to " + config.hris_attendance_url);
        }

        using (var listener = new HttpListener())
        {
            listener.Prefixes.Add(config.listener_prefix);
            listener.Start();
            Console.WriteLine("LGSV ZK9500 bridge running at " + config.listener_prefix);
            Console.WriteLine("Endpoints: GET /health, POST /enroll, POST /verify, POST /scan");

            while (true)
            {
                var context = listener.GetContext();
                ThreadPool.QueueUserWorkItem(_ => HandleRequest(context));
            }
        }
    }

    static void InitializeDevice()
    {
        int init = device.Initialize();
        if (init != 0) throw new Exception("ZKFinger SDK initialization failed. Code: " + init);

        int count = device.GetDeviceCount();
        if (count <= 0) throw new Exception("No ZK9500 fingerprint scanner detected.");

        int open = device.OpenDevice(0);
        if (open != 0) throw new Exception("Unable to open ZK9500 device. Code: " + open);

        ReadImageSize();
        Console.WriteLine("ZK9500 ready. Device count: " + count);
        Console.WriteLine("Image size: " + imageWidth + "x" + imageHeight);
    }

    static BridgeConfig DefaultConfig()
    {
        return new BridgeConfig
        {
            device_reference = DefaultDeviceReference,
            hris_attendance_url = "http://localhost:3000/api/biometric/station-attendance",
            auth_header_name = "x-biometric-api-key",
            auth_secret = "",
            background_scanner_enabled = true,
            duplicate_local_cooldown_seconds = 60,
            scanner_idle_delay_ms = 600,
            listener_prefix = "http://localhost:8787/"
        };
    }

    static BridgeConfig ReadConfig()
    {
        if (!File.Exists(ConfigPath))
        {
            var defaults = DefaultConfig();
            File.WriteAllText(ConfigPath, Json.Serialize(defaults));
            Console.WriteLine("Created bridge config: " + ConfigPath);
            Console.WriteLine("Set auth_secret in this file if your HRIS biometric device requires an API key.");
            return defaults;
        }

        var loaded = Json.Deserialize<BridgeConfig>(File.ReadAllText(ConfigPath)) ?? DefaultConfig();
        var defaultsConfig = DefaultConfig();
        if (string.IsNullOrWhiteSpace(loaded.device_reference)) loaded.device_reference = defaultsConfig.device_reference;
        if (string.IsNullOrWhiteSpace(loaded.hris_attendance_url)) loaded.hris_attendance_url = defaultsConfig.hris_attendance_url;
        if (string.IsNullOrWhiteSpace(loaded.auth_header_name)) loaded.auth_header_name = defaultsConfig.auth_header_name;
        if (loaded.duplicate_local_cooldown_seconds <= 0) loaded.duplicate_local_cooldown_seconds = defaultsConfig.duplicate_local_cooldown_seconds;
        if (loaded.scanner_idle_delay_ms <= 0) loaded.scanner_idle_delay_ms = defaultsConfig.scanner_idle_delay_ms;
        if (string.IsNullOrWhiteSpace(loaded.listener_prefix)) loaded.listener_prefix = defaultsConfig.listener_prefix;
        return loaded;
    }

    static void Log(string message)
    {
        var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message;
        Console.WriteLine(line);
        try
        {
            File.AppendAllText(LogPath, line + Environment.NewLine);
        }
        catch
        {
            // Console logging is enough if ProgramData is temporarily unavailable.
        }
    }

    static void ReadImageSize()
    {
        var buffer = new byte[4];
        int size = 4;
        int widthResult = device.GetParameters(1, buffer, ref size);
        if (widthResult == 0)
        {
            int value = 0;
            if (zkfp2.ByteArray2Int(buffer, ref value) && value > 0) imageWidth = value;
        }

        buffer = new byte[4];
        size = 4;
        int heightResult = device.GetParameters(2, buffer, ref size);
        if (heightResult == 0)
        {
            int value = 0;
            if (zkfp2.ByteArray2Int(buffer, ref value) && value > 0) imageHeight = value;
        }
    }

    static BridgeStore ReadStore()
    {
        if (!File.Exists(StorePath)) return new BridgeStore { templates = new List<TemplateRecord>() };
        var store = Json.Deserialize<BridgeStore>(File.ReadAllText(StorePath));
        if (store.templates == null) store.templates = new List<TemplateRecord>();
        return store;
    }

    static void WriteStore(BridgeStore store)
    {
        File.WriteAllText(StorePath, Json.Serialize(store));
    }

    static void LoadTemplatesIntoMatcher()
    {
        device.Clear();
        foreach (var item in ReadStore().templates.Where(t => t.is_active))
        {
            try
            {
                device.AddRegTemplate(item.employee_id, Convert.FromBase64String(item.template_base64));
            }
            catch (Exception ex)
            {
                Console.WriteLine("Template load skipped for employee " + item.employee_id + ": " + ex.Message);
            }
        }
    }

    static byte[] CaptureTemplate(out int size)
    {
        lock (DeviceLock)
        {
            var image = new byte[Math.Max(1, imageWidth * imageHeight)];
            var template = new byte[TemplateSize];
            size = TemplateSize;
            var deadline = DateTime.UtcNow.AddSeconds(CaptureTimeoutSeconds);

            while (DateTime.UtcNow < deadline)
            {
                int captureSize = TemplateSize;
                int result = device.AcquireFingerprint(image, template, ref captureSize);
                if (result == 0 && captureSize > 0)
                {
                    size = captureSize;
                    var exact = new byte[captureSize];
                    Buffer.BlockCopy(template, 0, exact, 0, captureSize);
                    return exact;
                }
                Thread.Sleep(250);
            }

            throw new Exception("Fingerprint scan timed out. Place finger firmly on the ZK9500 scanner.");
        }
    }

    static byte[] TryCaptureTemplateOnce(out int size)
    {
        lock (DeviceLock)
        {
            var image = new byte[Math.Max(1, imageWidth * imageHeight)];
            var template = new byte[TemplateSize];
            int captureSize = TemplateSize;
            int result = device.AcquireFingerprint(image, template, ref captureSize);
            if (result == 0 && captureSize > 0)
            {
                size = captureSize;
                var exact = new byte[captureSize];
                Buffer.BlockCopy(template, 0, exact, 0, captureSize);
                return exact;
            }
            size = 0;
            return null;
        }
    }

    static byte[] EnrollTemplate()
    {
        Console.WriteLine("Enrollment started. Capture the same finger 3 times.");
        int s1, s2, s3;
        var t1 = CaptureTemplate(out s1);
        Console.WriteLine("Capture 1 accepted. Lift finger, then scan again.");
        Thread.Sleep(1200);
        var t2 = CaptureTemplate(out s2);
        Console.WriteLine("Capture 2 accepted. Lift finger, then scan again.");
        Thread.Sleep(1200);
        var t3 = CaptureTemplate(out s3);

        var merged = new byte[TemplateSize];
        int mergedSize = TemplateSize;
        int result = device.GenerateRegTemplate(t1, t2, t3, merged, ref mergedSize);
        if (result != 0 || mergedSize <= 0) throw new Exception("Fingerprint enrollment merge failed. Code: " + result);

        var exact = new byte[mergedSize];
        Buffer.BlockCopy(merged, 0, exact, 0, mergedSize);
        return exact;
    }

    static void HandleRequest(HttpListenerContext context)
    {
        try
        {
            AddCors(context.Response);
            if (context.Request.HttpMethod == "OPTIONS")
            {
                Respond(context, 204, new { ok = true });
                return;
            }

            string path = context.Request.Url.AbsolutePath.Trim('/').ToLowerInvariant();
            if (context.Request.HttpMethod == "GET" && path == "health")
            {
                Respond(context, 200, new { ok = true, device_id = config.device_reference, status = "ZK9500 bridge running", background_scanner_enabled = config.background_scanner_enabled });
                return;
            }
            if (context.Request.HttpMethod == "POST" && path == "enroll")
            {
                Enroll(context);
                return;
            }
            if (context.Request.HttpMethod == "POST" && path == "verify")
            {
                Verify(context);
                return;
            }
            if (context.Request.HttpMethod == "POST" && path == "scan")
            {
                Scan(context);
                return;
            }

            Respond(context, 404, new { error = "Endpoint not found." });
        }
        catch (Exception ex)
        {
            Console.WriteLine("ERROR: " + ex.Message);
            Respond(context, 500, new { error = ex.Message });
        }
    }

    static ScanRequest ReadRequest(HttpListenerRequest request)
    {
        using (var reader = new StreamReader(request.InputStream, request.ContentEncoding))
        {
            var body = reader.ReadToEnd();
            return string.IsNullOrWhiteSpace(body) ? new ScanRequest() : Json.Deserialize<ScanRequest>(body);
        }
    }

    static void Enroll(HttpListenerContext context)
    {
        var body = ReadRequest(context.Request);
        if (body.employee_id <= 0) throw new Exception("employee_id is required.");

        var template = EnrollTemplate();
        var store = ReadStore();
        store.templates.RemoveAll(t => t.employee_id == body.employee_id);
        var record = new TemplateRecord
        {
            employee_id = body.employee_id,
            employee_code = body.employee_code ?? "",
            employee_name = body.employee_name ?? "",
            reference_id = "ZK9500-" + body.employee_id,
            template_base64 = Convert.ToBase64String(template),
            is_active = true,
            enrolled_at = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
        };
        store.templates.Add(record);
        WriteStore(store);
        LoadTemplatesIntoMatcher();

        Console.WriteLine("Enrolled employee " + body.employee_id);
        Respond(context, 200, new { message = "Fingerprint enrolled.", employee_id = body.employee_id, reference_id = record.reference_id });
    }

    static void Verify(HttpListenerContext context)
    {
        var body = ReadRequest(context.Request);
        if (body.employee_id <= 0) throw new Exception("employee_id is required.");

        int captureSize;
        var template = CaptureTemplate(out captureSize);
        int fid = 0;
        int score = 0;
        int result;
        lock (DeviceLock)
        {
            result = device.Identify(template, ref fid, ref score);
        }
        if (result != 0 || fid <= 0)
        {
            Respond(context, 404, new { matched = false, error = "Fingerprint was not matched to an enrolled employee.", score = score });
            return;
        }

        var store = ReadStore();
        var record = store.templates.FirstOrDefault(t => t.employee_id == fid && t.is_active);
        bool selectedEmployeeMatched = fid == body.employee_id;
        Console.WriteLine("VERIFY matched employee " + fid + " score " + score);
        Respond(context, 200, new
        {
            matched = selectedEmployeeMatched,
            employee_id = fid,
            expected_employee_id = body.employee_id,
            employee_code = record == null ? "" : record.employee_code,
            employee_name = record == null ? "" : record.employee_name,
            score = score,
            message = selectedEmployeeMatched ? "Fingerprint matched selected employee." : "Fingerprint matched a different employee."
        });
    }

    static void Scan(HttpListenerContext context)
    {
        var body = ReadRequest(context.Request);
        var hrisApiUrl = string.IsNullOrWhiteSpace(body.hris_api_url)
            ? "http://localhost:3000/api/biometric/attendance"
            : body.hris_api_url;
        var scanType = string.IsNullOrWhiteSpace(body.scan_type) ? "AUTO" : body.scan_type.ToUpperInvariant();

        int captureSize;
        var template = CaptureTemplate(out captureSize);
        int fid = 0;
        int score = 0;
        int result;
        lock (DeviceLock)
        {
            result = device.Identify(template, ref fid, ref score);
        }
        if (result != 0 || fid <= 0)
        {
            Respond(context, 404, new { error = "Fingerprint was not matched to an enrolled employee.", score = score });
            return;
        }

        var payload = new Dictionary<string, object>();
        payload["employee_id"] = fid;
        payload["device_id"] = config.device_reference;
        payload["scan_type"] = scanType;
        payload["scan_time"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:sszzz");
        payload["verification_score"] = score;

        var response = PostJson(hrisApiUrl, Json.Serialize(payload), body.auth_token);
        Console.WriteLine(scanType + " posted for employee " + fid + " score " + score);
        Respond(context, 200, new { message = "Biometric scan posted to HRIS.", employee_id = fid, score = score, hris_response = response });
    }

    static void BackgroundScannerLoop()
    {
        while (true)
        {
            try
            {
                int captureSize;
                var template = TryCaptureTemplateOnce(out captureSize);
                if (template == null)
                {
                    Thread.Sleep(config.scanner_idle_delay_ms);
                    continue;
                }
                Log("STEP 1: Fingerprint detected.");

                int fid = 0;
                int score = 0;
                int result;
                lock (DeviceLock)
                {
                    result = device.Identify(template, ref fid, ref score);
                }
                if (result != 0 || fid <= 0)
                {
                    Log("STEP 2: Employee identification failed. Score: " + score + ", SDK result: " + result);
                    Thread.Sleep(config.scanner_idle_delay_ms);
                    continue;
                }
                Log("STEP 2: Employee identified. employee_id=" + fid + ", score=" + score);

                if (IsLocalDuplicate(fid))
                {
                    Log("Duplicate local scan ignored for employee " + fid);
                    Thread.Sleep(config.scanner_idle_delay_ms);
                    continue;
                }

                var payload = new Dictionary<string, object>();
                payload["employee_id"] = fid;
                payload["device_id"] = config.device_reference;
                payload["scan_time"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:sszzz");
                payload["verification_score"] = score;

                var jsonPayload = Json.Serialize(payload);
                Log("STEP 3: Attendance payload generated. " + jsonPayload);
                Log("STEP 3: Attendance POST sent to " + config.hris_attendance_url);
                var response = PostJson(config.hris_attendance_url, jsonPayload, "");
                RememberLocalPost(fid);
                Log("STEP 3: API response received. " + response);
            }
            catch (Exception ex)
            {
                Log("STEP 3: API failure or scanner error. " + ex.Message);
                Thread.Sleep(2000);
            }
        }
    }

    static bool IsLocalDuplicate(int employeeId)
    {
        DateTime last;
        if (!LastPostedByEmployee.TryGetValue(employeeId, out last)) return false;
        return (DateTime.UtcNow - last).TotalSeconds < config.duplicate_local_cooldown_seconds;
    }

    static void RememberLocalPost(int employeeId)
    {
        LastPostedByEmployee[employeeId] = DateTime.UtcNow;
    }

    static string PostJson(string url, string json, string token)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = "POST";
        request.ContentType = "application/json";
        request.ContentLength = bytes.Length;
        if (!string.IsNullOrWhiteSpace(token)) request.Headers["Authorization"] = "Bearer " + token;
        if (!string.IsNullOrWhiteSpace(config.auth_secret) && !string.IsNullOrWhiteSpace(config.auth_header_name))
        {
            request.Headers[config.auth_header_name] = config.auth_secret;
        }

        using (var stream = request.GetRequestStream())
        {
            stream.Write(bytes, 0, bytes.Length);
        }

        try
        {
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                return reader.ReadToEnd();
            }
        }
        catch (WebException ex)
        {
            if (ex.Response == null) throw;
            using (var response = (HttpWebResponse)ex.Response)
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                throw new Exception("HRIS rejected scan: " + reader.ReadToEnd());
            }
        }
    }

    static void AddCors(HttpListenerResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = "*";
        response.Headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
        response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    }

    static void Respond(HttpListenerContext context, int status, object payload)
    {
        var json = Json.Serialize(payload);
        var bytes = Encoding.UTF8.GetBytes(json);
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json";
        context.Response.ContentLength64 = bytes.Length;
        context.Response.OutputStream.Write(bytes, 0, bytes.Length);
        context.Response.OutputStream.Close();
    }
}
