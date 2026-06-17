const WEBC_MAGIC = new Uint8Array([0x00, 0x77, 0x65, 0x62, 0x63]);
const WEBC_HEADER_LENGTH = 8;
const WEBC_VERSION_OFFSET = 5;
const WEBC_VERSION_LENGTH = 3;
const WEBC_V2 = "002";
const WEBC_V3 = "003";
const WEBC_TAG_MANIFEST = 1;
const WEBC_TAG_INDEX = 2;
const WEBC_TAG_ATOMS = 3;
const WEBC_TAG_VOLUME = 4;
const WEBC_V3_SECTION_HASH_BYTES = 32;
const WEBC_TAG_DIRECTORY = 30;
const WEBC_TAG_FILE = 31;
const U64_BYTES = 8;
const SHA256_BYTES = 32;
const WEBC_V3_TIMESTAMPS_BYTES = 24;
const MAX_CBOR_DEPTH = 128;

export const SUPPORTED_WEBC_METADATA_VERSIONS = new Set([WEBC_V2, WEBC_V3]);

const textDecoder = new TextDecoder();

export class WebcMetadataError extends Error {
  constructor(message) {
    super(message);
    this.name = "WebcMetadataError";
  }
}

export function detectWebcVersion(bytes) {
  const data = toUint8Array(bytes);
  if (!startsWithBytes(data, WEBC_MAGIC) || data.byteLength < WEBC_HEADER_LENGTH) {
    return null;
  }
  return textDecoder.decode(
    data.subarray(WEBC_VERSION_OFFSET, WEBC_VERSION_OFFSET + WEBC_VERSION_LENGTH),
  );
}

export function extractWebcPackageMetadata(bytes) {
  const data = toUint8Array(bytes);
  const version = detectWebcVersion(data);
  if (!version) {
    throw new WebcMetadataError("missing WebC version header");
  }
  if (!SUPPORTED_WEBC_METADATA_VERSIONS.has(version)) {
    throw new WebcMetadataError(`unsupported WebC version ${version}`);
  }
  const sections = readWebcSections(data, version);
  if (!sections.manifest) {
    throw new WebcMetadataError("missing WebC manifest section");
  }
  const manifest = decodeCbor(sections.manifest.payload);
  const metadata = normalizeWebcManifest(manifest, { version });
  const artifacts = extractWebcArtifacts(sections, metadata, { version });
  return {
    ...metadata,
    webcArtifacts: artifacts,
  };
}

function readWebcSections(data, version) {
  const sections = {
    atoms: null,
    manifest: null,
    volumes: {},
  };
  let offset = WEBC_HEADER_LENGTH;
  while (offset < data.byteLength) {
    const sectionOffset = offset;
    const tag = readByte(data, offset);
    offset += 1;

    let hash = null;
    if (version === WEBC_V3 && tag !== WEBC_TAG_INDEX) {
      requireAvailable(data, offset, WEBC_V3_SECTION_HASH_BYTES);
      hash = data.subarray(offset, offset + WEBC_V3_SECTION_HASH_BYTES);
      offset += WEBC_V3_SECTION_HASH_BYTES;
    }

    const length = readUint64Le(data, offset);
    offset += U64_BYTES;
    requireAvailable(data, offset, length);
    const payloadOffset = offset;
    const payload = data.subarray(offset, offset + length);
    const section = {
      hash,
      length,
      payload,
      payloadOffset,
      sectionOffset,
      tag,
    };

    if (tag === WEBC_TAG_MANIFEST) {
      sections.manifest = section;
    } else if (tag === WEBC_TAG_ATOMS) {
      sections.atoms = parseAtomsSection(section, { version });
    } else if (tag === WEBC_TAG_VOLUME) {
      const volume = parseVolumeSection(section, { version });
      sections.volumes[volume.name] = volume;
    }
    offset += length;
  }
  return sections;
}

function normalizeWebcManifest(manifest, options) {
  const root = objectValue(manifest, "WebC manifest must be a map");
  const commandMap = objectValue(
    root.commands,
    "WebC manifest commands must be a map",
  );
  const commands = Object.keys(commandMap);
  if (commands.length === 0) {
    throw new WebcMetadataError("WebC manifest commands must be a non-empty map");
  }

  const entrypoint = optionalString(root.entrypoint);
  const defaultCommand = entrypoint && commands.includes(entrypoint) ? entrypoint : commands[0];
  const packageAnnotations = optionalObject(root.package) ?? {};
  const packageInfo = normalizePackageAnnotations(packageAnnotations);
  const filesystem = normalizeFilesystemMappings(packageAnnotations.fs);

  return {
    atoms: normalizeAtoms(root.atoms),
    commandMetadata: normalizeCommandMetadata(commandMap),
    commands,
    defaultCommand,
    entrypoint: defaultCommand,
    filesystem,
    manifest: root,
    package: packageInfo,
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    version: options.version,
  };
}

