export function webcCommandManifest() {
  return {
    package: {
      fs: [
        {
          host_path: "rootfs",
          mount_path: "/",
          volume_name: "/rootfs",
        },
      ],
      wapm: {
        name: "wasmer/bash",
        version: "1.0.25",
      },
    },
    atoms: {
      "bash-atom": {
        kind: "https://webc.org/kind/wasm",
        signature: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      coreutils: {
        kind: "https://webc.org/kind/wasm",
        signature: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      },
    },
    commands: {
      bash: {
        runner: "https://webc.org/runner/wasi",
        annotations: {
          atom: {
            name: "bash-atom",
          },
          wasi: {
            atom: "bash-atom",
            cwd: "/workspace",
            env: ["PATH=/bin"],
            exec_name: "bash",
            main_args: ["-l"],
          },
        },
      },
      ls: {
        runner: "https://webc.org/runner/wasi",
        annotations: {
          atom: {
            name: "coreutils",
          },
          wasi: {
            atom: "coreutils",
            exec_name: "ls",
          },
        },
      },
    },
    entrypoint: "bash",
  };
}

export function webcV2Bytes(manifest) {
  const manifestBytes = cborEncode(manifest);
  return concatByteArrays([
    webcHeader("002"),
    webcV2Section(2, cborEncode({})),
    webcV2Section(1, manifestBytes),
  ]);
}

export function webcV3Bytes(manifest) {
  const manifestBytes = cborEncode(manifest);
  return concatByteArrays([
    webcHeader("003"),
    webcV3Section(2, cborEncode({})),
    webcV3Section(1, manifestBytes),
  ]);
}

function webcHeader(version) {
  return concatByteArrays([
    new Uint8Array([0x00, 0x77, 0x65, 0x62, 0x63]),
    new TextEncoder().encode(version),
  ]);
}

function webcV2Section(tag, payload) {
  return concatByteArrays([
    new Uint8Array([tag]),
    uint64Le(payload.byteLength),
    payload,
  ]);
}

function webcV3Section(tag, payload) {
  return concatByteArrays([
    new Uint8Array([tag]),
    tag === 2 ? new Uint8Array(0) : new Uint8Array(32),
    uint64Le(payload.byteLength),
    payload,
  ]);
}

function cborEncode(value) {
  if (value == null) {
    return new Uint8Array([0xf6]);
  }
  if (typeof value === "boolean") {
    return new Uint8Array([value ? 0xf5 : 0xf4]);
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return cborInteger(value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concatByteArrays([cborLength(3, bytes.byteLength), bytes]);
  }
  if (value instanceof Uint8Array) {
    return concatByteArrays([cborLength(2, value.byteLength), value]);
  }
  if (Array.isArray(value)) {
    return concatByteArrays([
      cborLength(4, value.length),
      ...value.map((item) => cborEncode(item)),
    ]);
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return concatByteArrays([
    cborLength(5, entries.length),
    ...entries.flatMap(([key, item]) => [cborEncode(key), cborEncode(item)]),
  ]);
}

function cborInteger(value) {
  if (value >= 0) {
    return cborLength(0, value);
  }
  return cborLength(1, -1 - value);
}

function cborLength(major, length) {
  const prefix = major << 5;
  if (length < 24) {
    return new Uint8Array([prefix | length]);
  }
  if (length < 0x100) {
    return new Uint8Array([prefix | 24, length]);
  }
  if (length < 0x10000) {
    return new Uint8Array([prefix | 25, length >> 8, length & 0xff]);
  }
  return new Uint8Array([
    prefix | 26,
    (length >> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ]);
}

function uint64Le(value) {
  let remaining = BigInt(value);
  const bytes = new Uint8Array(8);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function concatByteArrays(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
