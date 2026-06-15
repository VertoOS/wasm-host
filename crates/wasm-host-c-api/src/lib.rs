use std::{
    collections::HashMap,
    ffi::{c_char, CStr},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
#[cfg(not(target_arch = "wasm32"))]
use wasm_host_core::{
    register_native_host_commands, GatewayHttpBridgeWorker, NativeGatewayHttpTransport,
    NativeHostCommandSpec, NativeHostCommandWorker, NativeHttpBridgeWorker,
};
use wasm_host_core::{
    CancellationSource, CompletedProcess, EventBus, HostMount, HostProfile, HttpBridge, Limits,
    PackageCommandAlias, PackageSpec, RunRequest, SandboxOptions, SandboxState,
    VirtualExecutableBridge,
};

const DEFAULT_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const DEFAULT_EVENT_QUEUE_SIZE: usize = 4096;
const WASM_HOST_STATUS_OK: i32 = 0;
const WASM_HOST_STATUS_ERROR: i32 = 1;
const VERSION: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();

pub struct WasmHostRunResult {
    status: i32,
    returncode: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    error: Vec<u8>,
}

#[derive(Deserialize)]
struct FfiRunOptions {
    webc: String,
    command: Vec<String>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    package: Option<String>,
    #[serde(default)]
    aliases: Vec<FfiAlias>,
    #[serde(default)]
    mounts: Vec<FfiMount>,
    #[serde(default)]
    host_commands: Vec<FfiHostCommand>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    stdin_base64: Option<String>,
    #[serde(default)]
    output_limit: Option<usize>,
    #[serde(default)]
    timeout_seconds: Option<f64>,
    #[serde(default)]
    module_cache_dir: Option<String>,
    #[serde(default)]
    http_bridge: Option<String>,
}

#[derive(Deserialize)]
struct FfiAlias {
    alias: String,
    command: String,
}

#[derive(Deserialize)]
struct FfiMount {
    source: String,
    target: String,
    #[serde(default = "default_read_only")]
    read_only: bool,
}

#[derive(Deserialize)]
struct FfiHostCommand {
    guest_path: String,
    host_command: String,
}

#[no_mangle]
pub extern "C" fn wasm_host_version() -> *const c_char {
    VERSION.as_ptr().cast()
}

#[no_mangle]
pub extern "C" fn wasm_host_run_json(options_json: *const c_char) -> *mut WasmHostRunResult {
    let result = match std::panic::catch_unwind(|| parse_json_ptr(options_json).and_then(run_json))
    {
        Ok(Ok(process)) => result_from_process(process),
        Ok(Err(error)) => result_from_error(error.to_string()),
        Err(_) => result_from_error("wasm_host_run_json panicked".to_string()),
    };

    Box::into_raw(Box::new(result))
}

#[no_mangle]
pub extern "C" fn wasm_host_result_status(result: *const WasmHostRunResult) -> i32 {
    with_result(result, WASM_HOST_STATUS_ERROR, |result| result.status)
}

#[no_mangle]
pub extern "C" fn wasm_host_result_returncode(result: *const WasmHostRunResult) -> i32 {
    with_result(result, 125, |result| result.returncode)
}

#[no_mangle]
pub extern "C" fn wasm_host_result_stdout_ptr(result: *const WasmHostRunResult) -> *const u8 {
    with_result(result, std::ptr::null(), |result| {
        non_empty_ptr(&result.stdout).unwrap_or(std::ptr::null())
    })
}

#[no_mangle]
pub extern "C" fn wasm_host_result_stdout_len(result: *const WasmHostRunResult) -> usize {
    with_result(result, 0, |result| result.stdout.len())
}

#[no_mangle]
pub extern "C" fn wasm_host_result_stderr_ptr(result: *const WasmHostRunResult) -> *const u8 {
    with_result(result, std::ptr::null(), |result| {
        non_empty_ptr(&result.stderr).unwrap_or(std::ptr::null())
    })
}

#[no_mangle]
pub extern "C" fn wasm_host_result_stderr_len(result: *const WasmHostRunResult) -> usize {
    with_result(result, 0, |result| result.stderr.len())
}

#[no_mangle]
pub extern "C" fn wasm_host_result_error_ptr(result: *const WasmHostRunResult) -> *const u8 {
    with_result(result, std::ptr::null(), |result| {
        non_empty_ptr(&result.error).unwrap_or(std::ptr::null())
    })
}

#[no_mangle]
pub extern "C" fn wasm_host_result_error_len(result: *const WasmHostRunResult) -> usize {
    with_result(result, 0, |result| result.error.len())
}

#[no_mangle]
pub extern "C" fn wasm_host_result_free(result: *mut WasmHostRunResult) {
    if result.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(result));
    }
}

