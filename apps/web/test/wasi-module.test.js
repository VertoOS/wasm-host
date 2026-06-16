import assert from "node:assert/strict";
import test from "node:test";
import { Worker as NodeWorker } from "node:worker_threads";

import {
  hasLocalCodexVersionSmokeArtifact,
  readLocalCodexVersionSmokeArtifact,
} from "../fixtures/codex-version-smoke-fixture.js";
import {
  fetchCodexArtifactBytes,
  parseArtifactManifestJson,
} from "../src/artifact-manifest.js";
import { createBrowserCommandWorkerRuntime } from "../src/command-worker.js";
import {
  createRawWasiModuleExecutor,
  createRawWasiModuleWorkerExecutor,
  loadRawWasiModulePackage,
} from "../src/wasi-module.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const ARGV_ECHO_WASM = base64ToBytes(
  "AGFzbQEAAAABFgRgAn9/AX9gBH9/f38Bf2ABfwBgAAAC4AEGFndhc2lfc25hcHNob3RfcHJldmlldzEOYXJnc19zaXplc19nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGFyZ3NfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MRFlbnZpcm9uX3NpemVzX2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzELZW52aXJvbl9nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQAAgMCAQMFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQABgpEAUIAQQBBBBAAGkEIQQwQAhpBwABBgAIQARpB4ABBgAQQAxpBgAFBxAAoAgA2AgBBhAFBCTYCAEEBQYABQQFBEBAEGgs=",
);

const STDERR_EXIT_WASM = base64ToBytes(
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKFAESAEECQcAAQQFBEBAAGkEHEAELCxkCAEGAAgsEYmFkCgBBwAALCAABAAAEAAAA",
);

const STDIN_ECHO_WASM = base64ToBytes(
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACZwMWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQdmZF9yZWFkAAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAMKVQFTAEEAQYABNgIAQQRBIDYCAEEAQQBBAUEQEAAaQQRBECgCADYCAEEBQQBBAUEUEAEaQQRBIDYCAEEAQQBBAUEQEAAaQRAoAgBBAEcEQEHGABACCws=",
);

const STDIN_BADF_WASM = base64ToBytes(
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRQIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQdmZF9yZWFkAAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQAAQMCAQIFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQAAgofAR0AQQBBwAE2AgBBBEEINgIAQQlBAEEBQRAQABABCw==",
);

const FDSTAT_WASM = base64ToBytes(
  "AGFzbQEAAAABFgRgAn9/AX9gBH9/f38Bf2ABfwBgAAACmgEEFndhc2lfc25hcHNob3RfcHJldmlldzENZmRfZmRzdGF0X2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzETZmRfZmRzdGF0X3NldF9mbGFncwAAFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfd3JpdGUAARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCXByb2NfZXhpdAACAwMCAgMFAwEAAQYQA38AQQALfwBBIAt/AEEwCwcTAgZtZW1vcnkCAAZfc3RhcnQABQqSAwIGACAAEAMLiAMBAX9BACMAEAAhACAABEBBChAECyMALQAAQQJHBEBBCxAECyMAQQJqLwEAQQBHBEBBDBAECyMAQQhqKQMAQgpSBEBBDRAECyMAQRBqKQMAQgBSBEBBDhAEC0EAQQQQASEAIAAEQEEPEAQLQQAjABAAIQAgAARAQRAQBAsjAEECai8BAEEARwRAQREQBAtBASMAEAAhACAABEBBFBAECyMALQAAQQJHBEBBFRAECyMAQQJqLwEAQQBHBEBBFhAECyMAQQhqKQMAQsgAUgRAQRcQBAsjAEEQaikDAEIAUgRAQRgQBAtBAUEEEAEhACAABEBBGRAEC0ECIwAQACEAIAAEQEEeEAQLIwBBCGopAwBCyABSBEBBHxAEC0ECQQQQASEAIAAEQEEgEAQLIwBB4wA6AABBCSMAEAAhACAAQQhHBEBBKBAECyMALQAAQeMARwRAQSkQBAtBCUEEEAEhACAAQQhHBEBBKhAECyMBQcAANgIAIwFBBGpBCjYCAEEBIwFBASMCEAIaCwsRAQBBwAALCmZkc3RhdC1vawo=",
);

const CLOCK_RANDOM_WASM = base64ToBytes(
  "AGFzbQEAAAABHQVgA39+fwF/YAJ/fwF/YAR/f39/AX9gAX8AYAAAArkBBRZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxDmNsb2NrX3RpbWVfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQ1jbG9ja19yZXNfZ2V0AAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQpyYW5kb21fZ2V0AAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQACFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAMDAwIDBAUDAQACBhsFfwBBAAt/AEEQC38AQSALfwBBMAt/AEGACAsHEwIGbWVtb3J5AgAGX3N0YXJ0AAYKlQMCBgAgABAEC4sDAQJ/QQAjARABIQAgAARAQQoQBQsjASkDAFAEQEELEAULQQBCACMAEAAhACAABEBBDBAFCyMAKQMAUARAQQ0QBQtBASMBEAEhACAABEBBFBAFCyMBKQMAUARAQRUQBQtBAUIAIwAQACEAIAAEQEEWEAULIwApAwBQBEBBFxAFCyMAQojvmavF6IyRETcDAEEJQgAjABAAIQAgAEEcRwRAQR4QBQsjACkDAEKI75mrxeiMkRFSBEBBHxAFCyMBQpHEzKHUytm7iH83AwBBCSMBEAEhACAAQRxHBEBBIBAFCyMBKQMAQpHEzKHUytm7iH9SBEBBIRAFCyMEQfCiBBACIQAgAARAQSgQBQsjBCgCACMEQQRqKAIAciMEQQhqKAIAIwRBDGooAgByciEBIAFFBEBBKRAFCyMEQdCDBGooAgAjBEHUgwRqKAIAciMEQdiDBGooAgAjBEHcgwRqKAIAcnIhASABRQRAQSoQBQsjAkHAADYCACMCQQRqQRA2AgBBASMCQQEjAxADGgsLFwEAQcAACxBjbG9jay1yYW5kb20tb2sK",
);

const SCHED_YIELD_WASM = base64ToBytes(
  "AGFzbQEAAAABGgVgAAF/YAR/f39/AX9gAX8AYAN/f38AYAAAAmsDFndhc2lfc25hcHNob3RfcHJldmlldzELc2NoZWRfeWllbGQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQAAgMEAwMDBAUDAQABBxMCBm1lbW9yeQIABl9zdGFydAAFClADDgAgACABRwRAIAIQAgsLKwBBACAANgIAQQQgATYCAEEBQQBBAUEIEAFBACACEANBCCgCACABIAIQAwsTABAAQQBBChADQYAIQQ9BCxAECwsWAQBBgAgLD3NjaGVkLXlpZWxkLW9rCg==",
);

const READ_FILE_WASM = base64ToBytes(
  "AGFzbQEAAAABLwdgAn9/AX9gA39/fwF/YAl/f39/f35+f38Bf2AEf39/fwF/YAF/AX9gAX8AYAAAAqoCCBZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxDmZkX3ByZXN0YXRfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MRNmZF9wcmVzdGF0X2Rpcl9uYW1lAAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwYXRoX29wZW4AAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxD2ZkX2ZpbGVzdGF0X2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfcmVhZAADFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfY2xvc2UABBZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAMWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQABQMDAgUGBQMBAAEGPAp/AEEAC38AQcAAC38AQaABC38AQbABC38AQbQBC38AQbgBC38AQcABC38AQYACC38AQYAEC38AQaAECwcTAgZtZW1vcnkCAAZfc3RhcnQACQqxBAIGACAAEAcLpwQBAn9BAyMAEAAhACAABEBBChAICyMALQAAQQBHBEBBCxAICyMAQQRqKAIAQQpHBEBBDBAIC0EDIwZBChABIQAgAARAQQ0QCAsjBi0AAEEvRwRAQQ4QCAsjBkEJai0AAEHlAEcEQEEPEAgLQQMQBSEAIABBCEcEQEEQEAgLIwIjBzYCACMCQQRqQSA2AgBBAyMCQQEjAxAEIQAgAEEfRwRAQREQCAsjBUHjADYCAEEDQQAjCUELQQBCAkIAQQAjBRACIQAgAEEsRwRAQRQQCAsjBSgCAEHjAEcEQEEVEAgLQQlBACMIQQlBAEICQgBBACMFEAIhACAAQQhHBEBBFhAIC0EBQQAjCEEJQQBCAkIAQQAjBRACIQAgAEHMAEcEQEEXEAgLQQNBACMIQQlBAUICQgBBACMFEAIhACAAQcwARwRAQRgQCAtBA0EAIwhBCUEAQgJCAEEAIwUQAiEAIAAEQEEeEAgLIwUoAgAhASABQQNNBEBBHxAICyABIwEQAyEAIAAEQEEgEAgLIwFBEGotAABBBEcEQEEhEAgLIwFBIGopAwBCDVIEQEEiEAgLIwIjBzYCACMCQQRqQSA2AgAgASMCQQEjAxAEIQAgAARAQSgQCAsjAygCAEENRwRAQSkQCAsgARAFIQAgAARAQSoQCAsgASMCQQEjAxAEIQAgAEEIRwRAQSsQCAsjAiMHNgIAIwJBBGpBDTYCAEEBIwJBASMEEAYaCwshAgBBgAQLCWhlbGxvLnR4dABBoAQLC21pc3NpbmcudHh0",
);

