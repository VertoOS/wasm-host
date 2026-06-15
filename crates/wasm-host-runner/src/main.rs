use std::{
    collections::HashMap,
    ffi::OsString,
    fmt,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use serde_json::{json, Map, Value};
use wasm_host_core::{
    CancellationSource, EventBus, HostMount, HostProfile, Limits, OutputSink, OutputSinks,
    PackageCommandAlias, PackageSpec, RunError, RunErrorKind, RunRequest, SandboxOptions,
    SandboxState, VirtualExecutableBridge, VirtualProcessInvocation, VirtualProcessRequest,
};

const DEFAULT_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const DEFAULT_EVENT_QUEUE_SIZE: usize = 4096;
const WEBC_MAGIC: &[u8; 5] = b"\0webc";
const EXIT_USAGE: u8 = 2;
const EXIT_PACKAGE: u8 = 65;
const EXIT_TIMEOUT: u8 = 124;
const EXIT_HOST: u8 = 125;
const EXIT_CANCELLED: u8 = 130;
const EXIT_COMMAND_NOT_FOUND: u8 = 127;

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(exit_code(code)),
        Err(error) => {
            if !error.suppress_plain_error {
                eprintln!("wasm-host-runner: {error}");
            }
            ExitCode::from(error.exit_code)
        }
    }
}

fn run() -> Result<i32, RunnerError> {
    let options = Options::parse(std::env::args_os().skip(1)).map_err(RunnerError::usage)?;
    let reporter = EventReporter::new(options.event_format);
    let started_at = Instant::now();
    let package_name = options.package_name.clone().unwrap_or_else(|| {
        options
            .webc
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("package")
            .to_string()
    });

    reporter
        .runner_started(&options, &package_name)
        .map_err(RunnerError::host)?;
    if let Err(error) = validate_webc_package(&options.webc) {
        reporter
            .runner_failed("package", EXIT_PACKAGE, &error, started_at.elapsed())
            .map_err(RunnerError::host)?;
        return Err(RunnerError::package_reported(error, options.event_format));
    }
    reporter
        .package_validated(&options.webc, &package_name)
        .map_err(RunnerError::host)?;

    let (events, _event_receiver) = EventBus::new(DEFAULT_EVENT_QUEUE_SIZE);
    let (virtual_executables, virtual_process_receiver) =
        VirtualExecutableBridge::new(DEFAULT_EVENT_QUEUE_SIZE);
    let package = PackageSpec {
        name: package_name.clone(),
        webc_path: options.webc.to_string_lossy().to_string(),
        content_sha256: "0".repeat(64),
        command_aliases: options.command_aliases,
    };
    let sandbox_options = SandboxOptions {
        module_cache_dir: options.module_cache_dir.clone(),
    };
    let state = match SandboxState::new_with_profile_and_options(
        options.profile,
        HashMap::new(),
        options.host_mounts.clone(),
        vec![package],
        options.cwd,
        options.env,
        events,
        virtual_executables,
        sandbox_options,
    ) {
        Ok(state) => state,
        Err(error) => {
            reporter
                .runner_failed("sandbox", EXIT_HOST, &error, started_at.elapsed())
                .map_err(RunnerError::host)?;
            return Err(RunnerError::host_reported(error, options.event_format));
        }
    };
    if let Err(error) = register_host_commands(&state, &options.host_commands) {
        reporter
            .runner_failed("sandbox", EXIT_HOST, &error, started_at.elapsed())
            .map_err(RunnerError::host)?;
        return Err(RunnerError::host_reported(error, options.event_format));
    }
    let _host_command_worker = HostCommandWorker::spawn(
        options.host_commands.clone(),
        options.host_mounts.clone(),
        virtual_process_receiver,
    );
    reporter
        .sandbox_initialized(&package_name)
        .map_err(RunnerError::host)?;
    let cancellation = CancellationSource::new();
    let output = OutputSinks {
        stdout: Some(OutputSink::new(io::stdout())),
        stderr: Some(OutputSink::new(io::stderr())),
    };
    let result = match state.run_blocking_with_output(
        RunRequest {
            args: options.command,
            input: options.stdin,
            env: None,
            cwd: None,
            limits: Limits {
                output_bytes: options.output_limit,
                wall_time_seconds: options.timeout_seconds,
            },
        },
        output,
        cancellation.token(),
    ) {
        Ok(result) => result,
        Err(error) => {
            let failure = run_failure_for_error(&error);
            reporter
                .runner_failed(
                    failure.stage,
                    failure.exit_code,
                    &error,
                    started_at.elapsed(),
                )
                .map_err(RunnerError::host)?;
            return Err(RunnerError::reported(
                error,
                failure.exit_code,
                options.event_format,
            ));
        }
    };

    reporter
        .command_completed(&result, started_at.elapsed())
        .map_err(RunnerError::host)?;
    Ok(result.returncode)
}

