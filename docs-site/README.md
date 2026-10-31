# 价格哨站文档站

面向用户的使用说明，发布在 <https://docs.cryptotool.bar>。基于 Astro + MDX，样式沿用主应用的 Breakout 配色与字体。

## 修改文档

每个页面是 `src/content/docs/` 下的一个 `.mdx` 文件，路径就是网址：`anomaly/rules.mdx` 对应 `/anomaly/rules/`。每页开头的 `title` 是标题，`description` 是标题下方的导语。

- 改文字：直接编辑对应 `.mdx` 文件。
- 加页面：新建 `.mdx` 文件，写好 `title` 和 `description`，再把页面 id（路径去掉 `.mdx`）加进 `src/nav.ts`。左侧目录和上一篇、下一篇都按这里的顺序生成。
- 首页：`src/pages/index.astro`。
- 改配色和版式：`src/styles/site.css`。颜色值与主应用 `web/tokens.css` 保持一致。
- 可用组件（在 `.mdx` 里 import 后使用）：`Aside`（提示框，type 为 note、tip、caution）、`Steps`（编号步骤）、`Tabs` + `TabItem`、`LinkCard`、`Formula`（带复制按钮的公式）、`Pipeline`（流程图）、`RelativeCalc`（相对 BTC 计算器）。

文档只写普通用户能看到和用到的功能。改动规则相关代码时（例如 `src/anomaly/rules.ts`、`src/notifications/hub.ts`），记得同步更新对应页面。

## 本地运行与发布

需要 Node.js 22.23.4 或更高版本。

```sh
cd docs-site
npm ci
npm run dev      # 本地预览 http://localhost:4321（开发模式下搜索不可用）
npm run build    # 输出到 dist/，并生成搜索索引
npm run deploy   # 构建并发布到 Cloudflare Worker open-alert-docs（需已登录 wrangler）
```

文档站是一个只有静态资源的 Worker，绑定自定义域名 `docs.cryptotool.bar`，和主应用的 Worker、后端服务器互不影响。
