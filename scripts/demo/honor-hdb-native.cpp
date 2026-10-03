// Version-locked bridge to the locally installed HonorSuite 11.0.0.736.
// This is a private vendor ABI, not an Honor-supported SDK. A hash mismatch
// fails closed. Each invocation negotiates its own normal HDB authentication;
// it never reads another process, reuses its credentials, or bypasses consent.
// Build only as x86 Release (/MD, _ITERATOR_DEBUG_LEVEL=0).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <bcrypt.h>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <cstdint>
#include <ctime>
#include <fcntl.h>
#include <io.h>
#include <string>
#include <vector>
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "ws2_32.lib")

#if !defined(_M_IX86)
#error This bridge requires the inspected PE32 x86 ABI.
#endif
#if _ITERATOR_DEBUG_LEVEL != 0
#error The vendor ABI requires release STL.
#endif
static_assert(sizeof(std::string) == 24, "Vendor string ABI mismatch");

static constexpr wchar_t kDirectory[] = L"C:\\Program Files (x86)\\HonorSuite";
static constexpr wchar_t kDll[] = L"C:\\Program Files (x86)\\HonorSuite\\CommBase.dll";
static constexpr wchar_t kAppBaseDll[] = L"C:\\Program Files (x86)\\HonorSuite\\AppBase.dll";
static constexpr char kExpectedSha[] = "02466c02fd33e828660070e9ec5e109a1406c68276438cb147d65dc926b11b4e";
static constexpr char kAppBaseSha[] = "bb34f71fdafadb977d02f3418df298294df6a2658a2b26450ad4890bd02ae90a";
static constexpr size_t kMaximumResponse = 4 * 1024 * 1024;
static constexpr DWORD kSocketTimeout = 5000;
static constexpr DWORD kTotalTimeout = 60000;

// Stderr contains static, machine-readable stage names only. No command,
// signature, remote failure payload, serial, or authentication bytes are logged.
static void stage(const char* name) {
    std::fprintf(stderr, "stage=%s\n", name);
    std::fflush(stderr);
}
struct Failure { const char* name; int code; };
[[noreturn]] static void fail(const char* name, int code) { throw Failure{name, code}; }

struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
struct Socket {
    SOCKET value = INVALID_SOCKET;
    ~Socket() { if (value != INVALID_SOCKET) closesocket(value); }
};
struct SensitiveText {
    std::string value;
    ~SensitiveText() { if (!value.empty()) SecureZeroMemory(&value[0], value.size()); }
};
enum class Mode { Validate, Doctor, Service, Push };
struct Options {
    Mode mode = Mode::Validate;
    int port = 0;
    std::string serial;
    std::string service;
    std::wstring localFile;
    std::string remoteFile;
};

static HANDLE gFinished = nullptr;
static bool gWinsockStarted = false;
static void* gTimer = nullptr;
static bool gTimerStarted = false;
static void (__thiscall* gTimerStop)(void*) = nullptr;
static HANDLE (__thiscall* gTimerThread)(void*) = nullptr;

static DWORD WINAPI watchdog(void*) {
    if (WaitForSingleObject(gFinished, kTotalTimeout) != WAIT_OBJECT_0) {
        // Only this helper is terminated. DLL detach can deadlock after a
        // vendor-thread failure, so do not run it on the timeout path. Do not
        // log first: a blocked stderr pipe or stdio lock must not delay exit.
        // The parent identifies a hard timeout by exit code 124.
        TerminateProcess(GetCurrentProcess(), 124);
    }
    return 0;
}

