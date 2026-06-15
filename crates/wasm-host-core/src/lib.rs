use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    error::Error,
    fmt,
    future::Future,
    io::{self, SeekFrom, Write as _},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    task::{Context as TaskContext, Poll, Waker},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncWrite, AsyncWriteExt, ReadBuf};
use virtual_fs::{
    create_dir_all, host_fs, DirEntry, FileOpener, FileSystem, FileType, FsError, Metadata,
    NullFile, OpenOptionsConfig, OverlayFileSystem, ReadDir, StaticFile, TmpFileSystem,
    UnionFileSystem, UnionMergeMode, VirtualFile,
};
use wasmer::sys::{BaseTunables, Cranelift, EngineBuilder, Features, NativeEngineExt};
use wasmer_package::utils::from_bytes;
use wasmer_wasix::{
    bin_factory::{spawn_exec, BinaryPackage},
    os::{TtyBridge, WasiTtyState},
    runtime::{
        module_cache::{FileSystemCache, ModuleCache, SharedCache},
        package_loader::BuiltinPackageLoader,
        resolver::InMemorySource,
        task_manager::{tokio::TokioTaskManager, VirtualTaskManager, VirtualTaskManagerExt},
    },
    PluggableRuntime, Runtime, WasiEnvBuilder,
};
use webc::metadata::annotations::Wasi;

#[cfg(not(target_arch = "wasm32"))]
mod host_command;
mod http;
#[cfg(not(target_arch = "wasm32"))]
pub use host_command::{
    register_native_host_commands, NativeHostCommandSpec, NativeHostCommandWorker,
};
#[cfg(not(target_arch = "wasm32"))]
pub use http::NativeHttpBridgeWorker;
pub use http::{
    HttpBridge, HttpBridgeError, HttpBridgeErrorKind, HttpBridgeRequest, HttpHeader, HttpRequest,
    HttpRequestLimits, HttpResponse,
};

const COMMAND_PATH_PREFIXES: &[&str] = &["/bin", "/usr/bin"];
const VIRTUAL_EXEC_BRIDGE_PATH: &str = "/dev/wasm-host-virtual-exec";
const HTTP_BRIDGE_PATH: &str = "/dev/wasm-host-http";
const VIRTUAL_EXECUTABLE_WASM: &str = r#"
(module
  (type $errno0 (func (param i32 i32) (result i32)))
  (type $args_get (func (param i32 i32) (result i32)))
  (type $environ_get (func (param i32 i32) (result i32)))
  (type $fd_read (func (param i32 i32 i32 i32) (result i32)))
  (type $fd_write (func (param i32 i32 i32 i32) (result i32)))
  (type $fd_fdstat_set_flags (func (param i32 i32) (result i32)))
  (type $path_open (func (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (type $proc_exit (func (param i32)))

  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (type $errno0)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (type $args_get)))
  (import "wasi_snapshot_preview1" "environ_sizes_get" (func $environ_sizes_get (type $errno0)))
  (import "wasi_snapshot_preview1" "environ_get" (func $environ_get (type $environ_get)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (type $fd_read)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (type $fd_write)))
  (import "wasi_snapshot_preview1" "fd_fdstat_set_flags" (func $fd_fdstat_set_flags (type $fd_fdstat_set_flags)))
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (type $path_open)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (type $proc_exit)))

  (memory (export "memory") 256)

  (global $argc_ptr i32 (i32.const 0))
  (global $argv_size_ptr i32 (i32.const 4))
  (global $nread_ptr i32 (i32.const 8))
  (global $fd_ptr i32 (i32.const 12))
  (global $written_ptr i32 (i32.const 16))
  (global $exec_path i32 (i32.const 128))
  (global $exec_path_len i32 (i32.const __VIRTUAL_EXEC_PATH_LEN__))
  (global $iovec i32 (i32.const 512))
  (global $argv_ptrs i32 (i32.const 1024))
  (global $argv_buf i32 (i32.const 65536))
  (global $envc_ptr i32 (i32.const 20))
  (global $env_size_ptr i32 (i32.const 24))
  (global $env_ptrs i32 (i32.const 262144))
  (global $env_buf i32 (i32.const 524288))
  (global $stdin_buf i32 (i32.const 1048576))
  (global $stdin_cap i32 (i32.const 1048576))
  (global $request_buf i32 (i32.const 2097152))
  (global $response_buf i32 (i32.const 4194304))
  (global $response_cap i32 (i32.const 8388608))

  (data (i32.const 64) "dev/wasm-host-virtual-exec")
  (data (i32.const 128) "__VIRTUAL_EXEC_PATH__")

  (func $strlen (param $ptr i32) (result i32)
    (local $cursor i32)
    (local.set $cursor (local.get $ptr))
    (block $done
      (loop $again
        (br_if $done (i32.eqz (i32.load8_u (local.get $cursor))))
        (local.set $cursor (i32.add (local.get $cursor) (i32.const 1)))
        (br $again)))
    (i32.sub (local.get $cursor) (local.get $ptr)))

  (func $write_record (param $cursor i32) (param $source i32) (result i32)
    (local $len i32)
    (local.set $len (call $strlen (local.get $source)))
    (i32.store (local.get $cursor) (local.get $len))
    (local.set $cursor (i32.add (local.get $cursor) (i32.const 4)))
    (memory.copy (local.get $cursor) (local.get $source) (local.get $len))
    (i32.add (local.get $cursor) (local.get $len)))

  (func $_start (export "_start")
    (local $cursor i32)
    (local $index i32)
    (local $stdin_len i32)
    (local $chunk i32)
    (local $fd i32)
    (local $response_len i32)
    (local $stdout_len i32)
    (local $stderr_len i32)
    (local $returncode i32)

    (drop (call $args_sizes_get (global.get $argc_ptr) (global.get $argv_size_ptr)))
    (drop (call $args_get (global.get $argv_ptrs) (global.get $argv_buf)))
    (drop (call $environ_sizes_get (global.get $envc_ptr) (global.get $env_size_ptr)))
    (drop (call $environ_get (global.get $env_ptrs) (global.get $env_buf)))
    (drop (call $fd_fdstat_set_flags (i32.const 0) (i32.const 4)))

    (local.set $stdin_len (i32.const 0))

    (local.set $cursor (global.get $request_buf))
    (i32.store (local.get $cursor) (i32.const 0x31565855))
    (local.set $cursor (i32.add (local.get $cursor) (i32.const 4)))
    (i32.store (local.get $cursor) (global.get $exec_path_len))
    (local.set $cursor (i32.add (local.get $cursor) (i32.const 4)))
    (memory.copy (local.get $cursor) (global.get $exec_path) (global.get $exec_path_len))
    (local.set $cursor (i32.add (local.get $cursor) (global.get $exec_path_len)))
    (i32.store (local.get $cursor) (i32.load (global.get $argc_ptr)))
    (local.set $cursor (i32.add (local.get $cursor) (i32.const 4)))
    (i32.store (local.get $cursor) (i32.load (global.get $envc_ptr)))
    (local.set $cursor (i32.add (local.get $cursor) (i32.const 4)))
    (i32.store (local.get $cursor) (local.get $stdin_len))
    (local.set $cursor (i32.add (local.get $cursor) (i32.const 4)))

    (local.set $index (i32.const 0))
    (block $argv_done
      (loop $argv_again
        (br_if $argv_done (i32.ge_u (local.get $index) (i32.load (global.get $argc_ptr))))
        (local.set
          $cursor
          (call $write_record
            (local.get $cursor)
            (i32.load (i32.add (global.get $argv_ptrs) (i32.mul (local.get $index) (i32.const 4))))))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $argv_again)))

    (local.set $index (i32.const 0))
    (block $env_done
      (loop $env_again
        (br_if $env_done (i32.ge_u (local.get $index) (i32.load (global.get $envc_ptr))))
        (local.set
          $cursor
          (call $write_record
            (local.get $cursor)
            (i32.load (i32.add (global.get $env_ptrs) (i32.mul (local.get $index) (i32.const 4))))))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $env_again)))

    (memory.copy (local.get $cursor) (global.get $stdin_buf) (local.get $stdin_len))
    (local.set $cursor (i32.add (local.get $cursor) (local.get $stdin_len)))

    (drop
      (call $path_open
        (i32.const 3)
        (i32.const 0)
        (i32.const 64)
        (i32.const 29)
        (i32.const 0)
        (i64.const -1)
        (i64.const -1)
        (i32.const 0)
        (global.get $fd_ptr)))
    (local.set $fd (i32.load (global.get $fd_ptr)))

    (i32.store (global.get $iovec) (global.get $request_buf))
    (i32.store
      (i32.add (global.get $iovec) (i32.const 4))
      (i32.sub (local.get $cursor) (global.get $request_buf)))
    (drop (call $fd_write (local.get $fd) (global.get $iovec) (i32.const 1) (global.get $written_ptr)))

    (i32.store (global.get $iovec) (global.get $response_buf))
    (i32.store (i32.add (global.get $iovec) (i32.const 4)) (global.get $response_cap))
    (drop (call $fd_read (local.get $fd) (global.get $iovec) (i32.const 1) (global.get $nread_ptr)))
    (local.set $response_len (i32.load (global.get $nread_ptr)))

    (if (i32.lt_u (local.get $response_len) (i32.const 16))
      (then (return)))
    (local.set $returncode (i32.load (i32.add (global.get $response_buf) (i32.const 4))))
    (local.set $stdout_len (i32.load (i32.add (global.get $response_buf) (i32.const 8))))
    (local.set $stderr_len (i32.load (i32.add (global.get $response_buf) (i32.const 12))))

    (i32.store (global.get $iovec) (i32.add (global.get $response_buf) (i32.const 16)))
    (i32.store (i32.add (global.get $iovec) (i32.const 4)) (local.get $stdout_len))
    (drop (call $fd_write (i32.const 1) (global.get $iovec) (i32.const 1) (global.get $written_ptr)))

    (i32.store
      (global.get $iovec)
      (i32.add (i32.add (global.get $response_buf) (i32.const 16)) (local.get $stdout_len)))
    (i32.store (i32.add (global.get $iovec) (i32.const 4)) (local.get $stderr_len))
    (drop (call $fd_write (i32.const 2) (global.get $iovec) (i32.const 1) (global.get $written_ptr)))

    (call $proc_exit (local.get $returncode)))
)
"#;

#[derive(Clone)]
pub struct Limits {
    pub output_bytes: usize,
    pub wall_time_seconds: Option<f64>,
}

#[derive(Clone)]
pub struct HostMount {
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostProfile {
    BrowserStrict,
    NativeFull,
}

#[derive(Clone, Debug)]
pub struct PackageCommandAlias {
    pub alias: String,
    pub command: String,
}

#[derive(Clone, Debug)]
pub struct PackageSpec {
    pub name: String,
    pub webc_path: String,
    pub content_sha256: String,
    pub command_aliases: Vec<PackageCommandAlias>,
}

#[derive(Clone, Debug, Default)]
pub struct SandboxOptions {
    pub module_cache_dir: Option<PathBuf>,
    pub http_bridge: Option<HttpBridge>,
}

#[derive(Clone, Debug)]
struct ResolvedPackageSpec {
    name: String,
    webc_path: PathBuf,
    command_aliases: Vec<PackageCommandAlias>,
}

#[derive(Clone)]
pub struct CompletedProcess {
    pub args: Vec<String>,
    pub returncode: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Clone)]
pub struct OutputSink {
    writer: Arc<Mutex<Box<dyn io::Write + Send + 'static>>>,
}

#[derive(Clone, Debug, Default)]
pub struct OutputSinks {
    pub stdout: Option<OutputSink>,
    pub stderr: Option<OutputSink>,
}

impl OutputSink {
    pub fn new(writer: impl io::Write + Send + 'static) -> Self {
        Self {
            writer: Arc::new(Mutex::new(Box::new(writer))),
        }
    }

    fn write_all(&self, data: &[u8]) -> io::Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("output sink lock failed"))?;
        writer.write_all(data)?;
        writer.flush()
    }
}

impl fmt::Debug for OutputSink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OutputSink { .. }")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunErrorKind {
    CommandResolution,
    Timeout,
    Cancelled,
}

#[derive(Debug)]
pub struct RunError {
    kind: RunErrorKind,
    message: String,
}

impl RunError {
    fn new(kind: RunErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> RunErrorKind {
        self.kind
    }
}

impl fmt::Display for RunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(formatter)
    }
}

impl Error for RunError {}

#[derive(Clone, Debug)]
pub struct CancellationSource {
    sender: tokio::sync::watch::Sender<bool>,
}

#[derive(Clone, Debug)]
pub struct CancellationToken {
    receiver: tokio::sync::watch::Receiver<bool>,
}

#[derive(Clone)]
pub struct SandboxState {
    pub fs: TmpFileSystem,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub profile: HostProfile,
    pub catalog: Arc<PackageCatalog>,
    pub events: EventBus,
    pub virtual_executables: VirtualExecutableRegistry,
    pub http_bridge: Option<HttpBridge>,
}

#[derive(Clone)]
struct CommandTarget {
    package: String,
    command: String,
}

#[derive(Clone, Debug)]
pub struct VirtualProcessRequest {
    pub id: u64,
    pub payload: Vec<u8>,
    cancellation: CancellationToken,
    response_sender: mpsc::Sender<VirtualProcessResponseEvent>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VirtualProcessInvocation {
    pub handler_token: u64,
    pub executable_path: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub stdin: Vec<u8>,
}

#[derive(Debug)]
enum VirtualProcessResponseEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Complete(Vec<u8>),
}

#[derive(Clone, Debug)]
pub struct VirtualExecutableBridge {
    inner: Arc<VirtualExecutableBridgeInner>,
}

#[derive(Debug)]
struct VirtualExecutableBridgeInner {
    sender: tokio::sync::mpsc::Sender<VirtualProcessRequest>,
    sequence: AtomicU64,
}

#[derive(Clone, Debug)]
pub struct VirtualExecutableRegistry {
    inner: Arc<Mutex<VirtualExecutableRegistryInner>>,
    bridge: VirtualExecutableBridge,
}

