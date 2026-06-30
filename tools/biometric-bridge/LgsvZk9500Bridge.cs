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

public class BridgeCommandPollResponse
{
    public BridgeCommand command { get; set; }
}

public class BridgeCommand
{
    public int command_id { get; set; }
    public string command_type { get; set; }
    public int employee_id { get; set; }
    public string employee_code { get; set; }
    public string employee_name { get; set; }
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
    static volatile bool CommandInProgress = false;

    public static void Main(string[] args)
    {
        Console.Title = "LGSV HR ZK9500 Biometric Bridge";
        ConfigureSecureTransport();
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

        var commandWorker = new Thread(BridgeCommandLoop);
        commandWorker.IsBackground = true;
        commandWorker.Start();
        Log("AWS command polling started. Polling " + BuildStationCommandUrl("/next"));

        using (var listener = new HttpListener())
        {
            listener.Prefixes.Add(config.listener_prefix);
            var loopbackPrefix = BuildLoopbackListenerPrefix(config.listener_prefix);
            if (!string.Equals(loopbackPrefix, config.listener_prefix, StringComparison.OrdinalIgnoreCase))
            {
                listener.Prefixes.Add(loopbackPrefix);
            }
            listener.Start();
            Console.WriteLine("LGSV ZK9500 bridge running at " + string.Join(", ", listener.Prefixes.Cast<string>()));
            Console.WriteLine("Endpoints: GET /health, POST /enroll, POST /verify, POST /scan");

            while (true)
            {
                var context = listener.GetContext();
                ThreadPool.QueueUserWorkItem(_ => HandleRequest(context));
            }
        }
    }

    static string BuildLoopbackListenerPrefix(string configuredPrefix)
    {
        Uri configuredUri;
        if (!Uri.TryCreate(configuredPrefix, UriKind.Absolute, out configuredUri))
        {
            return "http://127.0.0.1:8787/";
        }

        var builder = new UriBuilder(configuredUri)
        {
            Host = "127.0.0.1"
        };
        return builder.Uri.AbsoluteUri;
    }

    static string BuildStationCommandUrl(string suffix)
    {
        var attendanceUrl = string.IsNullOrWhiteSpace(config.hris_attendance_url)
            ? "http://localhost:3000/api/biometric/station-attendance"
            : config.hris_attendance_url.Trim();

        var marker = "/station-attendance";
        var index = attendanceUrl.LastIndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (index >= 0)
        {
            return attendanceUrl.Substring(0, index) + "/station-command" + suffix;
        }

        Uri uri;
        if (Uri.TryCreate(attendanceUrl, UriKind.Absolute, out uri))
        {
            return uri.GetLeftPart(UriPartial.Authority) + "/api/biometric/station-command" + suffix;
        }
        return "http://localhost:3000/api/biometric/station-command" + suffix;
    }