static bool hash_file(HANDLE file, char (&hex)[65]) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD objectSize = 0, returned = 0;
    unsigned char digest[32] = {};
    std::vector<unsigned char> object;
    bool ok = false;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
    do {
        if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &returned, 0) < 0) break;
        object.resize(objectSize);
        if (BCryptCreateHash(algorithm, &hash, object.data(), objectSize, nullptr, 0, 0) < 0) break;
        unsigned char buffer[65536];
        DWORD bytes = 0;
        bool readOk = true;
        for (;;) {
            if (!ReadFile(file, buffer, sizeof(buffer), &bytes, nullptr)) { readOk = false; break; }
            if (!bytes) break;
            if (BCryptHashData(hash, buffer, bytes, 0) < 0) { readOk = false; break; }
        }
        if (!readOk || BCryptFinishHash(hash, digest, sizeof(digest), 0) < 0) break;
        for (size_t i = 0; i < sizeof(digest); ++i) std::sprintf(hex + i * 2, "%02x", digest[i]);
        hex[64] = 0;
        ok = true;
    } while (false);
    if (hash) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return ok;
}

static std::string utf8(const wchar_t* input, size_t maximum, const char* error) {
    const size_t length = std::wcslen(input);
    if (!length || length > maximum) fail(error, 3);
    const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
        input, static_cast<int>(length), nullptr, 0, nullptr, nullptr);
    if (required <= 0 || static_cast<size_t>(required) > maximum) fail(error, 3);
    std::string output(static_cast<size_t>(required), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input, static_cast<int>(length),
        &output[0], required, nullptr, nullptr) != required || output.find('\0') != std::string::npos) fail(error, 3);
    return output;
}

static Options parse(int argc, wchar_t** argv) {
    Options options;
    if (argc == 2 && std::wcscmp(argv[1], L"--validate") == 0) return options;
    if (argc == 4 && std::wcscmp(argv[1], L"--doctor") == 0) options.mode = Mode::Doctor;
    else if (argc == 5 && std::wcscmp(argv[1], L"--service") == 0) options.mode = Mode::Service;
    else if (argc == 6 && std::wcscmp(argv[1], L"--push") == 0) options.mode = Mode::Push;
    else fail("invalid_arguments", 2);
    options.serial = utf8(argv[2], 128, "invalid_serial");
    for (const unsigned char c : options.serial) {
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_')) fail("invalid_serial", 3);
    }
    if (!*argv[3]) fail("invalid_port", 3);
    unsigned parsedPort = 0;
    for (const wchar_t* p = argv[3]; *p; ++p) {
        if (*p < L'0' || *p > L'9') fail("invalid_port", 3);
        parsedPort = parsedPort * 10 + (*p - L'0');
        if (parsedPort > 65535) fail("invalid_port", 3);
    }
    if (!parsedPort) fail("invalid_port", 3);
    options.port = static_cast<int>(parsedPort);
    options.service = options.mode == Mode::Doctor ?
        "shell:getprop ro.product.model; rc=$?; echo POTBOT_MODEL_EXIT:$rc" :
        options.mode == Mode::Push ? "sync:" : utf8(argv[4], 8192, "invalid_service");
    // Host services have their own unsigned protocol. Never authenticate or
    // select a transport for them using this device-service bridge.
    if (options.service.compare(0, 5, "host:") == 0 || options.service.compare(0, 5, "host-") == 0)
        fail("host_service_not_supported", 3);
    if (options.mode == Mode::Push) {
        options.localFile = argv[4];
        if (options.localFile.empty()) fail("invalid_local_file", 3);
        options.remoteFile = utf8(argv[5], 1024, "invalid_remote_file");
        if (options.remoteFile[0] != '/' || options.remoteFile.back() == '/') fail("invalid_remote_file", 3);
        for (const unsigned char c : options.remoteFile)
            if (c < 32 || c == 127 || c == ',') fail("invalid_remote_file", 3);
    }
    return options;
}