#[derive(Debug)]
struct RunnerError {
    exit_code: u8,
    error: anyhow::Error,
    suppress_plain_error: bool,
}

impl RunnerError {
    fn usage(error: anyhow::Error) -> Self {
        Self {
            exit_code: EXIT_USAGE,
            error,
            suppress_plain_error: false,
        }
    }

    fn package(error: anyhow::Error) -> Self {
        Self {
            exit_code: EXIT_PACKAGE,
            error,
            suppress_plain_error: false,
        }
    }

    fn package_reported(error: anyhow::Error, event_format: EventFormat) -> Self {
        Self {
            suppress_plain_error: event_format == EventFormat::Json,
            ..Self::package(error)
        }
    }

    fn host(error: anyhow::Error) -> Self {
        Self {
            exit_code: EXIT_HOST,
            error,
            suppress_plain_error: false,
        }
    }

    fn host_reported(error: anyhow::Error, event_format: EventFormat) -> Self {
        Self::reported(error, EXIT_HOST, event_format)
    }

    fn reported(error: anyhow::Error, exit_code: u8, event_format: EventFormat) -> Self {
        Self {
            exit_code,
            error,
            suppress_plain_error: event_format == EventFormat::Json,
        }
    }
}

impl fmt::Display for RunnerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for RunnerError {}

struct Options {
    webc: PathBuf,
    profile: HostProfile,
    event_format: EventFormat,
    module_cache_dir: Option<PathBuf>,
    package_name: Option<String>,
    command_aliases: Vec<PackageCommandAlias>,
    host_commands: Vec<HostCommandSpec>,
    host_mounts: Vec<HostMount>,
    cwd: String,
    env: HashMap<String, String>,
    stdin: Option<Vec<u8>>,
    output_limit: usize,
    timeout_seconds: Option<f64>,
    command: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HostCommandSpec {
    guest_path: String,
    host_command: PathBuf,
}

struct HostCommandWorker {
    _handle: thread::JoinHandle<()>,
}

struct RunFailure {
    stage: &'static str,
    exit_code: u8,
}

fn run_failure_for_error(error: &anyhow::Error) -> RunFailure {
    match error.downcast_ref::<RunError>().map(RunError::kind) {
        Some(RunErrorKind::CommandResolution) => RunFailure {
            stage: "command",
            exit_code: EXIT_COMMAND_NOT_FOUND,
        },
        Some(RunErrorKind::Timeout) => RunFailure {
            stage: "timeout",
            exit_code: EXIT_TIMEOUT,
        },
        Some(RunErrorKind::Cancelled) => RunFailure {
            stage: "cancelled",
            exit_code: EXIT_CANCELLED,
        },
        None => RunFailure {
            stage: "run",
            exit_code: EXIT_HOST,
        },
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EventFormat {
    None,
    Json,
}

impl EventFormat {
    fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "none" => Ok(Self::None),
            "json" => Ok(Self::Json),
            _ => Err(anyhow::anyhow!(
                "unknown event format: {value}; expected none or json"
            )),
        }
    }
}

struct EventReporter {
    format: EventFormat,
}

impl EventReporter {
    fn new(format: EventFormat) -> Self {
        Self { format }
    }

    fn runner_started(&self, options: &Options, package_name: &str) -> anyhow::Result<()> {
        self.emit(runner_started_event(options, package_name))
    }

    fn package_validated(&self, webc: &Path, package_name: &str) -> anyhow::Result<()> {
        self.emit(json!({
            "event": "package.validated",
            "package": package_name,
            "webc": webc.to_string_lossy(),
            "magic": display_bytes(WEBC_MAGIC),
        }))
    }

    fn sandbox_initialized(&self, package_name: &str) -> anyhow::Result<()> {
        self.emit(json!({
            "event": "sandbox.initialized",
            "package": package_name,
        }))
    }

    fn command_completed(
        &self,
        result: &wasm_host_core::CompletedProcess,
        elapsed: Duration,
    ) -> anyhow::Result<()> {
        self.emit(json!({
            "event": "command.completed",
            "returncode": result.returncode,
            "stdout_bytes": result.stdout.len(),
            "stderr_bytes": result.stderr.len(),
            "elapsed_ms": duration_ms(elapsed),
        }))
    }

