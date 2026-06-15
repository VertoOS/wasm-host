use std::{collections::HashMap, fs, thread};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::Value;
use tempfile::tempdir;
use wasm_host_core::{
    CancellationSource, EventBus, HostMount, Limits, RunRequest, SandboxState,
    VirtualExecutableBridge,
};

const OUTPUT_LIMIT: usize = 1024 * 1024;

fn sandbox(
    files: HashMap<String, Option<Vec<u8>>>,
    host_mounts: Vec<HostMount>,
    env: HashMap<String, String>,
) -> SandboxState {
    let (events, _event_receiver) = EventBus::new(64);
    let (virtual_processes, _virtual_process_receiver) = VirtualExecutableBridge::new(64);
    SandboxState::new(
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

#[test]
fn virtual_filesystem_supports_read_write_list_and_events() {
    let (events, mut event_receiver) = EventBus::new(64);
    let (virtual_processes, _virtual_process_receiver) = VirtualExecutableBridge::new(64);
    events.set_enabled(true);
    let state = SandboxState::new(
        HashMap::new(),
        Vec::new(),
        Vec::new(),
        "/work".to_string(),
        HashMap::new(),
        events,
        virtual_processes,
    )
    .expect("sandbox should initialize");
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
    let state = SandboxState::new(
        HashMap::new(),
        Vec::new(),
        Vec::new(),
        "/work".to_string(),
        HashMap::new(),
        events,
        virtual_processes,
    )
    .expect("sandbox should initialize");
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
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime should initialize");
    let read_only_dir = tempdir().expect("tempdir should be created");
    fs::write(read_only_dir.path().join("input.txt"), "from-host").expect("fixture write");
    let read_only_state = sandbox(
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
    let writable_state = sandbox(
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
fn virtual_executables_dispatch_through_the_host_bridge() {
    let (events, _event_receiver) = EventBus::new(64);
    let (virtual_processes, mut virtual_process_receiver) = VirtualExecutableBridge::new(64);
    let state = SandboxState::new(
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
