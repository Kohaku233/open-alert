import { t } from '../i18n.js';
import { useLanguage } from '../i18n.js';
import { memo, useEffect, useRef, useState } from 'react';
import { safeChartSymbol } from '../utils.js';
// Official reference embed only; symbols must satisfy the verified allowlist.
export const TradingChart = memo(function TradingChart({ symbol, source }: {
    symbol: string;
    source: string;
}) {
    const language = useLanguage();
    const host = useRef<HTMLDivElement>(null);
    const [retry, setRetry] = useState(0);
    const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
    useEffect(() => {
        const container = host.current!;
        if (!safeChartSymbol(symbol)) {
            setState('failed');
            return;
        }
        setState('loading');
        const widget = document.createElement('div');
        widget.className = 'tradingview-widget-container__widget';
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
        script.type = 'text/javascript';
        script.async = true;
        script.textContent = JSON.stringify({
            autosize: true, symbol, interval: '15', timezone: 'Asia/Shanghai', theme: 'dark',
            style: '1', locale: language === 'en' ? 'en' : 'zh_CN', backgroundColor: '#111111', gridColor: 'rgba(51,51,51,0.45)',
            allow_symbol_change: false, hide_side_toolbar: false, hide_top_toolbar: false,
            calendar: false, support_host: 'https://www.tradingview.com',
        });
        let alive = true;
        const fail = () => { if (alive)
            setState('failed'); };
        script.onerror = fail;
        // Observe our container for the official embed's iframe; never inspect chart data or its document.
        const observer = new MutationObserver(() => {
            const frame = container.querySelector('iframe');
            if (frame) {
                frame.addEventListener('load', () => { if (alive)
                    setState('loaded'); }, { once: true });
                observer.disconnect();
            }
        });
        observer.observe(container, { childList: true, subtree: true });
        container.replaceChildren(widget, script);
        const timeout = window.setTimeout(() => { if (alive)
            setState(value => value === 'loading' ? 'failed' : value); }, 20000);
        return () => { alive = false; window.clearTimeout(timeout); observer.disconnect(); script.onerror = null; container.replaceChildren(); };
    }, [symbol, retry, language]);
    const chartURL = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
    return <>
    <div className="chart-caption"><span role="status">{state === 'loading' ? t("正在连接 TradingView 图表…") : state === 'failed' ? t("图表连接不可用") : t("图表由 TradingView 提供")}</span><button className="text-button" onClick={() => setRetry(value => value + 1)}>{t("重连图表")}</button></div>
    <div className="chart-shell">
      <div ref={host} className="tradingview-widget-container"/>
      {state === 'failed' && <div className="chart-fallback" role="status"><strong>{t("图表暂时无法连接")}</strong><p>{t("后台警报使用 ")}{source}{t(" 最新成交价。可以重试参考图表，或打开 TradingView 查看。")}</p><button className="primary" onClick={() => setRetry(value => value + 1)}>{t("重试图表")}</button>{safeChartSymbol(symbol) && <a href={chartURL} target="_blank" rel="noopener noreferrer">{t("在 TradingView 打开")}</a>}</div>}
    </div>
    <div className="chart-bottom"><span>{t("TradingView 仅供参考；警报按 ")}{source}{t(" 后台最新成交价判断。")}</span>{safeChartSymbol(symbol) && <a className="tradingview-widget-copyright" href={chartURL} target="_blank" rel="noopener noreferrer">{t("在 TradingView 追踪所有市场")}</a>}</div>
  </>;
});
