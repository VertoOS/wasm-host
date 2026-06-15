from __future__ import annotations

import base64
import ctypes
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional, Sequence

WASM_HOST_STATUS_OK = 0
WASM_HOST_STATUS_ERROR = 1


class WasmHostError(RuntimeError):
    pass


@dataclass(frozen=True)
class Alias:
    alias: str
    command: str

    def to_json(self) -> dict:
        return {"alias": self.alias, "command": self.command}


@dataclass(frozen=True)
class Mount:
    source: str
    target: str
    read_only: bool = True

    def to_json(self) -> dict:
        return {
            "source": self.source,
            "target": self.target,
            "read_only": self.read_only,
        }


@dataclass(frozen=True)
class RunOptions:
    webc: str
    command: Sequence[str]
    profile: str = "browser-strict"
    package: Optional[str] = None
    aliases: Sequence[Alias] = field(default_factory=tuple)
    mounts: Sequence[Mount] = field(default_factory=tuple)
    cwd: str = "/work"
    env: Mapping[str, str] = field(default_factory=dict)
    stdin: Optional[bytes] = None
    output_limit: Optional[int] = None
    timeout_seconds: Optional[float] = None

    def to_json(self) -> str:
        payload = {
            "webc": self.webc,
            "command": list(self.command),
            "profile": self.profile,
            "cwd": self.cwd,
            "env": dict(self.env),
        }
        if self.package is not None:
            payload["package"] = self.package
        if self.aliases:
            payload["aliases"] = [alias.to_json() for alias in self.aliases]
        if self.mounts:
            payload["mounts"] = [mount.to_json() for mount in self.mounts]
        if self.stdin is not None:
            payload["stdin_base64"] = base64.b64encode(self.stdin).decode("ascii")
        if self.output_limit is not None:
            payload["output_limit"] = self.output_limit
        if self.timeout_seconds is not None:
            payload["timeout_seconds"] = self.timeout_seconds
        return json.dumps(payload, separators=(",", ":"), sort_keys=True)


@dataclass(frozen=True)
class Result:
    status: int
    returncode: int
    stdout: bytes
    stderr: bytes
    error: bytes

    @property
    def ok(self) -> bool:
        return self.status == WASM_HOST_STATUS_OK

    @property
    def error_text(self) -> str:
        return self.error.decode("utf-8", errors="replace")


class HostLibrary:
    def __init__(self, path: os.PathLike[str] | str):
        self.path = Path(path)
        self._lib = ctypes.CDLL(str(self.path))
        self._configure()

    def _configure(self) -> None:
        self._lib.wasm_host_version.argtypes = []
        self._lib.wasm_host_version.restype = ctypes.c_char_p

        self._lib.wasm_host_run_json.argtypes = [ctypes.c_char_p]
        self._lib.wasm_host_run_json.restype = ctypes.c_void_p

        result_argtypes = [ctypes.c_void_p]
        self._lib.wasm_host_result_status.argtypes = result_argtypes
        self._lib.wasm_host_result_status.restype = ctypes.c_int32
        self._lib.wasm_host_result_returncode.argtypes = result_argtypes
        self._lib.wasm_host_result_returncode.restype = ctypes.c_int32

        for name in (
            "wasm_host_result_stdout_ptr",
            "wasm_host_result_stderr_ptr",
            "wasm_host_result_error_ptr",
        ):
            function = getattr(self._lib, name)
            function.argtypes = result_argtypes
            function.restype = ctypes.c_void_p

        for name in (
            "wasm_host_result_stdout_len",
            "wasm_host_result_stderr_len",
            "wasm_host_result_error_len",
        ):
            function = getattr(self._lib, name)
            function.argtypes = result_argtypes
            function.restype = ctypes.c_size_t

        self._lib.wasm_host_result_free.argtypes = [ctypes.c_void_p]
        self._lib.wasm_host_result_free.restype = None

    def version(self) -> str:
        value = self._lib.wasm_host_version()
        if value is None:
            raise WasmHostError("wasm_host_version returned null")
        return value.decode("utf-8")

    def run_json(self, options_json: str) -> Result:
        raw_result = self._lib.wasm_host_run_json(options_json.encode("utf-8"))
        if not raw_result:
            raise WasmHostError("wasm_host_run_json returned null")
        try:
            return Result(
                status=int(self._lib.wasm_host_result_status(raw_result)),
                returncode=int(self._lib.wasm_host_result_returncode(raw_result)),
                stdout=self._bytes(raw_result, "stdout"),
                stderr=self._bytes(raw_result, "stderr"),
                error=self._bytes(raw_result, "error"),
            )
        finally:
            self._lib.wasm_host_result_free(raw_result)

    def _bytes(self, raw_result: int, stream: str) -> bytes:
        ptr = getattr(self._lib, f"wasm_host_result_{stream}_ptr")(raw_result)
        length = getattr(self._lib, f"wasm_host_result_{stream}_len")(raw_result)
        if not ptr or length == 0:
            return b""
        return ctypes.string_at(ptr, length)


def load_library(path: Optional[os.PathLike[str] | str] = None) -> HostLibrary:
    candidate = path or os.environ.get("WASM_HOST_LIBRARY")
    if candidate is None:
        raise WasmHostError("set WASM_HOST_LIBRARY or pass a library path")
    return HostLibrary(candidate)


def run(options: RunOptions, library: Optional[HostLibrary] = None) -> Result:
    host = library or load_library()
    return host.run_json(options.to_json())
