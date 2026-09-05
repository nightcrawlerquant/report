"""纯标准库报告引擎：普通行情、委托和统计数据生成 HTML 与按日 JS。"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import isfinite, sqrt
import re
from html import escape
from pathlib import Path
from urllib.parse import quote

SHANGHAI = timezone(timedelta(hours=8))


@dataclass(frozen=True)
class ReportBar:
    """行情事件时间为纳秒，沿用原回测右闭区间归分钟规则。"""

    ts_event: int
    open: float
    close: float
    low: float
    high: float
    volume: float


ASSET_DIR = Path(__file__).with_name("report_assets")
MINUTE_NS = 60_000_000_000


def _number(value: object, field: str) -> float:
    if value is None or isinstance(value, bool):
        raise ValueError(f"{field} 必须是有限数")
    number = float(value)
    if not isfinite(number):
        raise ValueError(f"{field} 必须是有限数")
    return number


def _validate(bars, orders, filename, timeframe, fee_rate, mode, pnl_events) -> None:
    if not bars:
        raise ValueError("报告行情不能为空")
    if not filename.endswith(".html") or any(char in filename for char in '/\\:*?"<>|'):
        raise ValueError("filename 必须是单个 HTML 文件名")
    if timeframe != "1s" and re.fullmatch(r"[1-9]\d*[mhd]", timeframe) is None:
        raise ValueError("timeframe 必须为 1s 或正整数加 m/h/d")
    if mode not in {"backtest", "live"}:
        raise ValueError("mode 必须为 backtest 或 live")
    _number(fee_rate, "fee_rate")
    previous = 0
    for bar in bars:
        if type(bar.ts_event) is not int or bar.ts_event <= 0 or bar.ts_event < previous:
            raise ValueError("行情 ts_event 必须是递增的正整数纳秒时间")
        open_, close, low, high, volume = (
            _number(getattr(bar, key), key) for key in ("open", "close", "low", "high", "volume"))
        if min(open_, close, low, high) <= 0 or volume < 0 or low > min(open_, close) or high < max(open_, close):
            raise ValueError("行情 OHLCV 无效")
        previous = bar.ts_event
    required = {"tradeId", "time", "type", "markerType", "price", "matchPrice", "quantity",
                "amount", "profit", "status", "matchTime", "originalId", "remark"}
    ids = set()
    for order in orders:
        missing = required - order.keys()
        if missing:
            raise ValueError(f"委托缺少字段: {sorted(missing)}")
        key = order["tradeId"]
        if not isinstance(key, str) or not key or key in ids:
            raise ValueError(f"tradeId 必须是唯一非空字符串: {key}")
        ids.add(key)
        if order["markerType"] not in {None, "", "开多", "平多", "开空", "平空"}:
            raise ValueError(f"未知交易标记: {order['markerType']}")
        for field in ("time", "matchTime"):
            value = order[field]
            if field == "matchTime" and value is None:
                continue
            if type(value) is not int or value <= 0:
                raise ValueError(f"{key}.{field} 必须为正整数毫秒时间")
        for field in ("price", "quantity", "amount", "profit", "matchPrice"):
            value = order[field]
            if value is None and (field == "matchPrice" or (field == "profit" and pnl_events is not None)):
                continue
            _number(value, f"{key}.{field}")
        if (order["matchTime"] is None) != (order["matchPrice"] is None):
            raise ValueError(f"{key} 成交时间和成交价必须同时存在或同时为 null")
    if pnl_events is not None:
        previous = 0
        for timestamp, delta in pnl_events:
            if type(timestamp) is not int or timestamp <= 0 or timestamp < previous:
                raise ValueError("pnl_events 必须按毫秒时间递增排列")
            _number(delta, "pnl_events.delta")
            previous = timestamp


def summarize(bars: list[ReportBar], orders: list[dict[str, object]],
              initial_capital: float | None, fee_rate: float) -> dict[str, object]:
    """按成交净现金流计算已实现权益；胜率按平仓委托计，不推断持仓配对。"""
    capital = _number(initial_capital, "initial_capital")
    if capital <= 0:
        raise ValueError("自动统计必须提供大于 0 的 initial_capital")
    filled = [order for order in orders if order["matchTime"] is not None and order["status"] != "撤销"]
    closed = [order for order in filled if order["markerType"] in {"平多", "平空"}]
    profits = [float(order["profit"]) for order in closed]
    events: dict[int, float] = {}
    for order in filled:
        timestamp = int(order["matchTime"])
        events[timestamp] = events.get(timestamp, 0.0) + float(order["profit"]) - float(order["amount"]) * fee_rate
    start = datetime.fromtimestamp(_report_timestamp_ms(bars[0]) / 1000, SHANGHAI).date()
    end = datetime.fromtimestamp(_report_timestamp_ms(bars[-1]) / 1000, SHANGHAI).date()
    daily = [0.0] * ((end - start).days + 1)
    equity = peak = capital
    max_drawdown = max_drawdown_percent = 0.0
    for timestamp, delta in sorted(events.items()):
        day = datetime.fromtimestamp(timestamp / 1000, SHANGHAI).date()
        if not start <= day <= end:
            raise ValueError("自动统计的成交日期必须位于行情日期范围内")
        daily[(day - start).days] += delta / capital
        equity += delta
        peak = max(peak, equity)
        drawdown = peak - equity
        if drawdown > max_drawdown:
            max_drawdown, max_drawdown_percent = drawdown, drawdown / peak * 100
    mean = sum(daily) / len(daily)
    std = sqrt(sum((value - mean) ** 2 for value in daily) / (len(daily) - 1)) if len(daily) > 1 else 0.0
    losses = -sum(value for value in profits if value < 0)
    return {"net_profit": sum(events.values()),
            "win_rate": sum(value > 0 for value in profits) / len(profits) if profits else 0.0,
            "max_drawdown_percent": max_drawdown_percent,
            "sharpe_ratio": mean / std * sqrt(365) if std else 0.0,
            "profit_loss_ratio": sum(value for value in profits if value > 0) / losses if losses else None}


def generate_from_files(market_path: Path, orders_path: Path, config_path: Path,
                        output_dir: Path) -> Path:
    """JSON 文件入口；行情 timestamp_ms 为区间起点，委托时间为成交实际毫秒。"""
    market = json.loads(Path(market_path).read_text(encoding="utf-8"))
    orders = json.loads(Path(orders_path).read_text(encoding="utf-8"))
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    bars = []
    for row in market:
        timestamp = row["timestamp_ms"]
        if type(timestamp) is not int or timestamp <= 0:
            raise ValueError("timestamp_ms 必须为正整数毫秒时间")
        bars.append(ReportBar(timestamp * 1_000_000 + 1, **{key: row[key] for key in
                              ("open", "close", "low", "high", "volume")}))
    return generate_report(bars, orders, Path(output_dir), **config)


def _write(path: Path, content: str) -> None:
    if not path.is_file() or path.read_text(encoding="utf-8") != content:
        path.write_text(content, encoding="utf-8")


def _day(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp / 1000, SHANGHAI).strftime("%Y%m%d")


def _report_timestamp_ms(bar: ReportBar) -> int:
    if bar.ts_event <= 0:
        raise ValueError(f"报告行情事件时间必须大于 0: {bar.ts_event}")
    return (bar.ts_event - 1) // MINUTE_NS * 60_000


def _daily_summary(orders: list[dict[str, object]], fee_rate: float) -> dict[str, object]:
    filled = [order for order in orders if order["matchTime"] is not None and order["status"] != "撤销"]
    closed = [order for order in filled if order["markerType"] in {"平多", "平空"}]
    wins = [float(order["profit"]) for order in closed if float(order["profit"]) > 0]
    losses = [-float(order["profit"]) for order in closed if float(order["profit"]) < 0]
    return {"netProfit": round(sum(float(order["profit"]) - float(order["amount"]) * fee_rate for order in filled), 8),
            "profitFactor": round(sum(wins) / sum(losses), 8) if losses else None,
            "winRate": len(wins) / len(closed) if closed else 0,
            "filledOrderCount": len(filled),
            "cancelledOrderCount": sum(order["status"] == "撤销" for order in orders)}


def _order_metrics(orders: list[dict[str, object]]) -> dict[str, object]:
    best_count = current_count = 0
    best_amount = current_amount = 0.0
    best_start = current_start = None
    closed = sorted((order for order in orders if order["markerType"] in {"平多", "平空"}
                     and order["matchTime"] is not None and order["status"] != "撤销"),
                    key=lambda order: (int(order["matchTime"]), str(order["tradeId"])))
    for order in closed:
        profit = float(order["profit"])
        if profit < 0:
            if current_count == 0:
                current_start = order["matchTime"]
            current_count, current_amount = current_count + 1, current_amount - profit
            if current_count > best_count or (current_count == best_count and current_amount > best_amount):
                best_count, best_amount, best_start = current_count, current_amount, current_start
        else:
            current_count, current_amount, current_start = 0, 0.0, None
    return {"filledOrderCount": sum(order["matchTime"] is not None and order["status"] != "撤销" for order in orders),
            "totalOrderCount": len(orders), "maxLossStreak": best_count,
            "maxLossStreakAmount": best_amount, "maxLossStreakStart": best_start}


def _write_data(data_dir: Path, bars: list[ReportBar], orders: list[dict[str, object]],
                fee_rate: float, *, order_pnl: bool = True) -> tuple[list[dict[str, str]], list[dict[str, str]], int]:
    bars_by_day: dict[str, list[list[float]]] = {}
    previous_timestamp: int | None = None
    for bar in bars:
        timestamp = _report_timestamp_ms(bar)
        if previous_timestamp is not None and timestamp < previous_timestamp:
            raise ValueError(f"报告行情时间倒序: {timestamp} < {previous_timestamp}")
        rows = bars_by_day.setdefault(_day(timestamp), [])
        row = [timestamp, float(bar.open), float(bar.close), float(bar.low),
               float(bar.high), float(bar.volume)]
        if rows and rows[-1][0] == timestamp:
            rows[-1][2] = row[2]
            rows[-1][3] = min(rows[-1][3], row[3])
            rows[-1][4] = max(rows[-1][4], row[4])
            rows[-1][5] += row[5]
        else:
            rows.append(row)
        previous_timestamp = timestamp
    orders_by_day: dict[str, list[dict[str, object]]] = {day: [] for day in bars_by_day}
    for order in orders:
        timestamp = order["matchTime"] if order["matchTime"] is not None else order["time"]
        orders_by_day.setdefault(_day(int(timestamp)), []).append(order)
    today, kline_files, order_files = datetime.now(SHANGHAI).strftime("%Y%m%d"), [], []
    for day, rows in sorted(bars_by_day.items(), reverse=True):
        path = data_dir / f"kline-{day}.js"
        _write(path, "window.__BACKTEST_KLINE_DAY__(" + json.dumps({"date": day, "bars": rows}, separators=(",", ":")) + ");\n")
        kline_files.append({"date": day, "name": path.name, "version": str(path.stat().st_mtime_ns)})
    for day, rows in sorted(orders_by_day.items()):
        payload: dict[str, object] = {"date": day, "orders": rows}
        if day < today and order_pnl:
            payload["summary"] = _daily_summary(rows, fee_rate)
        path = data_dir / f"orders{day}.js"
        _write(path, "window.__BACKTEST_ORDER_DAY__(" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ");\n")
        order_files.append({"date": day, "name": path.name, "version": str(path.stat().st_mtime_ns)})
    return kline_files, order_files, sum(len(rows) for rows in bars_by_day.values())


def _html(data_dir_name: str, title: str) -> str:
    return f"""<!doctype html>