function normalizeCommandMetadata(commandMap) {
  const metadata = {};
  for (const [name, value] of Object.entries(commandMap)) {
    const command = objectValue(value, `WebC command ${name} must be a map`);
    const annotations = optionalObject(command.annotations) ?? {};
    const atom = optionalObject(annotations.atom);
    const wasi = optionalObject(annotations.wasi);
    metadata[name] = {
      annotations,
      atom: optionalString(atom?.name) ?? optionalString(wasi?.atom) ?? null,
      cwd: optionalString(field(wasi, "cwd")) ?? null,
      dependency:
        optionalString(atom?.dependency) ?? optionalString(field(wasi, "package")) ?? null,
      env: optionalStringList(field(wasi, "env")),
      execName:
        optionalString(field(wasi, "exec_name", "exec-name")) ??
        optionalString(field(wasi, "execName")) ??
        null,
      mainArgs: optionalStringList(field(wasi, "main_args", "main-args")),
      runner: optionalString(command.runner) ?? null,
    };
  }
  return metadata;
}

function normalizePackageAnnotations(packageAnnotations) {
  const wapm = optionalObject(packageAnnotations.wapm) ?? {};
  return {
    description: optionalString(wapm.description) ?? null,
    homepage: optionalString(wapm.homepage) ?? null,
    license: optionalString(wapm.license) ?? null,
    name: optionalString(wapm.name) ?? null,
    private: wapm.private === true,
    repository: optionalString(wapm.repository) ?? null,
    version: optionalString(wapm.version) ?? null,
  };
}

function normalizeAtoms(value) {
  const atoms = optionalObject(value) ?? {};
  const metadata = {};
  for (const [name, atomValue] of Object.entries(atoms)) {
    const atom = objectValue(atomValue, `WebC atom ${name} must be a map`);
    metadata[name] = {
      annotations: optionalObject(atom.annotations) ?? {},
      kind: optionalString(atom.kind) ?? null,
      signature: optionalString(atom.signature) ?? null,
    };
  }
  return metadata;
}

function normalizeFilesystemMappings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const mapping = objectValue(item, "WebC filesystem mapping must be a map");
    return {
      from: optionalString(mapping.from) ?? null,
      hostPath:
        optionalString(field(mapping, "host_path", "host-path", "original_path")) ??
        optionalString(field(mapping, "original-path")) ??
        null,
      mountPath:
        optionalString(field(mapping, "mount_path", "mount-path")) ??
        nonEmptyString(null, "WebC filesystem mapping mount_path is required"),
      volumeName:
        optionalString(field(mapping, "volume_name", "volume-name")) ??
        nonEmptyString(null, "WebC filesystem mapping volume_name is required"),
    };
  });
}

function extractWebcArtifacts(sections, metadata, options) {
  const artifacts = {
    atoms: sections.atoms ?? emptyAtomArtifacts(),
    volumes: sections.volumes,
  };
  validateReferencedAtoms(metadata, artifacts.atoms);
  validateReferencedVolumes(metadata, artifacts.volumes);
  return artifacts;
}

function parseAtomsSection(section, options) {
  const volume = parseVolumePayload(section, {
    name: "atoms",
    pathPrefix: "",
    version: options.version,
  });
  return {
    files: volume.files,
    hash: sectionHashHex(section),
    payloadSpan: span(section.payloadOffset, section.length),
  };
}

function parseVolumeSection(section, options) {
  const payload = section.payload;
  let offset = 0;
  const nameLength = readUint64Le(payload, offset);
  offset += U64_BYTES;
  requireAvailable(payload, offset, nameLength);
  const name = textDecoder.decode(payload.subarray(offset, offset + nameLength));
  offset += nameLength;
  return parseVolumePayload(
    {
      ...section,
      payload: payload.subarray(offset),
      payloadOffset: section.payloadOffset + offset,
      length: section.length - offset,
    },
    {
      name,
      pathPrefix: "/",
      version: options.version,
    },
  );
}

function parseVolumePayload(section, options) {
  const payload = section.payload;
  let offset = 0;
  const headerLength = readUint64Le(payload, offset);
  offset += U64_BYTES;
  requireAvailable(payload, offset, headerLength);
  const header = payload.subarray(offset, offset + headerLength);
  offset += headerLength;
  const dataLength = readUint64Le(payload, offset);
  offset += U64_BYTES;
  requireAvailable(payload, offset, dataLength);
  const data = payload.subarray(offset, offset + dataLength);
  const dataOffset = section.payloadOffset + offset;
  const files = parseVolumeHeader(header, data, {
    dataOffset,
    pathPrefix: options.pathPrefix,
    version: options.version,
  });
  return {
    dataSpan: span(dataOffset, dataLength),
    files,
    hash: sectionHashHex(section),
    headerSpan: span(section.payloadOffset + U64_BYTES, headerLength),
    name: options.name,
    payloadSpan: span(section.payloadOffset, section.length),
  };
}