    fn runner_failed(
        &self,
        stage: &str,
        exit_code: u8,
        error: &anyhow::Error,
        elapsed: Duration,
    ) -> anyhow::Result<()> {
        self.emit(json!({
            "event": "runner.failed",
            "stage": stage,
            "exit_code": exit_code,
            "error": error.to_string(),
            "elapsed_ms": duration_ms(elapsed),
        }))
    }

    fn emit(&self, value: Value) -> anyhow::Result<()> {
        if self.format == EventFormat::Json {
            let mut stderr = io::stderr();
            write_event_json_line(&mut stderr, value)?;
        }
        Ok(())
    }
}

fn runner_started_event(options: &Options, package_name: &str) -> Value {
    let mut env_keys = options.env.keys().cloned().collect::<Vec<_>>();
    env_keys.sort();
    json!({
        "event": "runner.started",
        "profile": host_profile_name(options.profile),
        "package": package_name,
        "webc": options.webc.to_string_lossy(),
        "cwd": options.cwd,
        "argv0": options.command.first().map(String::as_str),
        "argc": options.command.len(),
        "alias_count": options.command_aliases.len(),
        "host_command_count": options.host_commands.len(),
        "mount_count": options.host_mounts.len(),
        "env_keys": env_keys,
        "env_count": options.env.len(),
        "module_cache_dir": options
            .module_cache_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        "output_limit": options.output_limit,
        "timeout_seconds": options.timeout_seconds,
    })
}

fn write_event_json_line(writer: &mut impl Write, value: Value) -> anyhow::Result<()> {
    let mut event = match value {
        Value::Object(map) => map,
        _ => {
            return Err(anyhow::anyhow!(
                "runner event payload must be a JSON object"
            ))
        }
    };
    let mut envelope = Map::new();
    envelope.insert("schema".to_string(), Value::from(1));
    envelope.insert("time_unix_ms".to_string(), Value::from(unix_time_ms()));
    envelope.append(&mut event);
    serde_json::to_writer(&mut *writer, &Value::Object(envelope))?;
    writeln!(writer)?;
    Ok(())
}

fn validate_webc_package(path: &Path) -> anyhow::Result<()> {
    let mut file = File::open(path).map_err(|error| {
        anyhow::anyhow!("unable to open WebC package {}: {error}", path.display())
    })?;
    let mut magic = [0_u8; WEBC_MAGIC.len()];
    file.read_exact(&mut magic).map_err(|error| {
        anyhow::anyhow!(
            "unable to read WebC package magic bytes from {}: {error}",
            path.display()
        )
    })?;

    if &magic != WEBC_MAGIC {
        return Err(anyhow::anyhow!(
            "invalid WebC package {}: expected magic bytes {}, found {}",
            path.display(),
            display_bytes(WEBC_MAGIC),
            display_bytes(&magic),
        ));
    }

    Ok(())
}

impl Options {
    fn parse(args: impl IntoIterator<Item = OsString>) -> anyhow::Result<Self> {
        let mut args = args.into_iter().peekable();
        let mut webc = None;
        let mut profile = HostProfile::default();
        let mut event_format = EventFormat::None;
        let mut module_cache_dir = None;
        let mut package_name = None;
        let mut command_aliases = Vec::new();
        let mut host_commands = Vec::new();
        let mut host_mounts = Vec::new();
        let mut cwd = "/work".to_string();
        let mut env = HashMap::new();
        let mut stdin = None;
        let mut output_limit = DEFAULT_OUTPUT_LIMIT;
        let mut timeout_seconds = None;
        let mut command = Vec::new();

        while let Some(arg) = args.next() {
            let arg = os_to_string(arg)?;
            if arg == "--" {
                command.extend(args.map(os_to_string).collect::<anyhow::Result<Vec<_>>>()?);
                break;
            }
            if !arg.starts_with('-') {
                command.push(arg);
                command.extend(args.map(os_to_string).collect::<anyhow::Result<Vec<_>>>()?);
                break;
            }

            match arg.as_str() {
                "-h" | "--help" => {
                    print_usage();
                    std::process::exit(0);
                }
                "--webc" => webc = Some(PathBuf::from(next_value(&mut args, "--webc")?)),
                "--profile" => {
                    profile = HostProfile::parse(&next_value(&mut args, "--profile")?)?;
                }
                "--event-format" => {
                    event_format = EventFormat::parse(&next_value(&mut args, "--event-format")?)?;
                }
                "--module-cache-dir" => {
                    module_cache_dir =
                        Some(PathBuf::from(next_value(&mut args, "--module-cache-dir")?));
                }
                "--package" => package_name = Some(next_value(&mut args, "--package")?),
                "--alias" => {
                    command_aliases.push(parse_alias(&next_value(&mut args, "--alias")?)?);
                }
                "--host-command" => {
                    host_commands.push(parse_host_command(&next_value(
                        &mut args,
                        "--host-command",
                    )?)?);
                }
                "--mount" => {
                    host_mounts.push(parse_mount(&next_value(&mut args, "--mount")?)?);
                }
                "--cwd" => cwd = next_value(&mut args, "--cwd")?,
                "--env" => {
                    let (key, value) = parse_key_value(&next_value(&mut args, "--env")?)?;
                    env.insert(key, value);
                }
                "--env-pass" => {
                    let key = next_value(&mut args, "--env-pass")?;
                    let value = std::env::var(&key)
                        .map_err(|_| anyhow::anyhow!("environment variable is not set: {key}"))?;
                    env.insert(key, value);
                }
                "--stdin-file" => {
                    stdin = Some(read_stdin_source(&next_value(&mut args, "--stdin-file")?)?);
                }
                "--output-limit" => {
                    output_limit = next_value(&mut args, "--output-limit")?
                        .parse()
                        .map_err(|_| anyhow::anyhow!("--output-limit must be a byte count"))?;
                }
                "--timeout" => {
                    let value = next_value(&mut args, "--timeout")?;
                    timeout_seconds = parse_timeout(&value)?;
                }
                _ => return Err(anyhow::anyhow!("unknown option: {arg}")),
            }
        }

        let webc = webc.ok_or_else(|| anyhow::anyhow!("missing required --webc <path>"))?;
        if command.is_empty() {
            return Err(anyhow::anyhow!("missing command after --"));
        }
        if !host_commands.is_empty() && profile != HostProfile::NativeFull {
            return Err(anyhow::anyhow!(
                "--host-command requires --profile native-full"
            ));
        }

        Ok(Self {
            webc,
            profile,
            event_format,
            module_cache_dir,
            package_name,
            command_aliases,
            host_commands,
            host_mounts,
            cwd,
            env,
            stdin,
            output_limit,
            timeout_seconds,
            command,
        })
    }
}

fn next_value(
    args: &mut std::iter::Peekable<impl Iterator<Item = OsString>>,
    option: &str,
) -> anyhow::Result<String> {
    args.next()
        .ok_or_else(|| anyhow::anyhow!("{option} requires a value"))
        .and_then(os_to_string)
}

fn os_to_string(value: OsString) -> anyhow::Result<String> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("arguments must be valid UTF-8"))
}