const PATH_FILESTAT_WASM = base64ToBytes(
  "AGFzbQEAAAABMwdgBX9/f39/AX9gCX9/f39/fn5/fwF/YAF/AX9gBH9/f38Bf2ABfwBgBX9/f35/AGAAAAK2AQUWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MRFwYXRoX2ZpbGVzdGF0X2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF9jbG9zZQACFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfd3JpdGUAAxZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCXByb2NfZXhpdAAEAwQDBAUGBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAcKtwMDBwAgABAEAAs/AEEDQQAgACABQcAAEABBAEcEQCAEEAULQdAALQAAIAJHBEAgBEEBahAFC0HgACkDACADUgRAIARBAmoQBQsL7AIBAX9BgAhBAUEDQgBBChAGQQNBAEGBCEEAQcAAEABBLEcEQEENEAULQYEIQRBBBEINQRAQBkEDQQFBgQhBEEHAABAAQQBHBEBBExAFC0EDQQBBkQhBC0HAABAAQSxHBEBBFBAFC0EDQQBBnQhBDEHAABAAQcwARwRAQRUQBQtBA0EAQaoIQRtBwAAQAEHMAEcEQEEWEAULQQNBAkGBCEEQQcAAEABBHEcEQEEXEAULQeMAQQBBgQhBEEHAABAAQQhHBEBBGBAFC0EAQQBBgQhBEEHAABAAQQJHBEBBGRAFC0EDQQBBgQhBEEEAQgJCAEEAQSAQAUEARwRAQRoQBQtBICgCACEAIABBAEGBCEEQQcAAEABBAkcEQEEbEAULIAAQAkEARwRAQRwQBQsgAEEAQYEIQRBBwAAQAEEIRwRAQR0QBQtBgAFByAg2AgBBhAFBETYCAEEBQYABQQFBiAEQA0EARwRAQR4QBQsLC3kGAEGACAsBLgBBgQgLEG5lc3RlZC9oZWxsby50eHQAQZEICwttaXNzaW5nLnR4dABBnQgLDC4uL2hlbGxvLnR4dABBqggLGy93b3Jrc3BhY2UvbmVzdGVkL2hlbGxvLnR4dABByAgLEXBhdGgtZmlsZXN0YXQtb2sK",
);

const FD_READDIR_WASM = base64ToBytes(
  "AGFzbQEAAAABPwlgBX9/f35/AX9gCX9/f39/fn5/fwF/YAF/AX9gBH9/f38Bf2ABfwBgA39/fwBgA35+fwBgBX9+f39/AGAAAAKvAQUWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQpmZF9yZWFkZGlyAAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwYXRoX29wZW4AARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX2Nsb3NlAAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQADFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAQDBgUEBQYHCAUDAQABBxMCBm1lbW9yeQIABl9zdGFydAAJCtsEBQcAIAAQBAALDgAgACABRwRAIAIQBQsLDgAgACABUgRAIAIQBQsLQAAgACkDACABIAQQByAAQQhqKQMAIAEgBEEBahAHIABBEGooAgAgAiAEQQJqEAYgAEEUai0AACADIARBA2oQBgvxAwEBf0EDQYAQQYACQgBBwAAQAEEAQQoQBkHAACgCAEHfAEELEAZBgBBCAUEJQQRBFBAIQZgQKAIAQeHYwcMGQRgQBkGcECgCAEHh3NDDB0EZEAZBoBAtAABB9ABBGhAGQaEQQgJBBkEDQR4QCEG5ECgCAEHuys2jB0EiEAZBvRAvAQBB5cgBQSMQBkG/EEIDQQhBBEEoEAhB1xAoAgBB+srRiwZBLBAGQdsQKAIAQa7o4aMHQS0QBkEDQYAYQYACQgFBwAAQAEEAQTIQBkHAACgCAEE+QTMQBkGAGEICQQZBA0E0EAhBmBgoAgBB7srNowdBOBAGQZwYLwEAQeXIAUE5EAZBA0GAIEEKQgBBwAAQAEEAQTwQBkHAACgCAEEKQT0QBkEDQYAgQYACQuMAQcAAEABBAEE+EAZBwAAoAgBBAEE/EAZBAEGAIEGAAkIAQcAAEABBNkHAABAGQeMAQYAgQYACQgBBwAAQAEEIQcEAEAZBA0EAQYAIQQlBAEICQgBBAEEgEAFBAEHCABAGQSAoAgAhACAAQYAgQYACQgBBwAAQAEE2QcMAEAYgABACQQBBxAAQBiAAQYAgQYACQgBBwAAQAEEIQcUAEAZBgAFBzAg2AgBBhAFBDjYCAEEBQYABQQFBiAEQA0EAQcYAEAYLCyQCAEGACAsJYWxwaGEudHh0AEHMCAsOZmQtcmVhZGRpci1vawo=",
);

const FD_READDIR_EMPTY_WASM = base64ToBytes(
  "AGFzbQEAAAABGQRgBX9/f35/AX9gBH9/f38Bf2ABfwBgAAACagMWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQpmZF9yZWFkZGlyAAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAIDAwICAwUDAQABBxMCBm1lbW9yeQIABl9zdGFydAAEClwCBwAgABACAAtSAEEDQYAQQYABQgBBwAAQAEEARwRAQQoQAwtBwAAoAgBBAEcEQEELEAMLQYABQYAINgIAQYQBQRE2AgBBAUGAAUEBQYgBEAFBAEcEQEEMEAMLCwsYAQBBgAgLEWVtcHR5LXJlYWRkaXItb2sK",
);

const SEEK_TELL_WASM = base64ToBytes(
  "AGFzbQEAAAABOAhgCX9/f39/fn5/fwF/YAR/fn9/AX9gAn9/AX9gBH9/f38Bf2ABfwF/YAR/f39/AX9gAX8AYAAAAu4BBxZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCXBhdGhfb3BlbgAAFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfc2VlawABFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfdGVsbAACFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfcmVhZAADFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfY2xvc2UABBZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAUWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQABgMDAgYHBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAgKiQYCBwAgABAGAAv+BQEBf0EDQQBBgAhBCEEAQiZCAEEAQSAQAEEARwRAQQoQBwtBICgCACEAIABBKBACQQBHBEBBCxAHC0EoKQMAQgBSBEBBDBAHCyAAQgZBAEEoEAFBAEcEQEENEAcLQSgpAwBCBlIEQEEOEAcLIABBKBACQQBHBEBBDxAHC0EoKQMAQgZSBEBBEBAHC0HAAEGAEDYCAEHEAEEFNgIAIABBwABBAUE4EANBAEcEQEEREAcLQTgoAgBBBUcEQEESEAcLQYAQLQAAQfcARwRAQRMQBwtBgRAtAABB7wBHBEBBFBAHC0GCEC0AAEHyAEcEQEEVEAcLQYMQLQAAQewARwRAQRYQBwtBhBAtAABB5ABHBEBBFxAHCyAAQSgQAkEARwRAQRgQBwtBKCkDAEILUgRAQRkQBwsgAEJ6QQFBKBABQQBHBEBBGhAHC0EoKQMAQgVSBEBBGxAHCyAAQntBAkEoEAFBAEcEQEEcEAcLQSgpAwBCB1IEQEEdEAcLIABCf0EAQSgQAUEcRwRAQR4QBwsgAEJ4QQFBKBABQRxHBEBBHxAHCyAAQnNBAkEoEAFBHEcEQEEgEAcLIABCACAAQhxBAEEoEAFBAEcEQEEuEAcLQSgpAwBCHFIEQEEvEAcLIABCB0EAQSgQAUEARwRAQTAQBwtBKCkDAEIHUgRAQTEQBwtB4wBBKBABQRxHBEBBIRAHCyAAQv///////////wBBAEEoEAFBPUcEQEEiEAcLIABBKBACQQBHBEBBIxAHC0EoKQMAQgdSBEBBJBAHC0HjAEEoEAJBCEcEQEElEAcLQQNCAEEAQSgQAUECRwRAQSYQBwtBAEEoEAJBAkcEQEEnEAcLQQFCAEEAQSgQAUECRwRAQSgQBwtBAkEoEAJBAkcEQEEpEAcLIAAQBEEARwRAQSoQBwsgAEEoEAJBCEcEQEErEAcLIABCAEEAQSgQAUEIRwRAQSwQBwtBwABBiAg2AgBBxABBDTYCAEEBQcAAQQFBOBAFQQBHBEBBLRAHCwsLIgIAQYAICwhzZWVrLnR4dABBiAgLDXNlZWstdGVsbC1vawo=",
);

