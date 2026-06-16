import { parentPort, workerData } from "node:worker_threads";

import { startBrowserCommandWorker } from "../src/command-worker-entry.js";
import {
  createFakeBrowserDeviceFlowAuthBroker,
  createMemorySecretProvider,
} from "../src/secrets.js";

if (!parentPort) {
  throw new Error("command worker entry fixture requires parentPort");
}

const secretProvider = await createCodexBrowserSecretProvider(workerData);

startBrowserCommandWorker({
  codexBrowser: secretProvider ? { secretProvider } : undefined,
  gatewayEndpoint: workerData?.gatewayEndpoint,
  port: parentPort,
});

async function createCodexBrowserSecretProvider(data = {}) {
  if (data.codexBrowserDeviceAuth) {
    const auth = createFakeBrowserDeviceFlowAuthBroker(
      data.codexBrowserDeviceAuth.options,
    );
    const login = await auth.startDeviceLogin({
      accountHint: data.codexBrowserDeviceAuth.accountHint,
      scopes: data.codexBrowserDeviceAuth.scopes,
      secretRef: data.codexBrowserDeviceAuth.secretRef,
      userCode: data.codexBrowserDeviceAuth.userCode,
    });
    if (data.codexBrowserDeviceAuth.bearerToken) {
      await auth.completeDeviceLogin(login.loginId, {
        account: data.codexBrowserDeviceAuth.account,
        bearerToken: data.codexBrowserDeviceAuth.bearerToken,
      });
    }
    return auth;
  }
  if (data.codexBrowserSecrets) {
    return createMemorySecretProvider(data.codexBrowserSecrets);
  }
  return null;
}
