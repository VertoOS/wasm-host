use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command as ProcessCommand,
    sync::mpsc,
    thread,
    time::Duration,
};

use ciborium::Value as CborValue;
use sha2::Digest as _;
use webc::{
    indexmap::IndexMap,
    metadata::{
        annotations::{Wapm, Wasi, WASI_RUNNER_URI},
        Atom, AtomSignature, Command, Manifest,
    },
    v3::{
        write::{FileEntry, Writer},
        ChecksumAlgorithm, SignatureAlgorithm, Timestamps,
    },
};

const FIXTURE_COMMAND: &str = "http-fixture";
const FIXTURE_ATOM: &str = "http-fixture";
const HTTP_BRIDGE_PATH: &str = "dev/wasm-host-http";

#[test]
fn native_http_bridge_is_available_to_wasi_guest() {
    let mut server = TestHttpServer::spawn();
    let webc = package_http_bridge_fixture(&server.url());
    let tmp = tempfile::tempdir().expect("temp dir");
    let webc_path = tmp.path().join("http-fixture.webc");
    std::fs::write(&webc_path, webc).expect("write WebC fixture");

    let output = ProcessCommand::new(env!("CARGO_BIN_EXE_wasm-host-runner"))
        .arg("--event-format")
        .arg("json")
        .arg("--http-bridge")
        .arg("native")
        .arg("--module-cache-dir")
        .arg(tmp.path().join("modules"))
        .arg("--webc")
        .arg(&webc_path)
        .arg("--")
        .arg(FIXTURE_COMMAND)
        .output()
        .expect("run fixture package");

    assert!(
        output.status.success(),
        "runner failed with status {:?}\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let response: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout should be JSON");
    assert_eq!(response["ok"], true);
    assert_eq!(response["response"]["status"], 200);
    assert_eq!(response["response"]["body_base64"], "YnJpZGdlLW9r");

    let events = String::from_utf8(output.stderr).expect("stderr should be UTF-8");
    assert!(
        events.contains(r#""http_bridge":"native""#),
        "runner events should include the native bridge mode:\n{events}"
    );
    assert!(
        events.contains(r#""event":"command.completed""#),
        "runner events should include command completion:\n{events}"
    );

    let request = server.request();
    assert!(
        request.starts_with("GET /http-bridge-fixture HTTP/1.1\r\n"),
        "unexpected request line:\n{request}"
    );
    assert!(
        request.contains("x-fixture: wasm-host-runner\r\n"),
        "missing fixture header:\n{request}"
    );
}

fn package_http_bridge_fixture(url: &str) -> Vec<u8> {
    let request = serde_json::json!({
        "method": "GET",
        "url": url,
        "headers": [
            {
                "name": "x-fixture",
                "value": "wasm-host-runner"
            }
        ],
        "response_body_limit": 4096
    })
    .to_string();
    let wasm = wat::parse_str(http_bridge_fixture_wat(&request)).expect("compile fixture WAT");
    let signature = atom_signature(&wasm);

    let mut package = IndexMap::new();
    package.insert(
        Wapm::KEY.to_string(),
        CborValue::serialized(&Wapm::new(
            Some("vertoos/http-bridge-fixture".to_string()),
            Some("0.1.0".to_string()),
            Some("HTTP bridge fixture".to_string()),
        ))
        .expect("serialize WAPM annotation"),
    );

    let mut atoms = IndexMap::new();
    atoms.insert(
        FIXTURE_ATOM.to_string(),
        Atom {
            kind: "https://webc.org/kind/wasm"
                .parse()
                .expect("valid atom kind URL"),
            signature,
            annotations: IndexMap::new(),
        },
    );

    let mut command_annotations = IndexMap::new();
    command_annotations.insert(
        Wasi::KEY.to_string(),
        CborValue::serialized(&Wasi::new(FIXTURE_ATOM)).expect("serialize WASI annotation"),
    );
    let mut commands = IndexMap::new();
    commands.insert(
        FIXTURE_COMMAND.to_string(),
        Command {
            runner: WASI_RUNNER_URI.to_string(),
            annotations: command_annotations,
        },
    );

    let manifest = Manifest {
        package,
        atoms,
        commands,
        entrypoint: Some(FIXTURE_COMMAND.to_string()),
        ..Manifest::default()
    };

    let mut atom_files = BTreeMap::new();
    atom_files.insert(
        FIXTURE_ATOM.parse().expect("valid atom path segment"),
        FileEntry::owned(wasm, Timestamps::default()),
    );

    Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)
        .expect("write manifest")
        .write_atoms(atom_files)
        .expect("write atoms")
        .finish(SignatureAlgorithm::None)
        .expect("finish WebC")
        .to_vec()
}

fn atom_signature(wasm: &[u8]) -> String {
    let hash: [u8; 32] = sha2::Sha256::digest(wasm).into();
    AtomSignature::Sha256(hash).to_string()
}

fn http_bridge_fixture_wat(request: &str) -> String {
    let path_len = HTTP_BRIDGE_PATH.len();
    let request_len = request.len();
    format!(
        r#"
(module
  (type $errno0 (func (param i32 i32) (result i32)))
  (type $fd_io (func (param i32 i32 i32 i32) (result i32)))
  (type $path_open (func (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (type $proc_exit (func (param i32)))

  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (type $fd_io)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (type $fd_io)))
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (type $path_open)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (type $proc_exit)))

  (memory (export "memory") 1)

  (global $fd_ptr i32 (i32.const 0))
  (global $nread_ptr i32 (i32.const 4))
  (global $written_ptr i32 (i32.const 8))
  (global $iovec i32 (i32.const 16))
  (global $path i32 (i32.const 64))
  (global $request i32 (i32.const 256))
  (global $response i32 (i32.const 4096))
  (global $response_cap i32 (i32.const 8192))

  (data (i32.const 64) "{path_data}")
  (data (i32.const 256) "{request_data}")

  (func $_start (export "_start")
    (local $fd i32)
    (local $nread i32)

    (if
      (call $path_open
        (i32.const 3)
        (i32.const 0)
        (global.get $path)
        (i32.const {path_len})
        (i32.const 0)
        (i64.const -1)
        (i64.const -1)
        (i32.const 0)
        (global.get $fd_ptr))
      (then (call $proc_exit (i32.const 20))))
    (local.set $fd (i32.load (global.get $fd_ptr)))

    (i32.store (global.get $iovec) (global.get $request))
    (i32.store (i32.add (global.get $iovec) (i32.const 4)) (i32.const {request_len}))
    (if
      (call $fd_write (local.get $fd) (global.get $iovec) (i32.const 1) (global.get $written_ptr))
      (then (call $proc_exit (i32.const 21))))

    (i32.store (global.get $iovec) (global.get $response))
    (i32.store (i32.add (global.get $iovec) (i32.const 4)) (global.get $response_cap))
    (if
      (call $fd_read (local.get $fd) (global.get $iovec) (i32.const 1) (global.get $nread_ptr))
      (then (call $proc_exit (i32.const 22))))
    (local.set $nread (i32.load (global.get $nread_ptr)))

    (i32.store (global.get $iovec) (global.get $response))
    (i32.store (i32.add (global.get $iovec) (i32.const 4)) (local.get $nread))
    (drop (call $fd_write (i32.const 1) (global.get $iovec) (i32.const 1) (global.get $written_ptr)))
  )
)
"#,
        path_data = wat_string_bytes(HTTP_BRIDGE_PATH.as_bytes()),
        request_data = wat_string_bytes(request.as_bytes()),
    )
}

fn wat_string_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("\\{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

struct TestHttpServer {
    url: String,
    request_receiver: mpsc::Receiver<String>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestHttpServer {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test HTTP server");
        let address = listener.local_addr().expect("read server address");
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept test request");
            let request = handle_test_http_request(stream);
            request_sender.send(request).expect("send captured request");
        });
        Self {
            url: format!("http://{address}/http-bridge-fixture"),
            request_receiver,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        self.url.clone()
    }

    fn request(&mut self) -> String {
        let request = self
            .request_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("receive captured HTTP request");
        if let Some(handle) = self.handle.take() {
            handle.join().expect("test HTTP server should exit cleanly");
        }
        request
    }
}

fn handle_test_http_request(mut stream: TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 512];
    loop {
        let length = stream.read(&mut buffer).expect("read HTTP request");
        if length == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..length]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        assert!(request.len() < 8192, "HTTP request headers exceeded 8 KiB");
    }
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nbridge-ok")
        .expect("write HTTP response");
    String::from_utf8(request).expect("HTTP request should be UTF-8")
}
