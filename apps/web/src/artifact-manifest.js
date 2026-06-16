const SUPPORTED_SCHEMA_VERSION = 1;
const RAW_WASI_PACKAGE_NAME = "codex";
const RAW_WASI_ARTIFACT_KIND = "wasi-module";
const RAW_WASI_COMMAND = "codex";
const RAW_WASI_ENTRYPOINT = "_start";
const SUPPORTED_WASI = "preview1";
const SUPPORTED_STDOUT_PREFIX = "codex-cli ";
const SUPPORTED_EXPECTED_STDERR = "";
const CODEX_BROWSER_PACKAGE_NAME = "codex-browser";
const CODEX_BROWSER_ARTIFACT_KIND = "codex-browser";
const CODEX_BROWSER_COMMAND = "build-request";
const CODEX_BROWSER_ENTRYPOINT = "codex_build_request";
const CODEX_BROWSER_RUNTIME = "wasm32-unknown-unknown";

const COMMON_REQUIRED_FIELDS = [
  "schemaVersion",
  "packageName",
  "artifactKind",
  "artifactPath",
  "artifactSizeBytes",
  "artifactSha256",
  "command",
  "entrypoint",
  "args",
  "expectedExitCode",
  "requiresNetwork",
  "requiresWorkspace",
  "requiresHostCommand",
  "requiresTerminal",
];

const RAW_WASI_REQUIRED_FIELDS = [
  ...COMMON_REQUIRED_FIELDS,
  "stdoutPrefix",
  "expectedStderr",
  "wasi",
];

const CODEX_BROWSER_REQUIRED_FIELDS = [
  ...COMMON_REQUIRED_FIELDS,
  "runtime",
];

export class ArtifactManifestError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = "ArtifactManifestError";
    this.kind = kind;
    this.stage = "artifact_manifest";
    this.details = details;
  }
}

export function parseArtifactManifestJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ArtifactManifestError(
      "invalid_manifest",
      "artifact manifest JSON is invalid",
      { cause: error.message },
    );
  }
}

export function validateCodexArtifactManifest(manifest) {
  validateObject(manifest);
  validateRequiredFields(manifest, COMMON_REQUIRED_FIELDS);
  validateExact(manifest.schemaVersion, SUPPORTED_SCHEMA_VERSION, {
    field: "schemaVersion",
    kind: "invalid_manifest",
  });
  validateArtifactPath(manifest.artifactPath);
  validateArtifactSize(manifest.artifactSizeBytes);
  normalizeSha256(manifest.artifactSha256);
  validateCapabilityFlag(manifest, "requiresNetwork", "requires_network");
  validateCapabilityFlag(manifest, "requiresWorkspace", "requires_workspace");
  validateCapabilityFlag(
    manifest,
    "requiresHostCommand",
    "requires_host_command",
  );
  validateCapabilityFlag(manifest, "requiresTerminal", "requires_terminal");
  switch (manifest.artifactKind) {
    case RAW_WASI_ARTIFACT_KIND:
      validateRawWasiCodexManifest(manifest);
      break;
    case CODEX_BROWSER_ARTIFACT_KIND:
      validateCodexBrowserRequestManifest(manifest);
      break;
    default:
      validateExact(manifest.artifactKind, RAW_WASI_ARTIFACT_KIND, {
        field: "artifactKind",
        reason: "artifact_kind",
      });
  }
  return manifest;
}

export function normalizeCodexBrowserRunFixture(manifest) {
  validateCodexArtifactManifest(manifest);
  if (manifest.artifactKind === CODEX_BROWSER_ARTIFACT_KIND) {
    return normalizeCodexBrowserRequestFixture(manifest);
  }
  return normalizeRawWasiCodexFixture(manifest);
}