fn parse_key_value(value: &str) -> anyhow::Result<(String, String)> {
    let (key, value) = value
        .split_once('=')
        .ok_or_else(|| anyhow::anyhow!("expected KEY=VALUE"))?;
    if key.is_empty() {
        return Err(anyhow::anyhow!("environment key cannot be empty"));
    }
    Ok((key.to_string(), value.to_string()))
}

fn parse_alias(value: &str) -> anyhow::Result<PackageCommandAlias> {
    let (alias, command) = value
        .split_once('=')
        .ok_or_else(|| anyhow::anyhow!("expected ALIAS=COMMAND"))?;
    Ok(PackageCommandAlias {
        alias: alias.to_string(),
        command: command.to_string(),
    })
}

fn parse_host_command(value: &str) -> anyhow::Result<HostCommandSpec> {
    let (guest_path, host_command) = value
        .split_once('=')
        .ok_or_else(|| anyhow::anyhow!("expected GUEST_PATH=HOST_COMMAND"))?;
    if guest_path.is_empty() || !guest_path.starts_with('/') {
        return Err(anyhow::anyhow!(
            "host command guest path must be an absolute sandbox path"
        ));
    }
    let host_command = PathBuf::from(host_command);
    if host_command.as_os_str().is_empty() || !host_command.is_absolute() {
        return Err(anyhow::anyhow!(
            "host command target must be an absolute host path"
        ));
    }
    Ok(HostCommandSpec {
        guest_path: guest_path.to_string(),
        host_command,
    })
}

fn parse_mount(value: &str) -> anyhow::Result<HostMount> {
    let parts = value.split(':').collect::<Vec<_>>();
    let (source, target, read_only) = match parts.as_slice() {
        [source, target] => (*source, *target, true),
        [source, target, "ro"] => (*source, *target, true),
        [source, target, "rw"] => (*source, *target, false),
        _ => {
            return Err(anyhow::anyhow!(
                "expected --mount HOST:GUEST[:ro|rw], got {value}"
            ));
        }
    };
    if target.is_empty() || !target.starts_with('/') {
        return Err(anyhow::anyhow!(
            "mount target must be an absolute guest path"
        ));
    }
    Ok(HostMount {
        source: source.to_string(),
        target: target.to_string(),
        read_only,
    })
}

