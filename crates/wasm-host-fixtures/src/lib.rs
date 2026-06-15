use std::collections::BTreeMap;

use anyhow::{Context, Result};
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

pub const STDOUT_COMMAND: &str = "stdout-fixture";
pub const HTTP_BRIDGE_COMMAND: &str = "http-fixture";

const STDOUT_ATOM: &str = "stdout-fixture";
const HTTP_BRIDGE_ATOM: &str = "http-fixture";
const HTTP_BRIDGE_PATH: &str = "dev/wasm-host-http";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HttpBridgeFixtureOptions {
    pub response_body_limit: usize,
    pub timeout_ms: Option<u64>,
}

impl Default for HttpBridgeFixtureOptions {
    fn default() -> Self {
        Self {
            response_body_limit: 4096,
            timeout_ms: None,
        }
    }
}

pub fn stdout_fixture_webc(stdout: &[u8]) -> Result<Vec<u8>> {
    let wasm = wat::parse_str(stdout_fixture_wat(stdout)).context("compile stdout fixture WAT")?;
    package_wasi_fixture(
        "vertoos/stdout-fixture",
        STDOUT_COMMAND,
        STDOUT_ATOM,
        "Stdout fixture",
        wasm,
    )
}

pub fn http_bridge_fixture_webc(url: &str) -> Result<Vec<u8>> {
    http_bridge_fixture_webc_with_options(url, HttpBridgeFixtureOptions::default())
}

pub fn http_bridge_fixture_webc_with_response_body_limit(
    url: &str,
    response_body_limit: usize,
) -> Result<Vec<u8>> {
    http_bridge_fixture_webc_with_options(
        url,
        HttpBridgeFixtureOptions {
            response_body_limit,
            ..HttpBridgeFixtureOptions::default()
        },
    )
}

pub fn http_bridge_fixture_webc_with_options(
    url: &str,
    options: HttpBridgeFixtureOptions,
) -> Result<Vec<u8>> {
    let mut request = serde_json::json!({
        "method": "GET",
        "url": url,
        "headers": [
            {
                "name": "x-fixture",
                "value": "wasm-host-runner"
            }
        ],
        "response_body_limit": options.response_body_limit
    });
    if let Some(timeout_ms) = options.timeout_ms {
        request["timeout_ms"] = serde_json::json!(timeout_ms);
    }
    let request = request.to_string();
    let wasm =
        wat::parse_str(http_bridge_fixture_wat(&request)).context("compile HTTP fixture WAT")?;
    package_wasi_fixture(
        "vertoos/http-bridge-fixture",
        HTTP_BRIDGE_COMMAND,
        HTTP_BRIDGE_ATOM,
        "HTTP bridge fixture",
        wasm,
    )
}

fn package_wasi_fixture(
    package_name: &str,
    command_name: &str,
    atom_name: &str,
    description: &str,
    wasm: Vec<u8>,
) -> Result<Vec<u8>> {
    let signature = atom_signature(&wasm);

    let mut package = IndexMap::new();
    package.insert(
        Wapm::KEY.to_string(),
        CborValue::serialized(&Wapm::new(
            Some(package_name.to_string()),
            Some("0.1.0".to_string()),
            Some(description.to_string()),
        ))
        .context("serialize WAPM annotation")?,
    );

    let mut atoms = IndexMap::new();
    atoms.insert(
        atom_name.to_string(),
        Atom {
            kind: "https://webc.org/kind/wasm"
                .parse()
                .context("parse atom kind URL")?,
            signature,
            annotations: IndexMap::new(),
        },
    );

    let mut command_annotations = IndexMap::new();
    command_annotations.insert(
        Wasi::KEY.to_string(),
        CborValue::serialized(&Wasi::new(atom_name)).context("serialize WASI annotation")?,
    );
    let mut commands = IndexMap::new();
    commands.insert(
        command_name.to_string(),
        Command {
            runner: WASI_RUNNER_URI.to_string(),
            annotations: command_annotations,
        },
    );

    let manifest = Manifest {
        package,
        atoms,
        commands,
        entrypoint: Some(command_name.to_string()),
        ..Manifest::default()
    };

    let mut atom_files = BTreeMap::new();
    atom_files.insert(
        atom_name.parse().context("parse atom path segment")?,
        FileEntry::owned(wasm, Timestamps::default()),
    );

    Ok(Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)
        .context("write WebC manifest")?
        .write_atoms(atom_files)
        .context("write WebC atoms")?
        .finish(SignatureAlgorithm::None)
        .context("finish WebC package")?
        .to_vec())
}

fn atom_signature(wasm: &[u8]) -> String {
    let hash: [u8; 32] = sha2::Sha256::digest(wasm).into();
    AtomSignature::Sha256(hash).to_string()
}

fn stdout_fixture_wat(stdout: &[u8]) -> String {
    let stdout_len = stdout.len();
    format!(
        r#"
(module
  (type $fd_io (func (param i32 i32 i32 i32) (result i32)))
  (type $proc_exit (func (param i32)))

  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (type $fd_io)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (type $proc_exit)))

  (memory (export "memory") 1)

  (global $written_ptr i32 (i32.const 0))
  (global $iovec i32 (i32.const 16))
  (global $stdout i32 (i32.const 64))

  (data (i32.const 64) "{stdout_data}")

  (func $_start (export "_start")
    (i32.store (global.get $iovec) (global.get $stdout))
    (i32.store (i32.add (global.get $iovec) (i32.const 4)) (i32.const {stdout_len}))
    (if
      (call $fd_write (i32.const 1) (global.get $iovec) (i32.const 1) (global.get $written_ptr))
      (then (call $proc_exit (i32.const 21))))
  )
)
"#,
        stdout_data = wat_string_bytes(stdout),
    )
}

fn http_bridge_fixture_wat(request: &str) -> String {
    let path_len = HTTP_BRIDGE_PATH.len();
    let request_len = request.len();
    format!(
        r#"
(module
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdout_fixture_is_webc() {
        let webc = stdout_fixture_webc(b"BINDING_FIXTURE_OK\n").unwrap();
        assert!(webc.starts_with(b"\0webc003"));
    }

    #[test]
    fn http_bridge_fixture_is_webc() {
        let webc = http_bridge_fixture_webc("http://127.0.0.1:1/test").unwrap();
        assert!(webc.starts_with(b"\0webc003"));
    }

    #[test]
    fn http_bridge_fixture_with_response_body_limit_is_webc() {
        let webc = http_bridge_fixture_webc_with_response_body_limit("http://127.0.0.1:1/test", 4)
            .unwrap();
        assert!(webc.starts_with(b"\0webc003"));
    }

    #[test]
    fn http_bridge_fixture_with_timeout_is_webc() {
        let webc = http_bridge_fixture_webc_with_options(
            "http://127.0.0.1:1/test",
            HttpBridgeFixtureOptions {
                timeout_ms: Some(50),
                ..HttpBridgeFixtureOptions::default()
            },
        )
        .unwrap();
        assert!(webc.starts_with(b"\0webc003"));
    }
}
