import { useState } from "react";
import { BellRing, ChevronsUpDown, LogOut, UserRound } from "lucide-react";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { Preferences } from "./Preferences.js";
import { t } from "../i18n.js";

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
              ["/account", "我的账户", UserRound],
              ["/notifications", "手机通知", BellRing],
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
        </div>
        <Preferences />
        <Button
          variant="ghost"
          className="account-logout"
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
