# 价格哨站文档站

面向用户的使用说明，发布在 <https://docs.cryptotool.bar>。基于 [Astro Starlight](https://starlight.astro.build)，主题沿用主应用的 Breakout 配色与字体。

## 修改文档

每个页面是 `src/content/docs/` 下的一个 `.mdx` 文件，路径就是网址：`anomaly/rules.mdx` 对应 `/anomaly/rules/`。

- 改文字：直接编辑对应 `.mdx` 文件，页面右下角的“编辑此页”也会跳到这里。
- 加页面：新建 `.mdx` 文件，写好 `title` 和 `description`，再把它加进 `astro.config.mjs` 的 `sidebar`。
- 改配色：`src/styles/breakout.css`。颜色值与主应用 `web/tokens.css` 保持一致，改主应用配色时这里也要同步。
- 可用组件：Starlight 自带的 `Aside`、`Steps`、`Tabs`、`CardGrid`、`LinkCard`，以及本站的 `Pipeline`（流程图）和 `RelativeCalc`（相对 BTC 计算器）。

文档里的数字和规则来自主应用源码。改动规则相关代码时（例如 `src/anomaly/rules.ts`、`src/notifications/hub.ts`），记得同步更新对应页面。

## 本地运行与发布

需要 Node.js 22.23.4 或更高版本。

```sh
cd docs-site
npm ci
npm run dev      # 本地预览 http://localhost:4321
npm run build    # 输出到 dist/
npm run deploy   # 构建并发布到 Cloudflare Worker open-alert-docs（需已登录 wrangler）
```

文档站是一个只有静态资源的 Worker，绑定自定义域名 `docs.cryptotool.bar`，和主应用的 Worker、后端服务器互不影响。
