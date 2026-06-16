import { resolveBrowserBearerSecret } from "./secrets.js";

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const DEFAULT_PACKAGE_ID = "codex-browser";
const DEFAULT_COMMAND = "build-request";
const MODEL_REQUEST_COMMAND = "model-request";
const WORKSPACE_EDIT_COMMAND = "workspace-edit";
const MODEL_BEARER_SECRET_ENV = "CODEX_MODEL_BEARER_SECRET_REF";
const DEFAULT_ENTRYPOINT = "codex_build_request";
const DEFAULT_MODEL = "gpt-5";
const CODEX_BROWSER_ARTIFACT_KIND = "codex-browser";
const CODEX_BROWSER_RUNTIME = "wasm32-unknown-unknown";
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_RESPONSE_BODY_LIMIT = 1024 * 1024;
const REQUIRED_EXPORTS = new Map([
  ["memory", "memory"],
  ["codex_alloc", "function"],
  ["codex_free", "function"],
  ["codex_build_request", "function"],
  ["codex_version", "function"],
  ["codex_output_ptr", "function"],
  ["codex_output_len", "function"],
  ["codex_clear_output", "function"],
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BrowserCodexBrowserError extends Error {
  constructor(kind, message, stage = "runtime", options = {}) {
    super(message);
    this.name = "BrowserCodexBrowserError";
    this.kind = kind;
    this.stage = stage;
    this.exitCode = options.exitCode ?? null;
  }
}

export async function loadCodexBrowserPackage(input = {}) {
  const bytes = toUint8Array(codexBrowserBytes(input));
  validateWasmMagic(bytes);
  const sha256 = await sha256Hex(bytes);
  verifyExpectedSha256(
    input.codexBrowser?.expectedSha256 ??
      input.expectedSha256 ??
      input.artifactSha256 ??
      input.metadata?.artifactSha256,
    sha256,
  );
  const module = await compileCodexBrowserModule(bytes);
  validateCodexBrowserExports(module);

  const commands = normalizeCommands(input);
  const defaultCommand = normalizeDefaultCommand(input, commands);
  const entrypoint = nonEmptyString(input.entrypoint ?? DEFAULT_ENTRYPOINT);
  const id = nonEmptyString(input.id ?? input.packageId ?? DEFAULT_PACKAGE_ID);
  const source = normalizeSource(input.source);
  const byteLength = bytes.byteLength;

  return {
    artifactKind: CODEX_BROWSER_ARTIFACT_KIND,
    byteLength,
    bytes,
    cache: input.cache ?? null,
    commands,
    contentSha256: sha256,
    defaultCommand,
    entrypoint,
    id,
    metadata: {
      ...(input.metadata ?? {}),
      artifactKind: CODEX_BROWSER_ARTIFACT_KIND,
      byteLength,
      defaultCommand,
      entrypoint,
      runtime: CODEX_BROWSER_RUNTIME,
      sha256,
      source,
    },
    module,
    sha256,
    source,
    type: CODEX_BROWSER_ARTIFACT_KIND,
  };
}

export function packageNeedsCodexBrowserLoader(value) {
  return isCodexBrowserPackage(value) && codexBrowserBytes(value) != null;
}

export function createCodexBrowserRequestBuilderExecutor(options = {}) {
  return {
    async run(request, output) {
      return runCodexBrowserRequestBuilder(request, output, options);
    },
  };
}

export async function runCodexBrowserRequestBuilder(
  request,
  output,
  options = {},
) {
  const packageRecord = request.package;
  if (!packageRecord?.commands?.includes(request.command)) {
    throw new BrowserCodexBrowserError(
      "command_not_found",
      `browser command not found: ${request.command}`,
      "command_resolution",
      { exitCode: 127 },
    );
  }
  if (
    request.command !== DEFAULT_COMMAND &&
    request.command !== MODEL_REQUEST_COMMAND &&
    request.command !== WORKSPACE_EDIT_COMMAND
  ) {
    throw new BrowserCodexBrowserError(
      "command_not_found",
      `unsupported codex-browser command: ${request.command}`,
      "command_resolution",
      { exitCode: 127 },
    );
  }
  throwIfAborted(request.signal);

  if (request.command === WORKSPACE_EDIT_COMMAND) {
    return runCodexBrowserWorkspaceEdit(request, output, options);
  }

  const endpoint =
    request.command === MODEL_REQUEST_COMMAND
      ? modelEndpointFromRequest(request, options)
      : null;
  const prompt = request.args[0];
  if (prompt == null || String(prompt).length === 0) {
    throw new BrowserCodexBrowserError(
      "invalid_request",
      `codex-browser ${request.command} requires a prompt argument`,
      "startup",
      { exitCode: 2 },
    );
  }
  const model =
    request.args[1] ??
    request.env.CODEX_MODEL ??
    request.env.OPENAI_MODEL ??
    options.defaultModel ??
    DEFAULT_MODEL;

  const runtime = await instantiateCodexBrowserPackage(packageRecord, options);

  const requestJson = callCodexBuildRequest(runtime.exports, runtime.memory, {
    model: String(model),
    outputLimit: options.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
    prompt: String(prompt),
    signal: request.signal,
  });
  if (request.command === MODEL_REQUEST_COMMAND) {
    return dispatchCodexModelRequest(
      request,
      output,
      requestJson,
      endpoint,
      options,
    );
  }
  await output.writeStdout(`${requestJson}\n`);
  return { exitCode: 0 };
}

async function runCodexBrowserWorkspaceEdit(request, output, options) {
  await instantiateCodexBrowserPackage(request.package, options);
  throwIfAborted(request.signal);

  const workspace = workspaceStoreFromRequest(request, options);
  const { expected, path, replacement } = workspaceEditArgs(request);
  let currentBytes;
  try {
    currentBytes = await workspace.readFile(path);
  } catch (error) {
    throw workspaceEditError(error);
  }
  throwIfAborted(request.signal);
  const current = decoder.decode(currentBytes);
  const index = current.indexOf(expected);
  if (index === -1) {
    throw new BrowserCodexBrowserError(
      "invalid_request",
      "codex-browser workspace-edit target text was not found",
      "runtime",
      { exitCode: 1 },
    );
  }
  const next =
    current.slice(0, index) +
    replacement +
    current.slice(index + expected.length);
  let stat;
  try {
    stat = await workspace.writeFile(path, next);
  } catch (error) {
    throw workspaceEditError(error);
  }
  throwIfAborted(request.signal);
  const result = {
    afterBytes: encoder.encode(next).byteLength,
    beforeBytes: currentBytes.byteLength,
    path: stat.path,
    replacements: 1,
  };
  await output.writeStdout(`${JSON.stringify(result)}\n`);
  return { exitCode: 0, workspaceEdit: result };
}

async function instantiateCodexBrowserPackage(packageRecord, options) {
  const module =
    packageRecord.module ??
    (await compileCodexBrowserModule(toUint8Array(packageRecord.bytes)));
  validateCodexBrowserExports(module);
  const instantiated = await globalThis.WebAssembly.instantiate(module, {});
  const instance = instantiated.instance ?? instantiated;
  const exports = instance.exports;
  const memory = exportedMemory(exports);
  validateRuntimeExports(exports);

  const version = callCodexVersion(exports, memory, options);
  if (version.crate_name !== "codex-browser") {
    throw new BrowserCodexBrowserError(
      "invalid_package",
      "codex-browser version output did not identify codex-browser",
      "package_load",
    );
  }
  exports.codex_clear_output();
  return { exports, memory };
}

async function dispatchCodexModelRequest(
  request,
  output,
  requestJson,
  endpoint,
  options,
) {
  const transport = request.httpTransport;
  if (typeof transport?.dispatch !== "function") {
    throw new BrowserCodexBrowserError(
      "unsupported",
      "codex-browser model-request requires an HTTP transport",
      "startup",
    );
  }
  const writer = new ModelResponseWriter(output);
  const { headers, sensitiveValues } = await modelRequestHeaders(request, options);
  try {
    await transport.dispatch(
      {
        body: encoder.encode(requestJson),
        headers,
        id: `${request.package.id}:${request.command}`,
        method: "POST",
        responseBodyLimit: optionalPositiveInteger(
          request.env.CODEX_MODEL_RESPONSE_BODY_LIMIT ??
            options.responseBodyLimit ??
            DEFAULT_RESPONSE_BODY_LIMIT,
          "CODEX_MODEL_RESPONSE_BODY_LIMIT",
        ),
        timeoutMs: optionalPositiveInteger(
          request.env.CODEX_MODEL_TIMEOUT_MS ?? options.timeoutMs,
          "CODEX_MODEL_TIMEOUT_MS",
          { optional: true },
        ),
        url: endpoint,
      },
      writer,
      request.signal,
    );
  } catch (error) {
    throw redactModelRequestError(error, sensitiveValues);
  }
  throwIfAborted(request.signal);
  if (!isSuccessfulHttpStatus(writer.status)) {
    throw new BrowserCodexBrowserError(
      "transport",
      `codex-browser model request failed with status ${writer.status}`,
      "runtime",
      { exitCode: 1 },
    );
  }
  return { exitCode: 0 };
}

async function modelRequestHeaders(request, options) {
  const headers = [
    { name: "content-type", value: "application/json" },
    { name: "accept", value: "text/event-stream, application/json" },
  ];
  throwIfAborted(request.signal);
  const bearerToken = await resolveBrowserBearerSecret(
    options.secretProvider,
    request.env?.[MODEL_BEARER_SECRET_ENV] ?? options.bearerSecretRef,
    { purpose: "codex-model-request", signal: request.signal },
  );
  throwIfAborted(request.signal);
  if (bearerToken) {
    headers.push({ name: "authorization", value: `Bearer ${bearerToken}` });
    return {
      headers,
      sensitiveValues: [`Bearer ${bearerToken}`, bearerToken],
    };
  }
  return { headers, sensitiveValues: [] };
}

function redactModelRequestError(error, sensitiveValues) {
  const message = redactSensitiveText(error?.message, sensitiveValues);
  if (message === error?.message) {
    return error;
  }
  const redacted = new Error(message);
  redacted.name = error?.name ?? "Error";
  const source = error && typeof error === "object" ? error : {};
  for (const key of ["kind", "stage", "exitCode", "cancelled", "timedOut"]) {
    if (key in source) {
      redacted[key] = source[key];
    }
  }
  return redacted;
}

function redactSensitiveText(value, sensitiveValues) {
  let text = String(value ?? "codex-browser model request failed");
  const values = [...(sensitiveValues ?? [])]
    .filter((sensitive) => sensitive != null && String(sensitive).length > 0)
    .map(String)
    .sort((left, right) => right.length - left.length);
  for (const sensitive of values) {
    text = text.split(sensitive).join("[redacted]");
  }
  return text;
}

class ModelResponseWriter {
  constructor(output) {
    this.headers = [];
    this.output = output;
    this.sse = null;
    this.status = null;
  }

  async start(status, headers) {
    this.status = Number(status);
    this.headers = headers ?? [];
    this.configureResponseDecoder();
  }

  async writeBodyChunk(chunk) {
    if (this.status != null && !isSuccessfulHttpStatus(this.status)) {
      return;
    }
    if (this.sse) {
      await this.sse.write(chunk);
      return;
    }
    await this.output.writeStdout(chunk);
  }

  async finish(status, headers, body) {
    this.status = Number(status);
    this.headers = headers ?? [];
    this.configureResponseDecoder();
    const bytes = toUint8Array(body ?? new Uint8Array(), {
      allowEmpty: true,
      message: "codex-browser model response body must be bytes",
      stage: "runtime",
    });
    if (isSuccessfulHttpStatus(this.status) && bytes.byteLength > 0) {
      await this.writeBodyChunk(bytes);
    }
    if (isSuccessfulHttpStatus(this.status) && this.sse) {
      await this.sse.finish();
    }
  }

  configureResponseDecoder() {
    if (
      this.sse ||
      !isSuccessfulHttpStatus(this.status) ||
      !isEventStreamResponse(this.headers)
    ) {
      return;
    }
    this.sse = new ResponsesSseModelWriter(this.output);
  }
}

class ResponsesSseModelWriter {
  constructor(output) {
    this.buffer = "";
    this.decoder = new TextDecoder();
    this.output = output;
  }

  async write(chunk) {
    this.buffer += this.decoder.decode(toUint8Array(chunk), { stream: true });
    await this.drainEvents();
  }

  async finish() {
    this.buffer += this.decoder.decode();
    await this.drainEvents({ final: true });
  }

  async drainEvents(options = {}) {
    normalizeSseNewlines(this);
    while (true) {
      const delimiter = this.buffer.indexOf("\n\n");
      if (delimiter === -1) {
        break;
      }
      const frame = this.buffer.slice(0, delimiter);
      this.buffer = this.buffer.slice(delimiter + 2);
      await this.handleFrame(frame);
    }
    if (options.final && this.buffer.trim() !== "") {
      const frame = this.buffer;
      this.buffer = "";
      await this.handleFrame(frame);
    }
  }

  async handleFrame(frame) {
    const event = parseSseFrame(frame);
    if (!event) {
      return;
    }
    if (event.data.trim() === "[DONE]") {
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch (_error) {
      throw invalidModelSse("codex-browser model SSE event was not JSON");
    }

    const type = String(payload?.type ?? event.event ?? "");
    switch (type) {
      case "response.output_text.delta":
        await this.writeTextDelta(payload);
        return;
      case "response.completed":
        return;
      case "response.error":
        throw invalidModelSse("codex-browser model SSE event reported an error");
      default:
        return;
    }
  }

  async writeTextDelta(payload) {
    if (typeof payload?.delta !== "string") {
      throw invalidModelSse("codex-browser model SSE delta was invalid");
    }
    if (payload.delta.length > 0) {
      await this.output.writeStdout(encoder.encode(payload.delta));
    }
  }
}

function normalizeSseNewlines(writer) {
  writer.buffer = writer.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseSseFrame(frame) {
  let event = "";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (!event && data.length === 0) {
    return null;
  }
  return { data: data.join("\n"), event };
}

function isEventStreamResponse(headers) {
  return headerValue(headers, "content-type")
    .toLowerCase()
    .split(";")
    .map((value) => value.trim())
    .includes("text/event-stream");
}

function headerValue(headers, name) {
  const normalizedName = name.toLowerCase();
  for (const header of headers ?? []) {
    if (String(header.name ?? "").toLowerCase() === normalizedName) {
      return String(header.value ?? "");
    }
  }
  return "";
}

function invalidModelSse(message) {
  return new BrowserCodexBrowserError("invalid_response", message, "runtime", {
    exitCode: 1,
  });
}

function callCodexVersion(exports, memory, options) {
  const status = Number(exports.codex_version());
  const text = readOutput(exports, memory, options.outputLimit ?? DEFAULT_OUTPUT_LIMIT);
  if (status !== 0) {
    throw new BrowserCodexBrowserError(
      "runtime",
      `codex-browser version failed with status ${status}`,
      "runtime",
      { exitCode: status },
    );
  }
  return parseJsonOutput(text, "codex-browser version output was not JSON");
}

function callCodexBuildRequest(exports, memory, options) {
  const prompt = passString(exports, memory, options.prompt);
  let model = null;
  try {
    model = passString(exports, memory, options.model);
    throwIfAborted(options.signal);
    const status = Number(
      exports.codex_build_request(
        prompt.ptr,
        prompt.len,
        model.ptr,
        model.len,
      ),
    );
    const text = readOutput(exports, memory, options.outputLimit);
    if (status !== 0) {
      const output = parseJsonOutput(text, "codex-browser error output was not JSON");
      throw new BrowserCodexBrowserError(
        "runtime",
        output.error ?? `codex-browser request build failed with status ${status}`,
        "runtime",
        { exitCode: status },
      );
    }
    parseJsonOutput(text, "codex-browser request output was not JSON");
    return text;
  } finally {
    exports.codex_free(prompt.ptr, prompt.len);
    if (model) {
      exports.codex_free(model.ptr, model.len);
    }
  }
}

function passString(exports, memory, value) {
  const bytes = encoder.encode(value);
  const ptr = Number(exports.codex_alloc(bytes.length));
  if (bytes.length > 0 && ptr === 0) {
    throw new BrowserCodexBrowserError(
      "runtime",
      "codex-browser allocation failed",
      "runtime",
    );
  }
  memoryRange(memory, ptr, bytes.length, "codex-browser allocation out of range").set(bytes);
  return { len: bytes.length, ptr };
}

function readOutput(exports, memory, outputLimit) {
  const ptr = Number(exports.codex_output_ptr());
  const len = Number(exports.codex_output_len());
  if (!Number.isSafeInteger(len) || len < 0 || len > outputLimit) {
    throw new BrowserCodexBrowserError(
      "runtime",
      `codex-browser output exceeded ${outputLimit} bytes`,
      "runtime",
    );
  }
  return decoder.decode(
    memoryRange(memory, ptr, len, "codex-browser output out of range"),
  );
}

function parseJsonOutput(text, message) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BrowserCodexBrowserError(
      "runtime",
      message,
      "runtime",
      { cause: error.message },
    );
  }
}

async function compileCodexBrowserModule(bytes) {
  if (typeof globalThis.WebAssembly?.compile === "function") {
    try {
      return await globalThis.WebAssembly.compile(bytes);
    } catch (error) {
      throw new BrowserCodexBrowserError(
        "invalid_package",
        error?.message ?? "codex-browser Wasm did not compile",
        "package_load",
      );
    }
  }
  if (typeof globalThis.WebAssembly?.Module === "function") {
    try {
      return new globalThis.WebAssembly.Module(bytes);
    } catch (error) {
      throw new BrowserCodexBrowserError(
        "invalid_package",
        error?.message ?? "codex-browser Wasm did not compile",
        "package_load",
      );
    }
  }
  throw new BrowserCodexBrowserError(
    "unsupported",
    "WebAssembly.compile is unavailable for codex-browser packages",
    "package_load",
  );
}

function validateCodexBrowserExports(module) {
  const exports = new Map(
    globalThis.WebAssembly.Module.exports(module).map((descriptor) => [
      descriptor.name,
      descriptor.kind,
    ]),
  );
  for (const [name, kind] of REQUIRED_EXPORTS) {
    if (exports.get(name) !== kind) {
      throw new BrowserCodexBrowserError(
        "invalid_package",
        `codex-browser export is missing or invalid: ${name}`,
        "package_load",
      );
    }
  }
}

function validateRuntimeExports(exports) {
  for (const [name, kind] of REQUIRED_EXPORTS) {
    const value = exports[name];
    if (kind === "function" && typeof value !== "function") {
      throw new BrowserCodexBrowserError(
        "invalid_package",
        `codex-browser export is not callable: ${name}`,
        "package_load",
      );
    }
  }
}

function exportedMemory(exports) {
  const memory = exports.memory;
  if (!(memory instanceof globalThis.WebAssembly.Memory)) {
    throw new BrowserCodexBrowserError(
      "invalid_package",
      "codex-browser package must export memory",
      "package_load",
    );
  }
  return memory;
}

function memoryRange(memory, ptr, len, message) {
  if (
    !Number.isSafeInteger(ptr) ||
    !Number.isSafeInteger(len) ||
    ptr < 0 ||
    len < 0 ||
    ptr + len > memory.buffer.byteLength
  ) {
    throw new BrowserCodexBrowserError("runtime", message, "runtime");
  }
  return new Uint8Array(memory.buffer, ptr, len);
}

function isCodexBrowserPackage(value) {
  return (
    value?.artifactKind === CODEX_BROWSER_ARTIFACT_KIND ||
    value?.type === CODEX_BROWSER_ARTIFACT_KIND ||
    value?.executorType === CODEX_BROWSER_ARTIFACT_KIND
  );
}

function codexBrowserBytes(value) {
  return (
    value?.codexBrowser?.bytes ??
    value?.source?.bytes ??
    value?.bytes ??
    null
  );
}

function validateWasmMagic(bytes) {
  if (!startsWithBytes(bytes, WASM_MAGIC)) {
    throw new BrowserCodexBrowserError(
      "invalid_package",
      "codex-browser bytes must start with Wasm magic",
      "package_load",
    );
  }
}

function normalizeCommands(input) {
  const commands = input.commands ?? [input.command ?? DEFAULT_COMMAND];
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new BrowserCodexBrowserError(
      "invalid_package",
      "codex-browser commands must be a non-empty array",
      "package_load",
    );
  }
  return commands.map((command) => nonEmptyString(command));
}

function normalizeDefaultCommand(input, commands) {
  const defaultCommand = nonEmptyString(input.defaultCommand ?? commands[0]);
  if (!commands.includes(defaultCommand)) {
    throw new BrowserCodexBrowserError(
      "invalid_package",
      "codex-browser default command must be listed in commands",
      "package_load",
    );
  }
  return defaultCommand;
}

function normalizeSource(source) {
  if (!source) {
    return { kind: "bytes", label: "explicit-bytes" };
  }
  return {
    kind: nonEmptyString(source.kind ?? "bytes"),
    label: nonEmptyString(source.label ?? source.kind ?? "explicit-bytes"),
  };
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new BrowserCodexBrowserError(
      "unsupported",
      "Web Crypto SHA-256 is unavailable for codex-browser packages",
      "package_load",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function verifyExpectedSha256(expected, actual) {
  if (expected == null) {
    return;
  }
  const normalized = String(expected).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized) || normalized !== actual) {
    throw new BrowserCodexBrowserError(
      "invalid_package",
      `codex-browser sha256 mismatch: expected ${normalized}, got ${actual}`,
      "package_load",
    );
  }
}

function startsWithBytes(bytes, prefix) {
  if (bytes.byteLength < prefix.byteLength) {
    return false;
  }
  return prefix.every((byte, index) => bytes[index] === byte);
}

function toUint8Array(value, options = {}) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (options.allowEmpty && value == null) {
    return new Uint8Array();
  }
  throw new BrowserCodexBrowserError(
    "invalid_package",
    options.message ?? "codex-browser bytes must be a byte buffer",
    options.stage ?? "package_load",
  );
}

