import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { getLanguage, t } from "../i18n.js";

export const DOCS_ORIGIN = "https://docs.cryptotool.bar";

/** Guide URL in the current interface language: Chinese pages at the root, English under /en/. */
export const docsUrl = (path = "/") => DOCS_ORIGIN + (getLanguage() === "en" ? "/en" : "") + path;

/** Opens one page of the user guide in a new tab. `path` is a docs route such as `/anomaly/rules/`. */
export function DocsLink({ path = "/", children, className = "" }: { path?: string; children?: ReactNode; className?: string }) {
  return <a className={`docs-link ${className}`.trim()} href={docsUrl(path)} target="_blank" rel="noopener">
    {children ?? t("了解规则")}<ArrowUpRight aria-hidden="true"/><span className="sr-only">{t("（在新标签页打开）")}</span>
  </a>;
}