static void send_all(SOCKET socket, const char* data, size_t length) {
    while (length) {
        const int count = send(socket, data, static_cast<int>(length), 0);
        if (count <= 0) fail("socket_write_failed", 31);
        data += count;
        length -= count;
    }
}
static void receive_exact(SOCKET socket, char* data, size_t length) {
    while (length) {
        const int count = recv(socket, data, static_cast<int>(length), 0);
        if (count <= 0) fail(count == 0 ? "truncated_response" : "socket_read_failed", 32);
        data += count;
        length -= count;
    }
}
static void framed_request(SOCKET socket, const std::string& request) {
    if (request.empty() || request.size() > 65535) fail("invalid_request_length", 30);
    char prefix[5] = {};
    std::sprintf(prefix, "%04x", static_cast<unsigned>(request.size()));
    send_all(socket, prefix, 4);
    send_all(socket, request.data(), request.size());
    char status[4] = {};
    receive_exact(socket, status, sizeof(status));
    if (std::memcmp(status, "HDB ", 4) == 0) fail("hdb_auth_response_rejected", 34);
    if (std::memcmp(status, "FAIL", 4) == 0) fail("service_remote_failed", 35);
    if (std::memcmp(status, "OKAY", 4) != 0) fail("invalid_service_status", 36);
}

static void connect_loopback(Socket& socket, int port) {
    socket.value = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket.value == INVALID_SOCKET) fail("socket_create_failed", 31);
    const DWORD timeout = kSocketTimeout;
    if (setsockopt(socket.value, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)) ||
        setsockopt(socket.value, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)))
        fail("socket_timeout_setup_failed", 31);
    // SO_SNDTIMEO does not bound connect(). Use nonblocking connect + select.
    u_long nonblocking = 1;
    if (ioctlsocket(socket.value, FIONBIO, &nonblocking)) fail("socket_mode_failed", 31);
    sockaddr_in address = {};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<u_short>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::connect(socket.value, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR) {
        if (WSAGetLastError() != WSAEWOULDBLOCK) fail("socket_connect_failed", 31);
        fd_set writable, errors;
        FD_ZERO(&writable); FD_ZERO(&errors);
        FD_SET(socket.value, &writable); FD_SET(socket.value, &errors);
        timeval wait = {static_cast<long>(kSocketTimeout / 1000), 0};
        if (select(0, nullptr, &writable, &errors, &wait) <= 0 || FD_ISSET(socket.value, &errors))
            fail("socket_connect_failed", 31);
        int error = 0, size = sizeof(error);
        if (getsockopt(socket.value, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &size) || error)
            fail("socket_connect_failed", 31);
    }
    nonblocking = 0;
    if (ioctlsocket(socket.value, FIONBIO, &nonblocking)) fail("socket_mode_failed", 31);
}

using GetAuth = void* (__cdecl*)();
using ConnectAuth = int (__thiscall*)(void*, int, std::string);
using ExtendCommand = int (__thiscall*)(void*, const char*, char*, std::string);

static void open_service(Socket& socket, HMODULE module, void* auth, const Options& options) {
    connect_loopback(socket, options.port);
    framed_request(socket.value, "host:transport:" + options.serial);
    stage("transport_selected");
    char suffix[1024] = {};
    const auto extend = reinterpret_cast<ExtendCommand>(reinterpret_cast<unsigned char*>(module) + 0x87830);
    const int result = extend(auth, options.service.c_str(), suffix, options.serial);
    const size_t length = strnlen(suffix, sizeof(suffix));
    if (result != 0 || (length != 41 && length != 73)) {
        SecureZeroMemory(suffix, sizeof(suffix));
        fail("command_auth_failed", 30);
    }
    SensitiveText request;
    request.value = options.service;
    request.value.append(suffix, length);
    SecureZeroMemory(suffix, sizeof(suffix));
    stage("command_signed");
    framed_request(socket.value, request.value);
    stage("service_opened");
}