#[derive(Debug, Default)]
struct VirtualExecutableRegistryInner {
    paths: HashMap<PathBuf, VirtualExecutableTarget>,
}

#[derive(Clone, Debug)]
struct VirtualExecutableTarget {
    token: u64,
    path: String,
}

#[derive(Clone, Debug)]
struct ResolvedVirtualExecutable {
    token: u64,
    executable_path: String,
}

#[derive(Deserialize, Serialize)]
struct VirtualProcessPayload {
    handler_token: u64,
    executable_path: String,
    argv: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    stdin: String,
}

#[derive(Deserialize, Serialize)]
struct GuestVirtualProcessPayload {
    executable_path: String,
    argv: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    stdin: String,
}

#[derive(Deserialize)]
struct HttpBridgeDeviceRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<HttpBridgeDeviceHeader>,
    #[serde(default)]
    body_base64: String,
    #[serde(default)]
    response_body_limit: Option<usize>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize, Serialize)]
struct HttpBridgeDeviceHeader {
    name: String,
    value: String,
}

#[derive(Serialize)]
struct HttpBridgeDeviceResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<HttpBridgeDeviceSuccess>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HttpBridgeDeviceError>,
}

#[derive(Serialize)]
struct HttpBridgeDeviceSuccess {
    status: u16,
    headers: Vec<HttpBridgeDeviceHeader>,
    body_base64: String,
}

#[derive(Serialize)]
struct HttpBridgeDeviceError {
    kind: String,
    message: String,
}

struct VirtualProcessResponsePayload {
    returncode: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Clone, Debug)]
struct VirtualProcessOutput {
    stdout: CapturedOutput,
    stderr: CapturedOutput,
}

struct BinaryCursor<'a> {
    data: &'a [u8],
    cursor: usize,
}

enum ResolvedCommand {
    Package(CommandTarget),
    Virtual(ResolvedVirtualExecutable),
}

pub struct PackageCatalog {
    runtime: Arc<dyn Runtime + Send + Sync>,
    handle: tokio::runtime::Handle,
    packages: HashMap<String, Arc<BinaryPackage>>,
    command_paths: HashMap<PathBuf, CommandTarget>,
}

#[derive(Debug)]
struct NonInteractiveTty;

impl TtyBridge for NonInteractiveTty {
    fn reset(&self) {}

    fn tty_get(&self) -> WasiTtyState {
        WasiTtyState {
            stdin_tty: false,
            stdout_tty: false,
            stderr_tty: false,
            echo: false,
            line_buffered: false,
            ..WasiTtyState::default()
        }
    }

    fn tty_set(&self, _tty_state: WasiTtyState) {}
}

pub struct RunRequest {
    pub args: Vec<String>,
    pub input: Option<Vec<u8>>,
    pub env: Option<HashMap<String, String>>,
    pub cwd: Option<String>,
    pub limits: Limits,
}

pub(crate) struct ProcessStreams {
    pub stdin: Box<dyn VirtualFile + Send + Sync + 'static>,
    pub stdout: CapturedOutput,
    pub stderr: CapturedOutput,
}

struct ProcessIo {
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: PathBuf,
    stdin: Box<dyn VirtualFile + Send + Sync + 'static>,
    stdout: Box<dyn VirtualFile + Send + Sync + 'static>,
    stderr: Box<dyn VirtualFile + Send + Sync + 'static>,
}

#[derive(Clone, Debug)]
pub struct FileSystemEvent {
    pub sequence: u64,
    pub kind: FileSystemEventKind,
    pub path: String,
    pub target_path: Option<String>,
    pub dropped_count: u64,
}

#[derive(Clone, Copy, Debug)]
pub enum FileSystemEventKind {
    FileCreated,
    FileModified,
    FileMetadataModified,
    FileRemoved,
    DirectoryCreated,
    DirectoryRemoved,
    PathRenamed,
    EventsDropped,
}

#[derive(Clone, Debug)]
pub struct EventBus {
    inner: Arc<EventBusInner>,
}

#[derive(Debug)]
struct EventBusInner {
    sender: tokio::sync::mpsc::Sender<FileSystemEvent>,
    enabled: AtomicBool,
    sequence: AtomicU64,
    dropped_count: AtomicU64,
}

#[derive(Clone, Debug)]
struct ReadOnlyFileSystem {
    inner: Arc<dyn FileSystem + Send + Sync>,
}

#[derive(Debug)]
struct ReadOnlyVirtualFile {
    inner: Box<dyn VirtualFile + Send + Sync + 'static>,
}

#[derive(Clone, Debug)]
struct ObservableFileSystem {
    inner: Arc<dyn FileSystem + Send + Sync>,
    events: EventBus,
}

#[derive(Debug)]
struct ObservableVirtualFile {
    inner: Box<dyn VirtualFile + Send + Sync + 'static>,
    events: EventBus,
    path: String,
}

#[derive(Clone, Debug)]
struct VirtualExecutableFileSystem {
    inner: Arc<dyn FileSystem + Send + Sync>,
    registry: VirtualExecutableRegistry,
    http_bridge: Option<HttpBridge>,
    wall_time: Option<Duration>,
    cancellation: CancellationToken,
}

#[derive(Debug)]
struct VirtualExecutableBridgeFile {
    registry: VirtualExecutableRegistry,
    wall_time: Option<Duration>,
    cancellation: CancellationToken,
    request: Vec<u8>,
    response: Option<Vec<u8>>,
    cursor: usize,
}

#[derive(Debug)]
struct HttpBridgeDeviceFile {
    bridge: HttpBridge,
    wall_time: Option<Duration>,
    cancellation: CancellationToken,
    request: Vec<u8>,
    response: Option<Vec<u8>>,
    cursor: usize,
}

#[derive(Debug)]
struct RelativeOrAbsolutePathHack<F>(F);

impl FileSystemEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FileCreated => "file_created",
            Self::FileModified => "file_modified",
            Self::FileMetadataModified => "file_metadata_modified",
            Self::FileRemoved => "file_removed",
            Self::DirectoryCreated => "directory_created",
            Self::DirectoryRemoved => "directory_removed",
            Self::PathRenamed => "path_renamed",
            Self::EventsDropped => "events_dropped",
        }
    }
}

impl HostProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BrowserStrict => "browser-strict",
            Self::NativeFull => "native-full",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "browser-strict" => Ok(Self::BrowserStrict),
            "native-full" => Ok(Self::NativeFull),
            _ => Err(anyhow!(
                "unknown host profile: {value}; expected browser-strict or native-full"
            )),
        }
    }
}

impl Default for HostProfile {
    fn default() -> Self {
        Self::BrowserStrict
    }
}

impl EventBus {
    pub fn new(capacity: usize) -> (Self, tokio::sync::mpsc::Receiver<FileSystemEvent>) {
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
        (
            Self {
                inner: Arc::new(EventBusInner {
                    sender,
                    enabled: AtomicBool::new(false),
                    sequence: AtomicU64::new(0),
                    dropped_count: AtomicU64::new(0),
                }),
            },
            receiver,
        )
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.inner.enabled.store(enabled, Ordering::Release);
        if enabled {
            return;
        }
        self.inner.dropped_count.store(0, Ordering::Release);
    }

    fn emit(&self, kind: FileSystemEventKind, path: String, target_path: Option<String>) {
        if !self.inner.enabled.load(Ordering::Acquire) {
            return;
        }

        let dropped_count = self.inner.dropped_count.swap(0, Ordering::AcqRel);
        if dropped_count > 0 {
            let dropped_event = self.event(
                FileSystemEventKind::EventsDropped,
                "/".to_string(),
                None,
                dropped_count,
            );
            if self.inner.sender.try_send(dropped_event).is_err() {
                self.inner
                    .dropped_count
                    .fetch_add(dropped_count.saturating_add(1), Ordering::AcqRel);
                return;
            }
        }

        let event = self.event(kind, path, target_path, 0);
        if self.inner.sender.try_send(event).is_ok() {
            return;
        }

        self.inner.dropped_count.fetch_add(1, Ordering::AcqRel);
    }

    fn event(
        &self,
        kind: FileSystemEventKind,
        path: String,
        target_path: Option<String>,
        dropped_count: u64,
    ) -> FileSystemEvent {
        FileSystemEvent {
            sequence: self.inner.sequence.fetch_add(1, Ordering::AcqRel) + 1,
            kind,
            path,
            target_path,
            dropped_count,
        }
    }
}

impl CancellationSource {
    pub fn new() -> Self {
        let (sender, _receiver) = tokio::sync::watch::channel(false);
        Self { sender }
    }

    pub fn token(&self) -> CancellationToken {
        CancellationToken {
            receiver: self.sender.subscribe(),
        }
    }

    pub fn cancel(&self) {
        let _ = self.sender.send(true);
    }
}

impl CancellationToken {
    pub fn is_cancelled(&self) -> bool {
        *self.receiver.borrow()
    }

    pub async fn cancelled(&mut self) {
        if self.is_cancelled() {
            return;
        }

        while self.receiver.changed().await.is_ok() {
            if self.is_cancelled() {
                return;
            }
        }
    }
}

impl VirtualProcessRequest {
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn invocation(&self) -> Result<VirtualProcessInvocation> {
        let payload: VirtualProcessPayload =
            serde_json::from_slice(&self.payload).context("invalid virtual process payload")?;
        let stdin = BASE64
            .decode(payload.stdin)
            .context("invalid virtual process stdin")?;
        Ok(VirtualProcessInvocation {
            handler_token: payload.handler_token,
            executable_path: payload.executable_path,
            argv: payload.argv,
            cwd: payload.cwd,
            env: payload.env,
            stdin,
        })
    }

    pub fn respond(&self, response: Vec<u8>) -> Result<()> {
        self.response_sender
            .send(VirtualProcessResponseEvent::Complete(response))
            .map_err(|_| anyhow!("virtual process response receiver closed"))
    }

    pub fn respond_process(&self, returncode: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> Result<()> {
        self.respond(encode_virtual_process_response(
            &VirtualProcessResponsePayload {
                returncode,
                stdout,
                stderr,
            },
        ))
    }

    pub fn write_stdout(&self, data: Vec<u8>) -> Result<()> {
        self.response_sender
            .send(VirtualProcessResponseEvent::Stdout(data))
            .map_err(|_| anyhow!("virtual process response receiver closed"))
    }

    pub fn write_stderr(&self, data: Vec<u8>) -> Result<()> {
        self.response_sender
            .send(VirtualProcessResponseEvent::Stderr(data))
            .map_err(|_| anyhow!("virtual process response receiver closed"))
    }
}

impl VirtualExecutableBridge {
    pub fn new(capacity: usize) -> (Self, tokio::sync::mpsc::Receiver<VirtualProcessRequest>) {
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
        (
            Self {
                inner: Arc::new(VirtualExecutableBridgeInner {
                    sender,
                    sequence: AtomicU64::new(0),
                }),
            },
            receiver,
        )
    }

    fn invoke_blocking(
        &self,
        payload: Vec<u8>,
        wall_time: Option<Duration>,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>> {
        self.invoke_blocking_with_output(payload, wall_time, cancellation, None)
    }

    fn invoke_blocking_with_output(
        &self,
        payload: Vec<u8>,
        wall_time: Option<Duration>,
        cancellation: CancellationToken,
        output: Option<VirtualProcessOutput>,
    ) -> Result<Vec<u8>> {
        let id = self.inner.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let (response_sender, response_receiver) = mpsc::channel();
        let request_cancellation = CancellationSource::new();
        let mut request = Some(VirtualProcessRequest {
            id,
            payload,
            cancellation: request_cancellation.token(),
            response_sender,
        });
        let deadline = wall_time.map(|timeout| Instant::now() + timeout);

        while let Some(candidate) = request.take() {
            if cancellation.is_cancelled() {
                request_cancellation.cancel();
                return Err(RunError::new(RunErrorKind::Cancelled, "process cancelled").into());
            }
            if deadline.is_some_and(|time| Instant::now() >= time) {
                request_cancellation.cancel();
                return Err(RunError::new(
                    RunErrorKind::Timeout,
                    "virtual executable exceeded wall time limit",
                )
                .into());
            }

            match self.inner.sender.try_send(candidate) {
                Ok(()) => break,
                Err(tokio::sync::mpsc::error::TrySendError::Full(candidate)) => {
                    request = Some(candidate);
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    request_cancellation.cancel();
                    return Err(anyhow!("virtual executable dispatcher is closed"));
                }
            }
        }

        loop {
            if cancellation.is_cancelled() {
                request_cancellation.cancel();
                return Err(RunError::new(RunErrorKind::Cancelled, "process cancelled").into());
            }
            if deadline.is_some_and(|time| Instant::now() >= time) {
                request_cancellation.cancel();
                return Err(RunError::new(
                    RunErrorKind::Timeout,
                    "virtual executable exceeded wall time limit",
                )
                .into());
            }

            let wait_time = deadline.map_or(Duration::from_millis(10), |time| {
                time.saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(10))
            });
            match response_receiver.recv_timeout(wait_time) {
                Ok(VirtualProcessResponseEvent::Stdout(data)) => {
                    if let Some(output) = &output {
                        if let Err(error) = output.stdout.write_all("stdout", &data) {
                            request_cancellation.cancel();
                            return Err(error);
                        }
                    }
                }
                Ok(VirtualProcessResponseEvent::Stderr(data)) => {
                    if let Some(output) = &output {
                        if let Err(error) = output.stderr.write_all("stderr", &data) {
                            request_cancellation.cancel();
                            return Err(error);
                        }
                    }
                }
                Ok(VirtualProcessResponseEvent::Complete(response)) => {
                    request_cancellation.cancel();
                    return Ok(response);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    request_cancellation.cancel();
                    return Err(anyhow!("virtual executable response channel closed"));
                }
            }
        }
    }
}

impl VirtualExecutableRegistry {
    pub fn new(bridge: VirtualExecutableBridge) -> Self {
        Self {
            inner: Arc::new(Mutex::new(VirtualExecutableRegistryInner::default())),
            bridge,
        }
    }

    pub fn bridge(&self) -> VirtualExecutableBridge {
        self.bridge.clone()
    }