fn read_stdin_source(value: &str) -> anyhow::Result<Vec<u8>> {
    if value == "-" {
        let mut data = Vec::new();
        io::stdin().read_to_end(&mut data)?;
        return Ok(data);
    }
    std::fs::read(Path::new(value))
        .map_err(|error| anyhow::anyhow!("unable to read stdin file {value}: {error}"))
}

fn parse_timeout(value: &str) -> anyhow::Result<Option<f64>> {
    if value == "none" {
        return Ok(None);
    }
    let seconds = value
        .parse()
        .map_err(|_| anyhow::anyhow!("--timeout must be positive seconds or none"))?;
    if !f64::is_finite(seconds) || seconds <= 0.0 {
        return Err(anyhow::anyhow!(
            "--timeout must be positive seconds or none"
        ));
    }
    Ok(Some(seconds))
}

fn display_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| match byte {
            b'\0' => "\\0".to_string(),
            b'\n' => "\\n".to_string(),
            b'\r' => "\\r".to_string(),
            b'\t' => "\\t".to_string(),
            0x20..=0x7e => (*byte as char).to_string(),
            _ => format!("\\x{byte:02x}"),
        })
        .collect::<Vec<_>>()
        .join("")
}

fn exit_code(code: i32) -> u8 {
    if (0..=255).contains(&code) {
        return code as u8;
    }
    1
}

fn host_profile_name(profile: HostProfile) -> &'static str {
    match profile {
        HostProfile::BrowserStrict => "browser-strict",
        HostProfile::NativeFull => "native-full",
    }
}

fn unix_time_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration_ms(duration),
        Err(_) => 0,
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

fn register_host_commands(
    state: &SandboxState,
    host_commands: &[HostCommandSpec],
) -> anyhow::Result<()> {
    for (index, spec) in host_commands.iter().enumerate() {
        state
            .register_virtual_executable(
                host_command_token(index),
                vec![spec.guest_path.clone()],
                false,
            )
            .with_context(|| {
                format!(
                    "unable to register host command bridge at {}",
                    spec.guest_path
                )
            })?;
    }
    Ok(())
}

fn host_command_token(index: usize) -> u64 {
    index as u64 + 1
}

impl HostCommandWorker {
    fn spawn(
        host_commands: Vec<HostCommandSpec>,
        host_mounts: Vec<HostMount>,
        mut receiver: tokio::sync::mpsc::Receiver<VirtualProcessRequest>,
    ) -> Option<Self> {
        if host_commands.is_empty() {
            return None;
        }

        let commands = host_commands
            .into_iter()
            .enumerate()
            .map(|(index, spec)| (host_command_token(index), spec))
            .collect::<HashMap<_, _>>();
        Some(Self {
            _handle: thread::spawn(move || {
                while let Some(request) = receiver.blocking_recv() {
                    if let Err(error) =
                        handle_host_command_request(&request, &commands, &host_mounts)
                    {
                        let _ = request.respond_process(
                            126,
                            Vec::new(),
                            format!("host command bridge failed: {error:#}\n").into_bytes(),
                        );
                    }
                }
            }),
        })
    }
}

fn handle_host_command_request(
    request: &VirtualProcessRequest,
    commands: &HashMap<u64, HostCommandSpec>,
    host_mounts: &[HostMount],
) -> anyhow::Result<()> {
    let invocation = request.invocation()?;
    let spec = commands.get(&invocation.handler_token).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown host command bridge token: {}",
            invocation.handler_token
        )
    })?;
    run_host_command(request, &invocation, spec, host_mounts)
}

fn run_host_command(
    request: &VirtualProcessRequest,
    invocation: &VirtualProcessInvocation,
    spec: &HostCommandSpec,
    host_mounts: &[HostMount],
) -> anyhow::Result<()> {
    let mut command = Command::new(&spec.host_command);
    command
        .args(invocation.argv.iter().skip(1))
        .env_clear()
        .envs(&invocation.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = map_guest_path_to_host(&invocation.cwd, host_mounts) {
        command.current_dir(cwd);
    }

    let mut child = command.spawn().with_context(|| {
        format!(
            "unable to spawn host command {} for {}",
            spec.host_command.display(),
            invocation.executable_path
        )
    })?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdin_handle = stdin.map(|mut stdin| {
        let input = invocation.stdin.clone();
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        })
    });
    let stdout_handle =
        stdout.map(|stdout| stream_host_command_output(stdout, request.clone(), true));
    let stderr_handle =
        stderr.map(|stderr| stream_host_command_output(stderr, request.clone(), false));

    let status = loop {
        if request.cancellation_token().is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };

    if let Some(handle) = stdin_handle {
        let _ = handle.join();
    }
    if let Some(handle) = stdout_handle {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }

    request.respond_process(exit_status_code(status), Vec::new(), Vec::new())
}

