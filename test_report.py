"""独立运行的报告契约校验，仅使用临时输出目录。"""

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from reporting import ReportBar, generate_from_files, generate_report


ROOT = Path(__file__).resolve().parent


def payload(path, prefix, suffix=");\n"):
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix) or not text.endswith(suffix):
        raise AssertionError(f"JS 协议错误：{path}")
    return json.loads(text[len(prefix):-len(suffix)])


class ReportTest(unittest.TestCase):
    def test_backtest_live_daily_files_and_refresh(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            data = ROOT / "demo_data"
            for mode, orders in (("backtest", "orders.json"), ("live", "orders_live.json")):
                html = generate_from_files(data / "market.json", data / orders,
                                           data / f"{mode}.json", output)
                self.assertTrue(html.is_file())
                report = output / f"{mode}_demo.data"
                config = payload(report / "config.js", "window.BACKTEST_REPORT_CONFIG=", ";\n")
                self.assertEqual(config["barCount"], 360)
                self.assertEqual([row["date"] for row in config["klineFiles"]], ["20260902", "20260901"])
                daily_path = report / "kline-20260901.js"
                daily = payload(daily_path, "window.__BACKTEST_KLINE_DAY__(")
                market = json.loads((data / "market.json").read_text(encoding="utf-8"))
                a, b = market[:2]
                self.assertEqual(daily["bars"][0], [a["timestamp_ms"], a["open"], b["close"],
                                 min(a["low"], b["low"]), max(a["high"], b["high"]), a["volume"] + b["volume"]])
                daily_orders = payload(report / "orders20260901.js", "window.__BACKTEST_ORDER_DAY__(")
                if mode == "backtest":
                    self.assertIn("summary", daily_orders)
                    self.assertAlmostEqual(config["summary"]["netProfit"], 0.3791)
                    self.assertEqual(config["summary"]["maxLossStreak"], 2)
                    self.assertEqual(config["summary"]["filledOrderCount"], 6)
                    self.assertEqual(config["summary"]["totalOrderCount"], 8)
                else:
                    self.assertNotIn("summary", daily_orders)
                    self.assertIsNone(daily_orders["orders"][0]["profit"])
                    self.assertAlmostEqual(sum(event[1] for event in config["pnlEvents"]), 0.25)
                    self.assertEqual(config["summary"]["netProfit"], 0.25)
                before = {path: path.stat().st_mtime_ns for path in report.glob("*.js") if path.name != "config.js"}
                generate_from_files(data / "market.json", data / orders, data / f"{mode}.json", output)
                self.assertEqual(before, {path: path.stat().st_mtime_ns for path in before})
            for name in ("backtest-report.js", "backtest-report.css", "echarts.min.js"):
                self.assertEqual((output / "static" / name).read_bytes(), (ROOT / "report_assets" / name).read_bytes())

    def test_invalid_input_and_empty_orders(self):
        bar = ReportBar(1788278400000000001, 100, 101, 99, 102, 10)
        with tempfile.TemporaryDirectory() as directory:
            def generate(bars, orders, **kwargs):
                return generate_report(bars, orders, Path(directory), "check.html", "DEMO", "1m", 0,
                                       initial_capital=10000, **kwargs)
            self.assertTrue(generate([bar], []).is_file())
            for bars in ([], [replace(bar, volume=-1)], [replace(bar, close=float("nan"))],
                         [bar, replace(bar, ts_event=bar.ts_event - 1)]):
                with self.assertRaises(ValueError):
                    generate(bars, [])
            orders = json.loads((ROOT / "demo_data/orders.json").read_text(encoding="utf-8"))
            with self.assertRaises(ValueError):
                generate([bar], [orders[0], orders[0]])
            with self.assertRaises(ValueError):
                generate([bar], [{"tradeId": "missing"}])
            with self.assertRaises(ValueError):
                generate([bar], [dict(orders[0], profit=None)])
            with self.assertRaises(ValueError):
                generate([bar], [], pnl_events=[])


if __name__ == "__main__":
    unittest.main()
