use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, ExitStatus, Stdio},
    thread,
    time::Duration,
};

use anyhow::{Context, Result};

use crate::{HostMount, SandboxState, VirtualProcessInvocation, VirtualProcessRequest};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeHostCommandSpec {
    pub guest_path: String,
    pub host_command: PathBuf,
}

pub struct NativeHostCommandWorker {
    _handle: thread::JoinHandle<()>,
}

impl NativeHostCommandSpec {
    pub fn new(guest_path: impl Into<String>, host_command: impl Into<PathBuf>) -> Result<Self> {
        let guest_path = guest_path.into();
        if guest_path.is_empty() || !guest_path.starts_with('/') {
            return Err(anyhow::anyhow!(
                "host command guest path must be an absolute sandbox path"
            ));
        }

        let host_command = host_command.into();
        if host_command.as_os_str().is_empty() || !host_command.is_absolute() {
            return Err(anyhow::anyhow!(
                "host command target must be an absolute host path"
            ));
        }

        Ok(Self {
            guest_path,
            host_command,
        })
    }
}

pub fn register_native_host_commands(
    state: &SandboxState,
    host_commands: &[NativeHostCommandSpec],
) -> Result<()> {
    for (index, spec) in host_commands.iter().enumerate() {
        state
            .register_virtual_executable(
                native_host_command_token(index),
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

impl NativeHostCommandWorker {
    pub fn spawn(
        host_commands: Vec<NativeHostCommandSpec>,
        host_mounts: Vec<HostMount>,
        mut receiver: tokio::sync::mpsc::Receiver<VirtualProcessRequest>,
    ) -> Option<Self> {
        if host_commands.is_empty() {
            return None;
        }

        let commands = host_commands
            .into_iter()
            .enumerate()
            .map(|(index, spec)| (native_host_command_token(index), spec))
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

fn native_host_command_token(index: usize) -> u64 {
    index as u64 + 1
}

fn handle_host_command_request(
    request: &VirtualProcessRequest,
    commands: &HashMap<u64, NativeHostCommandSpec>,
    host_mounts: &[HostMount],
) -> Result<()> {
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
    spec: &NativeHostCommandSpec,
    host_mounts: &[HostMount],
) -> Result<()> {
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

fn exit_status_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    signal_exit_code(status)
}

#[cfg(unix)]
fn signal_exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;

    status.signal().map_or(1, |signal| 128 + signal)
}

#[cfg(not(unix))]
fn signal_exit_code(_status: ExitStatus) -> i32 {
    1
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, path::PathBuf};

    use crate::{
        CancellationSource, EventBus, HostProfile, Limits, RunRequest, VirtualExecutableBridge,
    };

    use super::*;

    #[test]
    fn cwd_mapping_uses_longest_matching_mount() {
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
    fn bridge_runs_native_process_with_stdio_and_mapped_cwd() {
        let host_shell = PathBuf::from("/bin/sh");
        if !host_shell.is_file() {
            return;
        }

        let workspace = tempfile::tempdir().expect("workspace should be created");
        let host_mounts = vec![HostMount {
            source: workspace.path().to_string_lossy().to_string(),
            target: "/workspace".to_string(),
            read_only: false,
        }];
        let (events, _event_receiver) = EventBus::new(4);
        let (virtual_executables, virtual_process_receiver) = VirtualExecutableBridge::new(4);
        let state = SandboxState::new_with_profile(
            HostProfile::NativeFull,
            HashMap::new(),
            host_mounts.clone(),
            Vec::new(),
            "/workspace".to_string(),
            HashMap::from([("PATH".to_string(), "/tools:/bin:/usr/bin".to_string())]),
            events,
            virtual_executables,
        )
        .expect("sandbox should initialize");
        let spec = NativeHostCommandSpec::new("/tools/host-sh", host_shell)
            .expect("host command should be valid");
        register_native_host_commands(&state, std::slice::from_ref(&spec))
            .expect("host command should register");
        let _worker =
            NativeHostCommandWorker::spawn(vec![spec], host_mounts, virtual_process_receiver)
                .expect("host command worker should start");

        let result = state
            .run_blocking(
                RunRequest {
                    args: vec![
                        "host-sh".to_string(),
                        "-c".to_string(),
                        "cat > host-command-output.txt; printf 'arg=%s\\n' \"$1\"; printf 'stderr-line\\n' >&2".to_string(),
                        "script-name".to_string(),
                        "arg1".to_string(),
                    ],
                    input: Some(b"stdin-data".to_vec()),
                    env: None,
                    cwd: None,
                    limits: Limits {
                        output_bytes: 1024,
                        wall_time_seconds: Some(5.0),
                    },
                },
                CancellationSource::new().token(),
            )
            .expect("host command should run");

        assert_eq!(result.returncode, 0);
        assert_eq!(result.stdout, b"arg=arg1\n");
        assert_eq!(result.stderr, b"stderr-line\n");
        assert_eq!(
            fs::read(workspace.path().join("host-command-output.txt"))
                .expect("output file should exist"),
            b"stdin-data"
        );
    }
}