function nonEmptyString(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new BrowserCodexBrowserError(
      "invalid_package",
      "codex-browser fields must be non-empty strings",
      "package_load",
    );
  }
  return text;
}

function modelEndpointFromRequest(request, options) {
  const endpoint =
    request.args[2] ?? request.env.CODEX_MODEL_ENDPOINT ?? options.endpoint;
  const text = String(endpoint ?? "").trim();
  if (!text) {
    throw new BrowserCodexBrowserError(
      "invalid_request",
      "codex-browser model-request requires an endpoint argument",
      "startup",
      { exitCode: 2 },
    );
  }
  return text;
}

function workspaceStoreFromRequest(request, options) {
  const store = request.workspaceStore ?? options.workspaceStore;
  if (
    typeof store?.readFile !== "function" ||
    typeof store?.writeFile !== "function"
  ) {
    throw new BrowserCodexBrowserError(
      "unsupported",
      "codex-browser workspace-edit requires a browser workspace store",
      "startup",
    );
  }
  return store;
}

function workspaceEditArgs(request) {
  return {
    expected: requiredEditArg(
      request.args[1],
      "codex-browser workspace-edit requires target text",
    ),
    path: requiredEditArg(
      request.args[0],
      "codex-browser workspace-edit requires a workspace file path",
    ),
    replacement: optionalEditArg(request.args[2]),
  };
}

