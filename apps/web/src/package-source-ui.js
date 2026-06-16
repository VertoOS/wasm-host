import { mountBrowserTerminalShell } from "./terminal-ui.js";
import {
  PACKAGE_SOURCE_KINDS,
  builtinCodexPackageSourceOptions,
  createBrowserPackageSourceResolver,
} from "./package-source.js";

const SOURCE_LABELS = {
  "builtin-codex": "Built-in",
  "package-file": "File",
  "package-url": "URL",
  "manifest-json": "Manifest JSON",
  "manifest-url": "Manifest URL",
};

export class BrowserPackageSourceControls {
  constructor(options = {}) {
    this.elements = options.elements;
    this.terminal = options.terminal;
    this.resolvePackageSource = options.resolvePackageSource;
    this.onStateChange = options.onStateChange ?? (() => {});
    this.disposers = [];
    this.state = {
      error: null,
      metadata: options.metadata ?? null,
      phase: "ready",
    };
    this.bind();
    this.updateActiveSource();
    this.renderMetadata(this.state.metadata);
  }

  async apply() {
    if (this.elements.applyButton.disabled) {
      return null;
    }
    this.setState({ error: null, phase: "loading" });
    try {
      const options = await this.resolvePackageSource(this.currentInput());
      this.terminal.configurePackage(options);
      this.setState({
        error: null,
        metadata: options.metadata ?? null,
        phase: "ready",
      });
      return options;
    } catch (error) {
      this.setState({
        error,
        phase: "error",
      });
      return null;
    }
  }

  currentInput() {
    return {
      argsText: this.elements.argsInput.value,
      command: this.elements.commandInput.value,
      executorType: this.elements.executorInput.value,
      file: this.elements.fileInput.files?.[0] ?? null,
      kind: this.elements.sourceSelect.value,
      manifestText: this.elements.manifestInput.value,
      packageId: this.elements.packageIdInput.value,
      url: this.elements.urlInput.value,
    };
  }

  bind() {
    this.listen(this.elements.applyButton, "click", (event) => {
      event.preventDefault?.();
      this.apply();
    });
    this.listen(this.elements.sourceSelect, "change", () => {
      this.updateActiveSource();
    });
  }

  destroy() {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
  }

  listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.disposers.push(() => target.removeEventListener(type, listener));
  }

  setState(next) {
    this.state = {
      ...this.state,
      ...next,
    };
    this.elements.applyButton.disabled = this.state.phase === "loading";
    this.renderError(this.state.error);
    this.renderMetadata(this.state.metadata);
    this.onStateChange(this.state);
  }

  renderError(error) {
    this.elements.error.textContent = error?.message ?? "";
  }

  renderMetadata(metadata) {
    const summary = this.elements.summary;
    replaceChildren(summary);
    if (!metadata) {
      summary.textContent = "";
      return;
    }
    const rows = metadataRows(metadata);
    const dl = summary.ownerDocument.createElement("dl");
    for (const [label, value] of rows) {
      const dt = summary.ownerDocument.createElement("dt");
      dt.textContent = label;
      const dd = summary.ownerDocument.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
    summary.append(dl);
  }

  updateActiveSource() {
    const kind = this.elements.sourceSelect.value;
    this.elements.panel.dataset.packageSourceKind = kind;
    const isBuiltIn = kind === "builtin-codex";
    const isFile = kind === "package-file";
    const isUrl = kind === "package-url";
    const isManifestJson = kind === "manifest-json";
    const isManifestUrl = kind === "manifest-url";
    this.elements.fileInput.disabled = isBuiltIn || isUrl || isManifestUrl;
    this.elements.urlInput.disabled = isBuiltIn || isFile || isManifestJson;
    this.elements.manifestInput.disabled = !isManifestJson;
    this.elements.packageIdInput.disabled = isBuiltIn || isManifestJson || isManifestUrl;
    this.elements.commandInput.disabled = isBuiltIn || isManifestJson || isManifestUrl;
    this.elements.argsInput.disabled = isBuiltIn || isManifestJson || isManifestUrl;
    this.elements.executorInput.disabled = isBuiltIn || isManifestJson || isManifestUrl;
  }
}

export async function mountBrowserPackageTerminalShell(options = {}) {
  const document = options.document ?? globalThis.document;
  const root = options.root ?? document?.getElementById?.("app");
  if (!document || !root) {
    throw new Error("browser package terminal shell requires a document root");
  }

  const initialPackage =
    options.initialPackage ?? (await builtinCodexPackageSourceOptions(options));
  const { elements, packagePanel, terminalRoot } =
    renderPackageTerminalShell(document);
  replaceChildren(root, packagePanel, terminalRoot);

  const terminal = mountBrowserTerminalShell({
    ...initialPackage,
    createWorker: options.createWorker,
    document,
    onStateChange: options.onStateChange,
    root: terminalRoot,
  });
  const packageSources = new BrowserPackageSourceControls({
    elements,
    metadata: initialPackage.metadata,
    onStateChange: options.onPackageStateChange,
    resolvePackageSource:
      options.resolvePackageSource ?? createBrowserPackageSourceResolver(options),
    terminal,
  });

  return {
    destroy() {
      packageSources.destroy();
      terminal.destroy();
    },
    packageSources,
    terminal,
  };
}