const TMP_SCRATCH_WASM = base64ToBytes(
  "AGFzbQEAAAABUQxgAn9/AX9gA39/fwF/YAR/f39/AX9gBX9/f39/AX9gCX9/f39/fn5/fwF/YAR/fn9/AX9gAX8AYAF/AX9gA39/fwBgA35+fwBgAn9/AGAAAALHAwwWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQ5mZF9wcmVzdGF0X2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzETZmRfcHJlc3RhdF9kaXJfbmFtZQABFndhc2lfc25hcHNob3RfcHJldmlldzENZmRfZmRzdGF0X2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAQWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQACFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfc2VlawAFFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfcmVhZAACFndhc2lfc25hcHNob3RfcHJldmlldzEPZmRfZmlsZXN0YXRfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MRFwYXRoX2ZpbGVzdGF0X2dldAADFndhc2lfc25hcHNob3RfcHJldmlldzEQcGF0aF91bmxpbmtfZmlsZQABFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfY2xvc2UABxZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCXByb2NfZXhpdAAGAwcGCAgJCAoLBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0ABEKpwQGDgAgACABRwRAIAIQCwsLDgAgACABRwRAIAIQCwsLDgAgACABUgRAIAIQCwsLEQAgAC0AACABRwRAIAIQCwsLLQBBACAANgIAQQQgATYCAEEBQQBBAUEgEARBAEHGABAMQSAoAgAgAUHHABANC7cDAQF/QQRBEBAAQQBBChAMQRQoAgBBBEELEA1BBEGwAkEEEAFBAEEMEAxBsAJBL0ENEA9BsQJB9ABBDhAPQbICQe0AQQ8QD0GzAkHwAEEQEA9BBUEQEABBCEEREAxBBEEwEAJBAEESEAxBMC0AAEEDQRMQDUEDQQBBgAJBCEEBQsAAQgBBAEEgEANBzABBFBAMQQRBAEGAAkEIQQlC5oCAAUIAQQBBIBADQQBBFRAMQSAoAgAiAEEFQRYQDUEAQaACNgIAQQRBCzYCACAAQQBBAUEkEARBAEEXEAxBJCgCAEELQRgQDSAAQgBBAEEoEAVBAEEZEAxBKCkDAEIAQRoQDkEAQaABNgIAQQRBCzYCACAAQQBBAUEkEAZBAEEbEAxBJCgCAEELQRwQDUGgAUELEBAgAEHAABAHQQBBHRAMQdAALQAAQQRBHhANQeAAKQMAQgtBHxAOQQRBAEGAAkEIQcAAEAhBAEEgEAxB0AAtAABBBEEhEA1B4AApAwBCC0EiEA4gABAKQQBBIxAMQQRBgAJBCBAJQQBBJBAMQQRBAEGAAkEIQcAAEAhBLEElEAxBwAJBDxAQCws1AwBBgAILCG5vdGUudHh0AEGgAgsLc2NyYXRjaC1vawoAQcACCw90bXAtc2NyYXRjaC1vawo=",
);

const TMP_DIRS_WASM = base64ToBytes(
  "AGFzbQEAAAABYg5gAn9/AX9gA39/fwF/YAR/f39/AX9gBX9/f39/AX9gCX9/f39/fn5/fwF/YAR/fn9/AX9gBX9/f35/AX9gAX8AYAF/AX9gA39/fwBgA35+fwBgAn9/AGAFf39/f38AYAAAAp4DCxZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxFXBhdGhfY3JlYXRlX2RpcmVjdG9yeQABFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAQWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQACFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfc2VlawAFFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfcmVhZAACFndhc2lfc25hcHNob3RfcHJldmlldzEKZmRfcmVhZGRpcgAGFndhc2lfc25hcHNob3RfcHJldmlldzEPZmRfZmlsZXN0YXRfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MRFwYXRoX2ZpbGVzdGF0X2dldAADFndhc2lfc25hcHNob3RfcHJldmlldzEQcGF0aF91bmxpbmtfZmlsZQABFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfY2xvc2UACBZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCXByb2NfZXhpdAAHAwcGCQkKCwwNBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0ABAKhQUGDgAgACABRwRAIAIQCgsLDgAgACABRwRAIAIQCgsLDgAgACABUgRAIAIQCgsLLQBBACAANgIAQQQgATYCAEEBQQBBAUEgEAJBAEHaABALQSAoAgAgAUHbABAMC1UBAX8gAEEQaigCACABIAQQDCAAQRRqLQAAIAIgBEEBahAMQQAhBQNAIAUgAUkEQCAAQRhqIAVqLQAAIAMgBWotAAAgBEECahAMIAVBAWohBQwBCwsL0QMBAn9BBEGQAkEOEABBLEEKEAtBBEGAAkEFEABBAEELEAtBBEGAAkEFEABBFEEMEAtBBEEAQYACQQVBwAAQB0EAQQ0QC0HQAC0AAEEDQQ4QDEEEQQBBkAJBDkEJQuaAgAFCAEEAQSAQAUEAQQ8QC0EgKAIAIgBBBUEQEAxBAEGwAjYCAEEEQQc2AgAgAEEAQQFBJBACQQBBERALQSQoAgBBB0ESEAwgAEIAQQBBKBADQQBBExALQQBBtAE2AgBBBEEHNgIAIABBAEEBQSQQBEEAQRQQC0EkKAIAQQdBFRAMQbQBQQcQDiAAQcAAEAZBAEEWEAtB4AApAwBCB0EXEA1BBEGABEHAAEIAQSwQBUEAQRgQC0EsKAIAQR1BGRAMQYAEQQVBA0GAAkEaEA9BBEEAQYACQQVBAkKAgAFCAEEAQSAQAUEAQR4QC0EgKAIAIgFBBkEfEAwgAUGABEHAAEIAQSwQBUEAQSAQC0EsKAIAQSBBIRAMQYAEQQhBBEGWAkEiEA9BBEGAAkEFEAhBH0EoEAsgABAJQQBBKRALIAEQCUEAQSoQC0EEQZACQQ4QCEEAQSsQC0EEQQBBkAJBDkHAABAHQSxBLBALQcACQQsQDgsLPgQAQYACCwVidWlsZABBkAILDmJ1aWxkL25vdGUudHh0AEGwAgsHZGlyLW9rCgBBwAILC3RtcC1kaXItb2sK",
);