    pub fn register(
        &self,
        fs: &TmpFileSystem,
        token: u64,
        paths: Vec<String>,
        replace: bool,
    ) -> Result<()> {
        if paths.is_empty() {
            return Err(anyhow!("virtual executable paths cannot be empty"));
        }

        let mut normalized_paths = Vec::with_capacity(paths.len());
        for path in paths {
            let normalized = normalize_path(&path)?;
            if normalized == Path::new("/") {
                return Err(anyhow!(
                    "virtual executable path cannot be the sandbox root"
                ));
            }
            normalized_paths.push(normalized);
        }

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow!("virtual executable registry lock failed"))?;
        for path in &normalized_paths {
            if !replace && fs.metadata(path).is_ok() {
                return Err(anyhow!(
                    "virtual executable path already exists: {}",
                    path.display()
                ));
            }
            if !replace && inner.paths.contains_key(path) {
                return Err(anyhow!(
                    "virtual executable path is already registered: {}",
                    path.display()
                ));
            }
        }

        for path in normalized_paths {
            create_parent_directories(fs, &path)?;
            let path_string = path
                .to_str()
                .ok_or_else(|| anyhow!("virtual executable path must be valid UTF-8"))?
                .to_string();
            let executable = virtual_executable_wasm(&path_string)?;
            write_file_to_fs_blocking(fs, &path, executable.clone())?;
            inner.paths.insert(
                path,
                VirtualExecutableTarget {
                    token,
                    path: path_string,
                },
            );
        }
        Ok(())
    }

    pub fn unregister(&self, fs: &TmpFileSystem, token: u64) -> Result<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow!("virtual executable registry lock failed"))?;
        let paths = inner
            .paths
            .iter()
            .filter_map(|(path, target)| {
                if target.token == token {
                    return Some(path.clone());
                }
                None
            })
            .collect::<Vec<_>>();

        for path in paths {
            inner.paths.remove(&path);
            if fs.remove_file(&path).is_err() {
                continue;
            }
        }
        Ok(())
    }

    fn resolve_command(
        &self,
        command: &str,
        cwd: &Path,
        path_env: Option<&String>,
    ) -> Result<Option<ResolvedVirtualExecutable>> {
        if command.as_bytes().contains(&0) {
            return Err(RunError::new(
                RunErrorKind::CommandResolution,
                "command cannot contain NUL bytes",
            )
            .into());
        }
        if command.is_empty() {
            return Err(
                RunError::new(RunErrorKind::CommandResolution, "command cannot be empty").into(),
            );
        }

        if command.contains('/') {
            let path = normalize_command_path(command, cwd)?;
            return self.resolve_path(&path);
        }

        for directory in path_env.map_or("", String::as_str).split(':') {
            let candidate = command_path_from_path_entry(directory, command, cwd)?;
            if let Some(target) = self.resolve_path(&candidate)? {
                return Ok(Some(target));
            }
        }
        Ok(None)
    }

    fn resolve_path(&self, path: &Path) -> Result<Option<ResolvedVirtualExecutable>> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| anyhow!("virtual executable registry lock failed"))?;
        Ok(inner
            .paths
            .get(path)
            .map(|target| ResolvedVirtualExecutable {
                token: target.token,
                executable_path: target.path.clone(),
            }))
    }

    fn invoke_guest(
        &self,
        payload: &[u8],
        wall_time: Option<Duration>,
        cancellation: CancellationToken,
    ) -> Vec<u8> {
        match self.invoke_guest_result(payload, wall_time, cancellation) {
            Ok(response) => response,
            Err(error) => virtual_process_error_response(error.to_string()),
        }
    }

    fn invoke_guest_result(
        &self,
        payload: &[u8],
        wall_time: Option<Duration>,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>> {
        let guest = parse_guest_virtual_process_payload(payload)
            .context("invalid virtual executable request")?;
        let executable_path = normalize_path(&guest.executable_path)?;
        let target = self.resolve_path(&executable_path)?.ok_or_else(|| {
            anyhow!(
                "virtual executable is not registered: {}",
                executable_path.display()
            )
        })?;
        let request = VirtualProcessPayload {
            handler_token: target.token,
            executable_path: target.executable_path,
            argv: guest.argv,
            cwd: guest.cwd,
            env: guest.env,
            stdin: guest.stdin,
        };
        let payload = serde_json::to_vec(&request)?;
        self.bridge
            .invoke_blocking(payload, wall_time, cancellation)
    }
}

impl<'a> BinaryCursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, cursor: 0 }
    }

    fn expect_magic(&mut self, expected: &[u8]) -> Result<()> {
        let actual = self.read_bytes(expected.len())?;
        if actual == expected {
            return Ok(());
        }
        Err(anyhow!("invalid binary payload magic"))
    }

    fn read_u32(&mut self) -> Result<u32> {
        let bytes = self.read_bytes(4)?;
        Ok(u32::from_le_bytes(bytes.try_into()?))
    }

    fn read_string(&mut self) -> Result<String> {
        let len = self.read_u32()? as usize;
        let bytes = self.read_bytes(len)?;
        String::from_utf8(bytes.to_vec()).context("binary payload string is not UTF-8")
    }

    fn read_bytes(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .cursor
            .checked_add(len)
            .ok_or_else(|| anyhow!("binary payload is too large"))?;
        if end > self.data.len() {
            return Err(anyhow!("binary payload is truncated"));
        }
        let bytes = &self.data[self.cursor..end];
        self.cursor = end;
        Ok(bytes)
    }
}

impl ReadOnlyFileSystem {
    fn new(inner: Arc<dyn FileSystem + Send + Sync>) -> Self {
        Self { inner }
    }
}

impl ObservableFileSystem {
    fn new(inner: Arc<dyn FileSystem + Send + Sync>, events: EventBus) -> Self {
        Self { inner, events }
    }
}

impl VirtualExecutableFileSystem {
    fn new(
        inner: Arc<dyn FileSystem + Send + Sync>,
        registry: VirtualExecutableRegistry,
        http_bridge: Option<HttpBridge>,
        wall_time: Option<Duration>,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            inner,
            registry,
            http_bridge,
            wall_time,
            cancellation,
        }
    }
}

impl FileSystem for ReadOnlyFileSystem {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.inner.readlink(path)
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.inner.read_dir(path)
    }

    fn create_dir(&self, _path: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn remove_dir(&self, _path: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn rename<'a>(
        &'a self,
        _from: &'a Path,
        _to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        Box::pin(async { Err(FsError::PermissionDenied) })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.inner.metadata(path)
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.inner.symlink_metadata(path)
    }

    fn remove_file(&self, _path: &Path) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }

    fn mount(
        &self,
        _name: String,
        _path: &Path,
        _fs: Box<dyn FileSystem + Send + Sync>,
    ) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }
}

impl FileOpener for ReadOnlyFileSystem {
    fn open(
        &self,
        path: &Path,
        config: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        if config.create() || config.create_new() || config.append() || config.truncate() {
            return Err(FsError::PermissionDenied);
        }

        let mut read_config = config.clone();
        read_config.read = true;
        read_config.write = false;

        let mut options = self.inner.new_open_options();
        let file = options.options(read_config).open(path)?;
        Ok(Box::new(ReadOnlyVirtualFile { inner: file }))
    }
}

impl AsyncRead for ReadOnlyVirtualFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_read(cx, buf)
    }
}

impl AsyncSeek for ReadOnlyVirtualFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        Pin::new(&mut *self.inner).start_seek(position)
    }

    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Pin::new(&mut *self.inner).poll_complete(cx)
    }
}

impl AsyncWrite for ReadOnlyVirtualFile {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(read_only_mount_error()))
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(read_only_mount_error()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl VirtualFile for ReadOnlyVirtualFile {
    fn last_accessed(&self) -> u64 {
        self.inner.last_accessed()
    }

    fn last_modified(&self) -> u64 {
        self.inner.last_modified()
    }

    fn created_time(&self) -> u64 {
        self.inner.created_time()
    }

    fn set_times(&mut self, _atime: Option<u64>, _mtime: Option<u64>) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn size(&self) -> u64 {
        self.inner.size()
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn is_open(&self) -> bool {
        self.inner.is_open()
    }

    fn get_special_fd(&self) -> Option<u32> {
        self.inner.get_special_fd()
    }

    fn poll_read_ready(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let inner = self.get_mut();
        Pin::new(&mut *inner.inner).poll_read_ready(cx)
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }
}

impl FileSystem for ObservableFileSystem {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.inner.readlink(path)
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.inner.read_dir(path)
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        let result = self.inner.create_dir(path);
        if result.is_ok() {
            self.events.emit(
                FileSystemEventKind::DirectoryCreated,
                event_path(path),
                None,
            );
        }
        result
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        let result = self.inner.remove_dir(path);
        if result.is_ok() {
            self.events.emit(
                FileSystemEventKind::DirectoryRemoved,
                event_path(path),
                None,
            );
        }
        result
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        let inner = Arc::clone(&self.inner);
        let events = self.events.clone();
        let from_path = from.to_path_buf();
        let to_path = to.to_path_buf();
        Box::pin(async move {
            inner.rename(&from_path, &to_path).await?;
            events.emit(
                FileSystemEventKind::PathRenamed,
                event_path(&from_path),
                Some(event_path(&to_path)),
            );
            Ok(())
        })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.inner.metadata(path)
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.inner.symlink_metadata(path)
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        let result = self.inner.remove_file(path);
        if result.is_ok() {
            self.events
                .emit(FileSystemEventKind::FileRemoved, event_path(path), None);
        }
        result
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }

    fn mount(
        &self,
        name: String,
        path: &Path,
        fs: Box<dyn FileSystem + Send + Sync>,
    ) -> virtual_fs::Result<()> {
        self.inner.mount(name, path, fs)
    }
}

impl FileOpener for ObservableFileSystem {
    fn open(
        &self,
        path: &Path,
        config: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        let existed = self.inner.metadata(path).is_ok();
        let mut options = self.inner.new_open_options();
        let file = options.options(config.clone()).open(path)?;
        let path = event_path(path);

        if !existed && (config.create() || config.create_new()) {
            self.events
                .emit(FileSystemEventKind::FileCreated, path.clone(), None);
        } else if config.truncate() {
            self.events
                .emit(FileSystemEventKind::FileModified, path.clone(), None);
        }

        if config.would_mutate() {
            return Ok(Box::new(ObservableVirtualFile {
                inner: file,
                events: self.events.clone(),
                path,
            }));
        }

        Ok(file)
    }
}

impl AsyncRead for ObservableVirtualFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_read(cx, buf)
    }
}

impl AsyncSeek for ObservableVirtualFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        Pin::new(&mut *self.inner).start_seek(position)
    }

    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Pin::new(&mut *self.inner).poll_complete(cx)
    }
}

impl AsyncWrite for ObservableVirtualFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut *self.inner).poll_write(cx, buf) {
            Poll::Ready(Ok(bytes_written)) => {
                if bytes_written > 0 {
                    self.events
                        .emit(FileSystemEventKind::FileModified, self.path.clone(), None);
                }
                Poll::Ready(Ok(bytes_written))
            }
            result => result,
        }
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut *self.inner).poll_write_vectored(cx, bufs) {
            Poll::Ready(Ok(bytes_written)) => {
                if bytes_written > 0 {
                    self.events
                        .emit(FileSystemEventKind::FileModified, self.path.clone(), None);
                }
                Poll::Ready(Ok(bytes_written))
            }
            result => result,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_shutdown(cx)
    }
}

impl VirtualFile for ObservableVirtualFile {
    fn last_accessed(&self) -> u64 {
        self.inner.last_accessed()
    }

    fn last_modified(&self) -> u64 {
        self.inner.last_modified()
    }

    fn created_time(&self) -> u64 {
        self.inner.created_time()
    }

    fn set_times(&mut self, atime: Option<u64>, mtime: Option<u64>) -> virtual_fs::Result<()> {
        self.inner.set_times(atime, mtime)?;
        self.events.emit(
            FileSystemEventKind::FileMetadataModified,
            self.path.clone(),
            None,
        );
        Ok(())
    }

    fn size(&self) -> u64 {
        self.inner.size()
    }

    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        self.inner.set_len(new_size)?;
        self.events
            .emit(FileSystemEventKind::FileModified, self.path.clone(), None);
        Ok(())
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        self.inner.unlink()?;
        self.events
            .emit(FileSystemEventKind::FileRemoved, self.path.clone(), None);
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.inner.is_open()
    }

    fn get_special_fd(&self) -> Option<u32> {
        self.inner.get_special_fd()
    }

    fn write_from_mmap(&mut self, offset: u64, len: u64) -> io::Result<()> {
        self.inner.write_from_mmap(offset, len)?;
        self.events
            .emit(FileSystemEventKind::FileModified, self.path.clone(), None);
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let inner = self.get_mut();
        Pin::new(&mut *inner.inner).poll_read_ready(cx)
    }

    fn poll_write_ready(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let inner = self.get_mut();
        Pin::new(&mut *inner.inner).poll_write_ready(cx)
    }
}

impl FileSystem for VirtualExecutableFileSystem {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.inner.readlink(path)
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<ReadDir> {
        let mut entries = self
            .inner
            .read_dir(path)?
            .collect::<virtual_fs::Result<Vec<_>>>()?;
        if path == Path::new("/dev") {
            entries.push(DirEntry {
                path: PathBuf::from(VIRTUAL_EXEC_BRIDGE_PATH),
                metadata: Ok(virtual_exec_bridge_metadata()),
            });
            if self.http_bridge.is_some() {
                entries.push(DirEntry {
                    path: PathBuf::from(HTTP_BRIDGE_PATH),
                    metadata: Ok(host_bridge_device_metadata()),
                });
            }
        }
        Ok(ReadDir::new(entries))
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.inner.create_dir(path)
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.inner.remove_dir(path)
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        Box::pin(async move { self.inner.rename(from, to).await })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        if path == Path::new(VIRTUAL_EXEC_BRIDGE_PATH) {
            return Ok(virtual_exec_bridge_metadata());
        }
        if path == Path::new(HTTP_BRIDGE_PATH) && self.http_bridge.is_some() {
            return Ok(host_bridge_device_metadata());
        }
        self.inner.metadata(path)
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        if path == Path::new(VIRTUAL_EXEC_BRIDGE_PATH) {
            return Ok(virtual_exec_bridge_metadata());
        }
        if path == Path::new(HTTP_BRIDGE_PATH) && self.http_bridge.is_some() {
            return Ok(host_bridge_device_metadata());
        }
        self.inner.symlink_metadata(path)
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        if path == Path::new(VIRTUAL_EXEC_BRIDGE_PATH)
            || (path == Path::new(HTTP_BRIDGE_PATH) && self.http_bridge.is_some())
        {
            return Err(FsError::PermissionDenied);
        }
        self.inner.remove_file(path)
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }

    fn mount(
        &self,
        name: String,
        path: &Path,
        fs: Box<dyn FileSystem + Send + Sync>,
    ) -> virtual_fs::Result<()> {
        self.inner.mount(name, path, fs)
    }
}

impl FileOpener for VirtualExecutableFileSystem {
    fn open(
        &self,
        path: &Path,
        config: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        if path == Path::new(VIRTUAL_EXEC_BRIDGE_PATH) {
            if !config.read() || !(config.write() || config.append()) {
                return Err(FsError::PermissionDenied);
            }
            return Ok(Box::new(VirtualExecutableBridgeFile {
                registry: self.registry.clone(),
                wall_time: self.wall_time,
                cancellation: self.cancellation.clone(),
                request: Vec::new(),
                response: None,
                cursor: 0,
            }));
        }
        if path == Path::new(HTTP_BRIDGE_PATH) {
            let Some(bridge) = self.http_bridge.clone() else {
                return Err(FsError::EntryNotFound);
            };
            if !config.read() || !(config.write() || config.append()) {
                return Err(FsError::PermissionDenied);
            }
            return Ok(Box::new(HttpBridgeDeviceFile {
                bridge,
                wall_time: self.wall_time,
                cancellation: self.cancellation.clone(),
                request: Vec::new(),
                response: None,
                cursor: 0,
            }));
        }

        self.inner
            .new_open_options()
            .options(config.clone())
            .open(path)
    }
}

impl AsyncRead for VirtualExecutableBridgeFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.response.is_none() {
            let request = self.request.clone();
            let response =
                self.registry
                    .invoke_guest(&request, self.wall_time, self.cancellation.clone());
            self.response = Some(response);
            self.cursor = 0;
        }

        let response = self
            .response
            .as_ref()
            .expect("response should be initialized");
        let available = &response[self.cursor.min(response.len())..];
        if available.is_empty() {
            return Poll::Ready(Ok(()));
        }

        let length = available.len().min(buf.remaining());
        buf.put_slice(&available[..length]);
        self.cursor += length;
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for VirtualExecutableBridgeFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        let response_len = self.response.as_ref().map_or(0_i128, |response| {
            i128::try_from(response.len()).unwrap_or(i128::MAX)
        });
        let cursor = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => response_len + i128::from(offset),
            SeekFrom::Current(offset) => {
                i128::try_from(self.cursor).unwrap_or(i128::MAX) + i128::from(offset)
            }
        };
        if cursor < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot seek before start",
            ));
        }
        self.cursor = usize::try_from(cursor).unwrap_or(usize::MAX);
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.cursor as u64))
    }
}

impl AsyncWrite for VirtualExecutableBridgeFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.request.extend_from_slice(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl VirtualFile for VirtualExecutableBridgeFile {
    fn last_accessed(&self) -> u64 {
        current_time_nanos()
    }

    fn last_modified(&self) -> u64 {
        current_time_nanos()
    }

    fn created_time(&self) -> u64 {
        current_time_nanos()
    }

    fn size(&self) -> u64 {
        self.response
            .as_ref()
            .map_or(0_u64, |response| response.len() as u64)
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn is_open(&self) -> bool {
        true
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(1))
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(1))
    }
}

impl AsyncRead for HttpBridgeDeviceFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.response.is_none() {
            let response = handle_http_bridge_device_request(
                &self.bridge,
                &self.request,
                self.wall_time,
                self.cancellation.clone(),
            );
            self.response = Some(response);
            self.cursor = 0;
        }

        let response = self
            .response
            .as_ref()
            .expect("response should be initialized");
        let available = &response[self.cursor.min(response.len())..];
        if available.is_empty() {
            return Poll::Ready(Ok(()));
        }

        let length = available.len().min(buf.remaining());
        buf.put_slice(&available[..length]);
        self.cursor += length;
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for HttpBridgeDeviceFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        let response_len = self.response.as_ref().map_or(0_i128, |response| {
            i128::try_from(response.len()).unwrap_or(i128::MAX)
        });
        let cursor = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => response_len + i128::from(offset),
            SeekFrom::Current(offset) => {
                i128::try_from(self.cursor).unwrap_or(i128::MAX) + i128::from(offset)
            }
        };
        if cursor < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot seek before start",
            ));
        }
        self.cursor = usize::try_from(cursor).unwrap_or(usize::MAX);
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.cursor as u64))
    }
}

impl AsyncWrite for HttpBridgeDeviceFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.response.is_some() {
            self.request.clear();
        }
        self.request.extend_from_slice(buf);
        self.response = None;
        self.cursor = 0;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl VirtualFile for HttpBridgeDeviceFile {
    fn last_accessed(&self) -> u64 {
        current_time_nanos()
    }

    fn last_modified(&self) -> u64 {
        current_time_nanos()
    }

    fn created_time(&self) -> u64 {
        current_time_nanos()
    }

    fn size(&self) -> u64 {
        self.response
            .as_ref()
            .map_or(0_u64, |response| response.len() as u64)
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn is_open(&self) -> bool {
        true
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(1))
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(1))
    }
}

impl<F: FileSystem> RelativeOrAbsolutePathHack<F> {
    fn execute<Func, Ret>(&self, path: &Path, operation: Func) -> virtual_fs::Result<Ret>
    where
        Func: Fn(&F, &Path) -> virtual_fs::Result<Ret>,
    {
        let result = operation(&self.0, path);
        if result.is_err() && !path.is_absolute() {
            return operation(&self.0, &Path::new("/").join(path));
        }
        result
    }
}

impl<F: FileSystem> FileSystem for RelativeOrAbsolutePathHack<F> {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.execute(path, |fs, candidate| fs.readlink(candidate))
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.execute(path, |fs, candidate| fs.read_dir(candidate))
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.execute(path, |fs, candidate| fs.create_dir(candidate))
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.execute(path, |fs, candidate| fs.remove_dir(candidate))
    }

    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> Pin<Box<dyn Future<Output = virtual_fs::Result<()>> + Send + 'a>> {
        Box::pin(async move { self.0.rename(from, to).await })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.execute(path, |fs, candidate| fs.metadata(candidate))
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        self.execute(path, |fs, candidate| fs.symlink_metadata(candidate))
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        self.execute(path, |fs, candidate| fs.remove_file(candidate))
    }

    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        virtual_fs::OpenOptions::new(self)
    }

    fn mount(
        &self,
        name: String,
        path: &Path,
        fs: Box<dyn FileSystem + Send + Sync>,
    ) -> virtual_fs::Result<()> {
        let fs = Arc::new(fs);
        self.execute(path, move |inner, candidate| {
            inner.mount(name.clone(), candidate, Box::new(Arc::clone(&fs)))
        })
    }
}

impl<F: FileSystem> FileOpener for RelativeOrAbsolutePathHack<F> {
    fn open(
        &self,
        path: &Path,
        config: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        self.execute(path, |fs, candidate| {
            fs.new_open_options()
                .options(config.clone())
                .open(candidate)
        })
    }
}

impl SandboxState {
    pub fn new(
        files: HashMap<String, Option<Vec<u8>>>,
        host_mounts: Vec<HostMount>,
        packages: Vec<PackageSpec>,
        cwd: String,
        env: HashMap<String, String>,
        events: EventBus,
        virtual_processes: VirtualExecutableBridge,
    ) -> Result<Self> {
        Self::new_with_profile_and_options(
            HostProfile::default(),
            files,
            host_mounts,
            packages,
            cwd,
            env,
            events,
            virtual_processes,
            SandboxOptions::default(),
        )
    }

    pub fn new_with_profile(
        profile: HostProfile,
        files: HashMap<String, Option<Vec<u8>>>,
        host_mounts: Vec<HostMount>,
        packages: Vec<PackageSpec>,
        cwd: String,
        env: HashMap<String, String>,
        events: EventBus,
        virtual_processes: VirtualExecutableBridge,
    ) -> Result<Self> {
        Self::new_with_profile_and_options(
            profile,
            files,
            host_mounts,
            packages,
            cwd,
            env,
            events,
            virtual_processes,
            SandboxOptions::default(),
        )
    }

    pub fn new_with_profile_and_options(
        profile: HostProfile,
        files: HashMap<String, Option<Vec<u8>>>,
        host_mounts: Vec<HostMount>,
        packages: Vec<PackageSpec>,
        cwd: String,
        env: HashMap<String, String>,
        events: EventBus,
        virtual_processes: VirtualExecutableBridge,
        options: SandboxOptions,
    ) -> Result<Self> {
        if profile != HostProfile::NativeFull && !host_mounts.is_empty() {
            return Err(anyhow!(
                "host mounts require the native-full profile, current profile is {}",
                profile.as_str()
            ));
        }

        let catalog = catalog_for(packages, &options)?;
        let fs = TmpFileSystem::new();
        create_default_layout(&catalog, &fs)?;
        let cwd = normalize_path(&cwd)?;
        let cwd = cwd
            .to_str()
            .ok_or_else(|| anyhow!("sandbox cwd must be valid UTF-8"))?
            .to_string();
        let mut sandbox_env = default_env();
        sandbox_env.extend(env);

        let state = Self {
            fs,
            cwd,
            env: sandbox_env,
            profile,
            catalog,
            events,
            virtual_executables: VirtualExecutableRegistry::new(virtual_processes),
            http_bridge: options.http_bridge,
        };

        for (path, contents) in files {
            match contents {
                Some(data) => state.write_file_silent_blocking(&path, data)?,
                None => state.create_directory_silent(&path)?,
            }
        }

        for mount in host_mounts {
            state.mount_host(mount)?;
        }

        Ok(state)
    }

    pub fn exists(&self, path: &str) -> Result<bool> {
        let path = normalize_path(path)?;
        Ok(self.fs.metadata(&path).is_ok())
    }

    pub async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let path = normalize_path(path)?;
        read_file_from_fs(&self.fs, &path)
            .await
            .with_context(|| format!("unable to read {}", path.display()))
    }

    pub async fn write_file(&self, path: &str, data: Vec<u8>) -> Result<()> {
        let path = normalize_path(path)?;
        let existed = self.fs.metadata(&path).is_ok();
        self.create_parent_directories(&path)?;
        write_file_to_fs(&self.fs, &path, data)
            .await
            .with_context(|| format!("unable to write {}", path.display()))?;
        let kind = if existed {
            FileSystemEventKind::FileModified
        } else {
            FileSystemEventKind::FileCreated
        };
        self.events.emit(kind, event_path(&path), None);
        Ok(())
    }

    pub fn create_directory(&self, path: &str) -> Result<()> {
        let path = normalize_path(path)?;
        for created_path in create_directories(&self.fs, &path)? {
            self.events.emit(
                FileSystemEventKind::DirectoryCreated,
                event_path(&created_path),
                None,
            );
        }
        Ok(())
    }

    pub async fn rename_path(&self, from: &str, to: &str) -> Result<()> {
        let from = normalize_path(from)?;
        let to = normalize_path(to)?;
        self.create_parent_directories(&to)?;
        self.fs
            .rename(&from, &to)
            .await
            .with_context(|| format!("unable to rename {} to {}", from.display(), to.display()))?;
        self.events.emit(
            FileSystemEventKind::PathRenamed,
            event_path(&from),
            Some(event_path(&to)),
        );
        Ok(())
    }

    pub fn remove_file(&self, path: &str) -> Result<()> {
        let path = normalize_path(path)?;
        self.fs
            .remove_file(&path)
            .with_context(|| format!("unable to remove {}", path.display()))?;
        self.events
            .emit(FileSystemEventKind::FileRemoved, event_path(&path), None);
        Ok(())
    }

    pub fn remove_directory(&self, path: &str) -> Result<()> {
        let path = normalize_path(path)?;
        self.fs
            .remove_dir(&path)
            .with_context(|| format!("unable to remove {}", path.display()))?;
        self.events.emit(
            FileSystemEventKind::DirectoryRemoved,
            event_path(&path),
            None,
        );
        Ok(())
    }

    pub fn create_symlink(&self, target: &str, link_path: &str) -> Result<()> {
        let target = symlink_target(target)?;
        let link_path = normalize_path(link_path)?;
        self.create_parent_directories(&link_path)?;
        self.fs
            .create_symlink(&target, &link_path)
            .with_context(|| format!("unable to create symlink {}", link_path.display()))?;
        self.events.emit(
            FileSystemEventKind::FileCreated,
            event_path(&link_path),
            None,
        );
        Ok(())
    }

    pub fn readlink(&self, path: &str) -> Result<String> {
        let path = normalize_path(path)?;
        let target = self
            .fs
            .readlink(&path)
            .with_context(|| format!("unable to readlink {}", path.display()))?;
        target
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("symlink target must be valid UTF-8"))
    }

    fn write_file_silent_blocking(&self, path: &str, data: Vec<u8>) -> Result<()> {
        self.catalog.block_on(self.write_file_silent(path, data))
    }

    async fn write_file_silent(&self, path: &str, data: Vec<u8>) -> Result<()> {
        let path = normalize_path(path)?;
        create_parent_directories(&self.fs, &path)?;
        write_file_to_fs(&self.fs, &path, data)
            .await
            .with_context(|| format!("unable to write {}", path.display()))
    }

    fn create_directory_silent(&self, path: &str) -> Result<()> {
        let path = normalize_path(path)?;
        create_dir_all(&self.fs, &path)
            .with_context(|| format!("unable to create {}", path.display()))
    }

    fn create_parent_directories(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            for created_path in create_directories(&self.fs, parent)? {
                self.events.emit(
                    FileSystemEventKind::DirectoryCreated,
                    event_path(&created_path),
                    None,
                );
            }
        }
        Ok(())
    }

    pub fn mount_host(&self, mount: HostMount) -> Result<()> {
        if self.profile != HostProfile::NativeFull {
            return Err(anyhow!(
                "host mounts require the native-full profile, current profile is {}",
                self.profile.as_str()
            ));
        }

        let target = normalize_path(&mount.target)?;
        if target == Path::new("/") {
            return Err(anyhow!("host mount target cannot be the sandbox root"));
        }

        create_parent_directories(&self.fs, &target)?;
        if let Ok(metadata) = self.fs.metadata(&target) {
            if !metadata.is_dir() {
                return Err(anyhow!(
                    "host mount target is not a directory: {}",
                    target.display()
                ));
            }
        }

        let source = validate_host_mount_source(&mount.source)?;
        let _runtime_guard = self.catalog.handle.enter();
        let host_fs = host_fs::FileSystem::new(self.catalog.handle.clone(), source.clone())
            .with_context(|| format!("unable to mount host source {}", source.display()))?;
        let host_fs: Arc<dyn FileSystem + Send + Sync> = Arc::new(host_fs);
        let mounted_fs: Arc<dyn FileSystem + Send + Sync> = if mount.read_only {
            Arc::new(ReadOnlyFileSystem::new(host_fs))
        } else {
            host_fs
        };

        self.fs
            .mount(target.clone(), &mounted_fs, PathBuf::from("/"))
            .with_context(|| format!("unable to mount host source at {}", target.display()))
    }

    pub fn listdir(&self, path: &str) -> Result<Vec<String>> {
        let path = normalize_path(path)?;
        let mut names = self
            .fs
            .read_dir(&path)
            .with_context(|| format!("unable to list {}", path.display()))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                entry
                    .path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
            })
            .collect::<Vec<_>>();
        names.sort();
        Ok(names)
    }

    pub fn register_virtual_executable(
        &self,
        token: u64,
        paths: Vec<String>,
        replace: bool,
    ) -> Result<()> {
        self.virtual_executables
            .register(&self.fs, token, paths, replace)
    }

    pub fn unregister_virtual_executable(&self, token: u64) -> Result<()> {
        self.virtual_executables.unregister(&self.fs, token)
    }

    pub fn run_blocking(
        &self,
        request: RunRequest,
        cancellation: CancellationToken,
    ) -> Result<CompletedProcess> {
        self.catalog.run(self, request, cancellation)
    }

    pub fn run_blocking_with_output(
        &self,
        request: RunRequest,
        output: OutputSinks,
        cancellation: CancellationToken,
    ) -> Result<CompletedProcess> {
        self.catalog
            .run_with_output(self, request, output, cancellation)
    }

    #[allow(dead_code)]
    pub(crate) fn run_with_stdio_blocking(
        &self,
        request: RunRequest,
        streams: ProcessStreams,
        cancellation: CancellationToken,
    ) -> Result<CompletedProcess> {
        self.catalog
            .run_with_stdio(self, request, streams, cancellation)
    }
}

