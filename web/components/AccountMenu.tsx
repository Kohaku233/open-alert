import { useState } from "react";
import { ArrowUpRight, BellRing, BookOpen, ChevronsUpDown, LogOut, Settings2 } from "lucide-react";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { Preferences } from "./Preferences.js";
import { t } from "../i18n.js";
import { DOCS_ORIGIN } from "./DocsLink.js";

export function AccountMenu({
  name,
  email,
  navigate,
  logout,
  busy,
}: {
  name: string;
  email: string;
  navigate: (path: string) => void;
  logout: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className="account-chip" aria-label={t("账户菜单")}>
          <span className="account-avatar">
            {[...name][0]?.toUpperCase() || "O"}
            <i />
          </span>
          <span className="account-chip-identity">
            <strong>{name}</strong>
            <small>{email}</small>
          </span>
          <ChevronsUpDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="account-menu"
        aria-label={t("账户菜单")}
      >
        <div className="account-menu-identity">
          <strong>{name}</strong>
          <small>{email}</small>
        </div>
        <div className="account-menu-links">
          {(
            [
              ["/settings", "设置", Settings2],
              ["/notifications", "通知中心", BellRing],
            ] as const
          ).map(([href, label, Glyph]) => (
            <a
              key={href}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                setOpen(false);
                navigate(href);
              }}
            >
              <Glyph aria-hidden="true" />
              {t(label)}
            </a>
          ))}
          <a className="account-menu-docs" href={DOCS_ORIGIN + "/"} target="_blank" rel="noopener" onClick={() => setOpen(false)}>
            <BookOpen aria-hidden="true" />
            {t("使用文档")}
            <ArrowUpRight aria-hidden="true" className="account-menu-external" />
            <span className="sr-only">{t("（在新标签页打开）")}</span>
          </a>
        </div>
        <Preferences />
        <Button
          variant="ghost"
          className="account-logout"
          loading={busy}
          disabled={busy}
          onClick={logout}
        >
          <LogOut aria-hidden="true" />
          {busy ? t("正在退出…") : t("退出登录")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