const TMP_RMDIR_WASM = base64ToBytes(
  "AGFzbQEAAAABOAhgA39/fwF/YAV/f39/fwF/YAl/f39/f35+f38Bf2AEf39/fwF/YAF/AGADf39/AGACf38AYAAAApwCBxZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxFXBhdGhfY3JlYXRlX2RpcmVjdG9yeQAAFndhc2lfc25hcHNob3RfcHJldmlldzEVcGF0aF9yZW1vdmVfZGlyZWN0b3J5AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MRFwYXRoX2ZpbGVzdGF0X2dldAABFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQADFndhc2lfc25hcHNob3RfcHJldmlldzEQcGF0aF91bmxpbmtfZmlsZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAQDBAMFBgcFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQACQrkAwMOACAAIAFHBEAgAhAGCws2AEHAACAANgIAQcQAIAE2AgBBAUHAAEEBQcgAEARBAEHaABAHQcgAKAIAIAFHBEBB2wAQBgsLmwMBAn9BBEGABEEFEABBAEEKEAdBBEGABEEFEAFBAEELEAdBBEEAQYAEQQVBgAEQAkEsQQwQB0EEQZAEQQQQAEEAQRQQB0EEQQBBoARBDUEBQsAAQgBBAEHQABADQQBBFRAHQdAAKAIAIQBBwABBsAQ2AgBBxABBATYCACAAQcAAQQFByAAQBEEAQRYQB0EEQZAEQQQQAUE3QRcQB0EEQaAEQQ0QAUE2QRgQB0EEQaAEQQ0QBUEAQRkQB0EEQZAEQQQQAUEAQRoQB0EEQQBBwARBBkEBQsAAQgBBAEHQABADQQBBGxAHQQRB0ARBDBABQTZBHBAHQQRB4ARBBxABQSxBHRAHQQRB8ARBBBABQcwAQR4QB0EDQYAEQQUQAUHMAEEfEAdBBEGABUEEEABBAEEoEAdBBEGQBUEJEABBAEEpEAdBBEEAQYAFQQRBAkIAQgBBAEHUABADQQBBKhAHQdQAKAIAIQEgAUGgBUEBEAFBzABBKxAHIAFBpQVBBBABQQBBLBAHQQRBgAVBBBABQQBBLRAHQbAFQQ0QCAsLogENAEGABAsFZW1wdHkAQZAECwR3b3JrAEGgBAsNd29yay9ub3RlLnR4dABBsAQLAXgAQcAECwZwYXJlbnQAQdAECwxwYXJlbnQvY2hpbGQAQeAECwdtaXNzaW5nAEHwBAsELi4veABBgAULBGJhc2UAQZAFCwliYXNlL2xlYWYAQaAFCwEuAEGlBQsEbGVhZgBBsAULDXRtcC1ybWRpci1vawo=",
);

const FD_RESIZE_SYNC_WASM = base64ToBytes(
  "AGFzbQEAAAABRwtgCX9/f39/fn5/fwF/YAR/f39/AX9gBH9+f38Bf2ACf38Bf2ACf34Bf2ABfwF/YAF/AGADf39/AGACf38AYAN/fn8AYAAAAsgCCRZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCXBhdGhfb3BlbgAAFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfd3JpdGUAARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxB2ZkX3JlYWQAARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxB2ZkX3NlZWsAAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxD2ZkX2ZpbGVzdGF0X2dldAADFndhc2lfc25hcHNob3RfcHJldmlldzEUZmRfZmlsZXN0YXRfc2V0X3NpemUABBZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxB2ZkX3N5bmMABRZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC2ZkX2RhdGFzeW5jAAUWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQABgMFBAcICQoFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQADArsBAQOACAAIAFHBEAgAhAICws2AEHAACAANgIAQcQAIAE2AgBBAUHAAEEBQcgAEAFBAEHaABAJQcgAKAIAIAFHBEBB2wAQCAsLHwAgAEGAARAEQQAgAhAJQaABKQMAIAFSBEAgAhAICwuDBAECf0EEQQBBkARBCkEBQteAgANCAEEAQdAAEABBAEEKEAlB0AAoAgAhAEHAAEGABDYCAEHEAEEGNgIAIABBwABBAUHIABABQQBBCxAJQcgAKAIAQQZHBEBBDBAICyAAQgZBDRALIAAQBkEAQQ4QCSAAEAdBAEEPEAkgAEIDEAVBAEEQEAkgAEIDQREQCyAAQgBBAEHYABADQQBBEhAJQcAAQYACNgIAQcQAQQg2AgAgAEHAAEEBQcgAEAJBAEETEAlByAAoAgBBA0cEQEEUEAgLQYACLQAAQeEARwRAQRUQCAtBggItAABB4wBHBEBBFhAICyAAQgUQBUEAQRcQCSAAQgVBGBALIABCAEEAQdgAEANBAEEZEAkgAEHAAEEBQcgAEAJBAEEaEAlByAAoAgBBBUcEQEEbEAgLQYMCLQAAQQBHBEBBHBAIC0GEAi0AAEEARwRAQR0QCAsgAEJ/EAVBHEEeEAkgAEKAgICAgICAEBAFQT1BHxAJQQNBAEGgBEEMQQBCgoCAAUIAQQBB1AAQAEEAQSgQCUHUACgCACEBIAFCABAFQcwAQSkQCSABEAZBzABBKhAJIAEQB0HMAEErEAlBBEIAEAVBH0EyEAlBBBAGQR9BMxAJQQQQB0EfQTQQCUHjAEIAEAVBCEE1EAlB4wAQBkEIQTYQCUGwBEESEAoLC0cEAEGABAsGYWJjZGVmAEGQBAsKcmVzaXplLmJpbgBBoAQLDHJlYWRvbmx5LnR4dABBsAQLEmZkLXJlc2l6ZS1zeW5jLW9rCg==",
);

const FD_ALLOCATE_WASM = base64ToBytes(
  "AGFzbQEAAAABWw1gCX9/f39/fn5/fwF/YAN/fn4Bf2ACf38Bf2AEf39/fwF/YAR/fn9/AX9gAX8AYAN/f38AYAN+fn8AYAZ/f39/fn8Bf2AFf35+f38AYAN/fn8AYAJ/fwBgAAAC+QEHFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQtmZF9hbGxvY2F0ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEPZmRfZmlsZXN0YXRfZ2V0AAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQADFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfcmVhZAADFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfc2VlawAEFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAUDCgkGBwYICQoKCwwFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQADwrLBAkOACAAIAFHBEAgAhAGCwsOACAAIAFSBEAgAhAGCwsrAEEAIAA2AgBBBCABNgIAQQFBAEEBQQgQA0EAIAIQB0EIKAIAIAEgAhAHCyEAIABBACABIAIgAyAEQgBBAEEQEABBACAFEAdBECgCAAsQACAAIAEgAhABIAMgBBAHCxsAIABBwAAQAkEAIAIQB0HgACkDACABIAIQCAs8ACAAIAFBAEEYEAVBACACEAdBAEGgAjYCAEEEQQM2AgAgAEEAQQFBCBADQQAgAhAHQQgoAgBBAyACEAcLnwEAIABCAEEAQRgQBUEAIAEQB0EAQYABNgIAQQRBCDYCACAAQQBBAUEIEARBACABEAdBCCgCAEEIIAEQB0GAAS0AAEEAIAEQB0GBAS0AAEEAIAEQB0GCAS0AAEEAIAEQB0GDAS0AAEEAIAEQB0GEAS0AAEEAIAEQB0GFAS0AAEHhACABEAdBhgEtAABB4gAgARAHQYcBLQAAQeMAIAEQBwvRAQEBf0EEQYAIQQlBAULmgoABQQoQCiEAIABCBUIDQQBBCxALIABCCEEMEAwgAEIFQQ0QDSAAQQ4QDiAAQgJCAEEAQQ8QCyAAQghBEBAMIABC/////////w9CAUE9QREQCyAAQn9CAUEcQRIQC0EEQYoIQQtBAULmgIABQRMQCiEAIABCAEIBQcwAQRQQC0EDQZYIQQxBAEKugIABQRUQCiEAIABCAEIBQcwAQRYQC0EEQgBCAUEfQRcQC0HjAEIAQgFBCEEYEAtBowhBD0EZEAkLC1EFAEGgAgsDYWJjAEGACAsJYWxsb2MuYmluAEGKCAsLbm9hbGxvYy5iaW4AQZYICwxyZWFkb25seS50eHQAQaMICw9mZC1hbGxvY2F0ZS1vawo=",
);

