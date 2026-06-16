import assert from "node:assert/strict";
import test from "node:test";

import { BrowserPackageSourceControls } from "../src/package-source-ui.js";

test("BrowserPackageSourceControls applies package selections to the terminal", async () => {
  const elements = fakePackageElements();
  const terminal = {
    configured: null,
    configurePackage(options) {
      this.configured = options;
    },
  };
  let seenInput = null;
  const controller = new BrowserPackageSourceControls({
    elements,
    terminal,
    resolvePackageSource: async (input) => {
      seenInput = input;
      return {
        commandLabel: "smoke --version",
        loadMessage: { type: "command.load", id: "load-url" },
        metadata: {
          args: ["--version"],
          artifactKind: "webc-package",
          byteLength: 12,
          command: "smoke",
          packageId: "url-pkg",
          sha256: "a".repeat(64),
          sourceLabel: "https://example.test/pkg.webc",
        },
        runMessage: { type: "command.run", id: "run-url" },
      };
    },
  });

  elements.sourceSelect.value = "package-url";
  elements.urlInput.value = "https://example.test/pkg.webc";
  elements.packageIdInput.value = "url-pkg";
  elements.commandInput.value = "smoke";
  elements.argsInput.value = "--version";
  elements.executorInput.value = "smoke";

  const result = await controller.apply();

  assert.equal(result.commandLabel, "smoke --version");
  assert.equal(terminal.configured.commandLabel, "smoke --version");
  assert.deepEqual(seenInput, {
    argsText: "--version",
    command: "smoke",
    executorType: "smoke",
    file: null,
    kind: "package-url",
    manifestText: "",
    packageId: "url-pkg",
    url: "https://example.test/pkg.webc",
  });
  assert.equal(elements.error.textContent, "");
  assert.match(elements.summary.textContent, /url-pkg/);
  assert.match(elements.summary.textContent, /smoke --version/);
});

test("BrowserPackageSourceControls renders resolver errors", async () => {
  const elements = fakePackageElements();
  const controller = new BrowserPackageSourceControls({
    elements,
    terminal: { configurePackage() {} },
    resolvePackageSource: async () => {
      throw new Error("invalid package bytes");
    },
  });

  assert.equal(await controller.apply(), null);
  assert.equal(elements.error.textContent, "invalid package bytes");
  assert.equal(elements.applyButton.disabled, false);
});

function fakePackageElements() {
  return {
    applyButton: fakeElement(),
    argsInput: fakeElement(),
    commandInput: fakeElement(),
    error: fakeElement(),
    executorInput: fakeElement(),
    fileInput: fakeElement({ files: [] }),
    manifestInput: fakeElement(),
    packageIdInput: fakeElement(),
    panel: fakeElement(),
    sourceSelect: fakeElement({ value: "builtin-codex" }),
    summary: fakeElement(),
    urlInput: fakeElement(),
  };
}

function fakeElement(options = {}) {
  const listeners = new Map();
  const element = {
    children: [],
    dataset: {},
    disabled: false,
    files: options.files,
    ownerDocument: null,
    textContent: "",
    value: options.value ?? "",
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(listener);
    },
    append(...children) {
      this.children.push(...children);
      this.textContent += children
        .map((child) => child.textContent ?? "")
        .join("");
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    replaceChildren(...children) {
      this.children = children;
      this.textContent = children
        .map((child) => child.textContent ?? "")
        .join("");
    },
  };
  element.ownerDocument = {
    createElement() {
      return fakeElement();
    },
  };
  return element;
}
