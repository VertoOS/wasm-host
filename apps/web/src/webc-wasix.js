export const WEBC_PACKAGE_TYPE = "webc-package";
export const WEBC_WASIX_EXECUTOR_TYPE = "webc-wasix";
export const WEBC_WASIX_UNIMPLEMENTED_KIND =
  "webc_wasix_runtime_unimplemented";

const UNSUPPORTED_CAPABILITY_EXIT_CODE = 126;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

export function createWebcWasixExecutor(options = {}) {
  return {
    async run(request) {
      validateWebcWasixCommand(request);
      throwIfAborted(request.signal);
      throw webcWasixRuntimeUnavailable(options);
    },
  };
}

function validateWebcWasixCommand(request) {
  if (!request?.package?.commands?.includes(request.command)) {
    throw {
      exitCode: COMMAND_NOT_FOUND_EXIT_CODE,
      kind: "command_not_found",
      message: `browser command not found: ${String(request?.command ?? "")}`,
      stage: "command_resolution",
    };
  }
}

function webcWasixRuntimeUnavailable(options) {
  return {
    exitCode: options.exitCode ?? UNSUPPORTED_CAPABILITY_EXIT_CODE,
    kind: options.kind ?? WEBC_WASIX_UNIMPLEMENTED_KIND,
    message:
      options.message ??
      "browser WebC/WASIX runtime execution is not implemented yet",
    stage: "runtime",
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw (
    signal.reason ?? {
      cancelled: true,
      exitCode: 130,
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    }
  );
}
