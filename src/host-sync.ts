import { isTauri } from "@tauri-apps/api/core";
import {
  loadConfiguration,
  updateConfiguration,
  type FineShellConfiguration,
} from "./config-database";
import { createDeletedHostRecord } from "./configuration-mutations";
import {
  connectionTargetKey,
  createCredentialReference,
  credentialReferenceId,
  type CredentialProbeResult,
} from "./credential-registry";
import type { HostRecord, ProxyRecord, SshKeyRecord } from "./models";
import {
  commandErrorMessage,
  emitProtocolEventTo,
  invokeProtocolCommand as invoke,
  listenProtocolEvent,
} from "./tauri-protocol";

export interface HostSyncAccount {
  accountId: string;
  email: string;
  server: string;
}

interface HostSyncConfiguration {
  hosts: HostRecord[];
  keys: SshKeyRecord[];
  proxies: ProxyRecord[];
}

interface AppliedConfiguration extends HostSyncConfiguration {
  credentials: CredentialProbeResult[];
}

interface SyncResult {
  base: object;
  expectedLocal?: object | null;
}

export interface HostSyncStatus {
  state: "working" | "success" | "failed";
  time?: string;
  message?: string;
  conflict?: boolean;
  signInRequired?: boolean;
}

const bindingKey = "fineshell.hostSync.account";
const statusKey = "fineshell.hostSync.status";

export function hostSyncAccount() {
  return invoke<HostSyncAccount | null>("host_sync_account");
}

export function hostSyncRecoveryKey() {
  return invoke<string>("host_sync_recovery_key");
}

export async function signInToHostSync(values: {
  server: string;
  email: string;
  password: string;
  recoveryKey: string;
  register: boolean;
}) {
  const boundAccount = localStorage.getItem(bindingKey);
  const account = await invoke<HostSyncAccount>("host_sync_login", {
    ...values,
    boundAccount,
  });
  localStorage.setItem(bindingKey, account.accountId);
  void requestHostSync().catch(() => undefined);
  return account;
}

export async function signOutOfHostSync() {
  await invoke("host_sync_logout");
  localStorage.removeItem(statusKey);
}

export function readHostSyncStatus(): HostSyncStatus | null {
  const raw = localStorage.getItem(statusKey);
  return raw ? JSON.parse(raw) as HostSyncStatus : null;
}

export function isHostSyncStorageEvent(event: StorageEvent) {
  return event.key === statusKey;
}

export function hostSyncIsBound() {
  return localStorage.getItem(bindingKey) !== null;
}

export function requestHostSync(keepLocal?: boolean) {
  return emitProtocolEventTo("main", "host-sync:request", { keepLocal });
}

function project(config: FineShellConfiguration): HostSyncConfiguration {
  const keys = new Set(config.hosts.map((host) => host.sshKeyId));
  const proxies = new Set(config.hosts.map((host) => host.proxyId));
  return {
    hosts: config.hosts.map(({ lastConnectedAt, hostFingerprint, ...host }) => host),
    keys: config.sshKeys.filter((key) => keys.has(key.id)),
    proxies: config.proxies.filter((proxy) => proxies.has(proxy.id)),
  };
}

function restoreLocalFields(incoming: HostRecord, local?: HostRecord) {
  if (!local || connectionTargetKey(incoming) !== connectionTargetKey(local)) return incoming;
  return {
    ...incoming,
    lastConnectedAt: local.lastConnectedAt,
    hostFingerprint: local.hostFingerprint,
  };
}

function mergeOrder<T extends { id: string }>(existing: T[], incoming: T[], keepUnmatched: boolean) {
  const byId = new Map(incoming.map((record) => [record.id, record]));
  const merged: T[] = [];
  for (const record of existing) {
    const replacement = byId.get(record.id);
    if (replacement) {
      merged.push(replacement);
      byId.delete(record.id);
    } else if (keepUnmatched) {
      merged.push(record);
    }
  }
  return [...merged, ...byId.values()];
}

function writeStatus(status: HostSyncStatus) {
  localStorage.setItem(statusKey, JSON.stringify(status));
}