fn stream_host_command_output(
    mut reader: impl Read + Send + 'static,
    request: VirtualProcessRequest,
    stdout: bool,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(count) => count,
                Err(_) => return,
            };
            let data = buffer[..count].to_vec();
            let result = if stdout {
                request.write_stdout(data)
            } else {
                request.write_stderr(data)
            };
            if result.is_err() {
                return;
            }
        }
    })
}

fn map_guest_path_to_host(guest_path: &str, host_mounts: &[HostMount]) -> Option<PathBuf> {
    let mut best: Option<(&HostMount, &str)> = None;
    for mount in host_mounts {
        if let Some(relative) = guest_path_relative_to_mount(guest_path, &mount.target) {
            let replace = best
                .as_ref()
                .is_none_or(|(existing, _)| mount.target.len() > existing.target.len());
            if replace {
                best = Some((mount, relative));
            }
        }
    }

    let (mount, relative) = best?;
    let mut path = PathBuf::from(&mount.source);
    if !relative.is_empty() {
        path.push(relative);
    }
    Some(path)
}

fn guest_path_relative_to_mount<'a>(guest_path: &'a str, mount_target: &str) -> Option<&'a str> {
    if mount_target == "/" {
        return Some(guest_path.trim_start_matches('/'));
    }
    if guest_path == mount_target {
        return Some("");
    }
    guest_path
        .strip_prefix(mount_target)
        .and_then(|suffix| suffix.strip_prefix('/'))
}

fn exit_status_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    signal_exit_code(status)
}

#[cfg(unix)]
fn signal_exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;

    status.signal().map_or(1, |signal| 128 + signal)
}

#[cfg(not(unix))]
fn signal_exit_code(_status: std::process::ExitStatus) -> i32 {
    1
}

