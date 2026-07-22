import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const serviceName = "knowledgebase-agent-app";
const defaultAccount = "openai:default";
const defaultSecretStore = createMemorySecretStore();

export interface SecretStore {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
}

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface DesktopSettings {
  providerKeyAlias?: string;
  modelName?: string;
  workspaceRoot?: string;
}

export async function saveApiKey(
  settingsPath: string,
  apiKey: string,
  store: SecretStore = defaultSecretStore,
): Promise<void> {
  await store.setPassword(serviceName, defaultAccount, apiKey);

  const settings = await readDesktopSettings(settingsPath);
  await writeDesktopSettings(settingsPath, {
    ...settings,
    providerKeyAlias: defaultAccount,
  });
}

export async function loadApiKey(
  settingsPath: string,
  store: SecretStore = defaultSecretStore,
): Promise<string | null> {
  const settings = await readDesktopSettings(settingsPath);
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

export function createEncryptedFileSecretStore(secretsPath: string, cipher: SecretCipher): SecretStore {
  return {
    async setPassword(service, account, password) {
      if (!cipher.isEncryptionAvailable()) {
        throw new Error("Secure storage is unavailable on this machine");
      }

      const secrets = await readSecretsFile(secretsPath);
      secrets[secretKey(service, account)] = cipher.encryptString(password).toString("base64");
      await writeSecretsFile(secretsPath, secrets);
    },
    async getPassword(service, account) {
      if (!cipher.isEncryptionAvailable()) {
        return null;
      }

      const secrets = await readSecretsFile(secretsPath);
      const encrypted = secrets[secretKey(service, account)];
      if (!encrypted) {
        return null;
      }

      return cipher.decryptString(Buffer.from(encrypted, "base64"));
    },
  };
}

export async function readDesktopSettings(settingsPath: string): Promise<DesktopSettings> {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8")) as DesktopSettings;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function writeDesktopSettings(settingsPath: string, settings: DesktopSettings): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function readSecretsFile(secretsPath: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(secretsPath, "utf8")) as Record<string, string>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeSecretsFile(secretsPath: string, secrets: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(secretsPath), { recursive: true });
  await writeFile(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
}

function secretKey(service: string, account: string): string {
  return `${service}:${account}`;
}
