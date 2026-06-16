const SUPPORTED_SCHEMA_VERSION = 1;
const SUPPORTED_PACKAGE_NAME = "codex";
const SUPPORTED_ARTIFACT_KIND = "wasi-module";
const SUPPORTED_COMMAND = "codex";
const SUPPORTED_ENTRYPOINT = "_start";
const SUPPORTED_WASI = "preview1";
const SUPPORTED_STDOUT_PREFIX = "codex-cli ";
const SUPPORTED_EXPECTED_STDERR = "";

const REQUIRED_FIELDS = [
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
  "stdoutPrefix",
  "expectedStderr",
  "wasi",
  "requiresNetwork",
  "requiresWorkspace",
  "requiresHostCommand",
  "requiresTerminal",
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
  validateRequiredFields(manifest);
  validateExact(manifest.schemaVersion, SUPPORTED_SCHEMA_VERSION, {
    field: "schemaVersion",
    kind: "invalid_manifest",
  });
  validateExact(manifest.packageName, SUPPORTED_PACKAGE_NAME, {
    field: "packageName",
    reason: "package_name",
  });
  validateExact(manifest.artifactKind, SUPPORTED_ARTIFACT_KIND, {
    field: "artifactKind",
    reason: "artifact_kind",
  });
  validateExact(manifest.command, SUPPORTED_COMMAND, {
    field: "command",
    reason: "command",
  });
  validateExact(manifest.entrypoint, SUPPORTED_ENTRYPOINT, {
    field: "entrypoint",
    reason: "entrypoint",
  });
  validateExact(manifest.wasi, SUPPORTED_WASI, {
    field: "wasi",
    reason: "wasi",
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
  validateVersionSmoke(manifest);
  return manifest;
}

export function normalizeCodexBrowserRunFixture(manifest) {
  validateCodexArtifactManifest(manifest);
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

export async function fetchCodexArtifactBytes(manifest, options = {}) {
  const fixture = normalizeCodexBrowserRunFixture(manifest);
  const fetchImpl =
    "fetchImpl" in options ? options.fetchImpl : globalThis.fetch;
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
    fixture,
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

function validateRequiredFields(manifest) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in manifest)) {
      throw new ArtifactManifestError(
        "invalid_manifest",
        `artifact manifest is missing ${field}`,
        { field },
      );
    }
  }
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

function manifestMetadata(manifest, artifactSha256) {
  return {
    artifactKind: manifest.artifactKind,
    artifactPath: manifest.artifactPath,
    artifactSha256,
    artifactSizeBytes: manifest.artifactSizeBytes,
    command: manifest.command,
    entrypoint: manifest.entrypoint,
    expectedExitCode: manifest.expectedExitCode,
    expectedStderr: manifest.expectedStderr,
    packageName: manifest.packageName,
    schemaVersion: manifest.schemaVersion,
    stdoutPrefix: manifest.stdoutPrefix,
    wasi: manifest.wasi,
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