static std::string verified_model(const std::string& response) {
    std::string normalized;
    normalized.reserve(response.size());
    for (size_t i = 0; i < response.size(); ++i) {
        if (response[i] == '\r') {
            if (i + 1 >= response.size() || response[i + 1] != '\n') fail("doctor_response_invalid", 44);
            continue;
        }
        normalized.push_back(response[i]);
    }
    if (normalized.empty() || normalized.back() != '\n') fail("doctor_response_invalid", 44);
    normalized.pop_back();
    const size_t split = normalized.rfind('\n');
    if (split == std::string::npos) fail("doctor_response_invalid", 44);
    const std::string marker = normalized.substr(split + 1);
    if (marker != "POTBOT_MODEL_EXIT:0") {
        const std::string prefix = "POTBOT_MODEL_EXIT:";
        if (marker.compare(0, prefix.size(), prefix) != 0 || marker.size() <= prefix.size())
            fail("doctor_response_invalid", 44);
        for (size_t i = prefix.size(); i < marker.size(); ++i)
            if (marker[i] < '0' || marker[i] > '9') fail("doctor_response_invalid", 44);
        fail("doctor_command_failed", 43);
    }
    const std::string model = normalized.substr(0, split);
    if (model.empty() || model.size() > 200) fail("doctor_response_invalid", 44);
    for (size_t i = 0; i < model.size(); ++i) {
        const unsigned char c = model[i];
        const bool alphanumeric = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (!alphanumeric && (i == 0 || (c != ' ' && c != '.' && c != '_' && c != '+' &&
            c != '(' && c != ')' && c != '/' && c != '-'))) fail("doctor_response_invalid", 44);
    }
    return model + "\n";
}

static void read_service(SOCKET socket, bool doctor) {
    SensitiveText response;
    char buffer[65536];
    for (;;) {
        const int count = recv(socket, buffer, sizeof(buffer), 0);
        if (!count) break;
        if (count < 0) fail("socket_read_failed", 32);
        if (response.value.size() + count > kMaximumResponse) fail("response_too_large", 33);
        response.value.append(buffer, count);
        SecureZeroMemory(buffer, sizeof(buffer));
        // Buffer the whole response before emitting anything. Authentication
        // extensions may appear even after the initial smart-socket OKAY.
        if (response.value.compare(0, 4, "HDB ") == 0 || response.value.find("HDB AUTH") != std::string::npos)
            fail("hdb_auth_response_rejected", 34);
    }
    if (doctor) {
        response.value = verified_model(response.value);
        stage("doctor_command_exit_verified");
    }
    if (!response.value.empty() && std::fwrite(response.value.data(), 1, response.value.size(), stdout) != response.value.size())
        fail("stdout_write_failed", 37);
    if (std::fflush(stdout)) fail("stdout_write_failed", 37);
    stage("service_response_complete");
}

static void sync_header(SOCKET socket, const char* id, uint32_t value) {
    char header[8];
    std::memcpy(header, id, 4);
    for (unsigned i = 0; i < 4; ++i) header[i + 4] = static_cast<char>((value >> (8 * i)) & 255);
    send_all(socket, header, sizeof(header));
}
static void push_file(SOCKET socket, HANDLE localFile, const Options& options) {
    const std::string target = options.remoteFile + ",420"; // 0644, decimal wire format.
    sync_header(socket, "SEND", static_cast<uint32_t>(target.size()));
    send_all(socket, target.data(), target.size());
    char data[65536];
    DWORD bytes = 0;
    for (;;) {
        if (!ReadFile(localFile, data, sizeof(data), &bytes, nullptr)) fail("local_file_read_failed", 40);
        if (!bytes) break;
        sync_header(socket, "DATA", bytes);
        send_all(socket, data, bytes);
    }
    sync_header(socket, "DONE", static_cast<uint32_t>(std::time(nullptr)));
    char status[8] = {};
    receive_exact(socket, status, sizeof(status));
    if (std::memcmp(status, "HDB ", 4) == 0) fail("hdb_auth_response_rejected", 34);
    if (std::memcmp(status, "FAIL", 4) == 0) fail("sync_remote_failed", 41);
    if (std::memcmp(status, "OKAY", 4) != 0 || status[4] || status[5] || status[6] || status[7])
        fail("invalid_sync_status", 42);
    // Receipt of this explicit sync status is the success boundary. The socket
    // is closed by its owner; no package-manager command is ever implicit.
    stage("push_complete");
}