async function synchronize(account: HostSyncAccount, keepLocal?: boolean) {
  const current = await loadConfiguration();
  const configuration = project(current);
  const expected = JSON.stringify(configuration);
  const { base, expectedLocal } = await invoke<SyncResult>("host_sync_exchange", {
    accountId: account.accountId,
    configuration,
    base: current.hostSyncBase ? JSON.parse(current.hostSyncBase) : null,
    keepLocal: keepLocal ?? null,
  });
  const encoded = JSON.stringify(base);
  if (encoded === current.hostSyncBase && !expectedLocal) return;

  let received: AppliedConfiguration | undefined;
  if (expectedLocal) {
    if (JSON.stringify(project(await loadConfiguration())) !== expected) {
      throw new Error("本机连接配置刚发生变化，将在下一次同步时重试");
    }
    received = await invoke<AppliedConfiguration>("host_sync_apply", {
      accountId: account.accountId,
      vault: base,
      expectedLocal,
      configuration,
    });
  }
  let changed = false;
  let committed = false;
  await updateConfiguration((latest) => {
    if (JSON.stringify(project(latest)) !== expected) return latest;
    committed = true;
    if (!received) return { ...latest, hostSyncBase: encoded };
    const local = new Map(latest.hosts.map((host) => [host.id, host]));
    const receivedIds = new Set(received.hosts.map((host) => host.id));
    const deleted = latest.hosts
      .filter((host) => !receivedIds.has(host.id))
      .map((host) => createDeletedHostRecord(host));
    const deletedIds = new Set(deleted.map(({ host }) => host.id));
    const labels = new Map(
      [...received.hosts, ...received.proxies, ...received.keys].map(({ id, name }) => [id, name]),
    );
    const references = new Map(latest.credentialReferences.map((entry) => [entry.id, entry]));
    for (const { kind, ownerId, exists } of received.credentials) {
      const id = credentialReferenceId(kind, ownerId);
      if (!exists) references.delete(id);
      else if (!references.has(id)) {
        references.set(id, createCredentialReference(kind, ownerId, labels.get(ownerId) ?? ownerId));
      }
    }
    changed = true;
    return {
      ...latest,
      hosts: mergeOrder(latest.hosts, received.hosts, false)
        .map((host) => restoreLocalFields(host, local.get(host.id))),
      sshKeys: mergeOrder(latest.sshKeys, received.keys, true),
      proxies: mergeOrder(latest.proxies, received.proxies, true),
      credentialReferences: [...references.values()],
      trash: [
        ...deleted,
        ...latest.trash.filter(({ host }) => !receivedIds.has(host.id) && !deletedIds.has(host.id)),
      ],
      hostSyncBase: encoded,
    };
  });
  if (!committed) throw new Error("本机连接配置刚发生变化，将在下一次同步时重试");
  if (changed) {
    await Promise.allSettled([
      emitProtocolEventTo("main", "configuration:changed"),
      emitProtocolEventTo("settings", "configuration:changed"),
    ]);
  }
}

export function startHostSync() {
  if (!isTauri()) return;
  let running = false;
  let queued: { keepLocal?: boolean } | undefined;

  async function run(keepLocal?: boolean) {
    if (!hostSyncIsBound()) return;
    if (running) {
      if (keepLocal !== undefined) queued = { keepLocal };
      return;
    }
    running = true;
    try {
      const account = await hostSyncAccount();
      if (!account) return;
      if (keepLocal !== undefined) writeStatus({ state: "working" });
      await synchronize(account, keepLocal);
      writeStatus({ state: "success", time: new Date().toISOString() });
    } catch (error) {
      const message = commandErrorMessage(error);
      writeStatus({
        state: "failed",
        message,
        conflict: message.startsWith("同步冲突"),
        signInRequired: message.includes("重新登录"),
      });
    } finally {
      running = false;
      if (queued) {
        const { keepLocal } = queued;
        queued = undefined;
        void run(keepLocal);
      }
    }
  }

  void listenProtocolEvent("host-sync:request", ({ payload }) => {
    void run(payload.keepLocal);
  }).catch((error) => writeStatus({ state: "failed", message: commandErrorMessage(error) }));
  window.addEventListener("online", () => void run());
  window.setInterval(() => void run(), 15_000);
  void run();
}