function normalizeRawWasiCodexFixture(manifest) {
  const artifactSha256 = normalizeSha256(manifest.artifactSha256);
  const packageId = manifest.packageName;
  const command = manifest.command;

  return {
    type: "codex-browser-run-fixture",
    id: `${packageId}-version-smoke`,
    artifact: {
      kind: manifest.artifactKind,
      path: manifest.artifactPath,
      sha256: artifactSha256,
      sizeBytes: manifest.artifactSizeBytes,
    },
    commandLoad: {
      type: "command.load",
      id: `load-${packageId}`,
      package: {
        artifactKind: manifest.artifactKind,
        commands: [command],
        defaultCommand: command,
        entrypoint: manifest.entrypoint,
        executorType: manifest.artifactKind,
        id: packageId,
        metadata: manifestMetadata(manifest, artifactSha256),
        type: manifest.artifactKind,
      },
    },
    commandRun: {
      type: "command.run",
      id: `run-${packageId}-version`,
      packageId,
      command,
      args: [...manifest.args],
      env: {},
      cwd: "/workspace",
      stdinOpen: false,
    },
    expected: {
      exitCode: manifest.expectedExitCode,
      stdoutPrefix: manifest.stdoutPrefix,
      stderr: manifest.expectedStderr,
    },
    requirements: {
      hostCommand: manifest.requiresHostCommand,
      network: manifest.requiresNetwork,
      terminal: manifest.requiresTerminal,
      workspace: manifest.requiresWorkspace,
    },
    wasi: {
      imports: ["wasi_snapshot_preview1"],
      preview: manifest.wasi,
    },
  };
}

function normalizeCodexBrowserRequestFixture(manifest) {
  const artifactSha256 = normalizeSha256(manifest.artifactSha256);
  const packageId = manifest.packageName;
  const command = manifest.command;
  const [prompt, model] = manifest.args;

  return {
    type: "codex-browser-request-builder-fixture",
    id: `${packageId}-request-builder`,
    artifact: {
      kind: manifest.artifactKind,
      path: manifest.artifactPath,
      sha256: artifactSha256,
      sizeBytes: manifest.artifactSizeBytes,
    },
    commandLoad: {
      type: "command.load",
      id: `load-${packageId}`,
      package: {
        artifactKind: manifest.artifactKind,
        commands: [command],
        defaultCommand: command,
        entrypoint: manifest.entrypoint,
        executorType: manifest.artifactKind,
        id: packageId,
        metadata: manifestMetadata(manifest, artifactSha256),
        type: manifest.artifactKind,
      },
    },
    commandRun: {
      type: "command.run",
      id: `run-${packageId}-request-builder`,
      packageId,
      command,
      args: [...manifest.args],
      env: {},
      cwd: "/workspace",
      stdinOpen: false,
    },
    expected: {
      exitCode: manifest.expectedExitCode,
      model,
      prompt,
      runtime: manifest.runtime,
    },
    requirements: {
      hostCommand: manifest.requiresHostCommand,
      network: manifest.requiresNetwork,
      terminal: manifest.requiresTerminal,
      workspace: manifest.requiresWorkspace,
    },
  };
}

export async function fetchCodexArtifactBytes(manifest, options = {}) {
  const fixture = normalizeCodexBrowserRunFixture(manifest);
  const fetchImpl =
    "fetchImpl" in options ? options.fetchImpl : defaultFetchImpl();
  if (typeof fetchImpl !== "function") {
    throw new ArtifactManifestError(
      "artifact_fetch_failed",
      "Fetch API is unavailable for artifact loading",
    );
  }

  const artifactUrl = artifactUrlFromPath(
    fixture.artifact.path,
    options.baseUrl,
  );
  let response;
  try {
    response = await fetchImpl(artifactUrl, {
      credentials: options.credentials ?? "same-origin",
      method: "GET",
      signal: options.signal,
    });
  } catch (error) {
    throw new ArtifactManifestError(
      "artifact_fetch_failed",
      `artifact fetch failed for ${artifactUrl}`,
      { cause: error.message },
    );
  }
  if (!response?.ok) {
    throw new ArtifactManifestError(
      "artifact_fetch_failed",
      `artifact fetch failed for ${artifactUrl}`,
      { status: response?.status ?? null },
    );
  }

  const bytes = await responseBytes(response, fixture.artifact.sizeBytes);
  await verifyCodexArtifactBytes(bytes, fixture.artifact);
  return {
    artifactUrl,
    bytes,
    fixture: fixtureWithArtifactBytes(fixture, bytes),
  };
}

