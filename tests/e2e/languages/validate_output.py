#!/usr/bin/env python3
"""Validate structured language e2e smoke-test output."""

from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", required=True, choices=["python", "go"])
    parser.add_argument("--marker", required=True)
    parser.add_argument("--args-json", required=True)
    args = parser.parse_args()

    try:
        command_args = json.loads(args.args_json)
    except json.JSONDecodeError as error:
        return fail(f"invalid args JSON: {error}")
    if not isinstance(command_args, list) or not all(
        isinstance(value, str) for value in command_args
    ):
        return fail("args JSON must be a list of strings")

    output = sys.stdin.read()
    try:
        payload = find_payload(output, args.marker)
        validate_common(payload, args.marker)
        if args.language == "python":
            validate_python(payload, command_args)
        else:
            validate_go(payload, command_args)
    except ValidationError as error:
        return fail(str(error))

    print(f"{args.language} e2e payload validated")
    return 0


class ValidationError(Exception):
    pass


def find_payload(output: str, marker: str) -> dict:
    for line in reversed(output.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("marker") == marker:
            return value
    raise ValidationError(f"did not find JSON payload with marker {marker}")


def validate_common(payload: dict, marker: str) -> None:
    expect(payload, "marker", marker)
    expect(payload, "cwd", "/workspace")


def validate_python(payload: dict, command_args: list[str]) -> None:
    expect(payload, "tmp", "python wrote this")
    version = payload.get("version")
    if (
        not isinstance(version, list)
        or len(version) != 3
        or not all(isinstance(part, int) for part in version)
    ):
        raise ValidationError("python payload version must be a three-integer list")
    expect(payload, "argv", expected_python_argv(command_args))


def validate_go(payload: dict, command_args: list[str]) -> None:
    expect(payload, "tmp", "go wrote this\n")
    go_version = payload.get("go")
    if not isinstance(go_version, str) or not go_version.startswith("go"):
        raise ValidationError("go payload go version must start with 'go'")
    targets = payload.get("targets")
    if not isinstance(targets, str) or "/" not in targets:
        raise ValidationError("go payload targets must be formatted as os/arch")
    expect(payload, "args", expected_go_args(command_args))


def expected_python_argv(command_args: list[str]) -> list[str]:
    if command_args and command_args[0] == "/workspace/python/smoke.py":
        return command_args[1:]
    return command_args


def expected_go_args(command_args: list[str]) -> list[str]:
    if (
        len(command_args) >= 2
        and command_args[0] == "run"
        and command_args[1] == "/workspace/go/smoke.go"
    ):
        return command_args[2:]
    return command_args


def expect(payload: dict, key: str, expected: object) -> None:
    actual = payload.get(key)
    if actual != expected:
        raise ValidationError(f"expected {key} {expected!r}, got {actual!r}")


def fail(message: str) -> int:
    print(f"validate_output.py: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