impl PackageCatalog {
    fn load(
        package_specs: Vec<ResolvedPackageSpec>,
        module_cache_dir: PathBuf,
    ) -> Result<Arc<Self>> {
        let tokio_runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("wasm-host-wasmer")
            .build()
            .context("unable to create Wasmer runtime")?;
        let handle = tokio_runtime.handle().clone();
        let task_manager = Arc::new(TokioTaskManager::new(tokio_runtime));
        let virtual_task_manager: Arc<dyn VirtualTaskManager> = task_manager.clone();
        let _runtime_guard = handle.enter();
        let mut runtime = PluggableRuntime::new(virtual_task_manager);
        runtime.set_engine(sandbox_engine());
        runtime.set_tty(Arc::new(NonInteractiveTty));
        runtime.set_module_cache(SharedCache::default().with_fallback(FileSystemCache::new(
            module_cache_dir,
            Arc::clone(&task_manager),
        )));
        runtime.set_package_loader(BuiltinPackageLoader::new());
        runtime.set_source(package_source(&package_specs)?);

        let runtime = Arc::new(runtime);
        let mut packages = HashMap::new();
        let mut command_paths = HashMap::new();

        for spec in package_specs {
            let package = load_package(&handle, runtime.as_ref(), &spec.webc_path)?;
            register_package(&spec.name, &package, &mut command_paths)?;
            for alias in spec.command_aliases {
                register_command_alias(
                    &alias.alias,
                    &spec.name,
                    &alias.command,
                    &mut command_paths,
                )?;
            }
            packages.insert(spec.name, Arc::new(package));
        }

        Ok(Arc::new(Self {
            runtime,
            handle,
            packages,
            command_paths,
        }))
    }

    fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        self.handle.block_on(future)
    }

    fn run(
        &self,
        state: &SandboxState,
        request: RunRequest,
        cancellation: CancellationToken,
    ) -> Result<CompletedProcess> {
        self.run_with_output(state, request, OutputSinks::default(), cancellation)
    }

    fn run_with_output(
        &self,
        state: &SandboxState,
        request: RunRequest,
        output: OutputSinks,
        cancellation: CancellationToken,
    ) -> Result<CompletedProcess> {
        let RunRequest {
            args,
            input,
            env,
            cwd,
            limits,
        } = request;
        let input = input.unwrap_or_default();
        let streams = ProcessStreams {
            stdin: Box::new(StaticFile::new(input)),
            stdout: CapturedOutput::new(limits.output_bytes, output.stdout),
            stderr: CapturedOutput::new(limits.output_bytes, output.stderr),
        };
        let request = RunRequest {
            args,
            input: None,
            env,
            cwd,
            limits,
        };
        self.run_with_stdio(state, request, streams, cancellation)
    }

    fn run_with_stdio(
        &self,
        state: &SandboxState,
        request: RunRequest,
        streams: ProcessStreams,
        cancellation: CancellationToken,
    ) -> Result<CompletedProcess> {
        if request.args.is_empty() {
            return Err(anyhow!("command arguments cannot be empty"));
        }

        let args = request.args;
        let mut env = state.env.clone();
        if let Some(overrides) = request.env {
            env.extend(overrides);
        }

        let cwd = request.cwd.unwrap_or_else(|| state.cwd.clone());
        let cwd = normalize_path(&cwd)?;
        validate_directory(&state.fs, &cwd, "cwd")?;
        let wall_time = match request.limits.wall_time_seconds {
            Some(seconds) => Some(duration_from_seconds(seconds)?),
            None => None,
        };
        let target = match self.resolve_command(state, &args[0], &cwd, env.get("PATH"))? {
            ResolvedCommand::Virtual(target) => {
                let input = self.read_stdin_to_end(streams.stdin)?;
                let stdout = streams.stdout;
                let stderr = streams.stderr;
                return self.run_virtual_command(
                    args,
                    input,
                    env,
                    cwd,
                    target,
                    state,
                    wall_time,
                    stdout,
                    stderr,
                    cancellation,
                );
            }
            ResolvedCommand::Package(target) => target,
        };
        let package = self
            .packages
            .get(&target.package)
            .ok_or_else(|| anyhow!("package not loaded: {}", target.package))?;

        let injected_packages = self.injected_packages(&target.package);
        let stdout = streams.stdout;
        let stderr = streams.stderr;

        let run_result = self.run_package_command(
            ProcessIo {
                args: args.iter().skip(1).cloned().collect(),
                env,
                cwd,
                stdin: streams.stdin,
                stdout: Box::new(stdout.file()),
                stderr: Box::new(stderr.file()),
            },
            &target.command,
            package,
            injected_packages,
            state.fs.clone(),
            state.events.clone(),
            state.virtual_executables.clone(),
            state.http_bridge.clone(),
            wall_time,
            cancellation,
        );

        let stdout = stdout.capture("stdout")?;
        let stderr = stderr.capture("stderr")?;
        let returncode = run_result?;
        let (returncode, stderr) = normalize_process_outcome(&target.command, returncode, stderr);

        Ok(CompletedProcess {
            args,
            returncode,
            stdout,
            stderr,
        })
    }

    fn read_stdin_to_end(
        &self,
        mut stdin: Box<dyn VirtualFile + Send + Sync + 'static>,
    ) -> Result<Vec<u8>> {
        self.block_on(async move {
            let mut input = Vec::new();
            stdin
                .read_to_end(&mut input)
                .await
                .context("unable to read process stdin")?;
            Ok(input)
        })
    }

    fn run_virtual_command(
        &self,
        args: Vec<String>,
        input: Vec<u8>,
        env: HashMap<String, String>,
        cwd: PathBuf,
        target: ResolvedVirtualExecutable,
        state: &SandboxState,
        wall_time: Option<Duration>,
        stdout: CapturedOutput,
        stderr: CapturedOutput,
        cancellation: CancellationToken,
    ) -> Result<CompletedProcess> {
        let cwd = cwd
            .to_str()
            .ok_or_else(|| anyhow!("sandbox cwd must be valid UTF-8"))?
            .to_string();
        let request = VirtualProcessPayload {
            handler_token: target.token,
            executable_path: target.executable_path,
            argv: args.clone(),
            cwd,
            env,
            stdin: BASE64.encode(input),
        };
        let payload = serde_json::to_vec(&request)?;
        let output = VirtualProcessOutput {
            stdout: stdout.clone(),
            stderr: stderr.clone(),
        };
        let response = state
            .virtual_executables
            .bridge()
            .invoke_blocking_with_output(payload, wall_time, cancellation, Some(output))?;
        let response = decode_virtual_process_response(&response)
            .context("invalid virtual executable response")?;
        stdout.write_all("stdout", &response.stdout)?;
        stderr.write_all("stderr", &response.stderr)?;
        let captured_stdout = stdout.capture("stdout")?;
        let captured_stderr = stderr.capture("stderr")?;
        Ok(CompletedProcess {
            args,
            returncode: response.returncode,
            stdout: captured_stdout,
            stderr: captured_stderr,
        })
    }

    fn resolve_command(
        &self,
        state: &SandboxState,
        command: &str,
        cwd: &Path,
        path_env: Option<&String>,
    ) -> Result<ResolvedCommand> {
        if command.as_bytes().contains(&0) {
            return Err(RunError::new(
                RunErrorKind::CommandResolution,
                "command cannot contain NUL bytes",
            )
            .into());
        }
        if command.is_empty() {
            return Err(
                RunError::new(RunErrorKind::CommandResolution, "command cannot be empty").into(),
            );
        }

        if let Some(target) = state
            .virtual_executables
            .resolve_command(command, cwd, path_env)?
        {
            return Ok(ResolvedCommand::Virtual(target));
        }

        if command.contains('/') {
            let path = normalize_command_path(command, cwd)?;
            return self
                .command_paths
                .get(&path)
                .cloned()
                .map(ResolvedCommand::Package)
                .ok_or_else(|| {
                    RunError::new(
                        RunErrorKind::CommandResolution,
                        format!("command not found: {command}"),
                    )
                    .into()
                });
        }

        self.resolve_path_command(command, cwd, path_env)?
            .map(ResolvedCommand::Package)
            .ok_or_else(|| {
                RunError::new(
                    RunErrorKind::CommandResolution,
                    format!("command not found: {command}"),
                )
                .into()
            })
    }

    fn resolve_path_command(
        &self,
        command: &str,
        cwd: &Path,
        path_env: Option<&String>,
    ) -> Result<Option<CommandTarget>> {
        for directory in path_env.map_or("", String::as_str).split(':') {
            let candidate = command_path_from_path_entry(directory, command, cwd)?;
            if let Some(target) = self.command_paths.get(&candidate) {
                return Ok(Some(target.clone()));
            }
        }
        Ok(None)
    }

    fn injected_packages(&self, target_package: &str) -> Vec<BinaryPackage> {
        self.packages
            .iter()
            .filter_map(|(name, package)| {
                if name == target_package {
                    return None;
                }
                Some((**package).clone())
            })
            .collect()
    }

    fn run_package_command(
        &self,
        io: ProcessIo,
        command_name: &str,
        package: &BinaryPackage,
        injected_packages: Vec<BinaryPackage>,
        root_fs: TmpFileSystem,
        events: EventBus,
        virtual_executables: VirtualExecutableRegistry,
        http_bridge: Option<HttpBridge>,
        wall_time: Option<Duration>,
        cancellation: CancellationToken,
    ) -> Result<i32> {
        let command = package
            .get_command(command_name)
            .with_context(|| format!("package does not contain command {command_name}"))?;
        let wasi = command
            .metadata()
            .annotation("wasi")?
            .unwrap_or_else(|| Wasi::new(command_name));
        let exec_name = wasi.exec_name.as_deref().unwrap_or(command_name);
        let mut builder = WasiEnvBuilder::new(exec_name);
        builder.set_runtime(Arc::clone(&self.runtime));
        builder.set_module_hash(package.hash());
        builder.add_webc(package.clone());
        builder.include_packages(package.package_ids.clone());

        let package_files = process_package_files(package, &injected_packages)?;
        for injected_package in injected_packages {
            builder.add_webc(injected_package.clone());
            builder.include_packages(injected_package.package_ids.clone());
        }

        builder.set_current_dir(io.cwd.clone());
        if let Some(package_cwd) = &wasi.cwd {
            builder.set_current_dir(package_cwd);
        }

        if let Some(main_args) = &wasi.main_args {
            builder.add_args(main_args);
        }
        builder.add_args(io.args);

        for item in wasi.env.as_deref().unwrap_or_default() {
            match item.split_once('=') {
                Some((key, value)) => builder.add_env(key, value),
                None => builder.add_env(item, String::new()),
            }
        }
        builder.add_envs(io.env);

        let current_dir = builder.get_current_dir().unwrap_or(PathBuf::from("/"));
        builder.add_map_dir(".", current_dir)?;
        builder.add_preopen_dir("/")?;
        builder.set_fs(process_filesystem(
            root_fs,
            package_files,
            events,
            virtual_executables,
            http_bridge,
            wall_time,
            cancellation.clone(),
        ));
        builder.set_stdin(io.stdin);
        builder.set_stdout(io.stdout);
        builder.set_stderr(io.stderr);

        let _runtime_guard = self.handle.enter();
        let env = builder.build()?;
        let runtime = env.runtime.clone();
        let process = env.process.clone();
        let tasks = runtime.task_manager().clone();
        let package = package.clone();
        let command_name = command_name.to_string();

        let exit_code = tasks.spawn_and_block_on(async move {
            let mut cancellation = cancellation;

            let spawn = spawn_exec(package, &command_name, env, &runtime);
            let mut task_handle = tokio::select! {
                result = spawn => result.context("spawn failed")?,
                _ = cancellation.cancelled() => {
                    return Err(RunError::new(RunErrorKind::Cancelled, "process cancelled").into());
                }
            };

            let wait_finished = task_handle.wait_finished();
            tokio::pin!(wait_finished);

            let exit_code = if let Some(timeout) = wall_time {
                tokio::select! {
                    result = &mut wait_finished => result
                        .map_err(|error| anyhow!(error.to_string()))?,
                    _ = tokio::time::sleep(timeout) => {
                        process.terminate(126_i32.into());
                        let _ = wait_finished.await;
                        return Err(RunError::new(
                            RunErrorKind::Timeout,
                            format!(
                                "process exceeded wall time limit of {:.3} seconds",
                                timeout.as_secs_f64()
                            ),
                        )
                        .into());
                    }
                    _ = cancellation.cancelled() => {
                        process.terminate(126_i32.into());
                        let _ = wait_finished.await;
                        return Err(RunError::new(RunErrorKind::Cancelled, "process cancelled").into());
                    }
                }
            } else {
                tokio::select! {
                    result = &mut wait_finished => result
                        .map_err(|error| anyhow!(error.to_string()))?,
                    _ = cancellation.cancelled() => {
                        process.terminate(126_i32.into());
                        let _ = wait_finished.await;
                        return Err(RunError::new(RunErrorKind::Cancelled, "process cancelled").into());
                    }
                }
            };
            Ok::<_, anyhow::Error>(exit_code)
        })??;

        Ok(exit_code.raw())
    }
}

