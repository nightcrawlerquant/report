# 独立报告模块

输入普通委托、OHLCV 行情和报告配置，输出 HTML、按日 JS 与本地静态资源。
只使用 Python 标准库（Python 3.10+），无需安装 ppq_trader、数据库、交易 SDK 或 Web 服务。
目录可以整体移动到其他 Windows/Linux 机器；所有路径相对当前文件定位。

## 运行 demo

Windows 双击 `start_demo.cmd`，生成后自动打开两份报告。也可在本目录执行：

```text
python -B demo.py
```

Linux 执行 `sh start_demo.sh`。打开 `output/backtest_demo.html` 或 `output/live_demo.html`。
分享报告必须携带整个 `output`，包括 `static` 和对应的 `.data` 目录。
运行校验：`python -B test_report.py`。以上入口均无业务命令行参数。

## 模块边界

- `reporting.py`：输入校验、默认已实现盈亏统计、日数据拆分、HTML/资源输出。
- `report_assets/`：原项目的 JS、CSS、ECharts，逐字复制，未修改前端。
- `demo_data/`：可编辑的合成行情、委托和回测/实盘配置。跨两天，包含多空、部分平仓、连续亏损、撤单、未成交和未平仓。
- `demo.py`：启动配置打印和文件入口调用；输出位置在文件顶部常量中修改。

策略下单、交易所连接、成交清洗、开平配对、库存和账本归业务系统负责。报告不调用任何交易 API。
项目中 `common/report.py` 保留原回测函数签名，转调 `common/reporting.py`，直接使用原有 summary，保留已有回测统计口径。
本目录的 `reporting.py` 是通用引擎的独立副本，不通过绝对路径或 sys.path 引用原项目。

## 文件接口

```python
from pathlib import Path
from reporting import generate_from_files

html = generate_from_files(
    Path("demo_data/market.json"),
    Path("demo_data/orders.json"),
    Path("demo_data/backtest.json"),
    Path("output"),
)
```

行情 JSON 是按时间升序的对象数组，每行字段如下：

| 字段 | 说明 |
|---|---|
| timestamp_ms | Unix 毫秒，行情区间起点；不是结束时间 |
| open / close / low / high | 正数价格 |
| volume | 非负成交量 |

30 秒 demo 数据用于验证分钟合并；实用时可输入秒线或分钟线。日界线使用 UTC+8。
沿用原规则合并同一分钟：首开、末收、最低、最高、成交量求和。
前端源周期填 `1s` 时输出 `1m`；分钟数据填 `1m`。支持原来的正整数加 `m/h/d` 周期。
重复数据不会自动去重；调用方须提供不重复的行情快照，不能把同一根分钟线的多次累计更新同时输入。

委托 JSON 是对象数组，沿用原报告字段：

| 字段 | 说明 |
|---|---|
| tradeId | 唯一非空字符串；部分成交应拆成唯一记录，由调用方分配 ID |
| time / matchTime | 委托/成交 Unix 毫秒；未成交 matchTime 为 null |
| type | 展示操作名称，如开多、平多、开空、平空 |
| markerType | 开多、平多、开空、平空，或 null/空字符串（无标记） |
| price / matchPrice | 委托价格/成交价格；未成交 matchPrice 为 null |
| quantity / amount | 数量/成交金额；未成交 demo 金额为 0 |
| profit | 业务系统已计算的该记录盈亏；开仓通常为 0；账本模式可为 null |
| status | 原展示状态；撤单必须使用“撤销”，未成交必须没有成交时间和成交价格 |
| originalId | 对应开仓 ID，没有则 null |
| remark | 展示备注字符串 |

保留其他业务字段，不推断平仓盈亏，不自动匹配交易。成交标记必须有对应时间的行情。

配置必填 `filename/symbol/timeframe/fee_rate`；自动统计还需 `initial_capital`，详见 `backtest.json`。
默认 `mode=backtest`；实盘设 `mode=live`。回测和实盘使用同一个生成入口。
未知或缺失字段直接报错，不连接外部服务补数据。

## 内存接口与统计口径

```python
from pathlib import Path
from reporting import ReportBar, generate_report

bars = [ReportBar(ts_event=1788278400000000001,
                  open=100, close=101, low=99, high=102, volume=10)]
html = generate_report(bars, [], Path("output"), "empty_orders.html",
                       "DEMO", "1m", 0.0002, initial_capital=10000)
```

`ReportBar.ts_event` 是原引擎的**纳秒事件时间**，使用 `(ts_event - 1) // 分钟纳秒` 分桶。
若持有区间起点毫秒，转换为 `timestamp_ms * 1_000_000 + 1`，文件接口已完成此转换。
原生 Bar 只要提供这些字段就可直接传入，无需复制行情对象。

自动汇总按成交记录 `profit - amount * fee_rate` 计算净现金流，胜率按平仓记录计；
回撤基于已实现权益，Sharpe 基于 UTC+8 自然日收益，年化 365 天，不包含未平仓浮盈亏。
如果 profit 已扣手续费，必须把 fee_rate 设为 0，避免重复扣费。
需要原业务统计口径时，传入 summary：
`net_profit/win_rate/max_drawdown_percent/sharpe_ratio/profit_loss_ratio`，跳过自动汇总。

实盘只有成交和账本、没有单笔盈亏时，参考 `live.json`：显式提供 summary、
`pnl_events=[[毫秒时间, 本次净盈亏增量], ...]` 和 `metric_cards` 展示卡片。
这里是增量，不是累计值；手续费由账本计入。未知指标使用 null，展示卡片说明缺失口径。
这种模式不会生成无法计算的订单日汇总，沿用现有实盘的日订单文件格式。
原项目实盘发布器的采集、去重、账本基线和增量发布仍由业务层负责，不移入通用引擎。

## 实盘更新

业务系统在需要刷新时再次调用，提交该报告的完整行情和委托快照。
日 JS 内容不变则不重写，config.js 中携带文件版本，原页面刷新按钮仍可使用。
此入口处理完整快照，不是逐条追加 API；大型实盘历史继续使用业务层现有按日增量发布流程。
请勿多个进程同时写同一报告目录；线上发布频率、原子切换和服务配置由部署层管理。
旧日文件不会删除，但 config.js 只引用当前输入生成的日文件。