fn print_usage() {
    println!(
        "\
Run a WebC command with the embedded WASIX sandbox.

Usage:
  wasm-host-runner --webc <package.webc> [options] -- <command> [args...]

Options:
  --webc <path>              Local WebC package to load
  --profile <name>           Host profile: browser-strict or native-full,
                             default browser-strict
  --event-format <name>      Runner event format: none or json, default none.
                             JSON events are written to stderr as JSON lines
  --module-cache-dir <path>  Directory for compiled module cache artifacts.
                             Defaults to XDG_CACHE_HOME/HOME/temp fallback
  --package <name>           Logical package name, defaults to file stem
  --alias <ALIAS=COMMAND>    Expose an extra command alias from the package
  --host-command <GUEST=HOST>
                             Register an approved native host command bridge;
                             requires native-full and an absolute host path
  --mount <HOST:GUEST[:ro|rw]>
                             Mount a host directory into the sandbox; requires native-full
  --cwd <path>               Sandbox cwd, default /work
  --env <KEY=VALUE>          Add or override an environment variable
  --env-pass <KEY>           Copy an environment variable from the host
  --stdin-file <path|->      Read process stdin from a file or host stdin
  --output-limit <bytes>     Captured stdout/stderr limit, default 16777216
  --timeout <seconds|none>   Wall-time limit, default none
"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};

    #[test]
    fn parse_defaults_to_browser_strict_profile() {
        let options = Options::parse(args(["--webc", "tool.webc", "--", "tool"]))
            .expect("options should parse");

        assert_eq!(options.webc, PathBuf::from("tool.webc"));
        assert_eq!(options.profile, HostProfile::BrowserStrict);
        assert_eq!(options.event_format, EventFormat::None);
        assert_eq!(options.module_cache_dir, None);
        assert_eq!(options.command, ["tool"]);
        assert_eq!(options.cwd, "/work");
    }

    #[test]
    fn parse_accepts_json_event_format() {
        let options = Options::parse(args([
            "--webc",
            "tool.webc",
            "--event-format",
            "json",
            "--",
            "tool",
        ]))
        .expect("options should parse");

        assert_eq!(options.event_format, EventFormat::Json);
        assert_eq!(options.command, ["tool"]);
    }

    #[test]
    fn parse_accepts_module_cache_dir() {
        let options = Options::parse(args([
            "--webc",
            "tool.webc",
            "--module-cache-dir",
            ".cache/modules",
            "--",
            "tool",
        ]))
        .expect("options should parse");

        assert_eq!(
            options.module_cache_dir,
            Some(PathBuf::from(".cache/modules"))
        );
        assert_eq!(options.command, ["tool"]);
    }

    #[test]
    fn parse_accepts_native_host_command_bridge() {
        let options = Options::parse(args([
            "--webc",
            "tool.webc",
            "--profile",
            "native-full",
            "--host-command",
            "/tools/echo=/bin/echo",
            "--",
            "tool",
        ]))
        .expect("options should parse");

        assert_eq!(
            options.host_commands,
            [HostCommandSpec {
                guest_path: "/tools/echo".to_string(),
                host_command: PathBuf::from("/bin/echo"),
            }]
        );
    }

    #[test]
    fn parse_rejects_host_command_without_native_full_profile() {
        let error = match Options::parse(args([
            "--webc",
            "tool.webc",
            "--host-command",
            "/tools/echo=/bin/echo",
            "--",
            "tool",
        ])) {
            Ok(_) => panic!("host command bridge should require native-full"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("native-full"));
    }

    #[test]
    fn host_command_cwd_uses_longest_matching_mount() {
        let mounts = vec![
            HostMount {
                source: "/tmp/root".to_string(),
                target: "/workspace".to_string(),
                read_only: true,
            },
            HostMount {
                source: "/tmp/project".to_string(),
                target: "/workspace/project".to_string(),
                read_only: true,
            },
        ];

        assert_eq!(
            map_guest_path_to_host("/workspace/project/src", &mounts),
            Some(PathBuf::from("/tmp/project/src"))
        );
        assert_eq!(
            map_guest_path_to_host("/workspace/other", &mounts),
            Some(PathBuf::from("/tmp/root/other"))
        );
        assert_eq!(map_guest_path_to_host("/unmounted", &mounts), None);
    }

    #[test]
    fn parse_accepts_positive_timeout_and_none() {
        assert_eq!(
            parse_timeout("1.25").expect("positive timeout should parse"),
            Some(1.25)
        );
        assert_eq!(parse_timeout("none").expect("none should parse"), None);
    }

    #[test]
    fn parse_rejects_non_positive_timeout() {
        let zero = parse_timeout("0").expect_err("zero timeout should fail");
        assert!(zero.to_string().contains("positive seconds"));

        let negative = parse_timeout("-1").expect_err("negative timeout should fail");
        assert!(negative.to_string().contains("positive seconds"));
    }

    #[test]
    fn parse_rejects_unknown_profile() {
        let error = match Options::parse(args([
            "--webc",
            "tool.webc",
            "--profile",
            "native",
            "--",
            "tool",
        ])) {
            Ok(_) => panic!("unknown profile should fail"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("unknown host profile"));
    }

    #[test]
    fn parse_rejects_unknown_event_format() {
        let error = match Options::parse(args([
            "--webc",
            "tool.webc",
            "--event-format",
            "pretty",
            "--",
            "tool",
        ])) {
            Ok(_) => panic!("unknown event format should fail"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("unknown event format"));
    }

    #[test]
    fn parse_mounts_and_env_pass_without_putting_secret_in_command() {
        let key = "WASM_HOST_RUNNER_TEST_SECRET";
        env::set_var(key, "secret-value");
        let options = Options::parse(args([
            "--webc",
            "tool.webc",
            "--profile",
            "native-full",
            "--mount",
            ".:/workspace:rw",
            "--env-pass",
            key,
            "--",
            "tool",
        ]))
        .expect("options should parse");
        env::remove_var(key);

        assert_eq!(options.host_mounts.len(), 1);
        assert!(!options.host_mounts[0].read_only);
        assert_eq!(
            options.env.get(key).map(String::as_str),
            Some("secret-value")
        );
        assert_eq!(options.command, ["tool"]);
    }

    #[test]
    fn runner_started_event_omits_environment_values() {
        let options = Options {
            webc: PathBuf::from("/packages/tool.webc"),
            profile: HostProfile::NativeFull,
            event_format: EventFormat::Json,
            module_cache_dir: Some(PathBuf::from("/cache/modules")),
            package_name: Some("tool".to_string()),
            command_aliases: vec![PackageCommandAlias {
                alias: "alias".to_string(),
                command: "tool".to_string(),
            }],
            host_commands: vec![HostCommandSpec {
                guest_path: "/tools/host-tool".to_string(),
                host_command: PathBuf::from("/bin/echo"),
            }],
            host_mounts: vec![HostMount {
                source: ".".to_string(),
                target: "/workspace".to_string(),
                read_only: true,
            }],
            cwd: "/workspace".to_string(),
            env: HashMap::from([
                ("PUBLIC".to_string(), "visible-value".to_string()),
                ("SECRET".to_string(), "secret-value".to_string()),
            ]),
            stdin: None,
            output_limit: 4096,
            timeout_seconds: Some(1.5),
            command: vec!["tool".to_string(), "--flag".to_string()],
        };
        let mut output = Vec::new();
        write_event_json_line(&mut output, runner_started_event(&options, "tool"))
            .expect("event should write");

        let line = String::from_utf8(output).expect("event should be utf8");
        assert!(!line.contains("secret-value"));
        assert!(!line.contains("visible-value"));
        let event: Value = serde_json::from_str(&line).expect("event should parse");
        assert_eq!(event["schema"], 1);
        assert!(event["time_unix_ms"].as_u64().is_some());
        assert_eq!(event["event"], "runner.started");
        assert_eq!(event["profile"], "native-full");
        assert_eq!(event["argv0"], "tool");
        assert_eq!(event["argc"], 2);
        assert_eq!(event["alias_count"], 1);
        assert_eq!(event["host_command_count"], 1);
        assert_eq!(event["mount_count"], 1);
        assert_eq!(event["env_keys"], json!(["PUBLIC", "SECRET"]));
        assert_eq!(event["env_count"], 2);
        assert_eq!(event["module_cache_dir"], "/cache/modules");
    }

    #[test]
    fn command_resolution_errors_map_to_command_exit() {
        let (events, _event_receiver) = EventBus::new(4);
        let (virtual_executables, _virtual_process_receiver) = VirtualExecutableBridge::new(4);
        let state = SandboxState::new_with_profile(
            HostProfile::BrowserStrict,
            HashMap::new(),
            Vec::new(),
            Vec::new(),
            "/work".to_string(),
            HashMap::new(),
            events,
            virtual_executables,
        )
        .expect("sandbox should initialize");
        let error = match state.run_blocking(
            RunRequest {
                args: vec!["missing-tool".to_string()],
                input: None,
                env: None,
                cwd: None,
                limits: Limits {
                    output_bytes: 1024,
                    wall_time_seconds: Some(1.0),
                },
            },
            CancellationSource::new().token(),
        ) {
            Ok(_) => panic!("missing command should fail"),
            Err(error) => error,
        };

        let failure = run_failure_for_error(&error);
        assert_eq!(failure.stage, "command");
        assert_eq!(failure.exit_code, EXIT_COMMAND_NOT_FOUND);
    }

    #[test]
    fn timeout_errors_map_to_timeout_exit() {
        let (events, _event_receiver) = EventBus::new(4);
        let (virtual_executables, _virtual_process_receiver) = VirtualExecutableBridge::new(4);
        let state = SandboxState::new_with_profile(
            HostProfile::BrowserStrict,
            HashMap::new(),
            Vec::new(),
            Vec::new(),
            "/work".to_string(),
            HashMap::from([("PATH".to_string(), "/tools:/bin:/usr/bin".to_string())]),
            events,
            virtual_executables,
        )
        .expect("sandbox should initialize");
        state
            .register_virtual_executable(7, vec!["/tools/hang".to_string()], false)
            .expect("virtual executable should register");
        let error = match state.run_blocking(
            RunRequest {
                args: vec!["hang".to_string()],
                input: None,
                env: None,
                cwd: None,
                limits: Limits {
                    output_bytes: 1024,
                    wall_time_seconds: Some(0.01),
                },
            },
            CancellationSource::new().token(),
        ) {
            Ok(_) => panic!("timeout should fail"),
            Err(error) => error,
        };

        let failure = run_failure_for_error(&error);
        assert_eq!(failure.stage, "timeout");
        assert_eq!(failure.exit_code, EXIT_TIMEOUT);
    }

    #[test]
    fn validate_webc_package_accepts_webc_magic() {
        let package = temp_path("valid.webc");
        fs::write(&package, b"\0webc003rest").expect("fixture should write");

        validate_webc_package(&package).expect("valid magic should pass");
        fs::remove_file(package).expect("fixture should remove");
    }

    #[test]
    fn validate_webc_package_rejects_html_response() {
        let package = temp_path("html.webc");
        fs::write(&package, b"<!doctype html>").expect("fixture should write");

        let error = validate_webc_package(&package).expect_err("HTML should fail");
        fs::remove_file(package).expect("fixture should remove");

        let message = error.to_string();
        assert!(message.contains("invalid WebC package"));
        assert!(message.contains("expected magic bytes \\0webc"));
        assert!(message.contains("found <!doc"));
    }

    fn args(values: impl IntoIterator<Item = &'static str>) -> Vec<OsString> {
        values.into_iter().map(OsString::from).collect()
    }

    fn temp_path(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        path.push(format!(
            "wasm-host-runner-test-{}-{name}",
            std::process::id()
        ));
        path
    }
}
