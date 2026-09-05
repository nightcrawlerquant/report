function aggregateBars(sourceBars, intervalMinutes) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) throw new Error(`行情周期无效: ${intervalMinutes}`);
  if (intervalMinutes === 1) return sourceBars;
  const intervalMs = intervalMinutes * 60_000;
  const result = [];
  for (const bar of sourceBars) {
    const timestamp = Math.floor(bar[0] / intervalMs) * intervalMs;
    const current = result.at(-1);
    if (!current || current[0] !== timestamp) {
      result.push([timestamp, bar[1], bar[2], bar[3], bar[4], bar[5]]);
      continue;
    }
    current[2] = bar[2];
    current[3] = Math.min(current[3], bar[3]);
    current[4] = Math.max(current[4], bar[4]);
    current[5] += bar[5];
  }
  return result;
}

if (typeof module === "object" && module.exports) {
  module.exports = { aggregateBars };
} else {
(function () {
  "use strict";

  const config = window.BACKTEST_REPORT_CONFIG;
  const orders = [];
  if (!config || !Array.isArray(config.klineFiles) || !Array.isArray(config.orderFiles) || typeof echarts === "undefined") {
    showError("报告资源加载失败：缺少 config.js、日数据文件配置或 echarts.min.js");
    return;
  }

  const ROW_HEIGHT = 38;
  const OVERSCAN = 6;
  const INITIAL_LOAD_BARS = 1000;
  const INITIAL_VISIBLE_BARS = 240;
  const EQUITY_SAMPLE_LIMIT = 100;
  const TRADE_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc949", "#af7aa1", "#ff9da7", "#9c755f", "#bab0ab"];
  const markerStyles = {
    "开多": { name: "开多", text: "多", position: "bottom", rotate: 0 },
    "平多": { name: "平多", text: "平", position: "bottom", rotate: 0 },
    "开空": { name: "开空", text: "空", position: "top", rotate: 180 },
    "平空": { name: "平空", text: "平", position: "top", rotate: 180 },
  };
  const orderById = new Map();
  const pairColors = new Map();
  const loadedKlineDays = new Set();
  const loadedOrderDays = new Set();
  let indicators = [{ id: "indicator-1", type: "EMA", enabled: true, period: 20, color: "#2dd4bf" }];
  let indicatorSequence = 1;
  let displayedOrders = [];
  let displayOrderIndex = new Map();
  let sourceBars = [];
  let bars = [];
  let timeframeMinutes = 1;
  let loadingPromise = null;
  let selectedTradeId = null;
  let selectedMarker = null;
  let markerLookup = new Map();
  let markerScheme = "bubble";
  let equityChart;
  let chart;
  let tableCanvas;
  let tableViewport;

  function showError(message) {
    const target = document.getElementById("report-error");
    target.hidden = false;
    target.textContent = String(message && message.stack ? message.stack : message);
  }

  function formatNumber(value, digits) {
    return value === null || value === undefined || !Number.isFinite(Number(value))
      ? "-"
      : Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function formatTime(timestamp) {
    if (!timestamp) return "-";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(new Date(timestamp)).replaceAll("/", "-");
  }

  function localDateValue(timestamp) {
    const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
    return date.toISOString().slice(0, 10);
  }

  function periodMinutes(period) {
    const match = /^(\d+)([mhd])$/.exec(String(period).toLowerCase());
    if (!match) throw new Error(`行情源周期不支持聚合: ${period}`);
    const scale = { m: 1, h: 60, d: 1440 }[match[2]];
    return Number.parseInt(match[1], 10) * scale;
  }

  function periodLabel(minutes) {
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}min`;
  }

  function ensureTimeframeSelect() {
    let select = document.getElementById("kline-timeframe");
    if (!select) {
      const markerSelect = document.getElementById("marker-scheme");
      const markerControl = markerSelect && markerSelect.closest("label");
      if (!markerControl) throw new Error("报告缺少行情周期控件挂载点");
      const control = document.createElement("label");
      control.className = "marker-scheme-control";
      control.append("行情周期 ");
      select = document.createElement("select");
      select.id = "kline-timeframe";
      control.appendChild(select);
      markerControl.before(control);
    }
    const sourceMinutes = periodMinutes(config.period);
    const intervals = [...new Set([sourceMinutes, 5, 30, 60])]
      .filter((minutes) => minutes >= sourceMinutes && minutes % sourceMinutes === 0)
      .sort((left, right) => left - right);
    select.replaceChildren(...intervals.map((minutes) => {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = periodLabel(minutes);
      return option;
    }));
    select.value = String(sourceMinutes);
    timeframeMinutes = sourceMinutes;
    return select;
  }

  function displayPeriod(period) {
    const minute = /^(\d+)m$/.exec(period);
    return minute ? `${minute[1]}分钟` : period;
  }

  function loadScript(source, description) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`${description}加载失败: ${source}`));
      document.head.appendChild(script);
    });
  }

  window.__BACKTEST_ORDER_DAY__ = function (payload) {
    if (!payload || typeof payload.date !== "string" || !Array.isArray(payload.orders)) {
      throw new Error("订单日文件格式错误");
    }
    if (loadedOrderDays.has(payload.date)) throw new Error(`订单日文件重复: ${payload.date}`);
    orders.push(...payload.orders);
    loadedOrderDays.add(payload.date);
  };

  async function loadOrderDays() {
    await Promise.all(config.orderFiles.map((file) => loadScript(file.src, `订单日文件 ${file.date}`)));
    for (const file of config.orderFiles) {
      if (!loadedOrderDays.has(file.date)) throw new Error(`订单日文件日期不匹配: ${file.src}`);
    }
    orders.sort((left, right) => left.time - right.time || left.tradeId.localeCompare(right.tradeId));
    for (const order of orders) {
      if (orderById.has(order.tradeId)) throw new Error(`订单ID重复: tradeId=${order.tradeId}`);
      orderById.set(order.tradeId, order);
    }
    for (const order of orders) {
      if (!order.matchTime || !order.markerType || order.status === "撤销") continue;
      const pairId = order.originalId && orderById.has(order.originalId) ? order.originalId : order.tradeId;
      if (!pairColors.has(pairId)) pairColors.set(pairId, TRADE_COLORS[pairColors.size % TRADE_COLORS.length]);
      order.markerColor = pairColors.get(pairId);
    }
    for (const order of orders) order.markerColor ||= "#94a3b8";
  }

  function renderHeader() {
    document.getElementById("report-title").textContent = config.title;
    document.getElementById("report-subtitle").textContent = config.subtitle;
    const reportPeriod = document.getElementById("report-period");
    if (reportPeriod) reportPeriod.textContent = `${formatTime(config.firstTimestamp)} 至 ${formatTime(config.lastTimestamp)}`;
    const marketStatus = document.getElementById("report-market-status");
    if (marketStatus) {
      marketStatus.textContent = config.barCount
        ? `${Number(config.barCount).toLocaleString("zh-CN")} 根 · ${displayPeriod(config.period)}`
        : "无K线模式";
    }
    const generatedAt = document.getElementById("report-generated-at");
    if (generatedAt) generatedAt.textContent = formatTime(new Date(config.generatedAt).getTime());
    const summary = config.summary;
    const defaultCards = [
      ["净收益 (USDT)", `${summary.netProfit >= 0 ? "+" : ""}${formatNumber(summary.netProfit, 2)}`, summary.netProfit >= 0 ? "gain" : "loss", "扣除手续费后"],
      ["胜率", `${formatNumber(summary.winRate * 100, 2)}%`, "", `胜${summary.winningTrades} / 败${summary.losingTrades}`],
      ["最大回撤", `-${formatNumber(Math.abs(summary.maxDrawdownPercent), 2)}%`, "loss", summary.maxDrawdownSubtitle],
      ["Sharpe", formatNumber(summary.sharpe, 2), "", "日收益率年化"],
      ["盈亏比", Number(summary.profitFactor) === Infinity ? "∞" : formatNumber(summary.profitFactor, 2), "", "总盈利 / 总亏损"],
      ["委托概况", `${Number(summary.filledOrderCount).toLocaleString("zh-CN")} / ${Number(summary.totalOrderCount).toLocaleString("zh-CN")}`, "", "成交委托 / 总委托"],
      ["连续亏损笔数", `${summary.maxLossStreak} 笔`, summary.maxLossStreak ? "loss" : "", summary.maxLossStreak ? `${formatTime(summary.maxLossStreakStart)} · ${formatNumber(summary.maxLossStreakAmount, 2)} USDT` : "无连续亏损"],
    ];
    const cards = Array.isArray(config.metricCards)
      ? config.metricCards.map((card) => [card.label, card.value, card.tone || "", card.subtitle || ""])
      : defaultCards;
    const metrics = document.getElementById("metrics");
    for (const [label, value, tone, subtitle] of cards) {
      const card = document.createElement("article");
      card.className = "metric-card";
      const labelNode = document.createElement("div");
      labelNode.className = "metric-label";
      labelNode.textContent = label;
      const valueNode = document.createElement("div");
      valueNode.className = `metric-value ${tone}`;
      valueNode.textContent = value;
      const subtitleNode = document.createElement("div");
      subtitleNode.className = "metric-subtitle";
      subtitleNode.textContent = subtitle;
      card.append(labelNode, valueNode, subtitleNode);
      metrics.appendChild(card);
    }
  }

  function buildEquityPoints() {
    const events = new Map();
    if (Array.isArray(config.pnlEvents)) {
      for (const event of config.pnlEvents) {
        const timestamp = Number(event[0]);
        const delta = Number(event[1]);
        if (!Number.isFinite(timestamp) || !Number.isFinite(delta)) throw new Error("资金流水包含无效数值");
        events.set(timestamp, (events.get(timestamp) || 0) + delta);
      }
    } else {
      const feeRate = Number(config.feeRate);
      if (!Number.isFinite(feeRate)) throw new Error(`手续费率无效: ${config.feeRate}`);
      for (const order of orders) {
        if (!order.matchTime || order.status === "撤销") continue;
        if (feeRate && order.amount === null) throw new Error(`成交订单缺少金额: tradeId=${order.tradeId}`);
        const profit = order.profit === null ? 0 : Number(order.profit);
        const amount = order.amount === null ? 0 : Number(order.amount);
        const delta = profit - amount * feeRate;
        events.set(order.matchTime, (events.get(order.matchTime) || 0) + delta);
      }
    }

    let equity = 0;
    let peak = 0;
    const startTimestamp = !Array.isArray(config.pnlEvents) && orders.length ? orders[0].time : config.firstTimestamp;
    const points = [[startTimestamp, 0, 0]];
    for (const [timestamp, delta] of [...events.entries()].sort((left, right) => left[0] - right[0])) {
      if (timestamp > config.lastTimestamp) throw new Error(`权益事件晚于报告结束: timestamp=${timestamp}`);
      equity += delta;
      peak = Math.max(peak, equity);
      const point = [timestamp, equity, equity - peak];
      if (timestamp <= startTimestamp) points[0] = [startTimestamp, point[1], point[2]];
      else points.push(point);
    }
    if (points.at(-1)[0] < config.lastTimestamp) points.push([config.lastTimestamp, equity, equity - peak]);
    return points;
  }

  function sampleEquity(points) {
    if (points.length <= EQUITY_SAMPLE_LIMIT) return points.slice();
    let equityMinimum = points[0][1];
    let equityMaximum = points[0][1];
    let drawdownMinimum = points[0][2];
    let drawdownMaximum = points[0][2];
    let deepest = points[0];
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      equityMinimum = Math.min(equityMinimum, point[1]);
      equityMaximum = Math.max(equityMaximum, point[1]);
      drawdownMinimum = Math.min(drawdownMinimum, point[2]);
      drawdownMaximum = Math.max(drawdownMaximum, point[2]);
      if (point[2] < deepest[2]) deepest = point;
    }
    const equityRange = equityMaximum - equityMinimum || 1;
    const drawdownRange = drawdownMaximum - drawdownMinimum || 1;
    const bucketSize = (points.length - 2) / (EQUITY_SAMPLE_LIMIT - 2);
    const sampled = [points[0]];
    let anchorIndex = 0;

    for (let bucket = 0; bucket < EQUITY_SAMPLE_LIMIT - 2; bucket += 1) {
      const averageStart = Math.floor((bucket + 1) * bucketSize) + 1;
      const averageEnd = Math.min(Math.floor((bucket + 2) * bucketSize) + 1, points.length);
      let average = points.at(-1);
      if (averageStart < averageEnd) {
        average = [0, 0, 0];
        for (let index = averageStart; index < averageEnd; index += 1) {
          average[0] += points[index][0];
          average[1] += points[index][1];
          average[2] += points[index][2];
        }
        const averageCount = averageEnd - averageStart;
        average[0] /= averageCount;
        average[1] /= averageCount;
        average[2] /= averageCount;
      }
      const rangeStart = Math.floor(bucket * bucketSize) + 1;
      const rangeEnd = Math.min(Math.floor((bucket + 1) * bucketSize) + 1, points.length - 1);
      const anchor = points[anchorIndex];
      let bestScore = -1;
      let bestIndex = rangeStart;
      for (let index = rangeStart; index < rangeEnd; index += 1) {
        const point = points[index];
        const equityArea = Math.abs((anchor[0] - average[0]) * (point[1] - anchor[1]) - (anchor[0] - point[0]) * (average[1] - anchor[1])) / equityRange;
        const drawdownArea = Math.abs((anchor[0] - average[0]) * (point[2] - anchor[2]) - (anchor[0] - point[0]) * (average[2] - anchor[2])) / drawdownRange;
        const score = equityArea + drawdownArea;
        if (score > bestScore) { bestScore = score; bestIndex = index; }
      }
      sampled.push(points[bestIndex]);
      anchorIndex = bestIndex;
    }
    sampled.push(points.at(-1));

    if (!sampled.includes(deepest)) {
      let replaceIndex = 1;
      for (let index = 2; index < sampled.length - 1; index += 1) {
        if (Math.abs(sampled[index][0] - deepest[0]) < Math.abs(sampled[replaceIndex][0] - deepest[0])) replaceIndex = index;
      }
      sampled[replaceIndex] = deepest;
      sampled.sort((left, right) => left[0] - right[0]);
    }
    return sampled;
  }

  function renderEquityChart() {
    const points = buildEquityPoints();
    const sampled = sampleEquity(points);
    const equitySeriesName = config.equitySeriesName || "权益";
    const finalEquity = points.at(-1)[1];
    const deepestDrawdown = sampled.reduce(
      (minimum, point) => Math.min(minimum, point[2]),
      sampled[0][2],
    );
    document.getElementById("equity-summary").textContent =
      `末值 ${finalEquity >= 0 ? "+" : ""}${formatNumber(finalEquity, 2)} USDT · 最大回撤 ${formatNumber(deepestDrawdown, 2)} USDT`;
    equityChart = echarts.init(document.getElementById("equity-chart"), null, { renderer: "canvas" });
    equityChart.setOption({
      animation: false,
      legend: { top: 4, right: 22, data: [equitySeriesName, "回撤"], textStyle: { color: "#64748b", fontSize: 11 } },
      grid: { left: 70, right: 34, top: 34, bottom: 38 },
      tooltip: {
        trigger: "axis", confine: true, axisPointer: { type: "line" },
        formatter: (params) => {
          const values = Object.fromEntries(params.map((item) => [item.seriesName, item.value[1]]));
          return `<strong>${formatTime(params[0].value[0])}</strong><br>${equitySeriesName}：${formatNumber(values[equitySeriesName], 2)} USDT<br>回撤：${formatNumber(values["回撤"], 2)} USDT`;
        },
      },
      xAxis: { type: "time", axisLine: { lineStyle: { color: "#cbd5e1" } }, axisTick: { show: false }, axisLabel: { color: "#64748b", fontSize: 10 }, splitLine: { show: false } },
      yAxis: {
        type: "value", axisLine: { show: false }, axisLabel: {
          color: "#64748b", fontSize: 10,
          formatter: (value) => Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 0 }),
        },
        splitLine: { lineStyle: { color: "#e2e8f0" } },
        min: (range) => range.min < 0 ? range.min * 1.08 : 0,
        max: (range) => range.max > 0 ? range.max * 1.08 : 0,
      },
      dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "filter", start: 0, end: 100 }],
      series: [
        {
          id: "equity", name: equitySeriesName, type: "line", showSymbol: false, data: sampled.map((point) => [point[0], +point[1].toFixed(4)]),
          smooth: true, lineStyle: { width: 3.5, color: "#7c3aed" }, itemStyle: { color: "#7c3aed" }, areaStyle: { color: "#ede9fe", opacity: .4 },
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: "#94a3b8", width: 1 }, data: [{ yAxis: 0 }] },
        },
        {
          id: "drawdown", name: "回撤", type: "line", showSymbol: false, data: sampled.map((point) => [point[0], +point[2].toFixed(4)]),
          lineStyle: { width: 1.5, color: "#ef4444" }, areaStyle: { color: "#fecaca", opacity: .65 },
        },
      ],
    });
  }

  function calculateMA(values, period) {
    const result = Array(values.length).fill(null);
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[index];
      if (index >= period) sum -= values[index - period];
      if (index >= period - 1) result[index] = sum / period;
    }
    return result;
  }

  function calculateEMA(values, period) {
    const result = Array(values.length).fill(null);
    if (values.length < period) return result;
    let ema = 0;
    for (let index = 0; index < period; index += 1) ema += values[index];
    ema /= period;
    result[period - 1] = ema;
    const alpha = 2 / (period + 1);
    for (let index = period; index < values.length; index += 1) {
      ema = values[index] * alpha + ema * (1 - alpha);
      result[index] = ema;
    }
    return result;
  }

  function calculateMACD(values, fastPeriod, slowPeriod, signalPeriod) {
    const fast = calculateEMA(values, fastPeriod);
    const slow = calculateEMA(values, slowPeriod);
    const dif = values.map((_, index) => fast[index] === null || slow[index] === null ? null : fast[index] - slow[index]);
    const first = dif.findIndex((value) => value !== null);
    const dea = Array(values.length).fill(null);
    if (first >= 0) {
      let signal = dif[first];
      dea[first] = signal;
      const alpha = 2 / (signalPeriod + 1);
      for (let index = first + 1; index < values.length; index += 1) {
        signal = dif[index] * alpha + signal * (1 - alpha);
        dea[index] = signal;
      }
    }
    return { dif, dea, histogram: dif.map((value, index) => value === null ? null : (value - dea[index]) * 2) };
  }

  function lineData(values) {
    return values.map((value, index) => value === null ? [bars[index][0], null] : [bars[index][0], +value.toFixed(6)]);
  }

  function barAt(timestamp) {
    let left = 0;
    let right = bars.length - 1;
    let result = null;
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      if (bars[middle][0] <= timestamp) { result = bars[middle]; left = middle + 1; }
      else right = middle - 1;
    }
    return result;
  }

  function visibleMarkers() {
    if (!sourceBars.length) return new Map();
    const start = sourceBars[0][0];
    const end = sourceBars.at(-1)[0];
    const groups = new Map(Object.keys(markerStyles).map((type) => [type, []]));
    for (const order of orders) {
      if (!order.matchTime || !order.markerType || order.status === "撤销" || order.matchTime < start || order.matchTime > end) continue;
      const bar = barAt(order.matchTime);
      if (!bar) throw new Error(`交易标记找不到对应K线: tradeId=${order.tradeId}`);
      groups.get(order.markerType).push({
        value: [order.matchTime, order.price],
        tradeId: order.tradeId,
        order,
        bar,
        itemStyle: { color: order.markerColor },
        label: { color: order.markerColor },
      });
    }
    return groups;
  }

  function bubbleRender(side, color) {
    return (_params, api) => {
      const point = api.coord([api.value(0), api.value(1)]);
      const label = api.value(2);
      const width = 28;
      const height = 18;
      const tailHeight = 5;
      const below = side === "below";
      const rectangleY = below ? point[1] + tailHeight : point[1] - tailHeight - height;
      const tailBaseY = below ? point[1] + tailHeight : point[1] - tailHeight;
      return {
        type: "group",
        children: [
          {
            type: "polygon",
            shape: { points: [[point[0], point[1]], [point[0] - 4, tailBaseY], [point[0] + 4, tailBaseY]] },
            style: { fill: color },
          },
          {
            type: "rect",
            shape: { x: point[0] - width / 2, y: rectangleY, width, height, r: 4 },
            style: { fill: color },
            emphasis: { style: { stroke: "#fff", lineWidth: 1.5 } },
          },
          {
            type: "text",
            style: { x: point[0], y: rectangleY + height / 2, text: label, fill: "#fff", font: "600 11px sans-serif", align: "center", verticalAlign: "middle" },
          },
        ],
      };
    };
  }

  function addBubbleMarkers(series, markerGroups) {
    const definitions = [
      { id: "bubble-buy", name: "买 / 平", color: "#0ecb81", side: "below", types: [["开多", "买"], ["平空", "平"]] },
      { id: "bubble-sell", name: "卖 / 平", color: "#f6465d", side: "above", types: [["开空", "卖"], ["平多", "平"]] },
    ];
    for (const definition of definitions) {
      const data = definition.types.flatMap(([type, label]) => markerGroups.get(type).map((item) => ({
        ...item,
        value: [item.value[0], definition.side === "below" ? item.bar[3] : item.bar[4], label],
      }))).sort((left, right) => left.value[0] - right.value[0]);
      const seriesIndex = series.length;
      data.forEach((item, dataIndex) => markerLookup.set(item.tradeId, { seriesIndex, dataIndex }));
      series.push({
        id: definition.id, name: definition.name, type: "custom", xAxisIndex: 0, yAxisIndex: 0,
        renderItem: bubbleRender(definition.side, definition.color), data, encode: { x: 0, y: 1 },
        dimensions: ["time", "price", "label"], itemStyle: { color: definition.color }, z: 20, clip: false,
      });
    }
  }

  function addTriangleMarkers(series, markerGroups) {
    for (const [type, data] of markerGroups) {
      const style = markerStyles[type];
      const seriesIndex = series.length;
      data.forEach((item, dataIndex) => markerLookup.set(item.tradeId, { seriesIndex, dataIndex }));
      series.push({
        id: `marker-${type}`, name: style.name, type: "scatter", xAxisIndex: 0, yAxisIndex: 0, data,
        symbol: "triangle", symbolRotate: style.rotate, symbolSize: 13, z: 20,
        itemStyle: { color: "#cbd5e1" },
        label: { show: true, formatter: style.text, position: style.position, distance: 3, color: "#cbd5e1", fontWeight: 700, fontSize: 11 },
        emphasis: { scale: 1.8, itemStyle: { borderColor: "#fff", borderWidth: 2 } },
      });
    }
  }

  function tradeTooltip(order) {
    const lines = [
      `<strong style="color:${order.markerColor}">${escapeHtml(order.markerType || order.type)} · ${formatTime(order.matchTime || order.time)}</strong>`,
      `委托号：${escapeHtml(order.tradeId)}`,
      `金额：${formatNumber(order.amount, 2)} USDT`,
      `价格：${formatNumber(order.price, 4)}`,
    ];
    if (order.markerType === "平多" || order.markerType === "平空") {
      lines.push(`原委托号：${escapeHtml(order.originalId || "-")}`);
      lines.push(`盈亏：${formatNumber(order.profit, 2)} USDT`);
    }
    if (order.remark) lines.push(`备注：${escapeHtml(order.remark)}`);
    return lines.join("<br>");
  }

  function chartTooltip(params) {
    const points = Array.isArray(params) ? params : [params];
    const trade = points.find((point) => point.data && point.data.tradeId);
    if (trade) return tradeTooltip(trade.data.order);
    const candle = points.find((point) => point.seriesName === "K线");
    if (!candle) return "";
    const value = candle.data;
    return [
      `<strong>${formatTime(value[0])}</strong>`,
      `开：${formatNumber(value[1], 4)}　收：${formatNumber(value[2], 4)}`,
      `低：${formatNumber(value[3], 4)}　高：${formatNumber(value[4], 4)}`,
    ].join("<br>");
  }

  function indicatorName(indicator) {
    return indicator.type === "MACD"
      ? `MACD(${indicator.fast},${indicator.slow},${indicator.signal})`
      : `${indicator.type}${indicator.period}`;
  }

  function currentVisibleRange() {
    if (!chart || !bars.length) return null;
    const zoom = chart.getOption().dataZoom[0];
    const startIndex = Math.floor((bars.length - 1) * (zoom.start || 0) / 100);
    const endIndex = Math.ceil((bars.length - 1) * (zoom.end ?? 100) / 100);
    return [zoom.startValue || bars[startIndex][0], zoom.endValue || bars[endIndex][0]];
  }

  function refreshIndicatorChart() {
    const range = currentVisibleRange();
    renderIndicatorEditor();
    renderChart(range);
  }

  function numberInput(value, title, onChange) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "10000";
    input.required = true;
    input.value = value;
    input.title = title;
    input.setAttribute("aria-label", title);
    input.addEventListener("change", () => {
      if (!input.reportValidity()) return;
      onChange(Number.parseInt(input.value, 10), input);
    });
    return input;
  }

  function renderIndicatorEditor() {
    const list = document.getElementById("indicator-list");
    const fragment = document.createDocumentFragment();
    for (const indicator of indicators) {
      const chip = document.createElement("div");
      chip.className = "indicator-chip";
      const label = document.createElement("label");
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = indicator.enabled;
      enabled.addEventListener("change", () => { indicator.enabled = enabled.checked; refreshIndicatorChart(); });
      label.append(enabled, document.createTextNode(indicator.type));
      chip.appendChild(label);
      if (indicator.type === "MACD") {
        chip.append(
          numberInput(indicator.fast, "快线周期", (value, input) => {
            input.setCustomValidity(value < indicator.slow ? "" : "快线周期必须小于慢线周期");
            if (input.reportValidity()) { indicator.fast = value; refreshIndicatorChart(); }
          }),
          numberInput(indicator.slow, "慢线周期", (value, input) => {
            input.setCustomValidity(value > indicator.fast ? "" : "慢线周期必须大于快线周期");
            if (input.reportValidity()) { indicator.slow = value; refreshIndicatorChart(); }
          }),
          numberInput(indicator.signal, "信号周期", (value) => { indicator.signal = value; refreshIndicatorChart(); }),
        );
      } else {
        chip.appendChild(numberInput(indicator.period, "周期", (value) => { indicator.period = value; refreshIndicatorChart(); }));
        const color = document.createElement("input");
        color.type = "color";
        color.value = indicator.color;
        color.title = "线条颜色";
        color.addEventListener("change", () => { indicator.color = color.value; refreshIndicatorChart(); });
        chip.appendChild(color);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = `删除 ${indicatorName(indicator)}`;
      remove.addEventListener("click", () => { indicators = indicators.filter((item) => item.id !== indicator.id); refreshIndicatorChart(); });
      chip.appendChild(remove);
      fragment.appendChild(chip);
    }
    list.replaceChildren(fragment);
  }

  function addIndicator() {
    const type = document.getElementById("indicator-type").value;
    if (type === "MACD" && indicators.some((indicator) => indicator.type === "MACD")) return;
    indicatorSequence += 1;
    indicators.push(type === "MACD"
      ? { id: `indicator-${indicatorSequence}`, type, enabled: true, fast: 12, slow: 26, signal: 9 }
      : { id: `indicator-${indicatorSequence}`, type, enabled: true, period: type === "EMA" ? 20 : 50, color: TRADE_COLORS[indicatorSequence % TRADE_COLORS.length] });
    refreshIndicatorChart();
  }

  function buildOption() {
    const closes = bars.map((bar) => bar[2]);
    const overlays = indicators.filter((indicator) => indicator.enabled && indicator.type !== "MACD");
    const macdIndicator = indicators.find((indicator) => indicator.enabled && indicator.type === "MACD");
    const markerGroups = visibleMarkers();
    const series = [{
      id: "candles", name: "K线", type: "candlestick", xAxisIndex: 0, yAxisIndex: 0,
      data: bars.map((bar) => bar.slice(0, 5)),
      itemStyle: { color: "#22c55e", color0: "#ef4444", borderColor: "#22c55e", borderColor0: "#ef4444" },
    }];
    for (const indicator of overlays) {
      const values = indicator.type === "EMA" ? calculateEMA(closes, indicator.period) : calculateMA(closes, indicator.period);
      series.push({
        id: indicator.id, name: indicatorName(indicator), type: "line", xAxisIndex: 0, yAxisIndex: 0,
        data: lineData(values), showSymbol: false, connectNulls: false, sampling: "lttb",
        lineStyle: { width: 1.4, color: indicator.color }, emphasis: { disabled: true },
      });
    }

    markerLookup = new Map();
    if (markerScheme === "bubble") addBubbleMarkers(series, markerGroups);
    else addTriangleMarkers(series, markerGroups);
    series.push({
      id: "focusLine", name: "定位", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: [], silent: true,
      markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: "#64748b", width: 1, type: "dashed", opacity: .8 }, data: [] },
    });
    series.push({
      id: "volume", name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1,
      data: bars.map((bar) => ({ value: [bar[0], bar[5]], itemStyle: { color: bar[2] >= bar[1] ? "#22c55e80" : "#ef444480" } })),
      large: true, largeThreshold: 600,
    });
    if (macdIndicator) {
      const macd = calculateMACD(closes, macdIndicator.fast, macdIndicator.slow, macdIndicator.signal);
      series.push(
        { id: `${macdIndicator.id}-bar`, name: "MACD", type: "bar", xAxisIndex: 2, yAxisIndex: 2, data: lineData(macd.histogram), large: true, itemStyle: { color: (p) => p.value[1] >= 0 ? "#22c55e" : "#ef4444" } },
        { id: `${macdIndicator.id}-dif`, name: "DIF", type: "line", xAxisIndex: 2, yAxisIndex: 2, data: lineData(macd.dif), showSymbol: false, lineStyle: { width: 1, color: "#60a5fa" } },
        { id: `${macdIndicator.id}-dea`, name: "DEA", type: "line", xAxisIndex: 2, yAxisIndex: 2, data: lineData(macd.dea), showSymbol: false, lineStyle: { width: 1, color: "#f59e0b" } },
      );
    }

    const axisCount = macdIndicator ? 3 : 2;
    const axisIndices = Array.from({ length: axisCount }, (_, index) => index);
    const initialStart = Math.max(0, (bars.length - INITIAL_VISIBLE_BARS) / bars.length * 100);
    const axisLine = { lineStyle: { color: "#cbd5e1" } };
    const axisLabel = { color: "#64748b", fontSize: 10 };
    const splitLine = { lineStyle: { color: "#e2e8f0" } };
    const grids = macdIndicator
      ? [{ left: 70, right: 70, top: 54, height: "53%" }, { left: 70, right: 70, top: "63%", height: "11%" }, { left: 70, right: 70, top: "78%", height: "15%" }]
      : [{ left: 70, right: 70, top: 54, height: "64%" }, { left: 70, right: 70, top: "73%", height: "18%" }];
    return {
      animation: false, backgroundColor: "#fff", useUTC: false,
      legend: {
        top: 12, left: 18, textStyle: { color: "#475569", fontSize: 11 },
        data: [...overlays.map(indicatorName), ...(markerScheme === "bubble" ? ["买 / 平", "卖 / 平"] : ["开多", "平多", "开空", "平空"])],
      },
      axisPointer: { link: [{ xAxisIndex: axisIndices }], label: { backgroundColor: "#475569" } },
      tooltip: { trigger: "axis", confine: true, axisPointer: { type: "cross" }, backgroundColor: "#0f172aee", borderColor: "#475569", textStyle: { color: "#e2e8f0", fontSize: 12 }, formatter: chartTooltip },
      grid: grids,
      xAxis: axisIndices.map((index) => ({
        type: "time", gridIndex: index, axisLine, axisLabel: { ...axisLabel, show: index === axisCount - 1 }, axisTick: { show: false },
        splitLine: { show: index === 0, ...splitLine }, axisPointer: { show: true },
      })),
      yAxis: axisIndices.map((index) => ({
        type: "value", scale: index === 0, min: index === 1 ? 0 : undefined, boundaryGap: index === 0 ? ["5%", "8%"] : undefined,
        gridIndex: index, position: index < 2 ? "left" : "right", axisLine, axisLabel, splitLine: index === 1 ? { show: false } : splitLine,
      })),
      dataZoom: [
        { type: "inside", xAxisIndex: axisIndices, filterMode: "filter", start: initialStart, end: 100, throttle: 80 },
        { type: "slider", xAxisIndex: axisIndices, filterMode: "filter", start: initialStart, end: 100, bottom: 4, height: 18, borderColor: "#cbd5e1", fillerColor: "#2563eb22", textStyle: axisLabel },
      ],
      series,
    };
  }

  function renderChart(preserveRange) {
    chart.setOption(buildOption(), { notMerge: true, lazyUpdate: true });
    if (preserveRange) {
      chart.dispatchAction({ type: "dataZoom", startValue: preserveRange[0], endValue: preserveRange[1] });
    }
    updatePerformanceStatus();
  }

  window.__BACKTEST_KLINE_DAY__ = function (payload) {
    if (!payload || typeof payload.date !== "string" || !Array.isArray(payload.bars) || !payload.bars.length) {
      throw new Error("K线日文件格式错误");
    }
    if (loadedKlineDays.has(payload.date)) throw new Error(`K线日文件重复: ${payload.date}`);
    sourceBars = payload.bars.concat(sourceBars);
    bars = aggregateBars(sourceBars, timeframeMinutes);
    loadedKlineDays.add(payload.date);
  };

  async function loadKlineDay(index) {
    const file = config.klineFiles[index];
    if (!file || loadedKlineDays.has(file.date)) return;
    await loadScript(file.src, `K线日文件 ${file.date}`);
    if (!loadedKlineDays.has(file.date)) throw new Error(`K线日文件日期不匹配: ${file.src}`);
  }

  function loadPreviousDay() {
    if (loadingPromise) return loadingPromise;
    const next = loadedKlineDays.size;
    if (next >= config.klineFiles.length) return Promise.resolve();
    const range = chart.getOption().dataZoom[0];
    const oldStart = bars[Math.floor((bars.length - 1) * (range.start || 0) / 100)][0];
    const oldEnd = bars[Math.ceil((bars.length - 1) * (range.end ?? 100) / 100)][0];
    loadingPromise = loadKlineDay(next)
      .then(() => renderChart([oldStart, oldEnd]))
      .finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  async function loadUntil(timestamp) {
    while (sourceBars[0][0] > timestamp && loadedKlineDays.size < config.klineFiles.length) {
      await loadPreviousDay();
    }
  }

  function statusClass(status) {
    return { "成交": "filled", "平仓": "closed", "止损": "stopped", "撤销": "cancelled" }[status] || "neutral";
  }

  function createCell(text) {
    const cell = document.createElement("div");
    cell.setAttribute("role", "cell");
    cell.textContent = text;
    cell.title = text;
    return cell;
  }

  function createTypeCell(order) {
    const cell = createCell("");
    const content = document.createElement("span");
    content.className = "trade-type";
    const dot = document.createElement("span");
    dot.className = "trade-dot";
    dot.style.backgroundColor = order.markerColor;
    content.append(dot, document.createTextNode(order.type || "-"));
    cell.appendChild(content);
    cell.title = order.type || "-";
    return cell;
  }

  function refreshOrderFilter() {
    const hideCancelled = document.getElementById("hide-cancelled").checked;
    displayedOrders = hideCancelled ? orders.filter((order) => order.status !== "撤销") : orders.slice();
    displayOrderIndex = new Map(displayedOrders.map((order, index) => [order.tradeId, index]));
    tableCanvas.style.height = `${displayedOrders.length * ROW_HEIGHT}px`;
    tableViewport.scrollTop = 0;
    document.getElementById("order-count").textContent =
      `显示 ${displayedOrders.length.toLocaleString("zh-CN")} / 共 ${orders.length.toLocaleString("zh-CN")} ${Array.isArray(config.metricCards) ? "条成交" : "笔委托"}，仅渲染可视区域`;
    renderVisibleRows();
    updatePerformanceStatus();
  }

  function renderVisibleRows() {
    const viewportHeight = tableViewport.clientHeight - 38;
    const scrollTop = Math.max(0, tableViewport.scrollTop - 38);
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(displayedOrders.length, start + count);
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const order = displayedOrders[index];
      const row = document.createElement("div");
      row.className = `order-row${order.tradeId === selectedTradeId ? " active" : ""}`;
      row.setAttribute("role", "row");
      row.dataset.tradeId = order.tradeId;
      row.style.top = `${index * ROW_HEIGHT}px`;
      row.append(
        createCell(formatTime(order.time)), createTypeCell(order), createCell(formatNumber(order.price, 4)),
        createCell(formatNumber(order.quantity, 4)), createCell(formatNumber(order.amount, 2)),
      );
      const statusCell = createCell("");
      const tag = document.createElement("span");
      tag.className = `status-tag status-${statusClass(order.status)}`;
      tag.textContent = order.status;
      statusCell.appendChild(tag);
      row.append(
        statusCell, createCell(formatTime(order.matchTime)), createCell(order.tradeId), createCell(order.originalId || "-"),
        createCell(formatNumber(order.profit, 2)), createCell(order.remark || "-"),
      );
      row.addEventListener("click", () => locateTrade(order.tradeId, true).catch(showError));
      fragment.appendChild(row);
    }
    tableCanvas.replaceChildren(fragment);
  }

  function initializeTable() {
    tableViewport = document.getElementById("order-table");
    const headers = ["时间", "类型", "价格", "数量", "金额", "状态", "成交时间", "委托号", "原订单ID", "盈亏", "备注"];
    const header = document.createElement("div");
    header.className = "order-header";
    header.setAttribute("role", "row");
    headers.forEach((name) => header.appendChild(createCell(name)));
    tableCanvas = document.createElement("div");
    tableCanvas.className = "order-canvas";
    tableViewport.append(header, tableCanvas);
    tableViewport.addEventListener("scroll", renderVisibleRows, { passive: true });
    document.getElementById("hide-cancelled").addEventListener("change", refreshOrderFilter);
    refreshOrderFilter();
  }

  async function locateTrade(tradeId, scrollTable) {
    const order = orderById.get(tradeId);
    if (!order) throw new Error(`找不到订单: tradeId=${tradeId}`);
    selectedTradeId = tradeId;
    if (scrollTable) {
      const rowIndex = displayOrderIndex.get(tradeId);
      if (rowIndex !== undefined) tableViewport.scrollTop = rowIndex * ROW_HEIGHT;
      renderVisibleRows();
    }
    if (!order.matchTime || !order.markerType || order.status === "撤销") return;
    if (!bars.length) return;
    await loadUntil(order.matchTime);
    const marker = markerLookup.get(tradeId);
    if (!marker) return;
    if (selectedMarker) chart.dispatchAction({ type: "downplay", ...selectedMarker });
    selectedMarker = marker;
    const barInterval = bars.length > 1 ? bars[bars.length - 1][0] - bars[bars.length - 2][0] : 60_000;
    const windowMs = barInterval * 80;
    chart.dispatchAction({ type: "dataZoom", startValue: order.matchTime - windowMs, endValue: order.matchTime + windowMs });
    chart.setOption({ series: [{ id: "focusLine", markLine: { data: [{ xAxis: order.matchTime }] } }] });
    chart.dispatchAction({ type: "highlight", ...marker });
    chart.dispatchAction({ type: "showTip", ...marker });
  }

  function updatePerformanceStatus() {
    const rendered = tableCanvas ? tableCanvas.childElementCount : 0;
    const timeframe = document.getElementById("kline-timeframe");
    const timeframeLabel = timeframe ? timeframe.selectedOptions[0].textContent : displayPeriod(config.period);
    document.getElementById("performance-status").textContent =
      `已按需加载 ${sourceBars.length.toLocaleString("zh-CN")} / ${config.barCount.toLocaleString("zh-CN")} 根${displayPeriod(config.period)}K线；当前 ${bars.length.toLocaleString("zh-CN")} 根${timeframeLabel}K线；订单DOM ${rendered} / ${displayedOrders.length.toLocaleString("zh-CN")} 行。`;
  }

  function exportOrders() {
    const fields = ["time", "type", "price", "quantity", "amount", "status", "matchTime", "tradeId", "originalId", "remark"];
    const escapeCsv = (value) => `"${String(value === null || value === undefined ? "" : value).replaceAll('"', '""')}"`;
    const rows = [fields.join(","), ...orders.map((order) => fields.map((field) => escapeCsv(order[field])).join(","))];
    const blob = new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${config.symbol.replace("/", "-")}-${config.period}-orders.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function applyRange() {
    const startValue = document.getElementById("range-start").value;
    const endValue = document.getElementById("range-end").value;
    if (!startValue || !endValue) throw new Error("请选择开始和结束日期");
    const start = new Date(`${startValue}T00:00:00`).getTime();
    const end = new Date(`${endValue}T23:59:59.999`).getTime();
    if (start > end) throw new Error("开始日期不能晚于结束日期");
    await loadUntil(start);
    chart.dispatchAction({ type: "dataZoom", startValue: start, endValue: end });
  }

  function renderNoKline() {
    const toolbar = document.querySelector(".chart-toolbar");
    const title = document.createElement("strong");
    title.textContent = "行情图表";
    const note = document.createElement("span");
    note.textContent = "所选范围暂无1分钟行情，技术指标与交易标记不可用";
    toolbar.replaceChildren(title, note);
    const chartTarget = document.getElementById("kline-chart");
    chartTarget.className = "kline-empty";
    chartTarget.textContent = "当前区间无K线数据";
    document.getElementById("performance-status").textContent =
      `当前区间无K线数据；委托记录 ${displayedOrders.length.toLocaleString("zh-CN")} 行可正常查看。`;
  }

  async function initialize() {
    await loadOrderDays();
    renderHeader();
    renderEquityChart();
    initializeTable();
    if (config.klineFiles.length) {
      const timeframeSelect = ensureTimeframeSelect();
      renderIndicatorEditor();
      chart = echarts.init(document.getElementById("kline-chart"), null, { renderer: "canvas" });
      await loadKlineDay(0);
      while (bars.length < INITIAL_LOAD_BARS && loadedKlineDays.size < config.klineFiles.length) {
        await loadKlineDay(loadedKlineDays.size);
      }
      renderChart();
      const rangeStart = document.getElementById("range-start");
      const rangeEnd = document.getElementById("range-end");
      if (rangeStart && rangeEnd) {
        rangeStart.value = localDateValue(bars[0][0]);
        rangeEnd.value = localDateValue(bars.at(-1)[0]);
      }
      chart.on("datazoom", (event) => {
        const batch = event.batch ? event.batch[0] : event;
        if (batch.start <= 5) loadPreviousDay().catch(showError);
      });
      chart.on("click", (params) => {
        if (params.data && params.data.tradeId) locateTrade(params.data.tradeId, true).catch(showError);
      });
      document.getElementById("add-indicator").addEventListener("click", addIndicator);
      timeframeSelect.addEventListener("change", (event) => {
        const range = currentVisibleRange();
        timeframeMinutes = Number.parseInt(event.target.value, 10);
        bars = aggregateBars(sourceBars, timeframeMinutes);
        selectedMarker = null;
        renderChart(range);
      });
      document.getElementById("marker-scheme").addEventListener("change", (event) => {
        markerScheme = event.target.value;
        selectedMarker = null;
        renderChart(currentVisibleRange());
      });
      const applyButton = document.getElementById("apply-range");
      if (applyButton) applyButton.addEventListener("click", () => applyRange().catch(showError));
      const refreshButton = document.getElementById("refresh-report");
      if (refreshButton) refreshButton.addEventListener("click", () => location.reload());
      const exportButton = document.getElementById("export-orders");
      if (exportButton) exportButton.addEventListener("click", exportOrders);
    } else {
      renderNoKline();
    }
    window.addEventListener("resize", () => { equityChart.resize(); if (chart) chart.resize(); });
  }

  initialize().catch(showError);
}());
}