const FD_ADVISE_WASM = base64ToBytes(
  "AGFzbQEAAAABKwZgCX9/f39/fn5/fwF/YAR/fn5/AX9gBH9/f38Bf2ABfwBgA39/fwBgAAACjAEEFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlmZF9hZHZpc2UAARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQAAwMEAwQFBQUDAQABBxMCBm1lbW9yeQIABl9zdGFydAAGCtkCAw4AIAAgAUcEQCACEAMLCyIAQQBBoAI2AgBBBEENNgIAQQFBAEEBQQgQAkEAQcYAEAQLpAIBAX9BBEEAQYACQQpBAULAAUIAQQBBEBAAQQBBChAEQRAoAgAhACAAQgBCAEEAEAFBAEELEAQgAEIAQgFBARABQQBBDBAEIABCAEIBQQIQAUEAQQ0QBCAAQgBCAUEDEAFBAEEOEAQgAEIAQgFBBBABQQBBDxAEIABCAEIBQQUQAUEAQRAQBCAAQgBCAUEGEAFBHEEREAQgAEJ/QgFBABABQRxBEhAEIABCAEJ/QQAQAUEcQRMQBCAAQv////////8PQgFBABABQT1BFBAEQQRCAEIBQQAQAUEfQRUQBEHjAEIAQgFBABABQQhBFhAEQQNBAEGQAkEMQQBCgAFCAEEAQRQQAEEAQR4QBEEUKAIAIQAgAEIAQgFBAxABQQBBHxAEEAULCzYDAEGAAgsKYWR2aXNlLmJpbgBBkAILDHJlYWRvbmx5LnR4dABBoAILDWZkLWFkdmlzZS1vawo=",
);

const TMP_RENAME_WASM = base64ToBytes(
  "AGFzbQEAAAABYw1gCX9/f39/fn5/fwF/YAN/f38Bf2AGf39/f39/AX9gBH9/f38Bf2AEf35/fwF/YAF/AX9gAX8AYAN/f38AYAJ/fwBgBH9/fn8Bf2AHf39/f35/fwBgCH9/f39/f39/AGAAAAKhAggWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwYXRoX29wZW4AABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxFXBhdGhfY3JlYXRlX2RpcmVjdG9yeQABFndhc2lfc25hcHNob3RfcHJldmlldzELcGF0aF9yZW5hbWUAAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAMWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQdmZF9yZWFkAAMWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQdmZF9zZWVrAAQWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF9jbG9zZQAFFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAYDDAsHBwgIAwkKBwsIDAUDAQABBxMCBm1lbW9yeQIABl9zdGFydAASCq0JCw4AIAAgAUcEQCACEAcLCysAQQAgADYCAEEEIAE2AgBBAUEAQQFBCBADQQAgAhAIQQgoAgAgASACEAgLLABBAEGgAjYCAEEEQQM2AgAgAEEAQQFBCBADQQAgARAIQQgoAgBBAyABEAgLYwAgAEIAQQBBGBAFQQAgARAIQQBBgAE2AgBBBEEDNgIAIABBAEEBQQgQBEEAIAEQCEEIKAIAQQMgARAIQYABLQAAQeEAIAEQCEGBAS0AAEHiACABEAhBggEtAABB4wAgARAICyQAQQRBACAAIAEgAkLmgIABQgBBAEEQEABBACADEAhBECgCAAshAEEEQQAgACABQQIgAkIAQQBBEBAAQQAgAxAIQRAoAgALHAAgAEEAIAEgAiADIARCAEEAQRAQACAFIAYQCAsQAEEEIAAgARABQQAgAhAICxYAIAAgASACIAMgBCAFEAIgBiAHEAgLDAAgABAGQQAgARAIC8UGAQN/QYAIQQlBAUEKEAwhAiACQQsQCkEEQYAIQQlBBEGKCEEIQQBBDBAQIAJBDRALQQRBgAhBCUEAQq6AgAFBLEEOEA5BighBCEEAQQ8QDCEAIABBEBALQZMIQQxBAUEREAwhACAAQRIQEUEEQYoIQQhBBEGTCEEMQQBBExAQIAJBFBALQQRBighBCEEAQq6AgAFBLEEVEA5BkwhBDEEAQRYQDCEAIABBFxALQeAJQQpBGBAPQQRBkwhBDEEEQeAJQQpBH0EZEBBBoAhBA0EaEA9BqghBDUEBQRsQDCEAIABBHBAKIABBHRARQQRBoAhBA0EEQaQIQQVBAEEeEBBBuAhBD0EAQR8QDCEAIABBIBALQQRBqghBDUEAQq6AgAFBLEEhEA5BBEGkCEEFQQRBkwhBDEE2QSIQEEEEQaQIQQVBBEHWCUEJQRxBIxAQQYUKQQxBJBAPQQRBpAhBBUEEQYUKQQxBAEElEBBBvApBFkEAQSYQDCEAIABBJxALQfsJQQlBKBAPQZIKQQ9BKRAPQaIKQRlBAUEqEAwhACAAQSsQEUEEQfsJQQlBBEGSCkEPQTdBLBAQQcgIQQRBLRAPQc0IQQ1BAUEuEAwhACAAQS8QCiAAQTAQEUHICEEEQoCADEExEA0hASABQdsIQQggAUHkCEELQQBBMhAQQfAIQRBBAEEzEAwhACAAQTQQC0EEQcgIQQRBBEGBCUEGQQBBNRAQIAFB5AhBCyABQYgJQQlBAEE2EBBBkglBEEEAQTcQDCEAIABBOBALQQRB8AhBEEEAQq6AgAFBLEE5EA5BgQlBBkKAgAhBOhANIQEgAUGICUEJQQRBighBCEHMAEE7EBBBgQlBBkKAgARBPBANIQFBBEGSCUEQIAFBighBCEHMAEE9EBBBA0GTCEEMQQRBighBCEHMAEE+EBBBBEGTCEEMQQNBighBCEHMAEE/EBBBBEGjCUEEQQRBighBCEHMAEHAABAQQQRBkwhBDEEEQagJQRFBLEHBABAQQboJQQpBAUHCABAMIQAgAEHDABARQQRBkwhBDEEEQcUJQRBBNkHEABAQQeMAQZMIQQxBBEGKCEEIQQhBxQAQEEHTCkEOQcYAEAkLC+MDHABBoAILA2FiYwBBgAgLCWFscGhhLnR4dABBiggLCGJldGEudHh0AEGTCAsMZXhpc3RpbmcudHh0AEGgCAsDZGlyAEGkCAsFbW92ZWQAQaoICw1kaXIvY2hpbGQudHh0AEG4CAsPbW92ZWQvY2hpbGQudHh0AEHICAsEYmFzZQBBzQgLDWJhc2UvZmlsZS50eHQAQdsICwhmaWxlLnR4dABB5AgLC3JlbmFtZWQudHh0AEHwCAsQYmFzZS9yZW5hbWVkLnR4dABBgQkLBm9wZW5lZABBiAkLCWFnYWluLnR4dABBkgkLEG9wZW5lZC9hZ2Fpbi50eHQAQaMJCwQuLi94AEGoCQsRbWlzc2luZy9jaGlsZC50eHQAQboJCwpwYXJlbnQudHh0AEHFCQsQcGFyZW50LnR4dC9jaGlsZABB1gkLCW1vdmVkL3N1YgBB4AkLCnRhcmdldC1kaXIAQfsJCwllbXB0eS1zcmMAQYUKCwxlbXB0eS10YXJnZXQAQZIKCw9ub25lbXB0eS10YXJnZXQAQaIKCxlub25lbXB0eS10YXJnZXQvY2hpbGQudHh0AEG8CgsWZW1wdHktdGFyZ2V0L2NoaWxkLnR4dABB0woLDnRtcC1yZW5hbWUtb2sK",
);

const MISSING_MEMORY_WASM = base64ToBytes(
  "AGFzbQEAAAABBAFgAAADAgEABwoBBl9zdGFydAAACgQBAgAL",
);

const UNSUPPORTED_IMPORT_WASM = base64ToBytes(
  "AGFzbQEAAAABCgJgAn9/AX9gAAACJgEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQtmZF9yZW51bWJlcgAAAwIBAQUDAQABBxMCBm1lbW9yeQIABl9zdGFydAABCgsBCQBBAEEBEAAaCw==",
);

const NON_COOPERATIVE_LOOP_WASM = base64ToBytes(
  "AGFzbQEAAAABBAFgAAADAgEABQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAAKCQEHAANADAALCw==",
);

test("loadRawWasiModulePackage validates explicit raw WASI module bytes", async () => {
  const expectedSha256 = await sha256Hex(ARGV_ECHO_WASM);
  const record = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: ARGV_ECHO_WASM,
    command: "codex",
    expectedSha256,
    id: "codex",
    metadata: { fixture: "argv-echo" },
  });

  assert.equal(record.id, "codex");
  assert.equal(record.artifactKind, "wasi-module");
  assert.equal(record.type, "wasi-module");
  assert.equal(record.entrypoint, "_start");
  assert.deepEqual(record.commands, ["codex"]);
  assert.equal(record.byteLength, ARGV_ECHO_WASM.byteLength);
  assert.equal(record.contentSha256, expectedSha256);
  assert.equal(record.metadata.fixture, "argv-echo");
  assert.equal(record.metadata.wasi, "preview1");
});

