use std::{
    collections::HashMap,
    ffi::OsString,
    fmt,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Map, Value};
use wasm_host_core::{
    CancellationSource, EventBus, HostMount, HostProfile, Limits, PackageCommandAlias, PackageSpec,
    RunRequest, SandboxState, VirtualExecutableBridge,
};

const DEFAULT_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const DEFAULT_EVENT_QUEUE_SIZE: usize = 4096;
const WEBC_MAGIC: &[u8; 5] = b"\0webc";
const EXIT_USAGE: u8 = 2;
const EXIT_PACKAGE: u8 = 65;
const EXIT_HOST: u8 = 125;

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
    let (virtual_executables, _virtual_process_receiver) =
        VirtualExecutableBridge::new(DEFAULT_EVENT_QUEUE_SIZE);
    let package = PackageSpec {
        name: package_name.clone(),
        webc_path: options.webc.to_string_lossy().to_string(),
        content_sha256: "0".repeat(64),
        command_aliases: options.command_aliases,
    };
    let state = match SandboxState::new_with_profile(
        options.profile,
        HashMap::new(),
        options.host_mounts,
        vec![package],
        options.cwd,
        options.env,
        events,
        virtual_executables,
    ) {
        Ok(state) => state,
        Err(error) => {
            reporter
                .runner_failed("sandbox", EXIT_HOST, &error, started_at.elapsed())
                .map_err(RunnerError::host)?;
            return Err(RunnerError::host_reported(error, options.event_format));
        }
    };
    reporter
        .sandbox_initialized(&package_name)
        .map_err(RunnerError::host)?;
    let cancellation = CancellationSource::new();
    let result = match state.run_blocking(
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
        cancellation.token(),
    ) {
        Ok(result) => result,
        Err(error) => {
            reporter
                .runner_failed("run", EXIT_HOST, &error, started_at.elapsed())
                .map_err(RunnerError::host)?;
            return Err(RunnerError::host_reported(error, options.event_format));
        }
    };

    io::stdout()
        .write_all(&result.stdout)
        .map_err(|error| RunnerError::host(anyhow::Error::new(error)))?;
    io::stderr()
        .write_all(&result.stderr)
        .map_err(|error| RunnerError::host(anyhow::Error::new(error)))?;
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
        Self {
            suppress_plain_error: event_format == EventFormat::Json,
            ..Self::host(error)
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
    package_name: Option<String>,
    command_aliases: Vec<PackageCommandAlias>,
    host_mounts: Vec<HostMount>,
    cwd: String,
    env: HashMap<String, String>,
    stdin: Option<Vec<u8>>,
    output_limit: usize,
    timeout_seconds: Option<f64>,
    command: Vec<String>,
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
        "mount_count": options.host_mounts.len(),
        "env_keys": env_keys,
        "env_count": options.env.len(),
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
        let mut package_name = None;
        let mut command_aliases = Vec::new();
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
                "--package" => package_name = Some(next_value(&mut args, "--package")?),
                "--alias" => {
                    command_aliases.push(parse_alias(&next_value(&mut args, "--alias")?)?);
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
                    timeout_seconds =
                        if value == "none" {
                            None
                        } else {
                            Some(value.parse().map_err(|_| {
                                anyhow::anyhow!("--timeout must be seconds or none")
                            })?)
                        };
                }
                _ => return Err(anyhow::anyhow!("unknown option: {arg}")),
            }
        }

        let webc = webc.ok_or_else(|| anyhow::anyhow!("missing required --webc <path>"))?;
        if command.is_empty() {
            return Err(anyhow::anyhow!("missing command after --"));
        }

        Ok(Self {
            webc,
            profile,
            event_format,
            package_name,
            command_aliases,
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
  --package <name>           Logical package name, defaults to file stem
  --alias <ALIAS=COMMAND>    Expose an extra command alias from the package
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
            package_name: Some("tool".to_string()),
            command_aliases: vec![PackageCommandAlias {
                alias: "alias".to_string(),
                command: "tool".to_string(),
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
        assert_eq!(event["mount_count"], 1);
        assert_eq!(event["env_keys"], json!(["PUBLIC", "SECRET"]));
        assert_eq!(event["env_count"], 2);
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