static void start_timer() {
    HMODULE appbase = GetModuleHandleW(L"AppBase.dll");
    if (!appbase) fail("timer_module_missing", 29);
    gTimer = reinterpret_cast<void*>(GetProcAddress(appbase,
        "?g_SysTimer@AppBaseBaseClass@@3VAppBaseLockTimer@1@A"));
    const auto setup = reinterpret_cast<int (__thiscall*)(void*)>(GetProcAddress(appbase,
        "?SetNew@AppBaseLockTimer@AppBaseBaseClass@@QAEHXZ"));
    const auto run = reinterpret_cast<void (__thiscall*)(void*)>(GetProcAddress(appbase,
        "?Run@AppBaseLockTimer@AppBaseBaseClass@@QAEXXZ"));
    gTimerStop = reinterpret_cast<void (__thiscall*)(void*)>(GetProcAddress(appbase,
        "?Stop@AppBaseLockTimer@AppBaseBaseClass@@QAEXXZ"));
    gTimerThread = reinterpret_cast<HANDLE (__thiscall*)(void*)>(GetProcAddress(appbase,
        "?GetThreadHandle@AppBaseLockThread@AppBaseBaseClass@@QAEPAXXZ"));
    if (!gTimer || !setup || !run || !gTimerStop || !gTimerThread) fail("timer_exports_missing", 29);
    if (setup(gTimer) != 1) fail("timer_setup_failed", 29);
    gTimerStarted = true;
    run(gTimer);
    const HANDLE thread = gTimerThread(gTimer);
    if (!thread || thread == INVALID_HANDLE_VALUE) fail("timer_start_failed", 29);
    stage("private_vendor_timer_started");
}

static void stop_timer() {
    if (!gTimerStarted) return;
    const HANDLE thread = gTimerThread(gTimer);
    gTimerStop(gTimer);
    if (!thread || thread == INVALID_HANDLE_VALUE || WaitForSingleObject(thread, 2000) != WAIT_OBJECT_0) {
        stage("timer_stop_failed");
        TerminateProcess(GetCurrentProcess(), 124);
    }
    // The vendor owns this handle. Do not CloseHandle it.
    gTimerStarted = false;
    stage("private_vendor_timer_stopped");
}