fn parse_json_ptr(options_json: *const c_char) -> Result<String> {
    if options_json.is_null() {
        return Err(anyhow!("options_json cannot be null"));
    }
    let options = unsafe { CStr::from_ptr(options_json) };
    options
        .to_str()
        .map(ToString::to_string)
        .context("options_json must be valid UTF-8")
}

fn run_json(options_json: String) -> Result<CompletedProcess> {
    let options: FfiRunOptions =
        serde_json::from_str(&options_json).context("unable to parse run options JSON")?;
    run_options(options)
}

fn result_from_process(process: CompletedProcess) -> WasmHostRunResult {
    WasmHostRunResult {
        status: WASM_HOST_STATUS_OK,
        returncode: process.returncode,
        stdout: process.stdout,
        stderr: process.stderr,
        error: Vec::new(),
    }
}

fn result_from_error(error: String) -> WasmHostRunResult {
    WasmHostRunResult {
        status: WASM_HOST_STATUS_ERROR,
        returncode: 125,
        stdout: Vec::new(),
        stderr: Vec::new(),
        error: error.into_bytes(),
    }
}

fn run_options(options: FfiRunOptions) -> Result<CompletedProcess> {
    if options.command.is_empty() {
        return Err(anyhow!("command cannot be empty"));
    }

    let profile = match options.profile {
        Some(profile) => HostProfile::parse(&profile)?,
        None => HostProfile::default(),
    };
    #[cfg(not(target_arch = "wasm32"))]
    let host_commands = {
        if !options.host_commands.is_empty() && profile != HostProfile::NativeFull {
            return Err(anyhow!(
                "host_commands require the native-full profile, current profile is {}",
                profile.as_str()
            ));
        }
        options
            .host_commands
            .into_iter()
            .map(|command| NativeHostCommandSpec::new(command.guest_path, command.host_command))
            .collect::<Result<Vec<_>>>()?
    };
    #[cfg(target_arch = "wasm32")]
    if !options.host_commands.is_empty() {
        return Err(anyhow!(
            "native host command bridge is not available on wasm32"
        ));
    }
    let package_name = options
        .package
        .unwrap_or_else(|| package_name(&options.webc));
    let aliases = options
        .aliases
        .into_iter()
        .map(|alias| PackageCommandAlias {
            alias: alias.alias,
            command: alias.command,
        })
        .collect::<Vec<_>>();
    let host_mounts = options
        .mounts
        .into_iter()
        .map(|mount| HostMount {
            source: mount.source,
            target: mount.target,
            read_only: mount.read_only,
        })
        .collect::<Vec<_>>();
    #[cfg(not(target_arch = "wasm32"))]
    let host_mounts_for_worker = host_mounts.clone();
    let stdin = options
        .stdin_base64
        .map(|stdin| {
            BASE64
                .decode(stdin)
                .context("stdin_base64 must be valid base64")
        })
        .transpose()?;
    let package = PackageSpec {
        name: package_name,
        webc_path: options.webc,
        content_sha256: "0".repeat(64),
        command_aliases: aliases,
    };
    let (http_bridge, _http_bridge_worker) = http_bridge_for_mode(options.http_bridge.as_deref())?;
    let sandbox_options = SandboxOptions {
        module_cache_dir: options.module_cache_dir.map(PathBuf::from),
        http_bridge,
    };
    let (events, _event_receiver) = EventBus::new(DEFAULT_EVENT_QUEUE_SIZE);
    let (virtual_executables, virtual_process_receiver) =
        VirtualExecutableBridge::new(DEFAULT_EVENT_QUEUE_SIZE);
    let state = SandboxState::new_with_profile_and_options(
        profile,
        HashMap::new(),
        host_mounts,
        vec![package],
        options.cwd.unwrap_or_else(|| "/work".to_string()),
        options.env,
        events,
        virtual_executables,
        sandbox_options,
    )?;
    #[cfg(not(target_arch = "wasm32"))]
    let _host_command_worker = {
        register_native_host_commands(&state, &host_commands)?;
        NativeHostCommandWorker::spawn(
            host_commands,
            host_mounts_for_worker,
            virtual_process_receiver,
        )
    };
    #[cfg(target_arch = "wasm32")]
    let _virtual_process_receiver = virtual_process_receiver;
    let cancellation = CancellationSource::new();
    state.run_blocking(
        RunRequest {
            args: options.command,
            input: stdin,
            env: None,
            cwd: None,
            limits: Limits {
                output_bytes: options.output_limit.unwrap_or(DEFAULT_OUTPUT_LIMIT),
                wall_time_seconds: options.timeout_seconds,
            },
        },
        cancellation.token(),
    )
}