fn process_package_files(
    package: &BinaryPackage,
    injected_packages: &[BinaryPackage],
) -> Result<Option<UnionFileSystem>> {
    let mut package_files = package.webc_fs.as_deref().map(UnionFileSystem::duplicate);
    for injected_package in injected_packages {
        let Some(injected_files) = injected_package.webc_fs.as_deref() else {
            continue;
        };
        match &mut package_files {
            Some(files) => files.merge(injected_files, UnionMergeMode::Skip)?,
            None => package_files = Some(injected_files.duplicate()),
        }
    }
    Ok(package_files)
}

fn process_filesystem(
    root_fs: TmpFileSystem,
    package_files: Option<UnionFileSystem>,
    events: EventBus,
    virtual_executables: VirtualExecutableRegistry,
    http_bridge: Option<HttpBridge>,
    wall_time: Option<Duration>,
    cancellation: CancellationToken,
) -> Arc<dyn FileSystem + Send + Sync> {
    let filesystem: Arc<dyn FileSystem + Send + Sync> = match package_files {
        Some(files) => {
            let overlay = OverlayFileSystem::new(root_fs, [RelativeOrAbsolutePathHack(files)]);
            Arc::new(overlay)
        }
        None => Arc::new(root_fs),
    };
    let filesystem = Arc::new(VirtualExecutableFileSystem::new(
        filesystem,
        virtual_executables,
        http_bridge,
        wall_time,
        cancellation,
    ));
    Arc::new(ObservableFileSystem::new(filesystem, events))
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct InteractiveStdin {
    state: Arc<Mutex<InteractiveStdinState>>,
}

#[allow(dead_code)]
#[derive(Debug)]
struct InteractiveStdinState {
    data: VecDeque<u8>,
    closed: bool,
    waker: Option<Waker>,
}

#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct InteractiveStdinFile {
    state: Arc<Mutex<InteractiveStdinState>>,
}

#[derive(Clone, Debug)]
pub(crate) struct CapturedOutput {
    state: Arc<Mutex<CapturedOutputState>>,
}

#[derive(Debug)]
struct CapturedOutputState {
    data: Vec<u8>,
    limit: usize,
    exceeded: bool,
    sink: Option<OutputSink>,
}

#[derive(Debug)]
struct LimitedCaptureFile {
    state: Arc<Mutex<CapturedOutputState>>,
    cursor: u64,
}

#[allow(dead_code)]
impl InteractiveStdin {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(InteractiveStdinState {
                data: VecDeque::new(),
                closed: false,
                waker: None,
            })),
        }
    }

    pub(crate) fn file(&self) -> InteractiveStdinFile {
        InteractiveStdinFile {
            state: Arc::clone(&self.state),
        }
    }

    pub(crate) fn write(&self, data: Vec<u8>) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("process stdin lock failed"))?;
        if state.closed {
            return Err(anyhow!("process stdin is closed"));
        }
        state.data.extend(data);
        if let Some(waker) = state.waker.take() {
            waker.wake();
        }
        Ok(())
    }

    pub(crate) fn close(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("process stdin lock failed"))?;
        state.closed = true;
        if let Some(waker) = state.waker.take() {
            waker.wake();
        }
        Ok(())
    }

    pub(crate) fn is_closed(&self) -> Result<bool> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("process stdin lock failed"))?;
        Ok(state.closed)
    }
}

impl AsyncSeek for InteractiveStdinFile {
    fn start_seek(self: Pin<&mut Self>, _position: SeekFrom) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "process stdin is not seekable",
        ))
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl AsyncRead for InteractiveStdinFile {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Poll::Ready(Err(io::Error::other("process stdin lock failed"))),
        };
        if state.data.is_empty() && state.closed {
            return Poll::Ready(Ok(()));
        }
        if state.data.is_empty() {
            state.waker = Some(cx.waker().clone());
            return Poll::Pending;
        }

        let read_len = buf.remaining().min(state.data.len());
        let data = state.data.drain(..read_len).collect::<Vec<_>>();
        buf.put_slice(&data);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for InteractiveStdinFile {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        _buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::ErrorKind::PermissionDenied.into()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl VirtualFile for InteractiveStdinFile {
    fn last_accessed(&self) -> u64 {
        1_000_000_000
    }

    fn last_modified(&self) -> u64 {
        1_000_000_000
    }

    fn created_time(&self) -> u64 {
        1_000_000_000
    }

    fn size(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.data.len() as u64)
            .unwrap_or_default()
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Err(FsError::PermissionDenied)
    }

    fn poll_read_ready(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Poll::Ready(Err(io::Error::other("process stdin lock failed"))),
        };
        if !state.data.is_empty() {
            return Poll::Ready(Ok(state.data.len()));
        }
        if state.closed {
            return Poll::Ready(Ok(0));
        }
        state.waker = Some(cx.waker().clone());
        Poll::Pending
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::ErrorKind::PermissionDenied.into()))
    }
}

impl CapturedOutput {
    pub(crate) fn new(limit: usize, sink: Option<OutputSink>) -> Self {
        Self {
            state: Arc::new(Mutex::new(CapturedOutputState {
                data: Vec::new(),
                limit,
                exceeded: false,
                sink,
            })),
        }
    }

    fn file(&self) -> LimitedCaptureFile {
        LimitedCaptureFile {
            state: Arc::clone(&self.state),
            cursor: 0,
        }
    }

    pub(crate) fn capture(&self, stream_name: &str) -> Result<Vec<u8>> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("captured {stream_name} lock failed"))?;
        if state.exceeded {
            return Err(anyhow!(
                "process {stream_name} output exceeded {} bytes",
                state.limit
            ));
        }
        Ok(state.data.clone())
    }

    fn write_all(&self, stream_name: &str, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }

        let sink = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow!("captured {stream_name} lock failed"))?;
            if state.exceeded {
                return Err(anyhow!(
                    "process {stream_name} output exceeded {} bytes",
                    state.limit
                ));
            }

            let Some(next_len) = state.data.len().checked_add(data.len()) else {
                state.exceeded = true;
                return Err(anyhow!(
                    "process {stream_name} output exceeded {} bytes",
                    state.limit
                ));
            };
            if next_len > state.limit {
                state.exceeded = true;
                return Err(anyhow!(
                    "process {stream_name} output exceeded {} bytes",
                    state.limit
                ));
            }

            state.data.extend_from_slice(data);
            state.sink.clone()
        };

        if let Some(sink) = sink {
            sink.write_all(data)
                .with_context(|| format!("unable to stream process {stream_name} output"))?;
        }

        Ok(())
    }
}

impl LimitedCaptureFile {
    fn write_limited(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("captured output lock failed"))?;
        if state.exceeded {
            return Err(output_limit_error(state.limit));
        }

        let available = state.limit.saturating_sub(state.data.len());
        if available == 0 {
            state.exceeded = true;
            return Err(output_limit_error(state.limit));
        }

        let write_len = available.min(buf.len());
        state.data.extend_from_slice(&buf[..write_len]);
        self.cursor = state.data.len() as u64;
        let sink = state.sink.clone();

        if write_len < buf.len() {
            state.exceeded = true;
        }
        drop(state);

        if let Some(sink) = sink {
            sink.write_all(&buf[..write_len])?;
        }

        Ok(write_len)
    }
}

impl AsyncSeek for LimitedCaptureFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("captured output lock failed"))?;
        let len = state.data.len() as i128;
        let current = self.cursor as i128;
        let next = match position {
            SeekFrom::Start(offset) => offset as i128,
            SeekFrom::End(offset) => len + offset as i128,
            SeekFrom::Current(offset) => current + offset as i128,
        };
        if next < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid seek before start",
            ));
        }
        drop(state);
        self.cursor = next as u64;
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.cursor))
    }
}

impl AsyncWrite for LimitedCaptureFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(self.write_limited(buf))
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        for candidate in bufs {
            if !candidate.is_empty() {
                return Poll::Ready(self.write_limited(candidate));
            }
        }
        Poll::Ready(self.write_limited(&[]))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for LimitedCaptureFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Poll::Ready(Err(io::Error::other("captured output lock failed"))),
        };
        let start = (self.cursor as usize).min(state.data.len());
        let available = &state.data[start..];
        let read_len = available.len().min(buf.remaining());
        buf.put_slice(&available[..read_len]);
        drop(state);
        self.cursor += read_len as u64;
        Poll::Ready(Ok(()))
    }
}

impl VirtualFile for LimitedCaptureFile {
    fn last_accessed(&self) -> u64 {
        1_000_000_000
    }

    fn last_modified(&self) -> u64 {
        1_000_000_000
    }

    fn created_time(&self) -> u64 {
        1_000_000_000
    }

    fn size(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.data.len() as u64)
            .unwrap_or_default()
    }

    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        let mut state = self.state.lock().map_err(|_| FsError::Lock)?;
        if new_size > state.limit as u64 {
            state.exceeded = true;
            return Err(FsError::StorageFull);
        }
        state.data.resize(new_size as usize, 0);
        self.cursor = self.cursor.min(new_size);
        Ok(())
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<io::Result<usize>> {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Poll::Ready(Err(io::Error::other("captured output lock failed"))),
        };
        let remaining = state.data.len().saturating_sub(self.cursor as usize);
        Poll::Ready(Ok(remaining))
    }

    fn poll_write_ready(
        self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<io::Result<usize>> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Poll::Ready(Err(io::Error::other("captured output lock failed"))),
        };
        if state.exceeded {
            return Poll::Ready(Err(output_limit_error(state.limit)));
        }
        let remaining = state.limit.saturating_sub(state.data.len());
        if remaining == 0 {
            state.exceeded = true;
            return Poll::Ready(Err(output_limit_error(state.limit)));
        }
        Poll::Ready(Ok(remaining.min(8192)))
    }
}

fn output_limit_error(limit: usize) -> io::Error {
    io::Error::other(format!("process output exceeded {limit} bytes"))
}

fn read_only_mount_error() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "read-only host mount")
}

fn normalize_process_outcome(command: &str, returncode: i32, stderr: Vec<u8>) -> (i32, Vec<u8>) {
    const FIND_CWD_RESTORE_ERROR: &[u8] =
        b"(null): Failed to restore initial working directory: Not a directory\n";

    if command == "find" && returncode == 1 && stderr == FIND_CWD_RESTORE_ERROR {
        return (0, Vec::new());
    }

    (returncode, stderr)
}

fn catalog_for(
    packages: Vec<PackageSpec>,
    options: &SandboxOptions,
) -> Result<Arc<PackageCatalog>> {
    let package_specs = resolve_package_specs(packages)?;
    PackageCatalog::load(package_specs, module_cache_dir(options))
}

fn resolve_package_specs(packages: Vec<PackageSpec>) -> Result<Vec<ResolvedPackageSpec>> {
    let mut resolved = Vec::with_capacity(packages.len());
    let mut names = HashSet::with_capacity(packages.len());
    for package in packages {
        validate_package_name(&package.name)?;
        if !names.insert(package.name.clone()) {
            return Err(anyhow!(
                "package name configured more than once: {}",
                package.name
            ));
        }
        validate_sha256(&package.content_sha256, &package.name)?;
        for alias in &package.command_aliases {
            validate_command_name(&alias.alias, "alias")?;
            validate_command_name(&alias.command, "command")?;
        }
        let webc_path = PathBuf::from(&package.webc_path)
            .canonicalize()
            .with_context(|| format!("unable to resolve package {}", package.name))?;
        resolved.push(ResolvedPackageSpec {
            name: package.name,
            webc_path,
            command_aliases: package.command_aliases,
        });
    }
    Ok(resolved)
}

fn validate_package_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(anyhow!("package name cannot be empty"));
    }
    if name.as_bytes().contains(&0) {
        return Err(anyhow!("package name cannot contain NUL bytes"));
    }
    Ok(())
}

fn validate_command_name(command: &str, label: &str) -> Result<()> {
    if command.is_empty() {
        return Err(anyhow!("package command {label} cannot be empty"));
    }
    if command.as_bytes().contains(&0) {
        return Err(anyhow!("package command {label} cannot contain NUL bytes"));
    }
    if command.contains('/') {
        return Err(anyhow!(
            "package command {label} cannot contain path separators"
        ));
    }
    Ok(())
}