test("loadRawWasiModulePackage rejects invalid bytes and sha mismatches", async () => {
  await assert.rejects(
    loadRawWasiModulePackage({
      artifactKind: "wasi-module",
      bytes: new Uint8Array([1, 2, 3]),
      command: "codex",
    }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.equal(error.stage, "package_load");
      assert.match(error.message, /Wasm magic/);
      return true;
    },
  );

  await assert.rejects(
    loadRawWasiModulePackage({
      artifactKind: "wasi-module",
      bytes: ARGV_ECHO_WASM,
      command: "codex",
      expectedSha256: "0".repeat(64),
    }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.match(error.message, /^raw WASI module sha256 mismatch:/);
      return true;
    },
  );
});

test("command worker loads and runs a raw WASI module fixture", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-codex",
    package: {
      artifactKind: "wasi-module",
      command: "codex",
      id: "codex",
      wasiModule: {
        bytes: ARGV_ECHO_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-codex",
    packageId: "codex",
    command: "codex",
    args: ["--version"],
  });

  const loaded = port.messages.find((message) => message.type === "command.loaded");
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.match(loaded.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(stdoutText(port.messages), "--version");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-codex",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 9,
      timedOut: false,
    },
  });
});

test("raw WASI executor captures stderr and proc_exit status", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor();
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: STDERR_EXIT_WASM,
    command: "codex",
    id: "codex",
  });

  const result = await executor.run(
    {
      args: [],
      command: "codex",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 7 });
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, "bad\n");
});

test("raw WASI executor serves preloaded stdin through fd_read", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor();
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: STDIN_ECHO_WASM,
    command: "cat",
    id: "cat",
  });

  const result = await executor.run(
    {
      args: [],
      command: "cat",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
      stdin: asyncByteChunks(["hello ", "world\n"]),
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "hello world\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor treats missing stdin as EOF", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor();
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: STDIN_ECHO_WASM,
    command: "cat",
    id: "cat",
  });

  const result = await executor.run(
    {
      args: [],
      command: "cat",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, "");
});

test("raw WASI fd_read reports BADF for non-stdin fds", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor();
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: STDIN_BADF_WASM,
    command: "badf",
    id: "badf",
  });

  const result = await executor.run(
    {
      args: [],
      command: "badf",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
      stdin: asyncByteChunks(["ignored"]),
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 8 });
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, "");
});

test("raw WASI executor supports stdio fd stat imports", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: FDSTAT_WASM,
    command: "fdstat",
    id: "fdstat",
  });

  const result = await executor.run(
    {
      args: [],
      command: "fdstat",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "fdstat-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor supports clock and random imports", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: CLOCK_RANDOM_WASM,
    command: "clock-random",
    id: "clock-random",
  });
  const randomChunks = [];
  const originalGetRandomValues = globalThis.crypto.getRandomValues;
  globalThis.crypto.getRandomValues = (array) => {
    randomChunks.push(array.byteLength);
    array.fill(randomChunks.length);
    return array;
  };

  let result;
  try {
    result = await executor.run(
      {
        args: [],
        command: "clock-random",
        env: {},
        package: packageRecord,
        signal: new AbortController().signal,
      },
      output,
    );
  } finally {
    globalThis.crypto.getRandomValues = originalGetRandomValues;
  }

  assert.deepEqual(result, { exitCode: 0 });
  assert.deepEqual(randomChunks, [65536, 4464]);
  assert.equal(output.stdout, "clock-random-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor supports sched_yield", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: SCHED_YIELD_WASM,
    command: "sched-yield",
    id: "sched-yield",
  });

  const result = await executor.run(
    {
      args: [],
      command: "sched-yield",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "sched-yield-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor reads packaged files through a workspace preopen", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: READ_FILE_WASM,
    command: "read-file",
    files: {
      "hello.txt": "from package\n",
    },
    id: "read-file",
  });

  const result = await executor.run(
    {
      args: [],
      command: "read-file",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(packageRecord.metadata.fileCount, 1);
  assert.equal(output.stdout, "from package\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor stats packaged files by path", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: PATH_FILESTAT_WASM,
    command: "path-filestat",
    files: {
      "nested/hello.txt": "from package\n",
    },
    id: "path-filestat",
  });

  const result = await executor.run(
    {
      args: [],
      command: "path-filestat",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "path-filestat-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor lists packaged files through fd_readdir", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: FD_READDIR_WASM,
    command: "fd-readdir",
    files: {
      "alpha.txt": "alpha\n",
      "nested/hello.txt": "nested\n",
      "zeta.txt": "zeta\n",
    },
    id: "fd-readdir",
  });

  const result = await executor.run(
    {
      args: [],
      command: "fd-readdir",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "fd-readdir-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor reports an empty workspace through fd_readdir", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: FD_READDIR_EMPTY_WASM,
    command: "empty-readdir",
    id: "empty-readdir",
  });

  const result = await executor.run(
    {
      args: [],
      command: "empty-readdir",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "empty-readdir-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor seeks and tells packaged files", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: SEEK_TELL_WASM,
    command: "seek-tell",
    files: {
      "seek.txt": "hello world\n",
    },
    id: "seek-tell",
  });

  const result = await executor.run(
    {
      args: [],
      command: "seek-tell",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "seek-tell-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor writes scratch files through a tmp preopen", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: TMP_SCRATCH_WASM,
    command: "tmp-scratch",
    id: "tmp-scratch",
  });

  const result = await executor.run(
    {
      args: [],
      command: "tmp-scratch",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "scratch-ok\ntmp-scratch-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor creates and lists scratch directories", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: TMP_DIRS_WASM,
    command: "tmp-dirs",
    id: "tmp-dirs",
  });

  const result = await executor.run(
    {
      args: [],
      command: "tmp-dirs",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "dir-ok\ntmp-dir-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor removes scratch directories", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: TMP_RMDIR_WASM,
    command: "tmp-rmdir",
    id: "tmp-rmdir",
  });

  const result = await executor.run(
    {
      args: [],
      command: "tmp-rmdir",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "tmp-rmdir-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor resizes and syncs scratch files", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: FD_RESIZE_SYNC_WASM,
    command: "fd-resize-sync",
    files: {
      "readonly.txt": "readonly\n",
    },
    id: "fd-resize-sync",
  });

  const result = await executor.run(
    {
      args: [],
      command: "fd-resize-sync",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "fd-resize-sync-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor allocates scratch file space", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: FD_ALLOCATE_WASM,
    command: "fd-allocate",
    files: {
      "readonly.txt": "readonly\n",
    },
    id: "fd-allocate",
  });

  const result = await executor.run(
    {
      args: [],
      command: "fd-allocate",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "fd-allocate-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor accepts file advice hints", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: FD_ADVISE_WASM,
    command: "fd-advise",
    files: {
      "readonly.txt": "readonly\n",
    },
    id: "fd-advise",
  });

  const result = await executor.run(
    {
      args: [],
      command: "fd-advise",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "fd-advise-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI executor renames scratch paths", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor({ worker: false });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: TMP_RENAME_WASM,
    command: "tmp-rename",
    id: "tmp-rename",
  });

  const result = await executor.run(
    {
      args: [],
      command: "tmp-rename",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "tmp-rename-ok\n");
  assert.equal(output.stderr, "");
});

test("raw WASI worker executor forwards output and exit status", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleWorkerExecutor({
    createWorker: createNodeWasiWorker,
  });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: ARGV_ECHO_WASM,
    command: "codex",
    id: "codex",
  });

  const result = await executor.run(
    {
      args: ["--version"],
      command: "codex",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "--version");
  assert.equal(output.stderr, "");
  assert.equal(packageRecord.bytes.byteLength, ARGV_ECHO_WASM.byteLength);

  const secondOutput = recordingOutput();
  const secondResult = await executor.run(
    {
      args: ["again-run"],
      command: "codex",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    secondOutput,
  );
  assert.deepEqual(secondResult, { exitCode: 0 });
  assert.equal(secondOutput.stdout, "again-run");
});

