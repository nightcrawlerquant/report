"""离线生成回测、实盘两份演示报告；不访问行情或交易接口。"""

from pathlib import Path

from reporting import generate_from_files


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "demo_data"
OUTPUT_DIR = ROOT / "output"


def main() -> None:
    print(f"输入目录：{DATA_DIR}")
    print(f"输出目录：{OUTPUT_DIR}；修改位置：demo.py 的 OUTPUT_DIR")
    for mode, orders in (("backtest", "orders.json"), ("live", "orders_live.json")):
        config = DATA_DIR / f"{mode}.json"
        print(f"当前报告配置（标的、周期、费率、资金/账本）：{config}")
        print(config.read_text(encoding="utf-8"))
        path = generate_from_files(DATA_DIR / "market.json", DATA_DIR / orders,
                                   config, OUTPUT_DIR)
        print(f"报告已生成：{path}")
    print("直接打开 output 中的 HTML；分享时请复制整个 output 目录。")


if __name__ == "__main__":
    main()
