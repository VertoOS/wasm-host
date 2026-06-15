#!/usr/bin/env python3
"""Resolve language WebC fixtures for the e2e harness."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import urllib.request


WEBC_MAGIC = b"\0webc"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--language", required=True)
    parser.add_argument("--tmp-root", required=True, type=Path)
    parser.add_argument("--optional", action="store_true")
    args = parser.parse_args()

    manifest_path = args.manifest.resolve()
    manifest = load_manifest(manifest_path)
    artifacts = manifest.get("artifacts", {})
    fixture = artifacts.get(args.language)
    if fixture is None:
        return fail(f"unknown language fixture: {args.language}")

    try:
        resolved = resolve_fixture(manifest, manifest_path, args.language, fixture, args.tmp_root)
    except MissingFixture as error:
        if args.optional:
            print_shell(
                {
                    "WASM_HOST_RESOLVED_AVAILABLE": "0",
                    "WASM_HOST_RESOLVED_REASON": str(error),
                }
            )
            return 0
        return fail(str(error))
    except FixtureError as error:
        return fail(str(error))

    print_shell(
        {
            "WASM_HOST_RESOLVED_AVAILABLE": "1",
            "WASM_HOST_RESOLVED_NAME": args.language,
            "WASM_HOST_RESOLVED_PACKAGE": resolved["package"],
            "WASM_HOST_RESOLVED_WEBC": str(resolved["webc"]),
            "WASM_HOST_RESOLVED_COMMAND": resolved["command"],
            "WASM_HOST_RESOLVED_ARGS_JSON": json.dumps(resolved["args"], separators=(",", ":")),
            "WASM_HOST_RESOLVED_MARKER": resolved["marker"],
        }
    )
    return 0


class FixtureError(Exception):
    pass


class MissingFixture(FixtureError):
    pass


def load_manifest(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as error:
        raise FixtureError(f"unable to read fixture manifest {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise FixtureError(f"invalid fixture manifest {path}: {error}") from error


def resolve_fixture(
    manifest: dict, manifest_path: Path, language: str, fixture: dict, tmp_root: Path
) -> dict:
    storage = fixture.get("storage", {})
    artifact = fixture.get("artifact", {})
    command = fixture.get("command", {})

    source_path = first_set_env(storage.get("path_env"))
    source_url = first_set_env(storage.get("url_env"))
    sha256 = first_set_env(storage.get("sha256_env"))

    if source_path is None:
        source_path = artifact.get("path")
    if source_url is None:
        source_url = artifact.get("url")
    if sha256 is None:
        sha256 = artifact.get("sha256")

    if source_path:
        package_path = resolve_manifest_path(manifest_path, source_path)
        if not package_path.is_file():
            raise FixtureError(f"{language} fixture package does not exist: {package_path}")
    elif source_url:
        package_path = fetch_fixture(manifest, source_url, storage, language, sha256)
    else:
        path_env = storage.get("path_env", f"WASM_HOST_{language.upper()}_WEBC")
        url_env = storage.get("url_env", f"WASM_HOST_{language.upper()}_WEBC_URL")
        raise MissingFixture(
            f"set {path_env}, {url_env}, or artifact.url/path in {manifest_path.name}"
        )

    if sha256:
        verify_sha256(package_path, sha256, language)

    webc_path = normalize_webc(package_path, language, tmp_root)
    validate_webc_magic(webc_path, language)

    return {
        "package": required_string(fixture, "package", language),
        "webc": webc_path,
        "command": os.environ.get(command.get("env", ""), command.get("default", language)),
        "args": command_args(command),
        "marker": required_string(command, "expected_marker", language),
    }


def first_set_env(name: str | None) -> str | None:
    if not name:
        return None
    value = os.environ.get(name)
    return value or None


def resolve_manifest_path(manifest_path: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return (manifest_path.parent / path).resolve()


def fetch_fixture(
    manifest: dict, url: str, storage: dict, language: str, sha256: str | None
) -> Path:
    cache_dir_env = manifest.get("cache_dir_env", "WASM_HOST_FIXTURE_CACHE_DIR")
    cache_dir = os.environ.get(cache_dir_env)
    if cache_dir:
        cache_path = Path(cache_dir).expanduser()
    else:
        cache_path = Path.home() / ".cache" / "wasm-host" / "fixtures" / "languages"
    cache_path.mkdir(parents=True, exist_ok=True)

    cache_name = storage.get("cache_name") or f"{language}.webc"
    if url.endswith(".gz") and not cache_name.endswith(".gz"):
        cache_name = f"{cache_name}.gz"
    target = cache_path / cache_name
    if target.is_file() and (not sha256 or sha256_file(target) == sha256.lower()):
        return target

    tmp = target.with_suffix(target.suffix + ".download")
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            with tmp.open("wb") as handle:
                shutil.copyfileobj(response, handle)
        tmp.replace(target)
    except OSError as error:
        raise FixtureError(f"unable to fetch {language} fixture from {url}: {error}") from error

    return target


def verify_sha256(path: Path, expected: str, language: str) -> None:
    normalized = expected.lower()
    if len(normalized) != 64 or any(char not in "0123456789abcdef" for char in normalized):
        raise FixtureError(f"{language} fixture sha256 must be a 64-character hex digest")
    actual = sha256_file(path)
    if actual != normalized:
        raise FixtureError(
            f"{language} fixture sha256 mismatch for {path}: expected {normalized}, got {actual}"
        )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_webc(path: Path, language: str, tmp_root: Path) -> Path:
    if path.name.endswith(".webc.gz"):
        output = tmp_root / f"{language}.webc"
        try:
            with gzip.open(path, "rb") as source, output.open("wb") as target:
                shutil.copyfileobj(source, target)
        except OSError as error:
            raise FixtureError(f"unable to decompress {language} fixture {path}: {error}") from error
        return output
    return path


def validate_webc_magic(path: Path, language: str) -> None:
    try:
        with path.open("rb") as handle:
            magic = handle.read(len(WEBC_MAGIC))
    except OSError as error:
        raise FixtureError(f"unable to read {language} WebC package {path}: {error}") from error

    if magic != WEBC_MAGIC:
        raise FixtureError(
            f"invalid {language} WebC package {path}: expected magic bytes "
            f"{display_bytes(WEBC_MAGIC)}, found {display_bytes(magic)}"
        )


def command_args(command: dict) -> list[str]:
    args_env = command.get("args_env")
    if args_env and args_env in os.environ:
        value = os.environ[args_env]
        return shlex.split(value) if value else []

    args = command.get("default_args", [])
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        raise FixtureError("command.default_args must be a list of strings")
    return args


def required_string(container: dict, key: str, language: str) -> str:
    value = container.get(key)
    if not isinstance(value, str) or not value:
        raise FixtureError(f"{language} fixture is missing string field: {key}")
    return value


def display_bytes(data: bytes) -> str:
    parts = []
    for byte in data:
        if byte == 0:
            parts.append("\\0")
        elif byte == 10:
            parts.append("\\n")
        elif byte == 13:
            parts.append("\\r")
        elif byte == 9:
            parts.append("\\t")
        elif 0x20 <= byte <= 0x7E:
            parts.append(chr(byte))
        else:
            parts.append(f"\\x{byte:02x}")
    return "".join(parts)


def print_shell(values: dict[str, str]) -> None:
    for key, value in values.items():
        print(f"{key}={shlex.quote(value)}")


def fail(message: str) -> int:
    print(f"resolve.py: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