function parseVolumeHeader(header, data, options) {
  const files = {};
  parseHeaderEntry(header, 0, options.pathPrefix, files, {
    data,
    dataOffset: options.dataOffset,
    seenOffsets: new Set(),
    version: options.version,
  });
  return files;
}

function parseHeaderEntry(header, offset, path, files, options) {
  if (options.seenOffsets.has(offset)) {
    throw new WebcMetadataError("WebC volume header contains a reference loop");
  }
  options.seenOffsets.add(offset);
  requireAvailable(header, offset, 1);
  const tag = header[offset];
  let cursor = offset + 1;
  if (tag === WEBC_TAG_DIRECTORY) {
    const length = readUint64Le(header, cursor);
    cursor += U64_BYTES;
    const entriesEnd = cursor + length;
    requireAvailable(header, cursor, length);
    if (options.version === WEBC_V3) {
      cursor += WEBC_V3_TIMESTAMPS_BYTES + SHA256_BYTES;
      requireAvailable(header, cursor, 0);
    }
    while (cursor < entriesEnd) {
      const childOffset = readUint64Le(header, cursor);
      cursor += U64_BYTES;
      if (options.version === WEBC_V3) {
        cursor += SHA256_BYTES;
      }
      const nameLength = readUint64Le(header, cursor);
      cursor += U64_BYTES;
      requireAvailable(header, cursor, nameLength);
      const name = textDecoder.decode(header.subarray(cursor, cursor + nameLength));
      cursor += nameLength;
      parseHeaderEntry(header, childOffset, childPath(path, name), files, options);
    }
    if (cursor !== entriesEnd) {
      throw new WebcMetadataError("invalid WebC volume directory length");
    }
    return;
  }
  if (tag === WEBC_TAG_FILE) {
    const startOffset = readUint64Le(header, cursor);
    cursor += U64_BYTES;
    const endOffset = readUint64Le(header, cursor);
    cursor += U64_BYTES;
    requireAvailable(header, cursor, SHA256_BYTES);
    const checksum = bytesToHex(header.subarray(cursor, cursor + SHA256_BYTES));
    cursor += SHA256_BYTES;
    if (options.version === WEBC_V3) {
      cursor += WEBC_V3_TIMESTAMPS_BYTES;
      requireAvailable(header, cursor, 0);
    }
    if (startOffset > endOffset || endOffset > options.data.byteLength) {
      throw new WebcMetadataError(`invalid WebC volume file span for ${path}`);
    }
    const byteLength = endOffset - startOffset;
    files[path] = {
      byteLength,
      bytes: options.data.subarray(startOffset, endOffset),
      checksumSha256: checksum,
      span: span(options.dataOffset + startOffset, byteLength),
    };
    return;
  }
  throw new WebcMetadataError(`unsupported WebC volume header tag ${tag}`);
}

function validateReferencedAtoms(metadata, atoms) {
  for (const [commandName, command] of Object.entries(metadata.commandMetadata)) {
    if (command.atom && !atoms.files[command.atom]) {
      throw new WebcMetadataError(
        `WebC command ${commandName} references missing atom ${command.atom}`,
      );
    }
  }
}

function validateReferencedVolumes(metadata, volumes) {
  for (const mapping of metadata.filesystem) {
    if (mapping.from) {
      continue;
    }
    if (!volumes[mapping.volumeName]) {
      throw new WebcMetadataError(
        `WebC filesystem mapping references missing volume ${mapping.volumeName}`,
      );
    }
  }
}

function emptyAtomArtifacts() {
  return {
    files: {},
    hash: null,
    payloadSpan: null,
  };
}

function childPath(parent, name) {
  if (parent === "") {
    return name;
  }
  if (parent === "/") {
    return `/${name}`;
  }
  return `${parent}/${name}`;
}

function span(offset, length) {
  return { length, offset };
}

function sectionHashHex(section) {
  return section.hash ? bytesToHex(section.hash) : null;
}

function decodeCbor(bytes) {
  const reader = new CborReader(bytes);
  const value = reader.readValue(0);
  if (!reader.isDone()) {
    throw new WebcMetadataError("WebC manifest CBOR has trailing data");
  }
  return value;
}

