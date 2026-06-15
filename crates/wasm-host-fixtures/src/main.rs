use std::{env, fs, path::PathBuf};

use anyhow::{bail, Context, Result};
use wasm_host_fixtures::{
    http_bridge_fixture_webc, http_bridge_fixture_webc_with_options, stdout_fixture_webc,
    HttpBridgeFixtureOptions,
};

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else {
        print_usage();
        bail!("missing fixture command");
    };

    match command.as_str() {
        "stdout" => {
            let options = CliOptions::parse(args, &["--output", "--stdout"])?;
            let output = options.required("--output")?;
            let stdout = options.required("--stdout")?;
            let webc = stdout_fixture_webc(stdout.as_bytes())?;
            write_output(output, &webc)
        }
        "http-bridge" => {
            let options = CliOptions::parse(
                args,
                &["--output", "--url", "--response-body-limit", "--timeout-ms"],
            )?;
            let output = options.required("--output")?;
            let url = options.required("--url")?;
            let fixture_options = if options.optional("--response-body-limit").is_some()
                || options.optional("--timeout-ms").is_some()
            {
                HttpBridgeFixtureOptions {
                    response_body_limit: parse_optional_usize(
                        &options,
                        "--response-body-limit",
                        HttpBridgeFixtureOptions::default().response_body_limit,
                    )?,
                    timeout_ms: parse_optional_positive_u64(&options, "--timeout-ms")?,
                }
            } else {
                HttpBridgeFixtureOptions::default()
            };
            let webc = if fixture_options == HttpBridgeFixtureOptions::default() {
                http_bridge_fixture_webc(url)?
            } else {
                http_bridge_fixture_webc_with_options(url, fixture_options)?
            };
            write_output(output, &webc)
        }
        "-h" | "--help" => {
            print_usage();
            Ok(())
        }
        value => {
            print_usage();
            bail!("unknown fixture command: {value}")
        }
    }
}

#[derive(Default)]
struct CliOptions {
    values: Vec<(String, String)>,
}

impl CliOptions {
    fn parse(args: impl Iterator<Item = String>, allowed: &[&str]) -> Result<Self> {
        let mut values = Vec::new();
        let mut args = args.peekable();
        while let Some(option) = args.next() {
            if !allowed.contains(&option.as_str()) {
                bail!("unknown option: {option}");
            }
            let value = args
                .next()
                .with_context(|| format!("{option} requires a value"))?;
            values.push((option, value));
        }
        Ok(Self { values })
    }

    fn required(&self, name: &str) -> Result<&str> {
        self.optional(name)
            .with_context(|| format!("missing required {name}"))
    }

    fn optional(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .rev()
            .find_map(|(key, value)| (key == name).then_some(value.as_str()))
    }
}

fn parse_optional_usize(options: &CliOptions, name: &str, default: usize) -> Result<usize> {
    match options.optional(name) {
        Some(value) => value
            .parse::<usize>()
            .with_context(|| format!("invalid {name}: {value}")),
        None => Ok(default),
    }
}

fn parse_optional_positive_u64(options: &CliOptions, name: &str) -> Result<Option<u64>> {
    let Some(value) = options.optional(name) else {
        return Ok(None);
    };
    let parsed = value
        .parse::<u64>()
        .with_context(|| format!("invalid {name}: {value}"))?;
    if parsed == 0 {
        bail!("{name} must be positive");
    }
    Ok(Some(parsed))
}

fn write_output(path: &str, data: &[u8]) -> Result<()> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("unable to create {}", parent.display()))?;
    }
    fs::write(&path, data).with_context(|| format!("unable to write {}", path.display()))
}

fn print_usage() {
    eprintln!(
        "usage:\n  wasm-host-fixtures stdout --output PATH --stdout TEXT\n  wasm-host-fixtures http-bridge --output PATH --url URL [--response-body-limit BYTES] [--timeout-ms MS]"
    );
}