test("raw WASI worker executor forwards preloaded stdin", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleWorkerExecutor({
    createWorker: createNodeWasiWorker,
  });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: STDIN_ECHO_WASM,
    command: "cat",
    id: "cat",
  });

  const result = await executor.run(
    {
      args: [],
      command: "cat",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
      stdin: asyncByteChunks(["worker ", "stdin\n"]),
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "worker stdin\n");
  assert.equal(output.stderr, "");
  assert.equal(packageRecord.bytes.byteLength, STDIN_ECHO_WASM.byteLength);
});

test("raw WASI worker request carries only preloaded stdin bytes", async () => {
  const output = recordingOutput();
  const worker = recordingWasiWorker();
  const executor = createRawWasiModuleWorkerExecutor({
    createWorker: () => worker,
  });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: STDIN_ECHO_WASM,
    command: "cat",
    id: "cat",
  });

  const result = await executor.run(
    {
      args: [],
      command: "cat",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
      stdin: asyncByteChunks(["transfer"]),
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].type, "wasi.run");
  assert.equal(worker.messages[0].request.stdin, undefined);
  assert.deepEqual(
    worker.messages[0].request.stdinBytes,
    encoder.encode("transfer"),
  );
  assert.deepEqual(worker.transferLists, [
    [worker.messages[0].request.stdinBytes.buffer],
  ]);
  assert.equal(packageRecord.bytes.byteLength, STDIN_ECHO_WASM.byteLength);
});

test("command worker passes initial stdin to raw WASI modules", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await loadStdinEchoPackage(runtime);
  await runtime.handleMessage({
    type: "command.run",
    id: "run-cat",
    packageId: "cat",
    command: "cat",
    stdinChunks: [encoder.encode("hello "), encoder.encode("cat\n")],
  });

  assert.equal(stdoutText(port.messages), "hello cat\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-cat",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 10,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that inspect stdio fd stat", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-fdstat",
    package: {
      artifactKind: "wasi-module",
      command: "fdstat",
      id: "fdstat",
      wasiModule: {
        bytes: FDSTAT_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-fdstat",
    packageId: "fdstat",
    command: "fdstat",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "fdstat-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-fdstat",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 10,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that use clock and random imports", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-clock-random",
    package: {
      artifactKind: "wasi-module",
      command: "clock-random",
      id: "clock-random",
      wasiModule: {
        bytes: CLOCK_RANDOM_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-clock-random",
    packageId: "clock-random",
    command: "clock-random",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "clock-random-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-clock-random",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 16,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that yield cooperatively", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-sched-yield",
    package: {
      artifactKind: "wasi-module",
      command: "sched-yield",
      id: "sched-yield",
      wasiModule: {
        bytes: SCHED_YIELD_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-sched-yield",
    packageId: "sched-yield",
    command: "sched-yield",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "sched-yield-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-sched-yield",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 15,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules with packaged files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-read-file",
    package: {
      artifactKind: "wasi-module",
      command: "read-file",
      id: "read-file",
      wasiModule: {
        bytes: READ_FILE_WASM,
        files: [
          {
            content: "from package\n",
            path: "/workspace/hello.txt",
          },
        ],
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-read-file",
    packageId: "read-file",
    command: "read-file",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "from package\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-read-file",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 13,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that stat packaged files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-path-filestat",
    package: {
      artifactKind: "wasi-module",
      command: "path-filestat",
      id: "path-filestat",
      wasiModule: {
        bytes: PATH_FILESTAT_WASM,
        files: [
          {
            content: "from package\n",
            path: "/workspace/nested/hello.txt",
          },
        ],
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-path-filestat",
    packageId: "path-filestat",
    command: "path-filestat",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "path-filestat-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-path-filestat",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 17,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that list packaged files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-fd-readdir",
    package: {
      artifactKind: "wasi-module",
      command: "fd-readdir",
      id: "fd-readdir",
      wasiModule: {
        bytes: FD_READDIR_WASM,
        files: [
          {
            content: "zeta\n",
            path: "/workspace/zeta.txt",
          },
          {
            content: "nested\n",
            path: "/workspace/nested/hello.txt",
          },
          {
            content: "alpha\n",
            path: "/workspace/alpha.txt",
          },
        ],
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-fd-readdir",
    packageId: "fd-readdir",
    command: "fd-readdir",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "fd-readdir-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-fd-readdir",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 14,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that seek packaged files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-seek-tell",
    package: {
      artifactKind: "wasi-module",
      command: "seek-tell",
      id: "seek-tell",
      wasiModule: {
        bytes: SEEK_TELL_WASM,
        files: [
          {
            content: "hello world\n",
            path: "/workspace/seek.txt",
          },
        ],
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-seek-tell",
    packageId: "seek-tell",
    command: "seek-tell",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "seek-tell-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-seek-tell",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 13,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules with scratch tmp files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tmp-scratch",
    package: {
      artifactKind: "wasi-module",
      command: "tmp-scratch",
      id: "tmp-scratch",
      wasiModule: {
        bytes: TMP_SCRATCH_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-tmp-scratch",
    packageId: "tmp-scratch",
    command: "tmp-scratch",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "scratch-ok\ntmp-scratch-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-tmp-scratch",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 26,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules with scratch directories", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tmp-dirs",
    package: {
      artifactKind: "wasi-module",
      command: "tmp-dirs",
      id: "tmp-dirs",
      wasiModule: {
        bytes: TMP_DIRS_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-tmp-dirs",
    packageId: "tmp-dirs",
    command: "tmp-dirs",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "dir-ok\ntmp-dir-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-tmp-dirs",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 18,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules with scratch directory removal", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tmp-rmdir",
    package: {
      artifactKind: "wasi-module",
      command: "tmp-rmdir",
      id: "tmp-rmdir",
      wasiModule: {
        bytes: TMP_RMDIR_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-tmp-rmdir",
    packageId: "tmp-rmdir",
    command: "tmp-rmdir",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "tmp-rmdir-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-tmp-rmdir",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 13,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that resize scratch files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-fd-resize-sync",
    package: {
      artifactKind: "wasi-module",
      command: "fd-resize-sync",
      id: "fd-resize-sync",
      wasiModule: {
        bytes: FD_RESIZE_SYNC_WASM,
        files: [
          {
            content: "readonly\n",
            path: "/workspace/readonly.txt",
          },
        ],
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-fd-resize-sync",
    packageId: "fd-resize-sync",
    command: "fd-resize-sync",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "fd-resize-sync-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-fd-resize-sync",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 18,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that allocate scratch files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-fd-allocate",
    package: {
      artifactKind: "wasi-module",
      command: "fd-allocate",
      id: "fd-allocate",
      wasiModule: {
        bytes: FD_ALLOCATE_WASM,
        files: [
          {
            content: "readonly\n",
            path: "/workspace/readonly.txt",
          },
        ],
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-fd-allocate",
    packageId: "fd-allocate",
    command: "fd-allocate",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "fd-allocate-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-fd-allocate",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 15,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules that advise files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-fd-advise",
    package: {
      artifactKind: "wasi-module",
      command: "fd-advise",
      id: "fd-advise",
      wasiModule: {
        bytes: FD_ADVISE_WASM,
        files: [
          {
            content: "readonly\n",
            path: "/workspace/readonly.txt",
          },
        ],
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-fd-advise",
    packageId: "fd-advise",
    command: "fd-advise",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "fd-advise-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-fd-advise",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 13,
      timedOut: false,
    },
  });
});

test("command worker runs raw WASI modules with scratch renames", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tmp-rename",
    package: {
      artifactKind: "wasi-module",
      command: "tmp-rename",
      id: "tmp-rename",
      wasiModule: {
        bytes: TMP_RENAME_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-tmp-rename",
    packageId: "tmp-rename",
    command: "tmp-rename",
  });

  const loaded = port.messages.find(
    (message) => message.type === "command.loaded",
  );
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.equal(stdoutText(port.messages), "tmp-rename-ok\n");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-tmp-rename",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 14,
      timedOut: false,
    },
  });
});

test("command worker preloads streaming stdin before raw WASI start", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await loadStdinEchoPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "run-stream-cat",
    packageId: "cat",
    command: "cat",
    stdinOpen: true,
  });
  await waitForMessage(
    port.messages,
    (message) =>
      message.type === "command.started" && message.id === "run-stream-cat",
  );
  await runtime.handleMessage({
    type: "command.stdin",
    id: "run-stream-cat",
    chunk: encoder.encode("stream "),
  });
  await runtime.handleMessage({
    type: "command.stdin",
    id: "run-stream-cat",
    chunk: encoder.encode("stdin\n"),
  });
  await runtime.handleMessage({
    type: "command.stdin.end",
    id: "run-stream-cat",
  });
  await run;

  assert.equal(stdoutText(port.messages), "stream stdin\n");
  assert.equal(stderrText(port.messages), "");
  assert.equal(port.messages.at(-1).type, "command.complete");
  assert.equal(port.messages.at(-1).result.stdoutBytes, 13);
});

test("command worker can cancel raw WASI stdin preload", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await loadStdinEchoPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "cancel-cat",
    packageId: "cat",
    command: "cat",
    stdinOpen: true,
  });
  await waitForMessage(
    port.messages,
    (message) => message.type === "command.started" && message.id === "cancel-cat",
  );
  await runtime.handleMessage({ type: "command.cancel", id: "cancel-cat" });
  await withTimeout(run, 1000, "raw WASI stdin preload cancel did not finish");

  assert.equal(stdoutText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "cancel-cat",
    error: {
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    },
    result: {
      cancelled: true,
      exitCode: 130,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("command worker can time out raw WASI stdin preload", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await loadStdinEchoPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "timeout-cat",
    packageId: "cat",
    command: "cat",
    stdinOpen: true,
    timeoutMs: 20,
  });
  await withTimeout(run, 1000, "raw WASI stdin preload timeout did not finish");

  assert.equal(stdoutText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "timeout-cat",
    error: {
      kind: "timeout",
      message: "browser command exceeded wall time limit",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: 124,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: true,
    },
  });
});

test("raw WASI executor reports command resolution failures", async () => {
  const executor = createRawWasiModuleExecutor();
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: ARGV_ECHO_WASM,
    command: "codex",
    id: "codex",
  });

  await assert.rejects(
    executor.run(
      {
        args: [],
        command: "other",
        env: {},
        package: packageRecord,
        signal: new AbortController().signal,
      },
      recordingOutput(),
    ),
    (error) => {
      assert.equal(error.kind, "command_not_found");
      assert.equal(error.stage, "command_resolution");
      assert.equal(error.exitCode, 127);
      return true;
    },
  );
});

test("raw WASI executor reports invalid modules and unsupported imports", async () => {
  const executor = createRawWasiModuleExecutor();
  const missingMemory = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: MISSING_MEMORY_WASM,
    command: "codex",
    id: "codex",
  });
  const unsupportedImport = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: UNSUPPORTED_IMPORT_WASM,
    command: "codex",
    id: "codex",
  });

  await assert.rejects(
    executor.run(baseRunRequest(missingMemory), recordingOutput()),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.equal(error.stage, "package_load");
      assert.match(error.message, /export memory/);
      return true;
    },
  );

  await assert.rejects(
    executor.run(baseRunRequest(unsupportedImport), recordingOutput()),
    (error) => {
      assert.equal(error.kind, "runtime");
      assert.match(error.message, /fd_renumber/);
      return true;
    },
  );
});

test("command worker times out non-cooperative raw WASI modules", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    wasiModule: { createWorker: createNodeWasiWorker },
  });

  await loadLoopPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "timeout-loop",
    packageId: "loop",
    command: "loop",
    timeoutMs: 50,
  });
  await withTimeout(run, 1000, "raw WASI timeout run did not finish");

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "timeout-loop",
    error: {
      kind: "timeout",
      message: "browser command exceeded wall time limit",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: 124,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: true,
    },
  });
});