<html lang=\"zh-CN\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
  <title>{escape(title)}</title>
  <link rel=\"stylesheet\" href=\"static/backtest-report.css\">
</head>
<body>
  <main id=\"report\" class=\"report-shell\">
    <header class=\"report-header\">
      <div><h1 id=\"report-title\"></h1><p id=\"report-subtitle\"></p></div>
      <div class=\"report-actions\">
        <label>开始<input id=\"range-start\" type=\"date\"></label>
        <label>结束<input id=\"range-end\" type=\"date\"></label>
        <button id=\"apply-range\" type=\"button\">应用</button>
        <button id=\"refresh-report\" type=\"button\">刷新</button>
        <button id=\"export-orders\" type=\"button\" class=\"primary\">导出</button>
      </div>
    </header>
    <section id=\"metrics\" class=\"metric-grid\" aria-label=\"核心指标\"></section>
    <section class=\"panel equity-panel\">
      <div class=\"equity-heading\"><div><h2>权益与回撤</h2><p>净收益曲线 · 水下回撤 · 最多 100 个采样点</p></div><span id=\"equity-summary\"></span></div>
      <div id=\"equity-chart\" role=\"img\" aria-label=\"权益与回撤曲线\"></div>
    </section>
    <section class=\"panel chart-panel\">
      <div class=\"chart-toolbar\">
        <strong>技术指标</strong>
        <label class=\"marker-scheme-control\">行情周期
          <select id=\"kline-timeframe\"><option value=\"1\" selected>1min</option><option value=\"5\">5min</option><option value=\"30\">30min</option><option value=\"60\">1h</option></select>
        </label>
        <label class=\"marker-scheme-control\">交易标记
          <select id=\"marker-scheme\"><option value=\"bubble\" selected>方案1 · 气泡</option><option value=\"triangle\">方案2 · 三角</option></select>
        </label>
        <div id=\"indicator-list\" class=\"indicator-list\"></div>
        <select id=\"indicator-type\" aria-label=\"指标类型\"><option>EMA</option><option>MA</option><option>MACD</option></select>
        <button id=\"add-indicator\" type=\"button\">+ 添加</button>
      </div>
      <div id=\"kline-chart\" role=\"img\" aria-label=\"K线回测图表\"></div>
    </section>
    <section class=\"panel order-panel\">
      <div class=\"section-heading\">
        <div><h2>委托记录</h2><p id=\"order-count\"></p></div>
        <label class=\"filter-switch\"><input id=\"hide-cancelled\" type=\"checkbox\" checked><span>屏蔽撤单</span></label>
      </div>
      <div id=\"order-table\" class=\"order-viewport\" role=\"table\" aria-label=\"委托记录\"></div>
    </section>
    <aside class=\"performance-note\"><strong>性能优化</strong><span id=\"performance-status\"></span></aside>
  </main>
  <div id=\"report-error\" class=\"report-error\" hidden></div>
  <script src=\"static/echarts.min.js\"></script>
  <script src=\"{quote(data_dir_name)}/config.js\"></script>
  <script defer src=\"static/backtest-report.js\"></script>
