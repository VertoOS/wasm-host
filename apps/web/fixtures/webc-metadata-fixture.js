const WEBC_TAG_MANIFEST = 1;
const WEBC_TAG_INDEX = 2;
const WEBC_TAG_ATOMS = 3;
const WEBC_TAG_VOLUME = 4;
const WEBC_TAG_DIRECTORY = 30;
const WEBC_TAG_FILE = 31;
const TIMESTAMPS_BYTES = 24;
const SHA256_BYTES = 32;
const textEncoder = new TextEncoder();

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

export function webcWasiCommandManifest(options = {}) {
  const command = options.command ?? "codex";
  const atom = options.atom ?? `${command}-atom`;
  const execName = options.execName ?? command;
  return {
    package: {
      wapm: {
        name: options.packageName ?? "codex/browser-smoke",
        version: options.packageVersion ?? "0.0.0",
      },
    },
    atoms: {
      [atom]: {
        kind: "https://webc.org/kind/wasm",
      },
    },
    commands: {
      [command]: {
        annotations: {
          atom: {
            name: atom,
          },
          wasi: {
            atom,
            cwd: options.cwd,
            env: options.env,
            exec_name: execName,
            main_args: options.mainArgs,
          },
        },
        runner: "https://webc.org/runner/wasi",
      },
    },
    entrypoint: command,
  };
}

export function webcV2Bytes(manifest, options = {}) {
  const manifestBytes = cborEncode(manifest);
  const sections = [
    webcHeader("002"),
    webcV2Section(WEBC_TAG_INDEX, cborEncode({})),
    webcV2Section(WEBC_TAG_MANIFEST, manifestBytes),
  ];
  if (options.atoms !== null) {
    sections.push(webcV2Section(WEBC_TAG_ATOMS, atomsPayload(options.atoms)));
  }
  for (const [name, tree] of Object.entries(options.volumes ?? defaultVolumes())) {
    sections.push(webcV2Section(WEBC_TAG_VOLUME, volumePayload(name, tree)));
  }
  return concatByteArrays(sections);
}

export function webcV3Bytes(manifest, options = {}) {
  const manifestBytes = cborEncode(manifest);
  const sections = [
    webcHeader("003"),
    webcV3Section(WEBC_TAG_INDEX, cborEncode({})),
    webcV3Section(WEBC_TAG_MANIFEST, manifestBytes),
  ];
  if (options.atoms !== null) {
    sections.push(webcV3Section(WEBC_TAG_ATOMS, atomsPayload(options.atoms, "003")));
  }
  for (const [name, tree] of Object.entries(options.volumes ?? defaultVolumes())) {
    sections.push(webcV3Section(WEBC_TAG_VOLUME, volumePayload(name, tree, "003")));
  }
  return concatByteArrays(sections);
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

function atomsPayload(input, version = "002") {
  const { data, header } = volumeParts(input ?? defaultAtoms(), version);
  return concatByteArrays([uint64Le(header.byteLength), header, uint64Le(data.byteLength), data]);
}

function volumePayload(name, tree, version = "002") {
  const nameBytes = textEncoder.encode(name);
  return concatByteArrays([
    uint64Le(nameBytes.byteLength),
    nameBytes,
    atomsPayload(tree, version),
  ]);
}

function volumeParts(tree, version) {
  const state = {
    data: [],
    header: [],
    version,
  };
  serializeDirectory(tree, state);
  return {
    data: new Uint8Array(state.data),
    header: new Uint8Array(state.header),
  };
}

function serializeDirectory(tree, state) {
  const start = state.header.length;
  state.header.push(WEBC_TAG_DIRECTORY);
  const lengthOffset = state.header.length;
  writeU64(state.header, 0);
  const entriesStart = state.header.length;
  if (state.version === "003") {
    writeZeros(state.header, TIMESTAMPS_BYTES + SHA256_BYTES);
  }
  const entries = Object.entries(tree).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const patches = [];
  for (const [name, value] of entries) {
    const nameBytes = textEncoder.encode(name);
    const offset = state.header.length;
    writeU64(state.header, 0);
    if (state.version === "003") {
      writeZeros(state.header, SHA256_BYTES);
    }
    writeU64(state.header, nameBytes.byteLength);
    writeBytes(state.header, nameBytes);
    patches.push({ offset, value });
  }
  patchU64(state.header, lengthOffset, state.header.length - entriesStart);
  for (const patch of patches) {
    patchU64(state.header, patch.offset, serializeEntry(patch.value, state));
  }
  return start;
}

function serializeEntry(value, state) {
  if (isDirectoryTree(value)) {
    return serializeDirectory(value, state);
  }
  return serializeFile(value, state);
}

function serializeFile(value, state) {
  const bytes = value instanceof Uint8Array ? value : textEncoder.encode(String(value));
  const dataStart = state.data.length;
  writeBytes(state.data, bytes);
  const dataEnd = state.data.length;
  const start = state.header.length;
  state.header.push(WEBC_TAG_FILE);
  writeU64(state.header, dataStart);
  writeU64(state.header, dataEnd);
  writeZeros(state.header, SHA256_BYTES);
  if (state.version === "003") {
    writeZeros(state.header, TIMESTAMPS_BYTES);
  }
  return start;
}

function isDirectoryTree(value) {
  return value && typeof value === "object" && !(value instanceof Uint8Array);
}

function defaultAtoms() {
  return {
    "bash-atom": wasmBytes("bash"),
    coreutils: wasmBytes("coreutils"),
  };
}

function defaultVolumes() {
  return {
    "/rootfs": {
      rootfs: {
        bin: {
          bash: "#!/bin/bash\n",
          ls: "coreutils ls\n",
        },
        etc: {
          profile: "PATH=/bin\n",
        },
      },
    },
  };
}

function wasmBytes(label) {
  return concatByteArrays([
    new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    textEncoder.encode(label),
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

function writeU64(buffer, value) {
  writeBytes(buffer, uint64Le(value));
}

function patchU64(buffer, offset, value) {
  const bytes = uint64Le(value);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    buffer[offset + index] = bytes[index];
  }
}

function writeZeros(buffer, length) {
  for (let index = 0; index < length; index += 1) {
    buffer.push(0);
  }
}

function writeBytes(buffer, bytes) {
  for (const byte of bytes) {
    buffer.push(byte);
  }
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