test("command worker cancels non-cooperative raw WASI modules", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    wasiModule: { createWorker: createNodeWasiWorker },
  });

  await loadLoopPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "cancel-loop",
    packageId: "loop",
    command: "loop",
  });
  await waitForMessage(
    port.messages,
    (message) => message.type === "command.started" && message.id === "cancel-loop",
  );
  await runtime.handleMessage({ type: "command.cancel", id: "cancel-loop" });
  await withTimeout(run, 1000, "raw WASI cancel run did not finish");

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "cancel-loop",
    error: {
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    },
    result: {
      cancelled: true,
      exitCode: 130,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test(
  "local Codex version-smoke artifact runs through the browser WASI executor",
  {
    skip:
      !hasLocalCodexVersionSmokeArtifact()
        ? "local Codex WASI artifact is not available"
        : false,
  },
  async () => {
    const { bytes: artifactBytes, manifestText } =
      await readLocalCodexVersionSmokeArtifact();
    const manifest = parseArtifactManifestJson(
      manifestText,
    );
    const { fixture } = await fetchCodexArtifactBytes(manifest, {
      fetchImpl: async () =>
        new Response(artifactBytes, {
          headers: { "Content-Length": String(artifactBytes.byteLength) },
          status: 200,
        }),
    });
    const port = recordingPort();
    const runtime = createBrowserCommandWorkerRuntime({
      httpTransports: { direct: {} },
      port,
    });

    await runtime.handleMessage(fixture.commandLoad);
    await runtime.handleMessage(fixture.commandRun);

    assert.equal(port.messages.at(-1).type, "command.complete");
    assert.equal(port.messages.at(-1).result.exitCode, fixture.expected.exitCode);
    assert.match(stdoutText(port.messages), /^codex-cli /);
    assert.equal(stderrText(port.messages), fixture.expected.stderr);
  },
);

function recordingPort() {
  const messages = [];
  return {
    messages,
    postMessage(message) {
      messages.push(message);
    },
  };
}

function loadLoopPackage(runtime) {
  return runtime.handleMessage({
    type: "command.load",
    id: "load-loop",
    package: {
      artifactKind: "wasi-module",
      command: "loop",
      id: "loop",
      wasiModule: {
        bytes: NON_COOPERATIVE_LOOP_WASM,
      },
    },
  });
}

function loadStdinEchoPackage(runtime) {
  return runtime.handleMessage({
    type: "command.load",
    id: "load-cat",
    package: {
      artifactKind: "wasi-module",
      command: "cat",
      id: "cat",
      wasiModule: {
        bytes: STDIN_ECHO_WASM,
      },
    },
  });
}

function baseRunRequest(packageRecord) {
  return {
    args: [],
    command: "codex",
    env: {},
    package: packageRecord,
    signal: new AbortController().signal,
  };
}

function createNodeWasiWorker() {
  const worker = new NodeWorker(
    new URL("../fixtures/wasi-module-node-worker-entry.js", import.meta.url),
  );
  const listeners = new Map();
  return {
    postMessage(message, transferList) {
      worker.postMessage(message, transferList);
    },
    terminate() {
      return worker.terminate();
    },
    addEventListener(type, listener) {
      const eventName = workerEventName(type);
      const wrapped =
        type === "message" ? (data) => listener({ data }) : (error) => listener(error);
      listeners.set(listener, { eventName, wrapped });
      worker.on(eventName, wrapped);
    },
    removeEventListener(_type, listener) {
      const record = listeners.get(listener);
      if (!record) {
        return;
      }
      listeners.delete(listener);
      worker.off(record.eventName, record.wrapped);
    },
  };
}

function recordingWasiWorker() {
  const listeners = new Map();
  return {
    messages: [],
    terminated: false,
    transferLists: [],
    postMessage(message, transferList = []) {
      this.messages.push(message);
      this.transferLists.push(transferList);
      const listener = listeners.get("message");
      queueMicrotask(() => {
        listener?.({
          data: {
            type: "wasi.complete",
            id: message.id,
            result: { exitCode: 0 },
          },
        });
      });
    },
    terminate() {
      this.terminated = true;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    },
  };
}

async function* asyncByteChunks(chunks) {
  for (const chunk of chunks) {
    yield typeof chunk === "string" ? encoder.encode(chunk) : chunk;
  }
}

function workerEventName(type) {
  return type === "message" ? "message" : type;
}

async function waitForMessage(messages, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const message = messages.find(predicate);
    if (message) {
      return message;
    }
    await delay(5);
  }
  throw new Error(`timed out waiting for message: ${JSON.stringify(messages)}`);
}

function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordingOutput() {
  return {
    stderr: "",
    stdout: "",
    async writeStderr(chunk) {
      this.stderr += decoder.decode(chunk);
    },
    async writeStdout(chunk) {
      this.stdout += decoder.decode(chunk);
    },
  };
}

function stdoutText(messages) {
  return chunksText(messages, "command.stdout");
}

function stderrText(messages) {
  return chunksText(messages, "command.stderr");
}

function chunksText(messages, type) {
  return decoder.decode(
    concatBytes(
      messages
        .filter((message) => message.type === type)
        .map((message) => message.chunk),
    ),
  );
}

function concatBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