#[cfg(not(target_arch = "wasm32"))]
fn http_bridge_for_mode(
    mode: Option<&str>,
) -> Result<(Option<HttpBridge>, Option<HttpBridgeWorker>)> {
    match mode.unwrap_or("off") {
        "off" => Ok((None, None)),
        "native" => {
            let (bridge, receiver) = HttpBridge::new(DEFAULT_EVENT_QUEUE_SIZE);
            let worker = NativeHttpBridgeWorker::spawn(receiver);
            Ok((
                Some(bridge),
                Some(HttpBridgeWorker::Native { _worker: worker }),
            ))
        }
        value if value.starts_with("gateway=") => {
            let endpoint = value
                .strip_prefix("gateway=")
                .expect("prefix should be present");
            if endpoint.is_empty() {
                return Err(anyhow!("HTTP gateway mode requires gateway=<url>"));
            }
            let (bridge, receiver) = HttpBridge::new(DEFAULT_EVENT_QUEUE_SIZE);
            let transport = NativeGatewayHttpTransport::new(endpoint)
                .map_err(|error| anyhow!("unable to configure HTTP gateway bridge: {error}"))?;
            let worker = GatewayHttpBridgeWorker::spawn(receiver, transport);
            Ok((
                Some(bridge),
                Some(HttpBridgeWorker::Gateway { _worker: worker }),
            ))
        }
        value => Err(anyhow!(
            "unknown HTTP bridge mode: {value}; expected off, native, or gateway=<url>"
        )),
    }
}

#[cfg(not(target_arch = "wasm32"))]
enum HttpBridgeWorker {
    Native { _worker: NativeHttpBridgeWorker },
    Gateway { _worker: GatewayHttpBridgeWorker },
}

#[cfg(target_arch = "wasm32")]
fn http_bridge_for_mode(mode: Option<&str>) -> Result<(Option<HttpBridge>, Option<()>)> {
    match mode.unwrap_or("off") {
        "off" => Ok((None, None)),
        "native" => Err(anyhow!(
            "native HTTP bridge mode is not available on wasm32"
        )),
        value if value.starts_with("gateway=") => Err(anyhow!(
            "gateway HTTP bridge mode is not available on wasm32"
        )),
        value => Err(anyhow!(
            "unknown HTTP bridge mode: {value}; expected off, native, or gateway=<url>"
        )),
    }
}

