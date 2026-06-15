use std::{
    collections::HashMap,
    ffi::OsString,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

use wasm_host_core::{
    CancellationSource, EventBus, HostMount, Limits, PackageCommandAlias, PackageSpec, RunRequest,
    SandboxState, VirtualExecutableBridge,
};

const DEFAULT_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const DEFAULT_EVENT_QUEUE_SIZE: usize = 4096;

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(exit_code(code)),
        Err(error) => {
            eprintln!("wasm-host-runner: {error}");
            ExitCode::from(125)
        }
    }
}

fn run() -> anyhow::Result<i32> {
    let options = Options::parse(std::env::args_os().skip(1))?;
    let (events, _event_receiver) = EventBus::new(DEFAULT_EVENT_QUEUE_SIZE);
    let (virtual_executables, _virtual_process_receiver) =
        VirtualExecutableBridge::new(DEFAULT_EVENT_QUEUE_SIZE);
    let package_name = options.package_name.unwrap_or_else(|| {
        options
            .webc
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("package")
            .to_string()
    });
    let package = PackageSpec {
        name: package_name,
        webc_path: options.webc.to_string_lossy().to_string(),
        content_sha256: "0".repeat(64),
        command_aliases: options.command_aliases,
    };
    let state = SandboxState::new(
        HashMap::new(),
        options.host_mounts,
        vec![package],
        options.cwd,
        options.env,
        events,
        virtual_executables,
    )?;
    let cancellation = CancellationSource::new();
    let result = state.run_blocking(
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
    )?;

    io::stdout().write_all(&result.stdout)?;
    io::stderr().write_all(&result.stderr)?;
    Ok(result.returncode)
}

struct Options {
    webc: PathBuf,
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

impl Options {
    fn parse(args: impl IntoIterator<Item = OsString>) -> anyhow::Result<Self> {
        let mut args = args.into_iter().peekable();
        let mut webc = None;
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

fn exit_code(code: i32) -> u8 {
    if (0..=255).contains(&code) {
        return code as u8;
    }
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
  --package <name>           Logical package name, defaults to file stem
  --alias <ALIAS=COMMAND>    Expose an extra command alias from the package
  --mount <HOST:GUEST[:ro|rw]>
                             Mount a host directory into the sandbox
  --cwd <path>               Sandbox cwd, default /work
  --env <KEY=VALUE>          Add or override an environment variable
  --env-pass <KEY>           Copy an environment variable from the host
  --stdin-file <path|->      Read process stdin from a file or host stdin
  --output-limit <bytes>     Captured stdout/stderr limit, default 16777216
  --timeout <seconds|none>   Wall-time limit, default none
"
    );
}
