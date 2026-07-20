import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const serviceName = "knowledgebase-agent-app";
const defaultAccount = "openai:default";

export interface SecretStore {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
}

export interface DesktopSettings {
  providerKeyAlias?: string;
  modelName?: string;
}

export async function saveApiKey(
  settingsPath: string,
  apiKey: string,
  store: SecretStore = createMemorySecretStore(),
): Promise<void> {
  await store.setPassword(serviceName, defaultAccount, apiKey);

  const settings = await readSettings(settingsPath);
  await writeSettings(settingsPath, {
    ...settings,
    providerKeyAlias: defaultAccount,
  });
}

export async function loadApiKey(
  settingsPath: string,
  store: SecretStore = createMemorySecretStore(),
): Promise<string | null> {
  const settings = await readSettings(settingsPath);
  if (!settings.providerKeyAlias) {
    return null;
  }

  return store.getPassword(serviceName, settings.providerKeyAlias);
}

export function createMemorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();

  return {
    async setPassword(service, account, password) {
      secrets.set(`${service}:${account}`, password);
    },
    async getPassword(service, account) {
      return secrets.get(`${service}:${account}`) ?? null;
    },
  };
}

async function readSettings(settingsPath: string): Promise<DesktopSettings> {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8")) as DesktopSettings;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeSettings(settingsPath: string, settings: DesktopSettings): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
