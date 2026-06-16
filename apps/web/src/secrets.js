export class BrowserSecretProviderError extends Error {
  constructor(kind, message, stage = "startup", options = {}) {
    super(message);
    this.name = "BrowserSecretProviderError";
    this.kind = kind;
    this.stage = stage;
    this.exitCode = options.exitCode ?? 2;
    this.safe = options.safe === true;
  }
}

export class MemorySecretProvider {
  constructor(secrets = {}) {
    this.secrets = new Map();
    for (const [name, secret] of secretEntries(secrets)) {
      this.setSecret(name, secret);
    }
  }

  setSecret(name, secret) {
    this.secrets.set(normalizeSecretRef(name), normalizeSecretRecord(secret));
    return this;
  }

  async getBearerToken(name) {
    const record = this.secrets.get(normalizeSecretRef(name));
    if (!record || record.type !== "bearer") {
      throw secretError("browser bearer secret is unavailable");
    }
    return record.value;
  }
}

export function createMemorySecretProvider(secrets = {}) {
  return new MemorySecretProvider(secrets);
}

export async function resolveBrowserBearerSecret(provider, ref, context = {}) {
  if (ref == null || ref === "") {
    return null;
  }
  const normalizedRef = normalizeSecretRef(ref);
  if (!provider) {
    throw secretError("browser secret provider is unavailable");
  }

  try {
    if (typeof provider.getBearerToken === "function") {
      return normalizeBearerSecretValue(
        await provider.getBearerToken(normalizedRef, context),
      );
    }
    if (typeof provider.getSecret === "function") {
      return normalizeBearerSecretValue(
        await provider.getSecret(normalizedRef, context),
      );
    }
  } catch (error) {
    if (error instanceof BrowserSecretProviderError && error.safe) {
      throw error;
    }
    throw secretError("browser secret provider failed");
  }

  throw secretError("browser secret provider does not support bearer lookup");
}

function secretEntries(secrets) {
  if (secrets instanceof Map) {
    return secrets.entries();
  }
  if (Array.isArray(secrets)) {
    return secrets;
  }
  return Object.entries(secrets);
}

function normalizeSecretRecord(secret) {
  if (typeof secret === "string") {
    return { type: "bearer", value: normalizeBearerSecretValue(secret) };
  }
  const type = String(secret?.type ?? "bearer").trim();
  return {
    type,
    value: normalizeBearerSecretValue(secret?.token ?? secret?.value),
  };
}

function normalizeSecretRef(ref) {
  const text = String(ref ?? "").trim();
  if (!text) {
    throw secretError("browser secret reference is required");
  }
  return text;
}

function normalizeBearerSecretValue(value) {
  if (value && typeof value === "object") {
    return normalizeBearerSecretValue(value.token ?? value.value);
  }
  const text = String(value ?? "");
  if (!text || /[\r\n]/.test(text)) {
    throw secretError("browser bearer secret is unavailable");
  }
  return text;
}

function secretError(message) {
  return new BrowserSecretProviderError("auth_failure", message, "startup", {
    exitCode: 2,
    safe: true,
  });
}