    static void ConfigureSecureTransport()
    {
        // .NET Framework can otherwise default to obsolete TLS versions on
        // older Windows installations. Prefer TLS 1.3 when SChannel supports
        // it, while retaining TLS 1.2 for the AWS HTTPS compatibility floor.
        const SecurityProtocolType Tls13 = (SecurityProtocolType)12288;
        try
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | Tls13;
        }
        catch (NotSupportedException)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
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
            var origin = context.Request.Headers["Origin"] ?? "-";
            Log("HTTP " + context.Request.HttpMethod + " " + context.Request.Url.AbsolutePath + " origin=" + origin);
            AddCors(context);
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
            if (context.Request.HttpMethod == "GET" && path == "verify-page")
            {
                VerifyPage(context);
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

    static void VerifyPage(HttpListenerContext context)
    {
        int expectedEmployeeId;
        if (!int.TryParse(context.Request.QueryString["employee_id"], out expectedEmployeeId) || expectedEmployeeId <= 0)
        {
            RespondHtml(context, 400, BuildVerifyPage("Missing employee", false, "employee_id is required.", ""));
            return;
        }

        try
        {
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
                Log("VERIFY PAGE no match. expected_employee_id=" + expectedEmployeeId + " score=" + score);
                RespondHtml(context, 200, BuildVerifyPage("No match", false, "Fingerprint was not matched to an enrolled employee.", "Score: " + score));
                return;
            }

            var store = ReadStore();
            var record = store.templates.FirstOrDefault(t => t.employee_id == fid && t.is_active);
            bool matched = fid == expectedEmployeeId;
            Log("VERIFY PAGE matched employee " + fid + " expected " + expectedEmployeeId + " score " + score);
            var employeeLabel = record == null
                ? ("Employee ID " + fid)
                : ((record.employee_name ?? "").Trim() + " " + (string.IsNullOrWhiteSpace(record.employee_code) ? "" : "(" + record.employee_code + ")")).Trim();
            var detail = "Expected employee ID: " + expectedEmployeeId + "<br>Matched: " + EscapeHtml(employeeLabel) + "<br>Score: " + score;
            RespondHtml(context, 200, BuildVerifyPage(
                matched ? "Fingerprint verified" : "Different employee matched",
                matched,
                matched ? "Fingerprint matched the selected employee." : "The scanned finger belongs to a different enrolled employee.",
                detail
            ));
        }
        catch (Exception ex)
        {
            Log("VERIFY PAGE error. expected_employee_id=" + expectedEmployeeId + " error=" + ex.Message);
            RespondHtml(context, 500, BuildVerifyPage("Verification failed", false, EscapeHtml(ex.Message), "Make sure the scanner is connected and your finger is placed cleanly."));
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

    static void BridgeCommandLoop()
    {
        while (true)
        {
            try
            {
                var payload = new Dictionary<string, object>();
                payload["device_id"] = config.device_reference;
                var response = PostJson(BuildStationCommandUrl("/next"), Json.Serialize(payload), "");
                var poll = Json.Deserialize<BridgeCommandPollResponse>(response);
                if (poll != null && poll.command != null && poll.command.command_id > 0)
                {
                    ProcessBridgeCommand(poll.command);
                }
            }
            catch (Exception ex)
            {
                Log("COMMAND POLL error. " + ex.Message);
                Thread.Sleep(5000);
                continue;
            }
            Thread.Sleep(2000);
        }
    }

    static void ProcessBridgeCommand(BridgeCommand command)
    {
        CommandInProgress = true;
        try
        {
            Log("COMMAND " + command.command_id + " started. type=" + command.command_type + " employee_id=" + command.employee_id);
            var commandType = (command.command_type ?? "").ToUpperInvariant();
            if (commandType == "VERIFY")
            {
                CompleteBridgeCommand(command.command_id, true, VerifyForCommand(command), "");
                return;
            }
            if (commandType == "ENROLL")
            {
                CompleteBridgeCommand(command.command_id, true, EnrollForCommand(command), "");
                return;
            }
            CompleteBridgeCommand(command.command_id, false, null, "Unsupported command type.");
        }
        catch (Exception ex)
        {
            Log("COMMAND " + command.command_id + " failed. " + ex.Message);
            CompleteBridgeCommand(command.command_id, false, null, ex.Message);
        }
        finally
        {
            CommandInProgress = false;
        }
    }

    static Dictionary<string, object> VerifyForCommand(BridgeCommand command)
    {
        int captureSize;
        var template = CaptureTemplate(out captureSize);
        int fid = 0;
        int score = 0;
        int result;
        lock (DeviceLock)
        {
            result = device.Identify(template, ref fid, ref score);
        }

        var payload = new Dictionary<string, object>();
        payload["expected_employee_id"] = command.employee_id;
        payload["employee_id"] = fid;
        payload["score"] = score;
        payload["sdk_result"] = result;

        if (result != 0 || fid <= 0)
        {
            payload["matched"] = false;
            payload["error"] = "Fingerprint was not matched to an enrolled employee.";
            payload["message"] = "Fingerprint was not matched to an enrolled employee.";
            return payload;
        }

        var store = ReadStore();
        var record = store.templates.FirstOrDefault(t => t.employee_id == fid && t.is_active);
        var selectedEmployeeMatched = fid == command.employee_id;
        payload["matched"] = selectedEmployeeMatched;
        payload["employee_code"] = record == null ? "" : record.employee_code;
        payload["employee_name"] = record == null ? "" : record.employee_name;
        payload["message"] = selectedEmployeeMatched ? "Fingerprint matched selected employee." : "Fingerprint matched a different employee.";
        Log("COMMAND " + command.command_id + " verify matched employee " + fid + " expected " + command.employee_id + " score " + score);
        return payload;
    }

    static Dictionary<string, object> EnrollForCommand(BridgeCommand command)
    {
        var template = EnrollTemplate();
        var store = ReadStore();
        store.templates.RemoveAll(t => t.employee_id == command.employee_id);
        var record = new TemplateRecord
        {
            employee_id = command.employee_id,
            employee_code = command.employee_code ?? "",
            employee_name = command.employee_name ?? "",
            reference_id = "ZK9500-" + command.employee_id,
            template_base64 = Convert.ToBase64String(template),
            is_active = true,
            enrolled_at = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
        };
        store.templates.Add(record);
        WriteStore(store);
        LoadTemplatesIntoMatcher();

        var payload = new Dictionary<string, object>();
        payload["employee_id"] = command.employee_id;
        payload["employee_code"] = record.employee_code;
        payload["employee_name"] = record.employee_name;
        payload["reference_id"] = record.reference_id;
        payload["message"] = "Fingerprint enrolled.";
        Log("COMMAND " + command.command_id + " enrolled employee " + command.employee_id);
        return payload;
    }

    static void CompleteBridgeCommand(int commandId, bool ok, Dictionary<string, object> result, string error)
    {
        var payload = new Dictionary<string, object>();
        payload["device_id"] = config.device_reference;
        payload["ok"] = ok;
        payload["result"] = result ?? new Dictionary<string, object>();
        payload["error"] = error ?? "";
        var response = PostJson(BuildStationCommandUrl("/" + commandId + "/complete"), Json.Serialize(payload), "");
        Log("COMMAND " + commandId + " completion posted. " + response);
    }

    static void BackgroundScannerLoop()
    {
        while (true)
        {
            try
            {
                if (CommandInProgress)
                {
                    Thread.Sleep(500);
                    continue;
                }
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

    static void AddCors(HttpListenerContext context)
    {
        var response = context.Response;
        var origin = context.Request.Headers["Origin"] ?? "";
        var allowedOrigin = origin == "https://lgsvhr.com"
            || origin == "https://www.lgsvhr.com"
            || origin.StartsWith("http://localhost:", StringComparison.OrdinalIgnoreCase)
            || origin.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase);

        if (allowedOrigin)
        {
            response.Headers["Access-Control-Allow-Origin"] = origin;
            response.Headers["Vary"] = "Origin";
        }
        response.Headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
        response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        response.Headers["Access-Control-Allow-Private-Network"] = "true";
        response.Headers["Access-Control-Max-Age"] = "600";
    }

    static string EscapeHtml(string value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return value
            .Replace("&", "&amp;")
            .Replace("<", "&lt;")
            .Replace(">", "&gt;")
            .Replace("\"", "&quot;")
            .Replace("'", "&#39;");
    }

    static string BuildVerifyPage(string title, bool ok, string message, string detail)
    {
        var color = ok ? "#00875a" : "#d32f2f";
        var background = ok ? "#e8fff4" : "#fff0f0";
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>LGSV ZK9500 Verification</title>"
            + "<style>body{font-family:Arial,sans-serif;background:#f6f8fb;color:#111827;margin:0;padding:40px;}"
            + ".card{max-width:620px;margin:0 auto;background:#fff;border:1px solid #d8dee9;padding:28px;box-shadow:0 12px 30px rgba(15,23,42,.08);}"
            + ".badge{display:inline-block;padding:8px 12px;border:1px solid " + color + ";background:" + background + ";color:" + color + ";font-weight:700;margin-bottom:16px;}"
            + "h1{font-size:24px;margin:0 0 12px;}p{line-height:1.5;}small{color:#475569;}button{margin-top:18px;padding:10px 14px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;}</style></head><body>"
            + "<div class=\"card\"><div class=\"badge\">" + (ok ? "Verified" : "Needs attention") + "</div>"
            + "<h1>" + EscapeHtml(title) + "</h1><p>" + message + "</p><p><small>" + detail + "</small></p>"
            + "<button onclick=\"window.close()\">Close tab</button></div></body></html>";
    }

    static void RespondHtml(HttpListenerContext context, int status, string html)
    {
        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.StatusCode = status;
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.ContentLength64 = bytes.Length;
        context.Response.OutputStream.Write(bytes, 0, bytes.Length);
        context.Response.OutputStream.Close();
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
