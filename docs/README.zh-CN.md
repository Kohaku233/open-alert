# Open Alert 中文文档

这里是运营者文档的中文入口。英文概览见仓库根目录的 [README.md](../README.md)。

- [安装与原生模块](INSTALL.md)
- [配置模板与密钥](CONFIGURATION.md)
- [部署与运行](RUNTIME.md)
- [备份与恢复](BACKUP.md)
- [旧系统离线迁移](MIGRATION.md)
- [三交易所行情、运行模式与离线验证](ccxt-runtime.md)
- [市场搜索界面与验证边界](market-search-design.md)

Binance 永续可配置东京 Vercel Hobby Function 中继；无需常驻 Node 服务器。每轮一个批量请求，全局最多 8 个品种。配置与实际 Function 验证见 [Binance Vercel 中继](binance-vercel-relay.md)。

当前支持 Binance、OKX、MEXC 的 USDT 现货及 USDT 结算线性永续。Node 使用 CCXT Pro 成交流；Cloudflare 使用常规 CCXT 最新成交采样，默认间隔 5 秒，限流和调度可能让间隔更长，也可能漏掉短暂越界。页面报告模式与成交价时效；近期没有成交不代表连接断开。

只有启用且未锁定的规则产生行情采集需求，空闲或暂停规则不请求报价。市场搜索在浏览器筛选目录，最多展示 40 个结果。TradingView 参考图表采用受限的交易所及币种映射，图表不参与警报判断；中继的真实成交时间、游标和重复检测继续由后台校验。

生产配置、数据库和备份必须保持在仓库之外。文档中的示例域名、邮箱和全零数据库 ID 都是占位符，不能直接用于部署。
