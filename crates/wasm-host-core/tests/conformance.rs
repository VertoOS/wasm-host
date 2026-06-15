use std::{
    collections::HashMap,
    fs,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::Value;
use tempfile::tempdir;
use wasm_host_core::{
    CancellationSource, EventBus, HostMount, HostProfile, HttpBridge, HttpBridgeError,
    HttpBridgeErrorKind, HttpHeader, HttpRequest, HttpRequestLimits, HttpResponse, Limits,
    OutputSink, OutputSinks, RunError, RunErrorKind, RunRequest, SandboxState,
    VirtualExecutableBridge, VirtualProcessRequest,
};

const OUTPUT_LIMIT: usize = 1024 * 1024;
const CONFORMANCE_PROFILE_ENV: &str = "WASM_HOST_CONFORMANCE_PROFILE";

fn selected_profile() -> HostProfile {
    match std::env::var(CONFORMANCE_PROFILE_ENV) {
        Ok(value) => HostProfile::parse(&value).unwrap_or_else(|error| {
            panic!("{CONFORMANCE_PROFILE_ENV} must be a valid host profile: {error:#}")
        }),
        Err(std::env::VarError::NotPresent) => HostProfile::default(),
        Err(error) => panic!("{CONFORMANCE_PROFILE_ENV} must be valid UTF-8: {error}"),
    }
}

fn sandbox_with_components(
    profile: HostProfile,
    files: HashMap<String, Option<Vec<u8>>>,
    host_mounts: Vec<HostMount>,
    env: HashMap<String, String>,
    events: EventBus,
    virtual_processes: VirtualExecutableBridge,
) -> SandboxState {
    SandboxState::new_with_profile(
        profile,
        files,
        host_mounts,
        Vec::new(),
        "/work".to_string(),
        env,
        events,
        virtual_processes,
    )
    .expect("sandbox should initialize")
}

fn sandbox_with_profile(
    profile: HostProfile,
    files: HashMap<String, Option<Vec<u8>>>,
    host_mounts: Vec<HostMount>,
    env: HashMap<String, String>,
) -> SandboxState {
    let (events, _event_receiver) = EventBus::new(64);
    let (virtual_processes, _virtual_process_receiver) = VirtualExecutableBridge::new(64);
    sandbox_with_components(profile, files, host_mounts, env, events, virtual_processes)
}

fn limits() -> Limits {
    Limits {
        output_bytes: OUTPUT_LIMIT,
        wall_time_seconds: Some(5.0),
    }
}

fn encode_virtual_process_response(returncode: i32, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    let mut data = Vec::with_capacity(16 + stdout.len() + stderr.len());
    data.extend_from_slice(b"UXR1");
    data.extend_from_slice(&returncode.to_le_bytes());
    data.extend_from_slice(&(stdout.len() as u32).to_le_bytes());
    data.extend_from_slice(&(stderr.len() as u32).to_le_bytes());
    data.extend_from_slice(stdout);
    data.extend_from_slice(stderr);
    data
}

#[derive(Clone)]
struct SharedOutput(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for SharedOutput {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("shared output lock failed"))?
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn shared_output_sink() -> (OutputSink, Arc<Mutex<Vec<u8>>>) {
    let output = Arc::new(Mutex::new(Vec::new()));
    (OutputSink::new(SharedOutput(Arc::clone(&output))), output)
}

fn wait_for_shared_output(output: &Arc<Mutex<Vec<u8>>>, expected: &[u8]) {
    let started = Instant::now();
    loop {
        let actual = output.lock().expect("shared output should lock").clone();
        if actual == expected {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "timed out waiting for streamed output; got {actual:?}, expected {expected:?}"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn virtual_command_sandbox() -> (
    SandboxState,
    tokio::sync::mpsc::Receiver<VirtualProcessRequest>,
) {
    let (events, _event_receiver) = EventBus::new(64);
    let (virtual_processes, virtual_process_receiver) = VirtualExecutableBridge::new(64);
    let state = SandboxState::new_with_profile(
        selected_profile(),
        HashMap::new(),
        Vec::new(),
        Vec::new(),
        "/work".to_string(),
        HashMap::from([("PATH".to_string(), "/tools:/bin:/usr/bin".to_string())]),
        events,
        virtual_processes,
    )
    .expect("sandbox should initialize");
    state
        .register_virtual_executable(42, vec!["/tools/host-tool".to_string()], false)
        .expect("virtual executable should register");
    (state, virtual_process_receiver)
}

#[test]
fn virtual_filesystem_supports_read_write_list_and_events() {
    let (events, mut event_receiver) = EventBus::new(64);
    let (virtual_processes, _virtual_process_receiver) = VirtualExecutableBridge::new(64);
    events.set_enabled(true);
    let state = sandbox_with_components(
        selected_profile(),
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        events,
        virtual_processes,
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime should initialize");

    runtime
        .block_on(state.write_file("/work/hello.txt", b"hello".to_vec()))
        .expect("file write should succeed");
    let contents = runtime
        .block_on(state.read_file("/work/hello.txt"))
        .expect("file read should succeed");
    assert_eq!(contents, b"hello");
    assert_eq!(
        state.listdir("/work").expect("listdir should succeed"),
        ["hello.txt"]
    );

    let created = runtime
        .block_on(event_receiver.recv())
        .expect("file creation event should be emitted");
    assert_eq!(created.kind.as_str(), "file_created");
    assert_eq!(created.path, "/work/hello.txt");

    runtime
        .block_on(state.write_file("/work/hello.txt", b"updated".to_vec()))
        .expect("file overwrite should succeed");
    let modified = runtime
        .block_on(event_receiver.recv())
        .expect("file modification event should be emitted");
    assert_eq!(modified.kind.as_str(), "file_modified");
    assert_eq!(modified.path, "/work/hello.txt");
}

#[test]
fn virtual_filesystem_supports_rename_delete_symlink_and_events() {
    let (events, mut event_receiver) = EventBus::new(64);
    let (virtual_processes, _virtual_process_receiver) = VirtualExecutableBridge::new(64);
    events.set_enabled(true);
    let state = sandbox_with_components(
        selected_profile(),
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
        events,
        virtual_processes,
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime should initialize");

    state
        .create_directory("/work/nested/child")
        .expect("directory creation should succeed");
    let nested = runtime
        .block_on(event_receiver.recv())
        .expect("nested directory event should be emitted");
    assert_eq!(nested.kind.as_str(), "directory_created");
    assert_eq!(nested.path, "/work/nested");
    let child = runtime
        .block_on(event_receiver.recv())
        .expect("child directory event should be emitted");
    assert_eq!(child.kind.as_str(), "directory_created");
    assert_eq!(child.path, "/work/nested/child");
    assert_eq!(
        state
            .listdir("/work/nested")
            .expect("nested listdir should succeed"),
        ["child"]
    );

    runtime
        .block_on(state.write_file("/work/nested/child/source.txt", b"rename-data".to_vec()))
        .expect("source write should succeed");
    let source_created = runtime
        .block_on(event_receiver.recv())
        .expect("source file event should be emitted");
    assert_eq!(source_created.kind.as_str(), "file_created");
    assert_eq!(source_created.path, "/work/nested/child/source.txt");

    state
        .create_symlink(
            "/work/nested/child/source.txt",
            "/work/nested/child/source.link",
        )
        .expect("symlink creation should succeed");
    assert_eq!(
        state
            .readlink("/work/nested/child/source.link")
            .expect("readlink should succeed"),
        "/work/nested/child/source.txt"
    );
    let link_created = runtime
        .block_on(event_receiver.recv())
        .expect("symlink creation event should be emitted");
    assert_eq!(link_created.kind.as_str(), "file_created");
    assert_eq!(link_created.path, "/work/nested/child/source.link");

    runtime
        .block_on(state.rename_path(
            "/work/nested/child/source.txt",
            "/work/nested/child/renamed.txt",
        ))
        .expect("rename should succeed");
    assert!(!state
        .exists("/work/nested/child/source.txt")
        .expect("old path existence check should succeed"));
    assert_eq!(
        runtime
            .block_on(state.read_file("/work/nested/child/renamed.txt"))
            .expect("renamed file should be readable"),
        b"rename-data"
    );
    let renamed = runtime
        .block_on(event_receiver.recv())
        .expect("rename event should be emitted");
    assert_eq!(renamed.kind.as_str(), "path_renamed");
    assert_eq!(renamed.path, "/work/nested/child/source.txt");
    assert_eq!(
        renamed.target_path.as_deref(),
        Some("/work/nested/child/renamed.txt")
    );

    state
        .remove_file("/work/nested/child/renamed.txt")
        .expect("file removal should succeed");
    let removed_file = runtime
        .block_on(event_receiver.recv())
        .expect("file removal event should be emitted");
    assert_eq!(removed_file.kind.as_str(), "file_removed");
    assert_eq!(removed_file.path, "/work/nested/child/renamed.txt");

    state
        .remove_file("/work/nested/child/source.link")
        .expect("symlink removal should succeed");
    let removed_link = runtime
        .block_on(event_receiver.recv())
        .expect("symlink removal event should be emitted");
    assert_eq!(removed_link.kind.as_str(), "file_removed");
    assert_eq!(removed_link.path, "/work/nested/child/source.link");

    state
        .remove_directory("/work/nested/child")
        .expect("directory removal should succeed");
    let removed_directory = runtime
        .block_on(event_receiver.recv())
        .expect("directory removal event should be emitted");
    assert_eq!(removed_directory.kind.as_str(), "directory_removed");
    assert_eq!(removed_directory.path, "/work/nested/child");
}

#[test]
fn host_mounts_can_be_read_only_or_writable() {
    if selected_profile() != HostProfile::NativeFull {
        return;
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime should initialize");
    let read_only_dir = tempdir().expect("tempdir should be created");
    fs::write(read_only_dir.path().join("input.txt"), "from-host").expect("fixture write");
    let read_only_state = sandbox_with_profile(
        HostProfile::NativeFull,
        HashMap::new(),
        vec![HostMount {
            source: read_only_dir.path().to_string_lossy().to_string(),
            target: "/mnt".to_string(),
            read_only: true,
        }],
        HashMap::new(),
    );

    assert_eq!(
        runtime
            .block_on(read_only_state.read_file("/mnt/input.txt"))
            .expect("read-only mount should be readable"),
        b"from-host"
    );
    assert!(
        runtime
            .block_on(read_only_state.write_file("/mnt/output.txt", b"blocked".to_vec()))
            .is_err(),
        "read-only mount should reject writes"
    );

    let writable_dir = tempdir().expect("tempdir should be created");
    let writable_state = sandbox_with_profile(
        HostProfile::NativeFull,
        HashMap::new(),
        vec![HostMount {
            source: writable_dir.path().to_string_lossy().to_string(),
            target: "/mnt".to_string(),
            read_only: false,
        }],
        HashMap::new(),
    );
    runtime
        .block_on(writable_state.write_file("/mnt/output.txt", b"from-sandbox".to_vec()))
        .expect("writable mount should accept writes");
    assert_eq!(
        fs::read(writable_dir.path().join("output.txt")).expect("host file should exist"),
        b"from-sandbox"
    );
}

#[test]
fn browser_strict_profile_rejects_host_mounts() {
    if selected_profile() != HostProfile::BrowserStrict {
        return;
    }

    let source = tempdir().expect("tempdir should be created");
    let (events, _event_receiver) = EventBus::new(64);
    let (virtual_processes, _virtual_process_receiver) = VirtualExecutableBridge::new(64);
    let result = SandboxState::new_with_profile(
        HostProfile::BrowserStrict,
        HashMap::new(),
        vec![HostMount {
            source: source.path().to_string_lossy().to_string(),
            target: "/mnt".to_string(),
            read_only: true,
        }],
        Vec::new(),
        "/work".to_string(),
        HashMap::new(),
        events,
        virtual_processes,
    );
    let error = match result {
        Ok(_) => panic!("browser-strict should reject host mounts"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("native-full profile"),
        "unexpected profile error: {error:#}"
    );
}

#[test]
fn http_bridge_normalizes_and_dispatches_requests() {
    let (bridge, mut http_receiver) = HttpBridge::new(4);
    let handler = thread::spawn(move || {
        let request = http_receiver
            .blocking_recv()
            .expect("HTTP request should arrive");
        assert_eq!(request.id, 1);
        assert_eq!(request.request.method, "GET");
        assert_eq!(request.request.url, "https://example.test/api");
        assert_eq!(
            request.request.headers,
            [HttpHeader::new("accept", "application/json").expect("header should normalize")]
        );
        assert_eq!(request.request.body, b"request-body");

        request
            .respond(
                HttpResponse::new(
                    201,
                    vec![HttpHeader::new("Content-Type", "text/plain").expect("valid header")],
                    b"response-body".to_vec(),
                )
                .expect("response should normalize"),
            )
            .expect("HTTP response should send");
    });

    let response = bridge
        .request_blocking(
            HttpRequest::new(
                " get ",
                " HTTPS://example.test/api ",
                vec![HttpHeader::new(" Accept ", " application/json ").expect("valid header")],
                b"request-body".to_vec(),
            )
            .expect("request should normalize"),
            HttpRequestLimits::default(),
            CancellationSource::new().token(),
        )
        .expect("HTTP request should complete");
    handler.join().expect("handler should finish");

    assert_eq!(response.status, 201);
    assert_eq!(
        response.headers,
        [HttpHeader::new("content-type", "text/plain").expect("valid header")]
    );
    assert_eq!(response.body, b"response-body");
}

#[test]
fn http_bridge_rejects_unsupported_schemes() {
    let error = HttpRequest::new("GET", "file:///workspace/data.txt", Vec::new(), Vec::new())
        .expect_err("file scheme should be rejected");
    assert_eq!(error.kind, HttpBridgeErrorKind::UnsupportedScheme);
    assert!(error.message.contains("file"));
}

#[test]
fn http_bridge_preserves_handler_errors() {
    let (bridge, mut http_receiver) = HttpBridge::new(4);
    let handler = thread::spawn(move || {
        let request = http_receiver
            .blocking_recv()
            .expect("HTTP request should arrive");
        request
            .fail(HttpBridgeError::gateway_unavailable(
                "local gateway is not running",
            ))
            .expect("HTTP error should send");
    });

    let error = bridge
        .request_blocking(
            HttpRequest::new("POST", "https://example.test/api", Vec::new(), Vec::new())
                .expect("request should normalize"),
            HttpRequestLimits::default(),
            CancellationSource::new().token(),
        )
        .expect_err("handler error should be returned");
    handler.join().expect("handler should finish");

    assert_eq!(error.kind, HttpBridgeErrorKind::GatewayUnavailable);
    assert_eq!(error.message, "local gateway is not running");
}

#[test]
fn http_bridge_enforces_response_body_limit() {
    let (bridge, mut http_receiver) = HttpBridge::new(4);
    let handler = thread::spawn(move || {
        let request = http_receiver
            .blocking_recv()
            .expect("HTTP request should arrive");
        request
            .respond(
                HttpResponse::new(200, Vec::new(), b"abcde".to_vec())
                    .expect("response should normalize"),
            )
            .expect("HTTP response should send");
    });

    let error = bridge
        .request_blocking(
            HttpRequest::new("GET", "https://example.test/api", Vec::new(), Vec::new())
                .expect("request should normalize"),
            HttpRequestLimits {
                response_body_bytes: 4,
                wall_time: Some(Duration::from_secs(5)),
            },
            CancellationSource::new().token(),
        )
        .expect_err("oversized response should fail");
    handler.join().expect("handler should finish");

    assert_eq!(error.kind, HttpBridgeErrorKind::ResponseTooLarge);
    assert_eq!(error.message, "HTTP response body exceeded 4 bytes");
}

#[test]
fn http_bridge_external_cancellation_cancels_pending_request() {
    let (bridge, mut http_receiver) = HttpBridge::new(4);
    let cancellation = CancellationSource::new();
    let (handler_ready_sender, handler_ready_receiver) = mpsc::channel();
    let handler = thread::spawn(move || {
        let request = http_receiver
            .blocking_recv()
            .expect("HTTP request should arrive");
        handler_ready_sender
            .send(())
            .expect("ready signal should send");

        let started = Instant::now();
        while !request.cancellation_token().is_cancelled() {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "HTTP request cancellation should be delivered"
            );
            thread::sleep(Duration::from_millis(5));
        }
    });

    let token = cancellation.token();
    let runner = thread::spawn(move || {
        bridge.request_blocking(
            HttpRequest::new("GET", "https://example.test/api", Vec::new(), Vec::new())
                .expect("request should normalize"),
            HttpRequestLimits::default(),
            token,
        )
    });
    handler_ready_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("handler should receive request");
    cancellation.cancel();
    handler.join().expect("handler should finish");

    let error = runner
        .join()
        .expect("runner thread should finish")
        .expect_err("external cancellation should fail the HTTP request");
    assert_eq!(error.kind, HttpBridgeErrorKind::Cancelled);
    assert_eq!(error.message, "HTTP request cancelled");
}

#[test]
fn virtual_executables_dispatch_through_the_host_bridge() {
    let (state, mut virtual_process_receiver) = virtual_command_sandbox();

    let handler = thread::spawn(move || {
        let request = virtual_process_receiver
            .blocking_recv()
            .expect("virtual process request should arrive");
        let payload: Value =
            serde_json::from_slice(&request.payload).expect("payload should be JSON");
        assert_eq!(payload["handler_token"], 42);
        assert_eq!(payload["executable_path"], "/tools/host-tool");
        assert_eq!(payload["argv"], serde_json::json!(["host-tool", "--flag"]));
        assert_eq!(payload["cwd"], "/work");
        assert_eq!(
            BASE64
                .decode(payload["stdin"].as_str().expect("stdin should be a string"))
                .expect("stdin should decode"),
            b"request-body"
        );
        assert!(payload["env"]["PATH"]
            .as_str()
            .expect("PATH should be present")
            .starts_with("/tools"));

        request
            .respond(encode_virtual_process_response(
                7,
                b"bridge-out",
                b"bridge-err",
            ))
            .expect("response should send");
    });

    let result = state
        .run_blocking(
            RunRequest {
                args: vec!["host-tool".to_string(), "--flag".to_string()],
                input: Some(b"request-body".to_vec()),
                env: None,
                cwd: None,
                limits: limits(),
            },
            CancellationSource::new().token(),
        )
        .expect("virtual command should run");
    handler.join().expect("handler thread should finish");

    assert_eq!(result.args, ["host-tool", "--flag"]);
    assert_eq!(result.returncode, 7);
    assert_eq!(result.stdout, b"bridge-out");
    assert_eq!(result.stderr, b"bridge-err");
}

#[test]
fn run_blocking_with_output_streams_and_captures_virtual_output() {
    let (state, mut virtual_process_receiver) = virtual_command_sandbox();
    let handler = thread::spawn(move || {
        let request = virtual_process_receiver
            .blocking_recv()
            .expect("virtual process request should arrive");
        request
            .respond(encode_virtual_process_response(
                0,
                b"streamed stdout",
                b"streamed stderr",
            ))
            .expect("response should send");
    });
    let (stdout_sink, streamed_stdout) = shared_output_sink();
    let (stderr_sink, streamed_stderr) = shared_output_sink();

    let result = state
        .run_blocking_with_output(
            RunRequest {
                args: vec!["host-tool".to_string()],
                input: None,
                env: None,
                cwd: None,
                limits: limits(),
            },
            OutputSinks {
                stdout: Some(stdout_sink),
                stderr: Some(stderr_sink),
            },
            CancellationSource::new().token(),
        )
        .expect("virtual command should run");
    handler.join().expect("handler thread should finish");

    assert_eq!(result.stdout, b"streamed stdout");
    assert_eq!(result.stderr, b"streamed stderr");
    assert_eq!(
        streamed_stdout
            .lock()
            .expect("stdout stream should lock")
            .as_slice(),
        b"streamed stdout"
    );
    assert_eq!(
        streamed_stderr
            .lock()
            .expect("stderr stream should lock")
            .as_slice(),
        b"streamed stderr"
    );
}

#[test]
fn virtual_executable_output_chunks_stream_before_final_response() {
    let (state, mut virtual_process_receiver) = virtual_command_sandbox();
    let (chunk_sent_sender, chunk_sent_receiver) = mpsc::channel();
    let (allow_final_sender, allow_final_receiver) = mpsc::channel();
    let handler = thread::spawn(move || {
        let request = virtual_process_receiver
            .blocking_recv()
            .expect("virtual process request should arrive");
        request
            .write_stdout(b"chunk-out".to_vec())
            .expect("stdout chunk should send");
        request
            .write_stderr(b"chunk-err".to_vec())
            .expect("stderr chunk should send");
        chunk_sent_sender
            .send(())
            .expect("chunk signal should send");
        allow_final_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("final response should be allowed");
        request
            .respond(encode_virtual_process_response(
                0,
                b"-final-out",
                b"-final-err",
            ))
            .expect("response should send");
    });
    let (stdout_sink, streamed_stdout) = shared_output_sink();
    let (stderr_sink, streamed_stderr) = shared_output_sink();

    let runner = thread::spawn(move || {
        state.run_blocking_with_output(
            RunRequest {
                args: vec!["host-tool".to_string()],
                input: None,
                env: None,
                cwd: None,
                limits: limits(),
            },
            OutputSinks {
                stdout: Some(stdout_sink),
                stderr: Some(stderr_sink),
            },
            CancellationSource::new().token(),
        )
    });
    chunk_sent_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("handler should send chunks");
    wait_for_shared_output(&streamed_stdout, b"chunk-out");
    wait_for_shared_output(&streamed_stderr, b"chunk-err");
    allow_final_sender
        .send(())
        .expect("final response signal should send");

    let result = runner
        .join()
        .expect("runner thread should finish")
        .expect("virtual command should run");
    handler.join().expect("handler thread should finish");

    assert_eq!(result.stdout, b"chunk-out-final-out");
    assert_eq!(result.stderr, b"chunk-err-final-err");
    assert_eq!(
        streamed_stdout
            .lock()
            .expect("stdout stream should lock")
            .as_slice(),
        b"chunk-out-final-out"
    );
    assert_eq!(
        streamed_stderr
            .lock()
            .expect("stderr stream should lock")
            .as_slice(),
        b"chunk-err-final-err"
    );
}

#[test]
fn virtual_executable_exit_code_and_stderr_are_preserved() {
    let (state, mut virtual_process_receiver) = virtual_command_sandbox();
    let handler = thread::spawn(move || {
        let request = virtual_process_receiver
            .blocking_recv()
            .expect("virtual process request should arrive");
        request
            .respond(encode_virtual_process_response(23, b"", b"tool failed\n"))
            .expect("response should send");
    });

    let result = state
        .run_blocking(
            RunRequest {
                args: vec!["host-tool".to_string()],
                input: None,
                env: None,
                cwd: None,
                limits: limits(),
            },
            CancellationSource::new().token(),
        )
        .expect("virtual command should run");
    handler.join().expect("handler thread should finish");

    assert_eq!(result.returncode, 23);
    assert_eq!(result.stdout, b"");
    assert_eq!(result.stderr, b"tool failed\n");
}

#[test]
fn missing_command_reports_command_resolution_error() {
    let state = sandbox_with_profile(
        selected_profile(),
        HashMap::new(),
        Vec::new(),
        HashMap::new(),
    );

    let error = match state.run_blocking(
        RunRequest {
            args: vec!["missing-tool".to_string()],
            input: None,
            env: None,
            cwd: None,
            limits: limits(),
        },
        CancellationSource::new().token(),
    ) {
        Ok(_) => panic!("missing command should fail"),
        Err(error) => error,
    };
    let run_error = error
        .downcast_ref::<RunError>()
        .expect("missing command should preserve RunError");

    assert_eq!(run_error.kind(), RunErrorKind::CommandResolution);
    assert_eq!(run_error.to_string(), "command not found: missing-tool");
}

fn virtual_command_error_for_response(
    stdout: &'static [u8],
    stderr: &'static [u8],
    output_bytes: usize,
) -> String {
    let (state, mut virtual_process_receiver) = virtual_command_sandbox();
    let handler = thread::spawn(move || {
        let request = virtual_process_receiver
            .blocking_recv()
            .expect("virtual process request should arrive");
        request
            .respond(encode_virtual_process_response(0, stdout, stderr))
            .expect("response should send");
    });

    let result = state.run_blocking(
        RunRequest {
            args: vec!["host-tool".to_string()],
            input: None,
            env: None,
            cwd: None,
            limits: Limits {
                output_bytes,
                wall_time_seconds: Some(5.0),
            },
        },
        CancellationSource::new().token(),
    );
    handler.join().expect("handler thread should finish");

    match result {
        Ok(_) => panic!("virtual command output limit should fail"),
        Err(error) => error.to_string(),
    }
}

#[test]
fn virtual_executable_stdout_respects_output_limit() {
    let error = virtual_command_error_for_response(b"abcde", b"", 4);
    assert_eq!(error, "process stdout output exceeded 4 bytes");
}

#[test]
fn virtual_executable_stderr_respects_output_limit() {
    let error = virtual_command_error_for_response(b"", b"abcde", 4);
    assert_eq!(error, "process stderr output exceeded 4 bytes");
}

#[test]
fn virtual_executable_wall_time_limit_cancels_pending_request() {
    let (state, mut virtual_process_receiver) = virtual_command_sandbox();
    let (handler_ready_sender, handler_ready_receiver) = mpsc::channel();
    let handler = thread::spawn(move || {
        let request = virtual_process_receiver
            .blocking_recv()
            .expect("virtual process request should arrive");
        handler_ready_sender
            .send(())
            .expect("ready signal should send");

        let started = Instant::now();
        while !request.cancellation_token().is_cancelled() {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "request cancellation should be delivered after timeout"
            );
            thread::sleep(Duration::from_millis(5));
        }
    });

    let result = state.run_blocking(
        RunRequest {
            args: vec!["host-tool".to_string()],
            input: None,
            env: None,
            cwd: None,
            limits: Limits {
                output_bytes: OUTPUT_LIMIT,
                wall_time_seconds: Some(0.05),
            },
        },
        CancellationSource::new().token(),
    );
    handler_ready_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("handler should receive request");
    handler.join().expect("handler thread should finish");

    let error = match result {
        Ok(_) => panic!("timeout should fail the virtual command"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("wall time limit"),
        "unexpected timeout error: {error:#}"
    );
    let run_error = error
        .downcast_ref::<RunError>()
        .expect("timeout should preserve RunError");
    assert_eq!(run_error.kind(), RunErrorKind::Timeout);
}

#[test]
fn virtual_executable_external_cancellation_cancels_pending_request() {
    let (state, mut virtual_process_receiver) = virtual_command_sandbox();
    let cancellation = CancellationSource::new();
    let (handler_ready_sender, handler_ready_receiver) = mpsc::channel();
    let handler = thread::spawn(move || {
        let request = virtual_process_receiver
            .blocking_recv()
            .expect("virtual process request should arrive");
        handler_ready_sender
            .send(())
            .expect("ready signal should send");

        let started = Instant::now();
        while !request.cancellation_token().is_cancelled() {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "request cancellation should be delivered after external cancel"
            );
            thread::sleep(Duration::from_millis(5));
        }
    });

    let token = cancellation.token();
    let runner = thread::spawn(move || {
        state.run_blocking(
            RunRequest {
                args: vec!["host-tool".to_string()],
                input: None,
                env: None,
                cwd: None,
                limits: limits(),
            },
            token,
        )
    });
    handler_ready_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("handler should receive request");
    cancellation.cancel();
    handler.join().expect("handler thread should finish");

    let error = match runner.join().expect("runner thread should finish") {
        Ok(_) => panic!("external cancellation should fail the virtual command"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("process cancelled"),
        "unexpected cancellation error: {error:#}"
    );
}