fn package_name(webc: &str) -> String {
    Path::new(webc)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("package")
        .to_string()
}

fn default_read_only() -> bool {
    true
}

fn with_result<T>(
    result: *const WasmHostRunResult,
    default: T,
    operation: impl FnOnce(&WasmHostRunResult) -> T,
) -> T {
    if result.is_null() {
        return default;
    }
    unsafe { operation(&*result) }
}

fn non_empty_ptr(data: &[u8]) -> Option<*const u8> {
    if data.is_empty() {
        None
    } else {
        Some(data.as_ptr())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_json_returns_owned_error_result() {
        let result = wasm_host_run_json(std::ptr::null());
        assert!(!result.is_null());
        assert_eq!(wasm_host_result_status(result), WASM_HOST_STATUS_ERROR);
        assert_eq!(wasm_host_result_returncode(result), 125);
        assert!(wasm_host_result_error_len(result) > 0);
        wasm_host_result_free(result);
    }

    #[test]
    fn invalid_json_returns_parse_error() {
        let options = std::ffi::CString::new("{").unwrap();
        let result = wasm_host_run_json(options.as_ptr());
        assert_eq!(wasm_host_result_status(result), WASM_HOST_STATUS_ERROR);
        assert_eq!(wasm_host_result_stdout_len(result), 0);
        assert_eq!(wasm_host_result_stderr_len(result), 0);
        let error = unsafe {
            std::slice::from_raw_parts(
                wasm_host_result_error_ptr(result),
                wasm_host_result_error_len(result),
            )
        };
        assert!(std::str::from_utf8(error)
            .unwrap()
            .contains("unable to parse run options JSON"));
        wasm_host_result_free(result);
    }

    #[test]
    fn empty_command_is_rejected_before_runtime_setup() {
        let options = std::ffi::CString::new(r#"{"webc":"missing.webc","command":[]}"#).unwrap();
        let result = wasm_host_run_json(options.as_ptr());
        assert_eq!(wasm_host_result_status(result), WASM_HOST_STATUS_ERROR);
        let error = unsafe {
            std::slice::from_raw_parts(
                wasm_host_result_error_ptr(result),
                wasm_host_result_error_len(result),
            )
        };
        assert_eq!(
            std::str::from_utf8(error).unwrap(),
            "command cannot be empty"
        );
        wasm_host_result_free(result);
    }

    #[test]
    fn mounts_default_to_read_only() {
        let options: FfiRunOptions = serde_json::from_str(
            r#"{"webc":"missing.webc","command":["tool"],"mounts":[{"source":".","target":"/workspace"}]}"#,
        )
        .unwrap();

        assert!(options.mounts[0].read_only);
    }

    #[test]
    fn unknown_http_bridge_mode_is_rejected_before_runtime_setup() {
        let options = std::ffi::CString::new(
            r#"{"webc":"missing.webc","command":["tool"],"http_bridge":"bad"}"#,
        )
        .unwrap();
        let result = wasm_host_run_json(options.as_ptr());
        assert_eq!(wasm_host_result_status(result), WASM_HOST_STATUS_ERROR);
        let error = unsafe {
            std::slice::from_raw_parts(
                wasm_host_result_error_ptr(result),
                wasm_host_result_error_len(result),
            )
        };
        assert_eq!(
            std::str::from_utf8(error).unwrap(),
            "unknown HTTP bridge mode: bad; expected off, native, or gateway=<url>"
        );
        wasm_host_result_free(result);
    }

    #[test]
    fn module_cache_dir_and_http_bridge_options_decode() {
        let options: FfiRunOptions = serde_json::from_str(
            r#"{"webc":"missing.webc","command":["tool"],"module_cache_dir":"/tmp/modules","http_bridge":"native"}"#,
        )
        .unwrap();

        assert_eq!(options.module_cache_dir.as_deref(), Some("/tmp/modules"));
        assert_eq!(options.http_bridge.as_deref(), Some("native"));
    }

    #[test]
    fn gateway_http_bridge_option_decodes() {
        let options: FfiRunOptions = serde_json::from_str(
            r#"{"webc":"missing.webc","command":["tool"],"http_bridge":"gateway=http://127.0.0.1:8080/bridge"}"#,
        )
        .unwrap();

        assert_eq!(
            options.http_bridge.as_deref(),
            Some("gateway=http://127.0.0.1:8080/bridge")
        );
    }

    #[test]
    fn host_commands_decode() {
        let options: FfiRunOptions = serde_json::from_str(
            r#"{"webc":"missing.webc","command":["tool"],"host_commands":[{"guest_path":"/tools/echo","host_command":"/bin/echo"}]}"#,
        )
        .unwrap();

        assert_eq!(options.host_commands.len(), 1);
        assert_eq!(options.host_commands[0].guest_path, "/tools/echo");
        assert_eq!(options.host_commands[0].host_command, "/bin/echo");
    }

    #[test]
    fn host_commands_require_native_full_profile() {
        let options = std::ffi::CString::new(
            r#"{"webc":"missing.webc","command":["tool"],"host_commands":[{"guest_path":"/tools/echo","host_command":"/bin/echo"}]}"#,
        )
        .unwrap();
        let result = wasm_host_run_json(options.as_ptr());
        assert_eq!(wasm_host_result_status(result), WASM_HOST_STATUS_ERROR);
        let error = unsafe {
            std::slice::from_raw_parts(
                wasm_host_result_error_ptr(result),
                wasm_host_result_error_len(result),
            )
        };
        assert_eq!(
            std::str::from_utf8(error).unwrap(),
            "host_commands require the native-full profile, current profile is browser-strict"
        );
        wasm_host_result_free(result);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_host_command_bridge_runs_with_stdio_and_mapped_cwd() {
        let host_shell = PathBuf::from("/bin/sh");
        if !host_shell.is_file() {
            return;
        }

        let package = tempfile::NamedTempFile::new().expect("package file should create");
        std::fs::write(
            package.path(),
            wasm_host_fixtures::stdout_fixture_webc(b"unused\n")
                .expect("fixture package should build"),
        )
        .expect("package should write");
        let workspace = tempfile::tempdir().expect("workspace should create");

        let result = run_options(FfiRunOptions {
            webc: package.path().to_string_lossy().to_string(),
            command: vec![
                "host-sh".to_string(),
                "-c".to_string(),
                "cat > host-command-output.txt; printf 'arg=%s\\n' \"$1\"; printf 'stderr-line\\n' >&2"
                    .to_string(),
                "script-name".to_string(),
                "arg1".to_string(),
            ],
            profile: Some("native-full".to_string()),
            package: Some("fixture".to_string()),
            aliases: Vec::new(),
            mounts: vec![FfiMount {
                source: workspace.path().to_string_lossy().to_string(),
                target: "/workspace".to_string(),
                read_only: false,
            }],
            host_commands: vec![FfiHostCommand {
                guest_path: "/tools/host-sh".to_string(),
                host_command: host_shell.to_string_lossy().to_string(),
            }],
            cwd: Some("/workspace".to_string()),
            env: HashMap::from([("PATH".to_string(), "/tools:/bin:/usr/bin".to_string())]),
            stdin_base64: Some(BASE64.encode(b"stdin-data")),
            output_limit: Some(1024),
            timeout_seconds: Some(5.0),
            module_cache_dir: None,
            http_bridge: None,
        })
        .expect("host command should run");

        assert_eq!(result.returncode, 0);
        assert_eq!(result.stdout, b"arg=arg1\n");
        assert_eq!(result.stderr, b"stderr-line\n");
        assert_eq!(
            std::fs::read(workspace.path().join("host-command-output.txt"))
                .expect("output file should exist"),
            b"stdin-data"
        );
    }
}
