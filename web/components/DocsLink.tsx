import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../i18n.js";

export const DOCS_ORIGIN = "https://docs.cryptotool.bar";

/** Opens one page of the user guide in a new tab. `path` is a docs route such as `/anomaly/rules/`. */
export function DocsLink({ path = "/", children, className = "" }: { path?: string; children?: ReactNode; className?: string }) {
  return <a className={`docs-link ${className}`.trim()} href={DOCS_ORIGIN + path} target="_blank" rel="noopener">
    {children ?? t("了解规则")}<ArrowUpRight aria-hidden="true"/><span className="sr-only">{t("（在新标签页打开）")}</span>
  </a>;
}
