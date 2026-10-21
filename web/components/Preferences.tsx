import { Sun, Moon, Monitor } from "lucide-react";
import { Button } from "./ui/button.js";
import { useTheme } from "../theme.js";
import { t, useLanguage, setLanguage } from "../i18n.js";

/** The same persisted preferences are available in the account menu and page. */
export function Preferences({ labels = false }: { labels?: boolean }) {
  const { preference, setTheme } = useTheme();
  const language = useLanguage();
  return (
    <div className={`account-preferences ${labels ? "text-preferences" : ""}`}>
      <div>
        <span>{t("外观")}</span>
        <div
          className="preference-segments"
          role="group"
          aria-label={t("外观主题")}
        >
          {(
            [
              ["light", Sun, "浅色"],
              ["dark", Moon, "深色"],
              ["system", Monitor, "跟随系统"],
            ] as const
          ).map(([value, Glyph, label]) => (
            <Button
              key={value}
              variant="ghost"
              type="button"
              aria-label={t(label)}
              title={t(label)}
              aria-pressed={preference === value}
              onClick={() => setTheme(value)}
            >
              {labels ? t(label) : <Glyph aria-hidden="true" />}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <span>{t(labels ? "界面语言" : "语言")}</span>
        <div
          className="preference-segments languages"
          role="group"
          aria-label={t("界面语言")}
        >
          <Button
            variant="ghost"
            type="button"
            aria-pressed={language === "zh-CN"}
            onClick={() => setLanguage("zh-CN")}
          >
            {t("中文")}
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-pressed={language === "en"}
            onClick={() => setLanguage("en")}
          >
            EN
          </Button>
        </div>
      </div>
    </div>
  );
}