</body>
</html>
"""


def generate_report(bars: list[ReportBar], orders: list[dict[str, object]], output_dir: Path,
                    filename: str, symbol: str, timeframe: str, fee_rate: float, *,
                    initial_capital: float | None = None,
                    summary: dict[str, object] | None = None,
                    mode: str = "backtest",
                    pnl_events: list[list[float]] | None = None,
                    metric_cards: list[dict[str, str]] | None = None) -> Path:
    """生成完整数据快照。summary 使用原回测字段；账本模式须显式传 summary。"""
    _validate(bars, orders, filename, timeframe, fee_rate, mode, pnl_events)
    if summary is None:
        if pnl_events is not None:
            raise ValueError("账本盈亏模式必须提供 summary，不从未知单笔盈亏推算指标")
        summary = summarize(bars, orders, initial_capital, fee_rate)
    for key in ("net_profit", "win_rate", "max_drawdown_percent", "sharpe_ratio", "profit_loss_ratio"):
        if summary[key] is not None:
            _number(summary[key], f"summary.{key}")
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    html_path, data_dir = output_dir / filename, output_dir / f"{Path(filename).stem}.data"
    data_dir.mkdir(exist_ok=True)
    kline_files, order_files, bar_count = _write_data(data_dir, bars, orders, fee_rate,
                                                    order_pnl=pnl_events is None)
    report_timeframe = "1m" if timeframe == "1s" else timeframe
    trade_profit: dict[str, float] = {}
    for order in orders:
        if order["type"] in {"平多", "平空"} and order["matchTime"] is not None and order["profit"] is not None:
            key = str(order["tradeId"])
            trade_profit[key] = trade_profit.get(key, 0.0) + float(order["profit"])
    label = "回测报告" if mode == "backtest" else "实盘报告"
    payload = {"symbol": symbol, "period": report_timeframe, "title": f"{symbol} {label}",
               "subtitle": f"{report_timeframe}行情 · {'Backtest Report' if mode == 'backtest' else 'Live Report'}", "generatedAt": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
               "firstTimestamp": _report_timestamp_ms(bars[0]), "lastTimestamp": _report_timestamp_ms(bars[-1]),
               "barCount": bar_count,
               "klineFiles": [{"date": item["date"], "src": f"{quote(data_dir.name)}/{item['name']}?v={item['version']}"} for item in kline_files],
               "orderFiles": [{"date": item["date"], "src": f"{quote(data_dir.name)}/{item['name']}?v={item['version']}"} for item in order_files],
               "feeRate": fee_rate,
               "summary": {"netProfit": summary["net_profit"], "winRate": summary["win_rate"],
                           "winningTrades": sum(value > 0 for value in trade_profit.values()),
                           "losingTrades": sum(value < 0 for value in trade_profit.values()),
                           "maxDrawdownPercent": summary["max_drawdown_percent"], "sharpe": summary["sharpe_ratio"],
                           "profitFactor": summary["profit_loss_ratio"], "maxDrawdownSubtitle": "已实现权益口径",
                           **_order_metrics([order for order in orders if order["profit"] is not None])}}
    payload["summary"]["totalOrderCount"] = len(orders)
    payload["summary"]["filledOrderCount"] = sum(order["matchTime"] is not None and order["status"] != "撤销" for order in orders)
    if pnl_events is not None:
        payload["pnlEvents"] = pnl_events
        payload["equitySeriesName"] = "已实现盈亏"
        payload["summary"]["maxDrawdownSubtitle"] = "外部账本统计口径"
    if metric_cards is not None:
        payload["metricCards"] = metric_cards
    _write(data_dir / "config.js", "window.BACKTEST_REPORT_CONFIG=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + ";\n")
    target = output_dir / "static"
    target.mkdir(exist_ok=True)
    for name in ("backtest-report.css", "backtest-report.js", "echarts.min.js"):
        source, destination = ASSET_DIR / name, target / name
        if not destination.is_file() or source.stat().st_size != destination.stat().st_size \
                or source.stat().st_mtime_ns != destination.stat().st_mtime_ns:
            shutil.copy2(source, destination)
    _write(html_path, _html(data_dir.name, str(payload["title"])))
    return html_path
