#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN_DIRS = ["src", "test", "e2e", "fixtures"];

const BLOCKED_FIRST_CLASS_TERMS = [
  {
    term: "mcp",
    reason:
      "MCP belongs in an adapter package over the browser tool protocol, not as a first-class web module.",
  },
  {
    term: "plugin",
    reason:
      "Plugin runtimes belong in adapter packages over neutral browser protocols.",
  },
  {
    term: "oauth",
    reason:
      "OAuth flows belong behind host-owned auth/secret providers or adapter packages.",
  },
  {
    term: "connector",
    reason:
      "Connector runtimes belong in adapter packages over neutral browser protocols.",
  },
  {
    term: "provider",
    reason:
      "Provider-specific model/auth runtimes should not become first-class web modules.",
  },
  {
    term: "openai",
    reason:
      "Provider SDKs belong behind the browser HTTP bridge or in adapter packages.",
  },
  {
    term: "anthropic",
    reason:
      "Provider SDKs belong behind the browser HTTP bridge or in adapter packages.",
  },
  {
    term: "gemini",
    reason:
      "Provider SDKs belong behind the browser HTTP bridge or in adapter packages.",
  },
  {
    term: "google",
    reason:
      "Provider SDKs belong behind the browser HTTP bridge or in adapter packages.",
  },
  {
    term: "app-server",
    reason:
      "Only the existing app-server protocol fixture is allowed in apps/web.",
  },
];

const BLOCKED_IMPORT_TERMS = [
  "mcp",
  "modelcontextprotocol",
  "plugin",
  "oauth",
  "connector",
  "provider",
  "openai",
  "anthropic",
  "gemini",
  "google",
];

const FIRST_CLASS_ALLOWLIST = new Map([
  [
    "src/app-server.js",
    "Browser-owned app-server JSON-RPC protocol fixture, not the native app-server runtime.",
  ],
  [
    "src/app-server-transport.js",
    "Loopback transport for the browser-owned app-server protocol fixture.",
  ],
  [
    "src/app-server-websocket.js",
    "Injectable WebSocket-compatible wrapper for the protocol fixture.",
  ],
  [
    "src/app-server-session.js",
    "Small deterministic controller over the app-server protocol fixture.",
  ],
  [
    "test/app-server.test.js",
    "Coverage for the browser-owned app-server protocol fixture.",
  ],
  [
    "test/app-server-transport.test.js",
    "Coverage for the loopback app-server transport fixture.",
  ],
  [
    "test/app-server-websocket.test.js",
    "Coverage for the WebSocket-compatible app-server fixture wrapper.",
  ],
  [
    "test/app-server-session.test.js",
    "Coverage for the deterministic app-server session fixture.",
  ],
]);

const PACKAGE_CHECK_SCRIPT = "node scripts/check-architecture.js";

const paths = await listFiles(APP_ROOT, SCAN_DIRS);
const violations = [];

for (const path of paths) {
  const normalized = path.toLowerCase();
  const match = BLOCKED_FIRST_CLASS_TERMS.find(({ term }) =>
    normalized.includes(term),
  );
  if (!match || FIRST_CLASS_ALLOWLIST.has(path)) {
    continue;
  }
  violations.push(`${path}: ${match.reason}`);
}

for (const path of paths.filter((path) => path.endsWith(".js"))) {
  const contents = await readFile(join(APP_ROOT, path), "utf8");
  for (const specifier of importSpecifiers(contents)) {
    const blocked = blockedImportTerm(specifier);
    if (!blocked) {
      continue;
    }
    violations.push(
      `${path}: imports \`${specifier}\`; high-level ${blocked} packages belong in adapter packages outside apps/web.`,
    );
  }
}

await assertPackageCheckRunsGuard(violations);

if (violations.length > 0) {
  console.error("Web architecture boundary violations:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error(
    [
      "",
      "Keep apps/web focused on low-level browser host protocols.",
      "High-level MCP/plugin/OAuth/provider/connector integrations should live",
      "in separate adapter packages or layer over protocol-neutral browser tools.",
      "Add to FIRST_CLASS_ALLOWLIST only for narrow protocol fixtures with a",
      "documented reason.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

async function assertPackageCheckRunsGuard(violations) {
  const packageJsonPath = join(APP_ROOT, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const checkScript = packageJson.scripts?.check ?? "";
  if (checkScript.includes(PACKAGE_CHECK_SCRIPT)) {
    return;
  }
  violations.push(
    `package.json: scripts.check must include \`${PACKAGE_CHECK_SCRIPT}\``,
  );
}

async function listFiles(root, dirs) {
  const files = [];
  for (const dir of dirs) {
    await walk(join(root, dir), files);
  }
  return files
    .map((path) => relative(root, path).split("\\").join("/"))
    .sort();
}

async function walk(path, files) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await walk(child, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(child);
    }
  }
}

function importSpecifiers(contents) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^'"]+?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (isBarePackageSpecifier(specifier)) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function isBarePackageSpecifier(specifier) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("node:") &&
    !specifier.startsWith("data:") &&
    !specifier.startsWith("http://") &&
    !specifier.startsWith("https://")
  );
}

function blockedImportTerm(specifier) {
  const normalized = specifier.toLowerCase();
  return BLOCKED_IMPORT_TERMS.find((term) => normalized.includes(term));
}