function requiredEditArg(value, message) {
  const text = String(value ?? "");
  if (!text) {
    throw new BrowserCodexBrowserError(
      "invalid_request",
      message,
      "startup",
      { exitCode: 2 },
    );
  }
  return text;
}

function optionalEditArg(value) {
  if (value == null) {
    throw new BrowserCodexBrowserError(
      "invalid_request",
      "codex-browser workspace-edit requires replacement text",
      "startup",
      { exitCode: 2 },
    );
  }
  return String(value);
}

function workspaceEditError(error) {
  if (typeof error?.kind === "string") {
    return new BrowserCodexBrowserError(
      error.kind,
      `codex-browser workspace-edit failed: ${error.message}`,
      error.stage ?? "workspace",
      { exitCode: 1 },
    );
  }
  return error;
}

function optionalPositiveInteger(value, name, options = {}) {
  if ((value == null || value === "") && options.optional) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new BrowserCodexBrowserError(
      "invalid_request",
      `${name} must be a positive integer`,
      "startup",
      { exitCode: 2 },
    );
  }
  return number;
}

function isSuccessfulHttpStatus(status) {
  return Number.isInteger(status) && status >= 200 && status <= 299;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw new BrowserCodexBrowserError(
    "cancelled",
    "codex-browser command cancelled",
    "runtime",
    { exitCode: 130 },
  );
}