export async function verifyCodexArtifactBytes(bytes, artifact) {
  const data = toUint8Array(bytes);
  validateArtifactSize(artifact?.sizeBytes);
  const expectedSha256 = normalizeSha256(artifact?.sha256);
  if (data.byteLength !== artifact.sizeBytes) {
    throw new ArtifactManifestError(
      "artifact_size_mismatch",
      `artifact size mismatch: expected ${artifact.sizeBytes}, got ${data.byteLength}`,
      { actual: data.byteLength, expected: artifact.sizeBytes },
    );
  }
  const actualSha256 = await sha256Hex(data);
  if (actualSha256 !== expectedSha256) {
    throw new ArtifactManifestError(
      "artifact_hash_mismatch",
      "artifact sha256 mismatch",
      { actual: actualSha256, expected: expectedSha256 },
    );
  }
}

function validateObject(manifest) {
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ArtifactManifestError(
      "invalid_manifest",
      "artifact manifest must be an object",
    );
  }
}

function defaultFetchImpl() {
  return typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;
}

function validateRequiredFields(manifest, fields) {
  for (const field of fields) {
    if (!(field in manifest)) {
      throw new ArtifactManifestError(
        "invalid_manifest",
        `artifact manifest is missing ${field}`,
        { field },
      );
    }
  }
}

function validateRawWasiCodexManifest(manifest) {
  validateRequiredFields(manifest, RAW_WASI_REQUIRED_FIELDS);
  validateExact(manifest.packageName, RAW_WASI_PACKAGE_NAME, {
    field: "packageName",
    reason: "package_name",
  });
  validateExact(manifest.command, RAW_WASI_COMMAND, {
    field: "command",
    reason: "command",
  });
  validateExact(manifest.entrypoint, RAW_WASI_ENTRYPOINT, {
    field: "entrypoint",
    reason: "entrypoint",
  });
  validateExact(manifest.wasi, SUPPORTED_WASI, {
    field: "wasi",
    reason: "wasi",
  });
  validateVersionSmoke(manifest);
}

function validateCodexBrowserRequestManifest(manifest) {
  validateRequiredFields(manifest, CODEX_BROWSER_REQUIRED_FIELDS);
  validateExact(manifest.packageName, CODEX_BROWSER_PACKAGE_NAME, {
    field: "packageName",
    reason: "package_name",
  });
  validateExact(manifest.command, CODEX_BROWSER_COMMAND, {
    field: "command",
    reason: "command",
  });
  validateExact(manifest.entrypoint, CODEX_BROWSER_ENTRYPOINT, {
    field: "entrypoint",
    reason: "entrypoint",
  });
  validateExact(manifest.runtime, CODEX_BROWSER_RUNTIME, {
    field: "runtime",
    reason: "runtime",
  });
  validateRequestBuilderArgs(manifest);
  validateExact(manifest.expectedExitCode, 0, {
    field: "expectedExitCode",
    reason: "expected_exit_code",
  });
}

function validateExact(value, expected, options = {}) {
  if (value === expected) {
    return;
  }
  const kind = options.kind ?? "unsupported";
  throw new ArtifactManifestError(
    kind,
    `unsupported artifact manifest field: ${options.field}`,
    {
      actual: value,
      expected,
      field: options.field,
      reason: options.reason ?? options.field,
    },
  );
}

function validateArtifactPath(value) {
  const text = nonEmptyString(value, "artifactPath must be a non-empty string");
  if (text.includes("\0")) {
    throw new ArtifactManifestError(
      "invalid_manifest",
      "artifactPath must not contain NUL",
      { field: "artifactPath" },
    );
  }
}

function validateArtifactSize(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArtifactManifestError(
      "invalid_manifest",
      "artifactSizeBytes must be a positive safe integer",
      { field: "artifactSizeBytes" },
    );
  }
}

function validateCapabilityFlag(manifest, field, reason) {
  if (manifest[field] === false) {
    return;
  }
  throw new ArtifactManifestError(
    "unsupported",
    `${field} must be false for the interim Codex browser smoke`,
    { field, reason },
  );
}

function validateVersionSmoke(manifest) {
  if (
    !Array.isArray(manifest.args) ||
    manifest.args.length !== 1 ||
    manifest.args[0] !== "--version"
  ) {
    throw new ArtifactManifestError(
      "unsupported",
      'interim Codex smoke supports only args ["--version"]',
      { field: "args", reason: "args" },
    );
  }
  validateExact(manifest.expectedExitCode, 0, {
    field: "expectedExitCode",
    reason: "expected_exit_code",
  });
  validateExact(manifest.stdoutPrefix, SUPPORTED_STDOUT_PREFIX, {
    field: "stdoutPrefix",
    reason: "stdout_prefix",
  });
  validateExact(manifest.expectedStderr, SUPPORTED_EXPECTED_STDERR, {
    field: "expectedStderr",
    reason: "expected_stderr",
  });
}

