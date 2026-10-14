# Open Alert 中文文档

这里是运营者文档的中文入口。英文概览见仓库根目录的 [README.md](../README.md)。

- [安装与原生模块](INSTALL.md)
- [配置模板与密钥](CONFIGURATION.md)
- [部署与运行](RUNTIME.md)
- [备份与恢复](BACKUP.md)
- [旧系统离线迁移](MIGRATION.md)
- [三交易所行情、运行模式与离线验证](ccxt-runtime.md)
- [市场搜索界面与验证边界](market-search-design.md)

Binance 永续可配置鉴权 Node relay，操作及验证边界见 [Binance 永续 relay](binance-futures-relay.md)。relay 模式需要现有常驻主机和 HTTPS 入口，全局最多 8 个品种，token 保存在 Cloudflare Secrets。

当前支持 Binance、OKX、MEXC 的 USDT 现货及 USDT 结算线性永续。Node 使用 CCXT Pro 成交流；Cloudflare 使用常规 CCXT 最新成交采样，默认间隔 5 秒，限流和调度可能让间隔更长，也可能漏掉短暂越界。页面报告模式与成交价时效；近期没有成交不代表连接断开。

只有可触发的启用规则产生采集需求，空闲或暂停规则不请求报价。市场搜索在浏览器筛选目录，最多展示 40 个结果；TradingView 只开放已有验证映射的 12 个 OKX 永续品种，图表不参与判断触发。目录和下架记录仅驻留当前进程；重启后必须重新成功加载完整目录才能评估。离线回归使用模拟提供方传输；另有 Binance 官方完整目录及 relay 成交流的真实 Node 验证。真实验证使用进程内桥接，不能说明最终公网 HTTPS、常驻运行或生产部署已经通过。

生产配置、数据库和备份必须保持在仓库之外。文档中的示例域名、邮箱和全零数据库 ID 都是占位符，不能直接用于部署。