fn validate_sha256(digest: &str, package_name: &str) -> Result<()> {
    if digest.len() != 64 {
        return Err(anyhow!(
            "package {package_name} content_sha256 must contain 64 hexadecimal characters"
        ));
    }
    if digest
        .chars()
        .all(|character| character.is_ascii_hexdigit())
    {
        return Ok(());
    }
    Err(anyhow!(
        "package {package_name} content_sha256 must contain 64 hexadecimal characters"
    ))
}

fn package_source(package_specs: &[ResolvedPackageSpec]) -> Result<InMemorySource> {
    let mut source = InMemorySource::new();
    for spec in package_specs {
        source
            .add_webc(&spec.webc_path)
            .with_context(|| format!("unable to index package {}", spec.name))?;
    }
    Ok(source)
}

fn load_package(
    handle: &tokio::runtime::Handle,
    runtime: &(dyn Runtime + Send + Sync),
    path: &Path,
) -> Result<BinaryPackage> {
    let data = std::fs::read(path).with_context(|| format!("unable to read {}", path.display()))?;
    let container =
        from_bytes(data).with_context(|| format!("unable to parse {}", path.display()))?;
    handle
        .block_on(BinaryPackage::from_webc(&container, runtime))
        .with_context(|| format!("unable to load {}", path.display()))
}

fn register_package(
    name: &str,
    package: &BinaryPackage,
    command_paths: &mut HashMap<PathBuf, CommandTarget>,
) -> Result<()> {
    for command in &package.commands {
        register_command_alias(command.name(), name, command.name(), command_paths)?;
    }
    Ok(())
}

fn register_command_alias(
    alias: &str,
    package: &str,
    command: &str,
    command_paths: &mut HashMap<PathBuf, CommandTarget>,
) -> Result<()> {
    let target = CommandTarget {
        package: package.to_string(),
        command: command.to_string(),
    };
    for prefix in COMMAND_PATH_PREFIXES {
        let path = Path::new(prefix).join(alias);
        if let Some(existing) = command_paths.get(&path) {
            if existing.package == target.package && existing.command == target.command {
                continue;
            }
            return Err(anyhow!(
                "command path collision at {}: {} from package {} conflicts with {} from package {}",
                path.display(),
                target.command,
                target.package,
                existing.command,
                existing.package,
            ));
        }
        command_paths.insert(path, target.clone());
    }
    Ok(())
}

fn sandbox_engine() -> wasmer::Engine {
    let mut features = Features::default();
    features.exceptions(true);

    let mut engine: wasmer::Engine = EngineBuilder::new(Cranelift::default())
        .set_features(Some(features))
        .into();
    let tunables = BaseTunables::for_target(engine.target());
    engine.set_tunables(tunables);
    engine
}

fn module_cache_dir(options: &SandboxOptions) -> PathBuf {
    options
        .module_cache_dir
        .clone()
        .unwrap_or_else(default_module_cache_dir)
}

fn default_module_cache_dir() -> PathBuf {
    if let Some(cache_home) = env::var_os("XDG_CACHE_HOME") {
        if !cache_home.is_empty() {
            return PathBuf::from(cache_home).join("wasm-host").join("modules");
        }
    }

    if let Some(home) = env::var_os("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home)
                .join(".cache")
                .join("wasm-host")
                .join("modules");
        }
    }

    env::temp_dir().join("wasm-host").join("modules")
}

fn duration_from_seconds(seconds: f64) -> Result<Duration> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return Err(anyhow!(
            "wall_time_seconds must be a positive finite number"
        ));
    }
    Ok(Duration::from_secs_f64(seconds))
}

fn create_default_layout(catalog: &PackageCatalog, fs: &TmpFileSystem) -> Result<()> {
    for path in [
        "/bin",
        "/usr",
        "/usr/bin",
        "/dev",
        "/tmp",
        "/work",
        "/home",
        "/home/sandbox",
        "/etc",
    ] {
        create_dir_all(fs, Path::new(path)).with_context(|| format!("unable to create {path}"))?;
    }
    catalog.block_on(write_file_to_fs(
        fs,
        Path::new("/etc/passwd"),
        b"sandbox:x:1000:1000:Sandbox User:/home/sandbox:/bin/sh\n".to_vec(),
    ))?;
    catalog.block_on(write_file_to_fs(
        fs,
        Path::new("/etc/group"),
        b"sandbox:x:1000:\n".to_vec(),
    ))?;
    fs.new_open_options_ext()
        .insert_device_file(PathBuf::from("/dev/null"), Box::<NullFile>::default())
        .context("unable to create /dev/null")?;
    Ok(())
}

fn default_env() -> HashMap<String, String> {
    HashMap::from([
        ("HOME".to_string(), "/home/sandbox".to_string()),
        ("LANG".to_string(), "C.UTF-8".to_string()),
        ("LOGNAME".to_string(), "sandbox".to_string()),
        ("PATH".to_string(), "/bin:/usr/bin".to_string()),
        ("TMPDIR".to_string(), "/tmp".to_string()),
        ("USER".to_string(), "sandbox".to_string()),
    ])
}

fn virtual_executable_wasm(path: &str) -> Result<Vec<u8>> {
    let wat = VIRTUAL_EXECUTABLE_WASM
        .replace("__VIRTUAL_EXEC_PATH_LEN__", &path.len().to_string())
        .replace("__VIRTUAL_EXEC_PATH__", &wat_string(path.as_bytes()));
    wat::parse_str(wat).context("unable to build virtual executable launcher")
}

fn wat_string(data: &[u8]) -> String {
    let mut output = String::with_capacity(data.len() * 3);
    for byte in data {
        output.push('\\');
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn virtual_process_error_response(message: String) -> Vec<u8> {
    encode_virtual_process_response(&VirtualProcessResponsePayload {
        returncode: 126,
        stdout: Vec::new(),
        stderr: format!("{message}\n").into_bytes(),
    })
}

fn encode_virtual_process_response(response: &VirtualProcessResponsePayload) -> Vec<u8> {
    let mut data = Vec::with_capacity(16 + response.stdout.len() + response.stderr.len());
    data.extend_from_slice(b"UXR1");
    data.extend_from_slice(&response.returncode.to_le_bytes());
    data.extend_from_slice(&(response.stdout.len() as u32).to_le_bytes());
    data.extend_from_slice(&(response.stderr.len() as u32).to_le_bytes());
    data.extend_from_slice(&response.stdout);
    data.extend_from_slice(&response.stderr);
    data
}

fn decode_virtual_process_response(data: &[u8]) -> Result<VirtualProcessResponsePayload> {
    if data.len() < 16 || &data[..4] != b"UXR1" {
        return Err(anyhow!("invalid virtual executable response header"));
    }
    let returncode = i32::from_le_bytes(data[4..8].try_into()?);
    let stdout_len = u32::from_le_bytes(data[8..12].try_into()?) as usize;
    let stderr_len = u32::from_le_bytes(data[12..16].try_into()?) as usize;
    let expected_len = 16_usize
        .checked_add(stdout_len)
        .and_then(|value| value.checked_add(stderr_len))
        .ok_or_else(|| anyhow!("virtual executable response is too large"))?;
    if data.len() < expected_len {
        return Err(anyhow!("virtual executable response is truncated"));
    }
    let stdout_start = 16;
    let stderr_start = stdout_start + stdout_len;
    Ok(VirtualProcessResponsePayload {
        returncode,
        stdout: data[stdout_start..stderr_start].to_vec(),
        stderr: data[stderr_start..expected_len].to_vec(),
    })
}

fn handle_http_bridge_device_request(
    bridge: &HttpBridge,
    data: &[u8],
    wall_time: Option<Duration>,
    cancellation: CancellationToken,
) -> Vec<u8> {
    let response = match dispatch_http_bridge_device_request(bridge, data, wall_time, cancellation)
    {
        Ok(response) => HttpBridgeDeviceResponse {
            ok: true,
            response: Some(response),
            error: None,
        },
        Err(error) => HttpBridgeDeviceResponse {
            ok: false,
            response: None,
            error: Some(HttpBridgeDeviceError {
                kind: http_bridge_error_kind_name(error.kind).to_string(),
                message: error.message,
            }),
        },
    };
    serde_json::to_vec(&response).unwrap_or_else(|error| {
        format!(
            r#"{{"ok":false,"error":{{"kind":"transport","message":"unable to encode HTTP bridge response: {error}"}}}}"#
        )
        .into_bytes()
    })
}

fn dispatch_http_bridge_device_request(
    bridge: &HttpBridge,
    data: &[u8],
    wall_time: Option<Duration>,
    cancellation: CancellationToken,
) -> std::result::Result<HttpBridgeDeviceSuccess, HttpBridgeError> {
    let request: HttpBridgeDeviceRequest = serde_json::from_slice(data).map_err(|error| {
        HttpBridgeError::invalid_request(format!("invalid HTTP bridge device request: {error}"))
    })?;
    let response_body_bytes = request
        .response_body_limit
        .unwrap_or_else(|| HttpRequestLimits::default().response_body_bytes);
    let wall_time = http_bridge_device_wall_time(wall_time, request.timeout_ms)?;
    let headers = request
        .headers
        .into_iter()
        .map(|header| HttpHeader::new(header.name, header.value))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let body = BASE64.decode(request.body_base64).map_err(|error| {
        HttpBridgeError::invalid_request(format!("invalid HTTP bridge request body: {error}"))
    })?;
    let request = HttpRequest::new(request.method, request.url, headers, body)?;
    let limits = HttpRequestLimits {
        response_body_bytes,
        wall_time,
    };
    let response = bridge.request_blocking(request, limits, cancellation)?;
    Ok(HttpBridgeDeviceSuccess {
        status: response.status,
        headers: response
            .headers
            .into_iter()
            .map(|header| HttpBridgeDeviceHeader {
                name: header.name,
                value: header.value,
            })
            .collect(),
        body_base64: BASE64.encode(response.body),
    })
}

fn http_bridge_device_wall_time(
    inherited_wall_time: Option<Duration>,
    timeout_ms: Option<u64>,
) -> std::result::Result<Option<Duration>, HttpBridgeError> {
    let Some(timeout_ms) = timeout_ms else {
        return Ok(inherited_wall_time);
    };
    if timeout_ms == 0 {
        return Err(HttpBridgeError::invalid_request(
            "HTTP request timeout_ms must be positive",
        ));
    }
    let timeout = Duration::from_millis(timeout_ms);
    Ok(match inherited_wall_time {
        Some(inherited) => Some(timeout.min(inherited)),
        None => Some(timeout),
    })
}

fn http_bridge_error_kind_name(kind: HttpBridgeErrorKind) -> &'static str {
    match kind {
        HttpBridgeErrorKind::InvalidRequest => "invalid_request",
        HttpBridgeErrorKind::InvalidResponse => "invalid_response",
        HttpBridgeErrorKind::UnsupportedScheme => "unsupported_scheme",
        HttpBridgeErrorKind::GatewayUnavailable => "gateway_unavailable",
        HttpBridgeErrorKind::AuthFailure => "auth_failure",
        HttpBridgeErrorKind::Cors => "cors",
        HttpBridgeErrorKind::Timeout => "timeout",
        HttpBridgeErrorKind::Cancelled => "cancelled",
        HttpBridgeErrorKind::Transport => "transport",
        HttpBridgeErrorKind::ResponseTooLarge => "response_too_large",
    }
}

fn parse_guest_virtual_process_payload(data: &[u8]) -> Result<GuestVirtualProcessPayload> {
    let mut cursor = BinaryCursor::new(data);
    cursor.expect_magic(b"UXV1")?;
    let executable_path = cursor.read_string()?;
    let argc = cursor.read_u32()? as usize;
    let envc = cursor.read_u32()? as usize;
    let stdin_len = cursor.read_u32()? as usize;
    let mut argv = Vec::with_capacity(argc);
    for _ in 0..argc {
        argv.push(cursor.read_string()?);
    }

    let mut env = HashMap::with_capacity(envc);
    for _ in 0..envc {
        let item = cursor.read_string()?;
        let Some((key, value)) = item.split_once('=') else {
            continue;
        };
        env.insert(key.to_string(), value.to_string());
    }

    let stdin = cursor.read_bytes(stdin_len)?;
    let cwd = env.get("PWD").cloned().unwrap_or_else(|| "/".to_string());
    Ok(GuestVirtualProcessPayload {
        executable_path,
        argv,
        cwd,
        env,
        stdin: BASE64.encode(stdin),
    })
}

fn virtual_exec_bridge_metadata() -> Metadata {
    host_bridge_device_metadata()
}

fn host_bridge_device_metadata() -> Metadata {
    let time = current_time_nanos();
    Metadata {
        ft: FileType::new_file(),
        accessed: time,
        created: time,
        modified: time,
        len: 0,
    }
}

fn current_time_nanos() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn write_file_to_fs_blocking(fs: &TmpFileSystem, path: &Path, data: Vec<u8>) -> Result<()> {
    create_parent_directories(fs, path)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("unable to create filesystem write runtime")?;
    runtime
        .block_on(write_file_to_fs(fs, path, data))
        .with_context(|| format!("unable to write {}", path.display()))
}

fn command_path_from_path_entry(directory: &str, command: &str, cwd: &Path) -> Result<PathBuf> {
    let command_path = if directory.is_empty() || directory == "." {
        cwd.join(command)
    } else {
        Path::new(directory).join(command)
    };
    let command_path = command_path
        .to_str()
        .ok_or_else(|| anyhow!("command path must be valid UTF-8"))?;

    if command_path.starts_with('/') {
        return normalize_path(command_path);
    }

    normalize_command_path(command_path, cwd)
}

fn validate_directory(fs: &TmpFileSystem, path: &Path, name: &str) -> Result<()> {
    let metadata = match fs.metadata(path) {
        Ok(metadata) => metadata,
        Err(FsError::EntryNotFound) => {
            return Err(anyhow!("{name} does not exist: {}", path.display()));
        }
        Err(FsError::BaseNotDirectory | FsError::NotAFile) => {
            return Err(anyhow!("{name} is not a directory: {}", path.display()));
        }
        Err(error) => {
            return Err(anyhow!(error))
                .with_context(|| format!("unable to inspect {name}: {}", path.display()));
        }
    };
    if metadata.is_dir() {
        return Ok(());
    }
    Err(anyhow!("{name} is not a directory: {}", path.display()))
}

fn validate_host_mount_source(path: &str) -> Result<PathBuf> {
    if path.as_bytes().contains(&0) {
        return Err(anyhow!("host mount source cannot contain NUL bytes"));
    }

    let path = PathBuf::from(path);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(anyhow!(
                "host mount source does not exist: {}",
                path.display()
            ));
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!("unable to inspect host mount source {}", path.display())
            });
        }
    };
    if !metadata.is_dir() {
        return Err(anyhow!(
            "host mount source is not a directory: {}",
            path.display()
        ));
    }

    path.canonicalize()
        .with_context(|| format!("unable to resolve host mount source {}", path.display()))
}

