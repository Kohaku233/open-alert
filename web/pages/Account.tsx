import { Preferences } from "../components/Preferences.js";
import { usePageMotion } from "../motion.js";
import {
  Panel,
  PageHeader,
  PageError,
  Disclosure,
} from "../components/Surface.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { t } from "../i18n.js";
import { useState, useRef } from "react";
import type { FormEvent } from "react";
import type { WorkspaceModel } from "../model.js";
import { errorText, request } from "../api.js";
import { formatTime, formatStatusTime, healthLabels } from "../utils.js";
import { FormError } from "../components/Dialog.js";
export function Account({
  model,
  notify,
  navigate,
  logout,
  logoutBusy,
}: {
  model: WorkspaceModel;
  navigate: (path: string) => void;
  logout: () => void;
  logoutBusy: boolean;
  notify: (text: string) => void;
}) {
  const [runtimeExpanded, setRuntimeExpanded] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  usePageMotion(pageRef, !!model.data, true, "settings");
  const { data, busy, mutate } = model;
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  if (!data) return model.error ? <PageError title={t("我的账户")} /> : null;
  async function bootstrap(event: FormEvent) {
    event.preventDefault();
    if (busy || !token) return;
    setError("");
    const onceToken = token.trim();
    setToken("");
    try {
      await mutate(() =>
        request<{
          bootstrapped: true;
        }>("/api/admin/bootstrap", "POST", undefined, { bearer: onceToken }),
      );
      setSetup(false);
      notify(t("初始管理员已设置。"));
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  const components = [
    ["database", t("数据库")],
    ["scheduler", t("后台监控")],
    ["prices", t("交易所行情")],
    ["email", t("邮件服务")],
  ] as const;
  const healthy = components.filter(
    ([key]) => data.status.health[key].state === "healthy",
  ).length;
  return (
    <section ref={pageRef} className="settings-page account-page">
      <PageHeader className="page-heading account-heading">
        <div>
          <span className="page-index">03 — ACCOUNT</span>
          <h1>{t("我的账户")}</h1>
          <p>{t("账户身份、配额与后台运行状态。")}</p>
        </div>
      </PageHeader>
      <div className="settings-grid account-grid">
        <div className="account-column">
          <Panel className="settings-panel identity-panel">
            <h2 className="sr-only">{t("账户信息")}</h2>
            <div className="account-identity">
              <span className="identity-avatar">
                {(data.status.user.name ||
                  data.status.user.email)[0]?.toUpperCase()}
              </span>
              <div>
                <strong>{data.status.user.email}</strong>
                <small className="desktop-identity-subtitle">
                  {data.status.user.role === "admin" ? "ADMIN" : "MEMBER"} ·{" "}
                  {data.status.user.name || t("尚未设置")}
                </small>
                <small className="mobile-identity-subtitle">
                  {data.status.user.role === "admin" ? t("管理员") : t("普通用户")} · {t("监控")} {data.status.settings.enabled ? t("已启用") : t("已暂停")}
                </small>
              </div>
            </div>
            <dl className="identity-summary">
              <div>
                <dt>{t("角色")}</dt>
                <dd>
                  {data.status.user.role === "admin"
                    ? t("管理员")
                    : t("普通用户")}
                </dd>
              </div>
              <div>
                <dt>{t("监控")}</dt>
                <dd
                  className={
                    data.status.settings.enabled ? "signal-text" : "amber-text"
                  }
                >
                  {data.status.settings.enabled ? t("已启用") : t("已暂停")}
                </dd>
              </div>
              <div>
                <dt>{t("今日通知尝试")}</dt>
                <dd>
                  {data.status.daily.attempts} / {data.status.daily.limit}
                </dd>
              </div>
            </dl>
            <p className="small muted account-privacy">
              {t(
                "仅显示你自己的警报、行情与通知设置。每日配额按 UTC 日期计算。",
              )}
            </p>
            {data.status.user.role !== "admin" && (
              <div className="bootstrap-section">
                <Button
                  variant="ghost"
                  className="text-button"
                  onClick={() => setSetup((value) => !value)}
                >
                  {t("设置初始管理员")}
                </Button>
                {setup && (
                  <form onSubmit={(event) => void bootstrap(event)}>
                    <p className="small muted">
                      {t(
                        "仅供首次部署且尚无管理员时使用。需已验证的登录账户与部署者持有的一次性引导令牌。",
                      )}
                    </p>
                    <Label>
                      {t("一次性引导令牌")}
                      <Input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        autoCapitalize="none"
                        required
                        minLength={32}
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                      />
                    </Label>
                    <Button
                      variant="default"
                      className="primary"
                      loading={busy}
                      disabled={busy || !!model.error}
                    >
                      {busy ? t("正在设置…") : t("设为初始管理员")}
                    </Button>
                    <FormError message={error} />
                  </form>
                )}
              </div>
            )}
          </Panel>
          <Panel className="settings-panel preferences-panel">
            <h2>{t("偏好设置")}</h2>
            <Preferences labels />
            <Button
              className="desktop-account-logout"
              loading={logoutBusy}
              disabled={logoutBusy}
              onClick={logout}
            >
              {logoutBusy ? t("正在退出…") : t("退出登录")}
            </Button>
          </Panel>
        </div>
        <Panel className="settings-panel runtime-panel">
          <div className="runtime-heading">
            <h2>{t("后台运行状态")}</h2>
            <span className={healthy === components.length ? "signal-text" : "amber-text"}>
              {healthy} / {components.length} {t("正常")}
            </span>
          </div>
          <Button className="mobile-runtime-heading" aria-expanded={runtimeExpanded} aria-controls="account-runtime-detail" onClick={() => setRuntimeExpanded(value => !value)}><span>{t('后台运行状态')}</span><span className={healthy === components.length ? 'signal-text' : 'amber-text'}>{healthy} / {components.length}</span></Button>
          <div className="runtime-health">
            {components.map(([key, label]) => {
              const health = data.status.health[key];
              return (
                <div className="health-row" key={key}>
                  <span>{label}</span>
                  <small title={formatTime(health.lastSuccessAt)}>
                    {t("最近成功：")}
                    {formatStatusTime(health.lastSuccessAt)}
                  </small>
                  <span
                    className={
                      health.state === "healthy" ? "success-text" : "amber-text"
                    }
                  >
                    <i />
                    {healthLabels[health.state]}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="desktop-runtime-notes">
            <p className="small muted">
              {t("最近行情轮询：")}
              {formatStatusTime(data.status.scheduler.lastPollAt)}
              {t("。目标间隔约 5 秒，网络与调度延迟可能影响实际周期。")}
            </p>
            <p className="small muted">
              {t(
                "行情缺失或超过 30 秒时停止触发。通知结果不确定时保持锁定，不会自动重发。",
              )}
            </p>
          </div>
          {runtimeExpanded && <div className="mobile-runtime-detail" id="account-runtime-detail">
            {components.map(([key, label]) => (
              <p className="small muted" key={key}>
                {label} · {formatTime(data.status.health[key].lastSuccessAt)}
                {data.status.health[key].code
                  ? ` · ${data.status.health[key].code}`
                  : ""}
              </p>
            ))}
          </div>}
        </Panel>
        <div className="mobile-account-actions">
          {data.status.user.role === "admin" &&
            data.status.capabilities.canAdmin && (
              <Button
                className="mobile-admin-link"
                onClick={() => navigate("/admin")}
              >
                {t("管理 · 邀请与账户")} <span>›</span>
              </Button>
            )}
          <Button loading={logoutBusy}
              disabled={logoutBusy} onClick={logout}>
            {logoutBusy ? t("正在退出…") : t("退出登录")}
          </Button>
        </div>
      </div>
    </section>
  );
}
