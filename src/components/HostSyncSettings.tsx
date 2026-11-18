import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Input, Message, Popconfirm, Space, Typography } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { commandErrorMessage } from "../tauri-protocol";
import {
  hostSyncAccount,
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
      if (isHostSyncStorageEvent(event)) setStatus(readHostSyncStatus());
    }
    window.addEventListener("storage", refresh);
    return () => {
      mounted = false;
      window.removeEventListener("storage", refresh);
    };
  }, []);

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
      setAccount(await signInToHostSync({ server, email, password, recoveryKey, register }));
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

  function sync(keepLocal?: boolean) {
    void requestHostSync(keepLocal).catch((error) => Message.error(commandErrorMessage(error)));
  }

  if (!isTauri()) return <Alert content="请在 FineShell 桌面应用中使用主机同步。" />;
  if (loading) return <Typography.Text>正在读取同步账号…</Typography.Text>;

  if (account && !status?.signInRequired) {
    return (
      <Space direction="vertical" size="large">
        <Typography.Text>{account.email}</Typography.Text>
        {status?.state === "failed" && <Alert type="error" content={status.message} />}
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
        {status?.conflict && (
          <Space wrap>
            <Popconfirm content="用本机版本覆盖所有冲突项？" onOk={() => sync(true)}>
              <Button>冲突项保留本机版本</Button>
            </Popconfirm>
            <Popconfirm content="用云端版本覆盖所有冲突项？" onOk={() => sync(false)}>
              <Button>冲突项保留云端版本</Button>
            </Popconfirm>
          </Space>
        )}
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
