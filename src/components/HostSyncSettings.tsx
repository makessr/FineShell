import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Input, Message, Popconfirm, Space, Typography } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { commandErrorMessage } from "../tauri-protocol";
import {
  hostSyncAccount,
  hostSyncDevices,
  relinkHostSyncKey,
  type BlockedSyncRecord,
  type HostSyncDevice,
  type SyncOptions,
  hostSyncIsBound,
  hostSyncRecoveryKey,
  isHostSyncStorageEvent,
  readHostSyncStatus,
  requestHostSync,
  signInToHostSync,
  signOutOfHostSync,
  type HostSyncAccount,
} from "../host-sync";

export default function HostSyncSettings() {
  const [account, setAccount] = useState<HostSyncAccount | null>(null);
  const [status, setStatus] = useState(readHostSyncStatus);
  const [loading, setLoading] = useState(isTauri);
  const [busy, setBusy] = useState(false);
  const [register, setRegister] = useState(false);
  const [server, setServer] = useState<string>(
    import.meta.env.VITE_FINESHELL_SYNC_URL || "https://auto.itfans.fun",
  );
  const [email, setEmail] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [devices, setDevices] = useState<HostSyncDevice[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [confirmedKey, setConfirmedKey] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    void hostSyncAccount().then((value) => {
      if (!mounted) return;
      setAccount(value);
      if (value) {
        setServer(value.server);
        setEmail(value.email);
      }
    }).catch((error) => {
      if (mounted) Message.error(commandErrorMessage(error));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    function refresh(event: StorageEvent) {
      if (isHostSyncStorageEvent(event)) {
        setStatus(readHostSyncStatus());
        setChoices({});
      }
    }
    window.addEventListener("storage", refresh);
    return () => {
      mounted = false;
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const accountId = account?.accountId;
  useEffect(() => {
    if (!accountId || status?.signInRequired) return;
    let active = true;
    void hostSyncDevices(accountId).then((value) => {
      if (active) {
        setDevices(value);
        setDeviceError("");
      }
    }).catch((error) => {
      if (active) setDeviceError(commandErrorMessage(error));
    });
    return () => { active = false; };
  }, [accountId, status?.signInRequired]);

  async function refreshDevices(revoke?: string) {
    if (!accountId) return;
    setBusy(true);
    try {
      setDevices(await hostSyncDevices(accountId, revoke));
      setDeviceError("");
    } catch (error) {
      setDeviceError(commandErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function relink(issue: BlockedSyncRecord) {
    try {
      const path = await open({ title: "选择 SSH 私钥文件", multiple: false, directory: false });
      if (typeof path === "string") await relinkHostSyncKey(issue, path);
    } catch (error) {
      Message.error(commandErrorMessage(error));
    }
  }

  function describe(record: Record<string, unknown> | null, other: Record<string, unknown> | null) {
    if (!record) return "已删除";
    const keys = new Set([...Object.keys(record), ...Object.keys(other ?? {})]);
    const fields = [...keys]
      .filter((key) => key !== "id" && key !== "name" &&
        JSON.stringify(record[key]) !== JSON.stringify(other?.[key]))
      .map((key) => [key, record[key] ?? null]);
    return <div>
      {String(record.name ?? "")}
      {fields.length > 0 && <details>
        <summary>查看配置差异</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(Object.fromEntries(fields), null, 2)}</pre>
      </details>}
    </div>;
  }

  async function changeMode(next: boolean) {
    try {
      const key = next ? await hostSyncRecoveryKey() : "";
      setRecoveryKey(key);
      setConfirmedKey("");
      setRegister(next);
    } catch (error) {
      Message.error(commandErrorMessage(error));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      setAccount(await signInToHostSync({ server, email, password, recoveryKey, register, deviceName }));
      setStatus(null);
      setRegister(false);
      setRecoveryKey("");
      setConfirmedKey("");
      Message.success("已登录，正在同步主机");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await signOutOfHostSync();
      setAccount(null);
      setStatus(null);
      setRecoveryKey("");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function sync(options: SyncOptions = {}) {
    void requestHostSync({ ...options, manual: true }).catch((error) => Message.error(commandErrorMessage(error)));
  }

  if (!isTauri()) return <Alert content="请在 FineShell 桌面应用中使用主机同步。" />;
  if (loading) return <Typography.Text>正在读取同步账号…</Typography.Text>;

  if (account && !status?.signInRequired) {
    return (
      <Space direction="vertical" size="large">
        <Typography.Text>{account.email}</Typography.Text>
        {status?.message && <Alert type="error" content={status.message} />}
        {status?.state === "working" && <Typography.Text>正在同步主机…</Typography.Text>}
        {status?.time && (
          <Typography.Text type="secondary">
            最近同步 {new Date(status.time).toLocaleString()}
          </Typography.Text>
        )}
        <Space wrap>
          <Button type="primary" onClick={() => sync()}>立即同步</Button>
          <Button loading={busy} onClick={() => void signOut()}>退出登录</Button>
        </Space>
        {status?.recoverable && (
          <Popconfirm content="以这台设备最后验证的快照恢复云端？" onOk={() => sync({ recover: true })}>
            <Button status="warning">恢复云端快照</Button>
          </Popconfirm>
        )}
        {status?.blocked?.map((issue) => (
          <Space key={issue.kind + "/" + issue.id} wrap>
            <Typography.Text>{issue.name} 的 SSH 密钥或关联主机无法读取</Typography.Text>
            {issue.relink && <Button onClick={() => void relink(issue)}>重新关联私钥</Button>}
          </Space>
        ))}
        {!!status?.conflicts?.length && status.snapshot && (
          <Space direction="vertical">
            <Typography.Title heading={6}>解决同步冲突</Typography.Title>
            {status.conflicts.map((conflict) => (
              <fieldset key={conflict.id}>
                <legend>{String(conflict.local?.name ?? conflict.cloud?.name ?? conflict.id)}</legend>
                {conflict.credentialChanged && <Typography.Text>两端凭据有差异</Typography.Text>}
                {(["local", "cloud"] as const).map((side) => (
                  <div key={side}>
                    <label>
                      <input type="radio" name={conflict.id} autoComplete="off"
                        checked={choices[conflict.id] === (side === "local")}
                        onChange={() => setChoices((current) => ({ ...current, [conflict.id]: side === "local" }))}
                      />
                      {side === "local" ? "保留本机版本" : "保留云端版本"}
                    </label>
                    {describe(conflict[side], conflict[side === "local" ? "cloud" : "local"])}
                  </div>
                ))}
              </fieldset>
            ))}
            <Button type="primary" disabled={status.conflicts.some(({ id }) => choices[id] === undefined)}
              onClick={() => status.snapshot && sync({ resolution: { snapshot: status.snapshot, choices } })}>
              应用选择并同步
            </Button>
          </Space>
        )}
        <Space direction="vertical">
          <Typography.Title heading={6}>已登录设备</Typography.Title>
          {deviceError && <Alert type="warning" content={deviceError} />}
          {devices.map((device) => (
            <Space key={device.id} wrap>
              <Typography.Text>{device.name}{device.current ? "（本机）" : ""}</Typography.Text>
              <Typography.Text type="secondary">
                {device.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString() : "尚无同步记录"}
              </Typography.Text>
              {!device.current && (
                <Popconfirm content="撤销后，该设备必须重新登录才能同步。"
                  onOk={() => refreshDevices(device.id)}>
                  <Button status="danger" loading={busy}>撤销登录</Button>
                </Popconfirm>
              )}
            </Space>
          ))}
          <Button loading={busy} onClick={() => void refreshDevices()}>刷新设备列表</Button>
        </Space>
      </Space>
    );
  }

  return (
    <form onSubmit={submit}>
      <Space direction="vertical" size="medium" style={{ width: "100%" }}>
        <Typography.Paragraph>
          登录后自动同步已保存的主机、分组和相关凭据。新设备首次登录时使用恢复密钥解锁。
        </Typography.Paragraph>
        {status?.signInRequired && <Alert type="warning" content={status.message} />}
        <label>
          同步服务地址
          <Input value={server} onChange={setServer} placeholder="https://sync.example.com" />
        </label>
        <label>
          邮箱
          <Input value={email} onChange={setEmail} autoComplete="username" />
        </label>
        <label>
          设备名称
          <Input value={deviceName} onChange={setDeviceName} maxLength={80} placeholder="例如 Windows 台式机" />
        </label>
        <label>
          账号密码
          <Input.Password value={password} onChange={setPassword} minLength={12}
            autoComplete={register ? "new-password" : "current-password"} />
        </label>
        {register ? (
          <>
            <Alert type="warning" content="请把恢复密钥存到密码管理器。丢失后，账号密码无法解密云端主机。" />
            <label>
              恢复密钥
              <Input value={recoveryKey} readOnly />
            </label>
            <label>
              粘贴恢复密钥以确认已保存
              <Input.Password value={confirmedKey} onChange={setConfirmedKey} autoComplete="off" />
            </label>
          </>
        ) : (
          <label>
            恢复密钥
            <Input.Password value={recoveryKey} onChange={setRecoveryKey} autoComplete="off" />
          </label>
        )}
        <Space>
          <Button type="primary" htmlType="submit" loading={busy}
            disabled={!server || !email || password.length < 12 || !recoveryKey ||
              (register && recoveryKey !== confirmedKey.trim())}>
            {register ? "创建账号并同步" : "登录并同步"}
          </Button>
          {!hostSyncIsBound() && (
            <Button disabled={busy} onClick={() => void changeMode(!register)}>
              {register ? "已有账号" : "创建账号"}
            </Button>
          )}
          {account && <Button loading={busy} onClick={() => void signOut()}>退出登录</Button>}
        </Space>
      </Space>
    </form>
  );
}