fn create_parent_directories(fs: &TmpFileSystem, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        create_dir_all(fs, parent)
            .with_context(|| format!("unable to create {}", parent.display()))?;
    }
    Ok(())
}

fn create_directories(fs: &TmpFileSystem, path: &Path) -> Result<Vec<PathBuf>> {
    let mut current = PathBuf::from("/");
    let mut created_paths = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(name) = component else {
            continue;
        };
        current.push(name);
        match fs.metadata(&current) {
            Ok(metadata) if metadata.is_dir() => continue,
            Ok(_) => {
                return Err(anyhow!("path is not a directory: {}", current.display()));
            }
            Err(FsError::EntryNotFound) => {}
            Err(error) => {
                return Err(anyhow!(error))
                    .with_context(|| format!("unable to inspect {}", current.display()));
            }
        }
        fs.create_dir(&current)
            .with_context(|| format!("unable to create {}", current.display()))?;
        created_paths.push(current.clone());
    }
    Ok(created_paths)
}

async fn read_file_from_fs(fs: &TmpFileSystem, path: &Path) -> Result<Vec<u8>> {
    let mut file = fs.new_open_options().read(true).open(path)?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents).await?;
    Ok(contents)
}

async fn write_file_to_fs(fs: &TmpFileSystem, path: &Path, data: Vec<u8>) -> Result<()> {
    let mut file = fs
        .new_open_options()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    file.write_all(&data).await?;
    file.flush().await?;
    Ok(())
}

fn normalize_path(path: &str) -> Result<PathBuf> {
    if path.as_bytes().contains(&0) {
        return Err(anyhow!("sandbox paths cannot contain NUL bytes"));
    }
    if !path.starts_with('/') {
        return Err(anyhow!("sandbox paths must be absolute"));
    }

    let mut normalized = PathBuf::from("/");
    for component in path.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            if !normalized.pop() {
                return Err(anyhow!("sandbox paths cannot escape root"));
            }
            continue;
        }
        normalized.push(component);
    }

    Ok(normalized)
}

fn symlink_target(target: &str) -> Result<PathBuf> {
    if target.is_empty() {
        return Err(anyhow!("symlink target cannot be empty"));
    }
    if target.as_bytes().contains(&0) {
        return Err(anyhow!("symlink target cannot contain NUL bytes"));
    }
    if target.starts_with('/') {
        return normalize_path(target);
    }
    Ok(PathBuf::from(target))
}

fn event_path(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new("/").join(path)
    };
    let Some(path) = absolute.to_str() else {
        return absolute.to_string_lossy().to_string();
    };
    match normalize_path(path) {
        Ok(normalized) => normalized.to_string_lossy().to_string(),
        Err(_) => absolute.to_string_lossy().to_string(),
    }
}

fn normalize_command_path(command: &str, cwd: &Path) -> Result<PathBuf> {
    if command.starts_with('/') {
        return normalize_path(command);
    }

    let mut path = cwd.to_path_buf();
    for component in command.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            if !path.pop() {
                return Err(anyhow!("command paths cannot escape root"));
            }
            continue;
        }
        path.push(component);
    }

    normalize_path(
        path.to_str()
            .ok_or_else(|| anyhow!("command path must be valid UTF-8"))?,
    )
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[derive(Clone)]
    struct SharedOutput(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for SharedOutput {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .map_err(|_| io::Error::other("shared output lock failed"))?
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn limited_capture_stops_storing_at_limit() {
        let captured = CapturedOutput::new(4, None);
        let mut file = captured.file();

        file.write_all(b"abcdef").await.unwrap_err();

        let state = captured.state.lock().expect("capture state should lock");
        assert_eq!(state.data, b"abcd");
        assert!(state.exceeded);
    }

    #[tokio::test]
    async fn limited_capture_streams_each_accepted_write_to_sink() {
        let streamed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = CapturedOutput::new(
            8,
            Some(OutputSink::new(SharedOutput(std::sync::Arc::clone(
                &streamed,
            )))),
        );
        let mut file = captured.file();

        file.write_all(b"ab")
            .await
            .expect("first write should pass");
        assert_eq!(
            streamed
                .lock()
                .expect("streamed output should lock")
                .as_slice(),
            b"ab"
        );

        file.write_all(b"cd")
            .await
            .expect("second write should pass");
        assert_eq!(
            streamed
                .lock()
                .expect("streamed output should lock")
                .as_slice(),
            b"abcd"
        );
        assert_eq!(
            captured
                .capture("stdout")
                .expect("captured output should be readable"),
            b"abcd"
        );
    }

    #[tokio::test]
    async fn http_bridge_device_dispatches_json_request() {
        let root = TmpFileSystem::new();
        create_dir_all(&root, Path::new("/dev")).expect("/dev should be created");
        let (events, _event_receiver) = EventBus::new(4);
        let (virtual_processes, _virtual_process_receiver) = VirtualExecutableBridge::new(4);
        let (bridge, mut http_receiver) = HttpBridge::new(4);
        let handler = std::thread::spawn(move || {
            let request = http_receiver
                .blocking_recv()
                .expect("HTTP request should arrive");
            assert_eq!(request.request.method, "POST");
            assert_eq!(request.request.url, "https://example.test/device");
            assert_eq!(
                request.request.headers,
                [HttpHeader::new("x-test", "yes").expect("header should be valid")]
            );
            assert_eq!(request.request.body, b"request-body");
            request
                .respond(
                    HttpResponse::new(
                        206,
                        vec![HttpHeader::new("x-reply", "ok").expect("header should be valid")],
                        b"response-body".to_vec(),
                    )
                    .expect("response should be valid"),
                )
                .expect("response should send");
        });
        let filesystem = process_filesystem(
            root,
            None,
            events,
            VirtualExecutableRegistry::new(virtual_processes),
            Some(bridge),
            Some(Duration::from_secs(5)),
            CancellationSource::new().token(),
        );
        let mut file = filesystem
            .new_open_options()
            .read(true)
            .write(true)
            .open(Path::new(HTTP_BRIDGE_PATH))
            .expect("HTTP bridge device should open");
        let payload = serde_json::json!({
            "method": "post",
            "url": "https://example.test/device",
            "headers": [{"name": "x-test", "value": "yes"}],
            "body_base64": BASE64.encode(b"request-body"),
        });
        file.write_all(&serde_json::to_vec(&payload).expect("payload should encode"))
            .await
            .expect("HTTP bridge request should write");

        let mut output = Vec::new();
        file.read_to_end(&mut output)
            .await
            .expect("HTTP bridge response should read");
        handler.join().expect("handler should finish");

        let value: serde_json::Value =
            serde_json::from_slice(&output).expect("response should be JSON");
        assert_eq!(value["ok"], true);
        assert_eq!(value["response"]["status"], 206);
        assert_eq!(value["response"]["headers"][0]["name"], "x-reply");
        assert_eq!(value["response"]["headers"][0]["value"], "ok");
        assert_eq!(
            value["response"]["body_base64"],
            BASE64.encode(b"response-body")
        );
    }

    #[tokio::test]
    async fn http_bridge_device_request_timeout_returns_json_and_cancels_request() {
        let root = TmpFileSystem::new();
        create_dir_all(&root, Path::new("/dev")).expect("/dev should be created");
        let (events, _event_receiver) = EventBus::new(4);
        let (virtual_processes, _virtual_process_receiver) = VirtualExecutableBridge::new(4);
        let (bridge, mut http_receiver) = HttpBridge::new(4);
        let (cancelled_sender, cancelled_receiver) = std::sync::mpsc::channel();
        let handler = std::thread::spawn(move || {
            let request = http_receiver
                .blocking_recv()
                .expect("HTTP request should arrive");
            let started = Instant::now();
            while !request.cancellation_token().is_cancelled() {
                assert!(
                    started.elapsed() < Duration::from_secs(2),
                    "HTTP request timeout should cancel the pending request"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            cancelled_sender
                .send(())
                .expect("cancelled signal should send");
        });
        let filesystem = process_filesystem(
            root,
            None,
            events,
            VirtualExecutableRegistry::new(virtual_processes),
            Some(bridge),
            Some(Duration::from_secs(5)),
            CancellationSource::new().token(),
        );
        let mut file = filesystem
            .new_open_options()
            .read(true)
            .write(true)
            .open(Path::new(HTTP_BRIDGE_PATH))
            .expect("HTTP bridge device should open");
        let payload = serde_json::json!({
            "method": "get",
            "url": "https://example.test/slow",
            "timeout_ms": 25,
        });
        file.write_all(&serde_json::to_vec(&payload).expect("payload should encode"))
            .await
            .expect("HTTP bridge request should write");

        let mut output = Vec::new();
        file.read_to_end(&mut output)
            .await
            .expect("HTTP bridge response should read");
        cancelled_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("HTTP request timeout should cancel bridge request");
        handler.join().expect("handler should finish");

        let value: serde_json::Value =
            serde_json::from_slice(&output).expect("response should be JSON");
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["kind"], "timeout");
        assert_eq!(
            value["error"]["message"],
            "HTTP request exceeded wall time limit"
        );
    }

    #[test]
    fn http_bridge_device_rejects_zero_request_timeout() {
        let (bridge, _http_receiver) = HttpBridge::new(4);
        let payload = serde_json::json!({
            "method": "get",
            "url": "https://example.test/slow",
            "timeout_ms": 0,
        });

        let error = match dispatch_http_bridge_device_request(
            &bridge,
            &serde_json::to_vec(&payload).expect("payload should encode"),
            Some(Duration::from_secs(5)),
            CancellationSource::new().token(),
        ) {
            Ok(_) => panic!("zero request timeout should fail"),
            Err(error) => error,
        };

        assert_eq!(error.kind, HttpBridgeErrorKind::InvalidRequest);
        assert_eq!(error.message, "HTTP request timeout_ms must be positive");
    }

    #[test]
    fn http_bridge_device_preserves_policy_error_kinds() {
        let cases = [
            (
                HttpBridgeError::gateway_unavailable("local gateway is not running"),
                "gateway_unavailable",
            ),
            (
                HttpBridgeError::auth_failure("gateway authentication failed"),
                "auth_failure",
            ),
            (
                HttpBridgeError::cors("request blocked by origin policy"),
                "cors",
            ),
            (
                HttpBridgeError::transport("TLS handshake failed"),
                "transport",
            ),
        ];

        for (error, expected_kind) in cases {
            let expected_message = error.message.clone();
            let (bridge, mut http_receiver) = HttpBridge::new(4);
            let handler = std::thread::spawn(move || {
                let request = http_receiver
                    .blocking_recv()
                    .expect("HTTP request should arrive");
                request.fail(error).expect("HTTP error should send");
            });
            let payload = serde_json::json!({
                "method": "get",
                "url": "https://example.test/policy",
            });

            let output = handle_http_bridge_device_request(
                &bridge,
                &serde_json::to_vec(&payload).expect("payload should encode"),
                Some(Duration::from_secs(5)),
                CancellationSource::new().token(),
            );
            handler.join().expect("handler should finish");

            let value: serde_json::Value =
                serde_json::from_slice(&output).expect("response should be JSON");
            assert_eq!(value["ok"], false);
            assert_eq!(value["error"]["kind"], expected_kind);
            assert_eq!(value["error"]["message"], expected_message);
        }
    }

    #[test]
    fn command_path_normalization_uses_cwd_for_relative_paths() {
        let path = normalize_command_path("./tool", Path::new("/work")).unwrap();
        assert_eq!(path, PathBuf::from("/work/tool"));
    }

    #[test]
    fn path_entries_resolve_like_sandbox_paths() {
        let absolute = command_path_from_path_entry("/bin", "cat", Path::new("/work")).unwrap();
        assert_eq!(absolute, PathBuf::from("/bin/cat"));

        let current = command_path_from_path_entry("", "cat", Path::new("/bin")).unwrap();
        assert_eq!(current, PathBuf::from("/bin/cat"));

        let relative = command_path_from_path_entry("usr/bin", "cat", Path::new("/")).unwrap();
        assert_eq!(relative, PathBuf::from("/usr/bin/cat"));
    }

    #[test]
    fn find_cleanup_error_is_normalized_only_when_exact() {
        let cleanup_error =
            b"(null): Failed to restore initial working directory: Not a directory\n".to_vec();
        let (returncode, stderr) = normalize_process_outcome("find", 1, cleanup_error);
        assert_eq!(returncode, 0);
        assert_eq!(stderr, b"");

        let real_error = b"find: missing argument\n(null): Failed to restore initial working directory: Not a directory\n"
            .to_vec();
        let (returncode, stderr) = normalize_process_outcome("find", 1, real_error);
        assert_eq!(returncode, 1);
        assert!(stderr.starts_with(b"find: missing argument"));
    }

    #[test]
    fn module_cache_dir_uses_explicit_option() {
        let options = SandboxOptions {
            module_cache_dir: Some(PathBuf::from("/tmp/wasm-host-modules")),
            http_bridge: None,
        };

        assert_eq!(
            module_cache_dir(&options),
            PathBuf::from("/tmp/wasm-host-modules")
        );
    }

    #[test]
    fn module_cache_dir_uses_default_when_option_is_missing() {
        let options = SandboxOptions::default();

        assert_eq!(module_cache_dir(&options), default_module_cache_dir());
    }
}