class CborReader {
  constructor(bytes) {
    this.bytes = toUint8Array(bytes);
    this.offset = 0;
  }

  isDone() {
    return this.offset === this.bytes.byteLength;
  }

  readValue(depth) {
    if (depth > MAX_CBOR_DEPTH) {
      throw new WebcMetadataError("WebC manifest CBOR nesting is too deep");
    }
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    switch (major) {
      case 0:
        return this.readArgument(additional);
      case 1:
        return -1 - this.readArgument(additional);
      case 2:
        return this.readBytes(this.readArgument(additional));
      case 3:
        return textDecoder.decode(this.readBytes(this.readArgument(additional)));
      case 4:
        return this.readArray(this.readArgument(additional), depth);
      case 5:
        return this.readMap(this.readArgument(additional), depth);
      case 6:
        return {
          tag: this.readArgument(additional),
          value: this.readValue(depth + 1),
        };
      case 7:
        return this.readSimple(additional);
      default:
        throw new WebcMetadataError("unsupported WebC manifest CBOR value");
    }
  }

  readArray(length, depth) {
    const items = [];
    for (let index = 0; index < length; index += 1) {
      items.push(this.readValue(depth + 1));
    }
    return items;
  }

  readMap(length, depth) {
    const value = {};
    for (let index = 0; index < length; index += 1) {
      const key = this.readValue(depth + 1);
      value[typeof key === "string" ? key : String(key)] = this.readValue(depth + 1);
    }
    return value;
  }

  readSimple(additional) {
    switch (additional) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 24:
        return this.readByte();
      case 25:
        return decodeFloat16(this.readUint16());
      case 26:
        return bytesDataView(this.readBytes(4)).getFloat32(0, false);
      case 27:
        return bytesDataView(this.readBytes(8)).getFloat64(0, false);
      default:
        throw new WebcMetadataError("unsupported WebC manifest CBOR simple value");
    }
  }

  readArgument(additional) {
    if (additional < 24) {
      return additional;
    }
    switch (additional) {
      case 24:
        return this.readByte();
      case 25:
        return this.readUint16();
      case 26:
        return this.readUint32();
      case 27:
        return this.readUint64();
      default:
        throw new WebcMetadataError("unsupported WebC manifest CBOR length");
    }
  }

  readByte() {
    requireAvailable(this.bytes, this.offset, 1);
    return this.bytes[this.offset++];
  }

  readBytes(length) {
    requireAvailable(this.bytes, this.offset, length);
    const bytes = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  readUint16() {
    const bytes = this.readBytes(2);
    return (bytes[0] << 8) | bytes[1];
  }

  readUint32() {
    const bytes = this.readBytes(4);
    return (
      bytes[0] * 2 ** 24 +
      bytes[1] * 2 ** 16 +
      bytes[2] * 2 ** 8 +
      bytes[3]
    );
  }

  readUint64() {
    return uint64BigIntToNumber(this.readBytes(8), false);
  }
}

function decodeFloat16(value) {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 2 ** 10);
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 2 ** 10);
}

function bytesDataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readByte(bytes, offset) {
  requireAvailable(bytes, offset, 1);
  return bytes[offset];
}

function readUint64Le(bytes, offset) {
  requireAvailable(bytes, offset, U64_BYTES);
  return uint64BigIntToNumber(bytes.subarray(offset, offset + U64_BYTES), true);
}

function uint64BigIntToNumber(bytes, littleEndian) {
  let value = 0n;
  for (let index = 0; index < U64_BYTES; index += 1) {
    const byte = BigInt(bytes[littleEndian ? U64_BYTES - 1 - index : index]);
    value = (value << 8n) | byte;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WebcMetadataError("WebC manifest length exceeds JavaScript limits");
  }
  return Number(value);
}

function requireAvailable(bytes, offset, length) {
  if (length < 0 || offset + length > bytes.byteLength) {
    throw new WebcMetadataError("truncated WebC metadata");
  }
}

function field(value, ...names) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  for (const name of names) {
    if (Object.hasOwn(value, name)) {
      return value[name];
    }
  }
  return undefined;
}

function objectValue(value, message) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  throw new WebcMetadataError(message);
}

function optionalObject(value) {
  if (value == null) {
    return null;
  }
  return objectValue(value, "WebC manifest field must be a map");
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonEmptyString(value, message) {
  const text = optionalString(value);
  if (!text) {
    throw new WebcMetadataError(message);
  }
  return text;
}

function optionalStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string");
}

function startsWithBytes(bytes, prefix) {
  if (bytes.byteLength < prefix.byteLength) {
    return false;
  }
  return prefix.every((byte, index) => bytes[index] === byte);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new WebcMetadataError("WebC metadata bytes must be a byte buffer");
}
