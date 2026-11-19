import { useState, type ReactNode } from "react";
import { Button, Dropdown, Menu, Tabs, Tooltip } from "@arco-design/web-react";
import { IconHome } from "@arco-design/web-react/icon";
import { Bot, Columns2 } from "lucide-react";
import type { TerminalSession } from "../models";
import { sessionTabName } from "../terminal-utils";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

const HOME_TAB_ID = "home";
type SplitDirection = "columns" | "rows";
const splitPreferenceKey = "fineshell.terminal.splitDirection";

interface SessionTabsProps {
  activeSessionId: string | null;
  aiAssistantVisible: boolean;
  hasActiveSession: boolean;
  homeContent: ReactNode;
  onActiveSessionChange: (sessionId: string | null) => void;
  onCloseSession: (sessionId: string) => void;
  onToggleAiAssistant: () => void;
  renderSession: (session: TerminalSession) => ReactNode;
  sessionContextMenuItems: (session: TerminalSession) => ContextMenuItem[];
  sessions: TerminalSession[];
}

function sessionStatusLabel(session: TerminalSession) {
  const labels = {
    connecting: "连接中",
    connected: "已连接",
    suspect: "响应异常",
    failed: "连接失败",
    disconnected: "已断开",
    reconnecting: "重连中",
  };
  return session.error
    ? `${labels[session.status]}：${session.error}`
    : labels[session.status];
}

function SessionTabs({
  activeSessionId,
  aiAssistantVisible,
  hasActiveSession,
  homeContent,
  onActiveSessionChange,
  onCloseSession,
  onToggleAiAssistant,
  renderSession,
  sessionContextMenuItems,
  sessions,
}: SessionTabsProps) {
  const [preferredDirection, setPreferredDirection] = useState<SplitDirection | undefined>(() => {
    const saved = localStorage.getItem(splitPreferenceKey);
    return saved === "rows" || saved === "columns" ? saved : undefined;
  });
  const [selectedPair, setSplit] = useState<{
    first: string;
    second: string;
    direction: SplitDirection;
  }>();
  const sessionIds = sessions.map(({ id }) => id);
  const companion = sessionIds.find((id) => id !== activeSessionId);
  const split = selectedPair ?? (preferredDirection && activeSessionId && companion
    ? { first: activeSessionId, second: companion, direction: preferredDirection }
    : undefined);
  const visiblePair = split && activeSessionId && companion
    ? [split.first, split.second].includes(activeSessionId)
      && sessionIds.includes(split.first) && sessionIds.includes(split.second)
      ? [split.first, split.second]
      : [split.first !== activeSessionId && sessionIds.includes(split.first)
        ? split.first : companion, activeSessionId]
    : undefined;

  function selectSession(id: string | null) {
    if (split && visiblePair && id) {
      const [first, second] = visiblePair;
      setSplit(visiblePair.includes(id)
        ? { ...split, first, second }
        : activeSessionId === first
          ? { ...split, first: id, second }
          : { ...split, first, second: id });
    }
    onActiveSessionChange(id);
  }

  function changeSplit(mode: string) {
    if (mode === "single") {
      setSplit(undefined);
      setPreferredDirection(undefined);
      localStorage.removeItem(splitPreferenceKey);
      return;
    }
    const other = sessions.find(({ id }) => id !== activeSessionId);
    if (activeSessionId && other) {
      const [first, second] = visiblePair ?? [activeSessionId, other.id];
      const direction = mode === "rows" ? "rows" : "columns";
      setSplit({ first, second, direction });
      setPreferredDirection(direction);
      localStorage.setItem(splitPreferenceKey, direction);
    }
  }
  return (
    <>
      <button
        aria-selected={activeSessionId === null}
        className={`terminal-home-tab${
          activeSessionId === null ? " terminal-home-tab-active" : ""
        }`}
        onClick={() => selectSession(null)}
        role="tab"
        type="button"
      >
        <IconHome />
        <span>首页</span>
      </button>
      <Tabs
        activeTab={activeSessionId ?? HOME_TAB_ID}
        className="terminal-tabs"
        editable
        onAddTab={() => selectSession(null)}
        onChange={(tabId) =>
          selectSession(tabId === HOME_TAB_ID ? null : tabId)
        }
        onDeleteTab={onCloseSession}
        showAddButton
        size="small"
        type="card-gutter"
      >
        <Tabs.TabPane
          closable={false}
          key={HOME_TAB_ID}
          title={
            <span className="terminal-tab-label">
              <IconHome />
              <span className="terminal-tab-name">首页</span>
            </span>
          }
        />
        {sessions.map((session) => (
          <Tabs.TabPane
            closable
            key={session.id}
            title={
              <ContextMenu items={sessionContextMenuItems(session)}>
                <span
                  className="terminal-tab-context-target terminal-tab-label"
                  onContextMenu={() => selectSession(session.id)}
                >
                  <span
                    className={`terminal-status-dot terminal-status-${session.status}`}
                  />
                  <Tooltip content={sessionStatusLabel(session)}>
                    <span className="terminal-tab-name">
                      {sessionTabName(sessions, session.id)}
                    </span>
                  </Tooltip>
                </span>
              </ContextMenu>
            }
          />
        ))}
      </Tabs>
      <div className="terminal-workspace" hidden={activeSessionId !== null}>
        {homeContent}
      </div>
      <div
        className={`terminal-workspace terminal-panes${visiblePair ? ` terminal-panes-${split?.direction}` : ""}`}
        hidden={activeSessionId === null}
      >
        {sessions.map((session) => {
          const paneIndex = visiblePair?.indexOf(session.id);
          const visible = paneIndex === undefined
            ? session.id === activeSessionId
            : paneIndex >= 0;
          return (
            <div
              aria-label={session.host.name}
              className="terminal-pane"
              hidden={!visible}
              key={session.id}
              onFocusCapture={() => {
                if (visible && activeSessionId !== session.id) selectSession(session.id);
              }}
              onPointerDownCapture={(event) => {
                if (event.button === 0 && visible && activeSessionId !== session.id) {
                  selectSession(session.id);
                }
              }}
              role="region"
              style={{ order: paneIndex }}
            >
              {renderSession(session)}
            </div>
          );
        })}
      </div>
      <div className="terminal-split-action">
        <Dropdown
          droplist={
            <Menu onClickMenuItem={changeSplit}>
              <Menu.Item key="columns">左右分屏</Menu.Item>
              <Menu.Item key="rows">上下分屏</Menu.Item>
              <Menu.Item key="single">单窗口</Menu.Item>
            </Menu>
          }
          trigger="click"
        >
          <Button
            aria-label="终端布局"
            className="terminal-ai-action-button"
            disabled={!hasActiveSession || sessions.length < 2}
            icon={<Columns2 aria-hidden="true" />}
            title="终端布局"
            type="text"
          />
        </Dropdown>
      </div>
      <div className="terminal-ai-action">
        <Tooltip content="AI">
          <span>
            <Button
              aria-label={aiAssistantVisible ? "关闭 AI 助手" : "打开 AI 助手"}
              aria-pressed={aiAssistantVisible}
              className={`terminal-ai-action-button${
                aiAssistantVisible ? " is-active" : ""
              }`}
              disabled={!hasActiveSession}
              icon={<Bot aria-hidden="true" />}
              onClick={onToggleAiAssistant}
              type="text"
            />
          </span>
        </Tooltip>
      </div>
    </>
  );
}

export default SessionTabs;