function validateRequestBuilderArgs(manifest) {
  if (
    !Array.isArray(manifest.args) ||
    manifest.args.length !== 2 ||
    !manifest.args.every((arg) => typeof arg === "string" && arg.length > 0)
  ) {
    throw new ArtifactManifestError(
      "unsupported",
      "codex-browser request builder requires args [prompt, model]",
      { field: "args", reason: "args" },
    );
  }
}

function manifestMetadata(manifest, artifactSha256) {
  return {
    artifactKind: manifest.artifactKind,
    artifactPath: manifest.artifactPath,
    artifactSha256,
    artifactSizeBytes: manifest.artifactSizeBytes,
    command: manifest.command,
    entrypoint: manifest.entrypoint,
    expectedExitCode: manifest.expectedExitCode,
    ...(manifest.expectedStderr != null
      ? { expectedStderr: manifest.expectedStderr }
      : {}),
    packageName: manifest.packageName,
    ...(manifest.runtime != null ? { runtime: manifest.runtime } : {}),
    schemaVersion: manifest.schemaVersion,
    ...(manifest.stdoutPrefix != null ? { stdoutPrefix: manifest.stdoutPrefix } : {}),
    ...(manifest.wasi != null ? { wasi: manifest.wasi } : {}),
  };
}

function fixtureWithArtifactBytes(fixture, bytes) {
  const artifactBytes =
    fixture.artifact.kind === CODEX_BROWSER_ARTIFACT_KIND
      ? {
          codexBrowser: {
            byteLength: bytes.byteLength,
            bytes,
            expectedSha256: fixture.artifact.sha256,
          },
        }
      : {
          wasiModule: {
            byteLength: bytes.byteLength,
            bytes,
            expectedSha256: fixture.artifact.sha256,
          },
        };
  return {
    ...fixture,
    commandLoad: {
      ...fixture.commandLoad,
      package: {
        ...fixture.commandLoad.package,
        ...artifactBytes,
      },
    },
  };
}

async function responseBytes(response, expectedSize) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength != null) {
    validateContentLength(contentLength, expectedSize);
  }
  if (typeof response.body?.getReader === "function") {
    return readResponseBodyBytes(response.body, expectedSize);
  }
  const bytes = toUint8Array(await response.arrayBuffer());
  validateResponseSize(bytes.byteLength, expectedSize);
  return bytes;
}

async function readResponseBodyBytes(body, expectedSize) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const bytes = toUint8Array(value);
    total += bytes.byteLength;
    validateResponseSize(total, expectedSize);
    if (bytes.byteLength > 0) {
      chunks.push(bytes);
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateContentLength(value, expectedSize) {
  const size = Number(value);
  if (!Number.isFinite(size) || size !== expectedSize) {
    throw new ArtifactManifestError(
      "artifact_size_mismatch",
      `artifact size mismatch: expected ${expectedSize}, got ${value}`,
      { actual: value, expected: expectedSize },
    );
  }
}

function validateResponseSize(size, expectedSize) {
  if (size > expectedSize) {
    throw new ArtifactManifestError(
      "artifact_size_mismatch",
      `artifact size mismatch: expected ${expectedSize}, got ${size}`,
      { actual: size, expected: expectedSize },
    );
  }
}

function artifactUrlFromPath(path, baseUrl) {
  const text = nonEmptyString(path, "artifactPath must be a non-empty string");
  if (baseUrl == null) {
    return text;
  }
  return new URL(text, baseUrl).toString();
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new ArtifactManifestError(
      "unsupported",
      "Web Crypto SHA-256 is unavailable for artifact verification",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function normalizeSha256(value) {
  const text = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new ArtifactManifestError(
      "invalid_manifest",
      "artifactSha256 must be a 64-character hex digest",
      { field: "artifactSha256" },
    );
  }
  return text;
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
  throw new ArtifactManifestError(
    "invalid_manifest",
    "artifact bytes must be a byte buffer",
  );
}

function nonEmptyString(value, message) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new ArtifactManifestError("invalid_manifest", message);
  }
  return text;
}