static int run_cpp(const Options& options) {
    Handle localFile;
    if (options.mode == Mode::Push) {
        localFile.value = CreateFileW(options.localFile.c_str(), GENERIC_READ, FILE_SHARE_READ,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
        BY_HANDLE_FILE_INFORMATION info = {};
        if (localFile.value == INVALID_HANDLE_VALUE || GetFileType(localFile.value) != FILE_TYPE_DISK ||
            !GetFileInformationByHandle(localFile.value, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
            fail("local_file_open_failed", 40);
    }
    stage("local_preflight_start");
    Handle file, appfile;
    file.value = CreateFileW(kDll, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    char digest[65] = {};
    if (file.value == INVALID_HANDLE_VALUE || !hash_file(file.value, digest) || std::strcmp(digest, kExpectedSha))
        fail("dll_hash_mismatch_or_unreadable", 11);
    stage("dll_hash_verified");
    appfile.value = CreateFileW(kAppBaseDll, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (appfile.value == INVALID_HANDLE_VALUE || !hash_file(appfile.value, digest) || std::strcmp(digest, kAppBaseSha))
        fail("appbase_hash_mismatch_or_unreadable", 11);
    stage("appbase_hash_verified");
    if (options.mode == Mode::Validate) {
        stage("local_preflight_complete");
        return 0; // No vendor code loading, timer, socket, or device operation.
    }
    if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS) || !AddDllDirectory(kDirectory))
        fail("dll_search_setup_failed", 12);
    WSADATA wsa = {};
    if (WSAStartup(MAKEWORD(2, 2), &wsa)) fail("winsock_init_failed", 14);
    gWinsockStarted = true;
    HMODULE module = LoadLibraryExW(kDll, nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
        LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    if (!module) fail("vendor_dll_load_failed", 15);
    const auto base = reinterpret_cast<unsigned char*>(module);
    const auto dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    const auto nt = reinterpret_cast<IMAGE_NT_HEADERS32*>(base + dos->e_lfanew);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || nt->Signature != IMAGE_NT_SIGNATURE ||
        nt->FileHeader.Machine != IMAGE_FILE_MACHINE_I386 || nt->OptionalHeader.SizeOfImage != 0x2D4000)
        fail("loaded_image_mismatch", 16);
    stage("vendor_dll_loaded");
    // Only initialize the two logging locks in this newly loaded DLL instance.
    // Do not start its log writer, which could persist authentication payloads.
    // No existing Suite process, authentication state, or code is modified.
    InitializeCriticalSection(reinterpret_cast<CRITICAL_SECTION*>(base + 0x2AD02C));
    InitializeCriticalSection(reinterpret_cast<CRITICAL_SECTION*>(base + 0x2AD050));
    stage("private_logging_locks_initialized");
    start_timer();
    const auto getter = reinterpret_cast<GetAuth>(base + 0x85830);
    const auto connectAuth = reinterpret_cast<ConnectAuth>(base + 0x86B40);
    void* auth = getter();
    if (!auth) fail("vendor_auth_singleton_failed", 24);
    stage("vendor_auth_connect_start");
    if (connectAuth(auth, options.port, options.serial) != 0) fail("vendor_auth_connect_failed", 25);
    stage("vendor_auth_connect_ok");
    Socket socket;
    open_service(socket, module, auth, options);
    if (options.mode == Mode::Push) push_file(socket.value, localFile.value, options);
    else read_service(socket.value, options.mode == Mode::Doctor);
    return 0;
}

// Keep SEH wrappers free of C++ objects requiring stack unwinding. An opaque
// vendor exception never prints registers, addresses, memory, or payloads.
static int run_guarded(const Options& options) {
    __try { return run_cpp(options); }
    __except (GetExceptionCode() == 0xE06D7363 ? EXCEPTION_CONTINUE_SEARCH : EXCEPTION_EXECUTE_HANDLER) {
        // /EHsc does not promise C++ unwinding for a real SEH fault. Do not
        // re-enter cleanup or stdio while vendor locks/state may be damaged.
        TerminateProcess(GetCurrentProcess(), 26);
        return 26;
    }
}
static void cleanup_guarded() {
    __try {
        stop_timer();
        if (gWinsockStarted) { WSACleanup(); gWinsockStarted = false; }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        stage("cleanup_exception");
        TerminateProcess(GetCurrentProcess(), 124);
    }
}

int wmain(int argc, wchar_t** argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    if (_setmode(_fileno(stdout), _O_BINARY) == -1) { stage("stdout_setup_failed"); return 37; }
    gFinished = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!gFinished) { stage("watchdog_setup_failed"); return 28; }
    HANDLE monitor = CreateThread(nullptr, 0, watchdog, nullptr, 0, nullptr);
    if (!monitor) { CloseHandle(gFinished); stage("watchdog_setup_failed"); return 28; }
    int result = 27;
    try {
        const Options options = parse(argc, argv);
        result = run_guarded(options);
    } catch (const Failure& error) {
        stage(error.name);
        result = error.code;
    } catch (...) {
        stage("cpp_exception");
    }
    cleanup_guarded();
    SetEvent(gFinished);
    if (WaitForSingleObject(monitor, 2000) != WAIT_OBJECT_0) {
        stage("watchdog_stop_failed");
        TerminateProcess(GetCurrentProcess(), 124);
    }
    CloseHandle(monitor);
    CloseHandle(gFinished);
    if (!result) stage("complete");
    return result;
}