function renderPackageTerminalShell(document) {
  const packagePanel = document.createElement("section");
  packagePanel.className = "package-source";
  packagePanel.dataset.packageSourcePanel = "";
  packagePanel.dataset.packageSourceKind = "builtin-codex";

  const controls = document.createElement("div");
  controls.className = "package-source__controls";

  const sourceSelect = select(document, "Source", "packageSource", [
    ...PACKAGE_SOURCE_KINDS,
  ]);
  for (const option of sourceSelect.input.options) {
    option.textContent = SOURCE_LABELS[option.value] ?? option.value;
  }
  const fileInput = input(document, "Package file", "packageFile", "file");
  const urlInput = input(document, "URL", "packageUrl", "url");
  const packageIdInput = input(document, "Package id", "packageId", "text");
  const commandInput = input(document, "Command", "packageCommand", "text");
  const argsInput = input(document, "Args", "packageArgs", "text");
  const executorInput = input(document, "Executor", "packageExecutor", "text");
  commandInput.input.value = "smoke";
  executorInput.input.value = "smoke";

  controls.append(
    sourceSelect.label,
    sourceSelect.input,
    fileInput.label,
    fileInput.input,
    urlInput.label,
    urlInput.input,
    packageIdInput.label,
    packageIdInput.input,
    commandInput.label,
    commandInput.input,
    argsInput.label,
    argsInput.input,
    executorInput.label,
    executorInput.input,
  );

  const manifestLabel = document.createElement("label");
  manifestLabel.htmlFor = "package-manifest-json";
  manifestLabel.textContent = "Manifest JSON";
  const manifestInput = document.createElement("textarea");
  manifestInput.id = "package-manifest-json";
  manifestInput.dataset.packageManifest = "";
  manifestInput.rows = 5;
  manifestInput.spellcheck = false;

  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.textContent = "Apply";
  applyButton.dataset.packageApply = "";

  const error = document.createElement("div");
  error.className = "package-source__error";
  error.dataset.packageError = "";
  error.setAttribute("role", "alert");

  const summary = document.createElement("div");
  summary.className = "package-source__summary";
  summary.dataset.packageSummary = "";

  packagePanel.append(
    controls,
    manifestLabel,
    manifestInput,
    applyButton,
    error,
    summary,
  );

  const terminalRoot = document.createElement("div");
  terminalRoot.dataset.terminalRoot = "";

  return {
    elements: {
      applyButton,
      argsInput: argsInput.input,
      commandInput: commandInput.input,
      error,
      executorInput: executorInput.input,
      fileInput: fileInput.input,
      manifestInput,
      packageIdInput: packageIdInput.input,
      panel: packagePanel,
      sourceSelect: sourceSelect.input,
      summary,
      urlInput: urlInput.input,
    },
    packagePanel,
    terminalRoot,
  };
}

function metadataRows(metadata) {
  return [
    ["Source", metadata.sourceLabel ?? metadata.sourceKind ?? ""],
    ["Package", metadata.packageId ?? ""],
    ["Command", commandWithArgs(metadata.command, metadata.args)],
    ["Artifact", metadata.artifactKind ?? ""],
    ["Format", metadata.format ?? metadata.executorType ?? ""],
    ["Bytes", metadata.byteLength == null ? "" : String(metadata.byteLength)],
    ["SHA-256", shortSha(metadata.sha256)],
  ].filter(([, value]) => value);
}

function commandWithArgs(command, args = []) {
  return [command, ...args].filter(Boolean).join(" ");
}

function shortSha(value) {
  const text = String(value ?? "");
  return text.length > 16 ? `${text.slice(0, 12)}...${text.slice(-8)}` : text;
}

function input(document, labelText, dataName, type) {
  const id = `package-${dataName}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  const element = document.createElement("input");
  element.id = id;
  element.type = type;
  element.dataset[dataName] = "";
  return { input: element, label };
}

function select(document, labelText, dataName, values) {
  const id = `package-${dataName}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  const element = document.createElement("select");
  element.id = id;
  element.dataset[dataName] = "";
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    element.append(option);
  }
  return { input: element, label };
}

function replaceChildren(element, ...children) {
  if (typeof element.replaceChildren === "function") {
    element.replaceChildren(...children);
    return;
  }
  element.children = children;
  element.textContent = "";
}
