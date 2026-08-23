"""产业温度计(注册表第 13 层):不是关于某家公司,是关于它所在产业链上下游的硬数据。

按公司的行业 / 概念归属挂载(编排器在 risk 阶段前按 datasources/industry_tags.json 判定),risk 阶段当"产业温度计"
写进报告,与公司自己的事实 / 估值对照 = 印证或反证。零鉴权、纯标准库 + requests;每个数字带来源与读法护栏。

实现移植自 产业挖掘-Scan-claude_V2/tools/tw_monthly_sweep.py 与 price_signals.py(2026-08-23),含它们踩过的坑:
  - FinMind 402(配额 / 限流)时**部分失败必须出声**(V2 曾静默从 12 家变 4 家);资料期过期(> 2 个月)不能当"当前";
  - Vast:q 参数必须是 urlencode 后的 JSON;🔴 带浏览器 UA 会 403,urllib 默认 UA 才通(这里显式传 Python-urllib);
    撮合市场报价分散 → 取中位数;H100 等旧卡"无在租报价"是市场状态不是故障;offers 有内容却解析不出 dph_total 才是真故障;
  - Kalshi 阶梯市场三分:ticker 一个都认不出 = 格式变了(真故障);认得出但无报价 = 未开盘 / 无成交(真实状态);
  - $3/卡时是 **B200 设备折旧参考线不是完整经济保本线**(不含电力 / 机房 / 运维);前沿紧与商品松可以同时为真。
"""
from __future__ import annotations

import json
import math
import re
import statistics
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sources._http import http_get

FINMIND = "https://api.finmindtrade.com/api/v4/data"
TW_DEFAULT = "2383,6274,2368,3081"
TW_NAMES = {"2383": "台光电子·CCL(M8/M9;英伟达链 + AWS Trainium 独供)", "6274": "台燿·CCL(交换机料)",
            "2368": "金像电·PCB(ASIC / Trainium 侧)", "3081": "联亚光电·InP 外延(光芯片上游)"}
VAST_BASE = "https://console.vast.ai/api/v0/bundles/?q="
KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXB200MS&status=open&limit=200"
DEPRECIATION_LINE = 3.0  # B200 每卡时设备折旧参考线(父项目标定,勿随意改);不是完整经济保本线


class IndustryError(RuntimeError):
    pass


def _prev(y: int, m: int) -> tuple[int, int]:
    return (y - 1, 12) if m == 1 else (y, m - 1)


def _months_between(a: tuple[int, int], b: tuple[int, int]) -> int:
    return (b[0] - a[0]) * 12 + (b[1] - a[1])


TAIPEI = ZoneInfo("Asia/Taipei")
SHANGHAI = ZoneInfo("Asia/Shanghai")  # GPU 快照日期按产品用户所在时区(UTC+8)标,避免 UTC 日期在本地凌晨少一天


def _now_taipei(now: Optional[datetime]) -> datetime:
    """月营收按台湾时间判"当前月";传入的 now(UTC / aware)换算到台北。"""
    n = now or datetime.now(timezone.utc)
    return (n if n.tzinfo else n.replace(tzinfo=timezone.utc)).astimezone(TAIPEI)


def _finmind_months(ticker: str, start_date: str, now_tw: datetime) -> tuple[dict, Optional[str]]:
    r = http_get(FINMIND, params={"dataset": "TaiwanStockMonthRevenue", "data_id": ticker, "start_date": start_date}, timeout=25, ext="json")
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code == 402:
        raise IndustryError(f"FinMind HTTP 402(配额 / 限流):{r.text[:120]}")
    if r.status_code >= 400:
        raise IndustryError(f"FinMind HTTP {r.status_code}:{r.text[:120]}")
    payload = r.json()
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise IndustryError(f"FinMind data 结构异常:{str(payload)[:120]}")
    months = {}
    for row in rows:
        try:
            y, m, v = int(row["revenue_year"]), int(row["revenue_month"]), float(row["revenue"])
        except (KeyError, TypeError, ValueError) as e:
            raise IndustryError(f"FinMind 行结构异常:{row!r}"[:160]) from e
        if not (2000 <= y <= 2100 and 1 <= m <= 12) or not math.isfinite(v) or v <= 0:
            raise IndustryError(f"月营收数值 / 期间无效:{row!r}"[:160])
        if (y, m) > (now_tw.year, now_tw.month):
            raise IndustryError(f"FinMind 返回未来月份 {y}-{m:02d}(契约 / 时钟异常)")
        if (y, m) in months and months[(y, m)] != v:
            raise IndustryError(f"FinMind 同一月份 {y}-{m:02d} 出现两个不同值:{months[(y, m)]} vs {v}")
        months[(y, m)] = v  # 完全相同的重复行去重
    return months, raw


def _build_company(ticker: str, months: dict, now: datetime) -> dict:
    """now 已是台北时间。缺前月 / 去年同月 / 累计基数不抛,但写进 missing(mapper 据此标 partial)。"""
    if not months:
        raise IndustryError("无月营收数据")
    y, m = max(months)
    current = months[(y, m)]
    previous = months.get(_prev(y, m))
    prior_year = months.get((y - 1, m))
    missing = []
    if previous is None:
        missing.append("前月(环比基数)")
    if prior_year is None:
        missing.append("去年同月(同比基数)")
    seq = []
    cur = (y, m)
    periods = []
    for _ in range(4):
        periods.append(cur)
        cur = _prev(*cur)
    for p in reversed(periods):
        v, b = months.get(p), months.get(_prev(*p))
        if v and b:
            seq.append(round((v / b - 1) * 100, 1))
    cum_ok = all((y, i) in months and (y - 1, i) in months for i in range(1, m + 1))
    if not cum_ok:
        missing.append("年初至今累计基数(缺月)")
    cum = sum(months[(y, i)] for i in range(1, m + 1)) if cum_ok else None
    cum_prior = sum(months[(y - 1, i)] for i in range(1, m + 1)) if cum_ok else None
    lag = _months_between((y, m), (now.year, now.month))
    return {"ticker": ticker, "name": TW_NAMES.get(ticker, ticker), "latest_period": f"{y}-{m:02d}", "lag_months": lag, "missing": missing,
            "stale": lag > 2, "revenue_twd": current, "revenue_e8twd": round(current / 1e8, 2),
            "mom_pct": round((current / previous - 1) * 100, 1) if previous else None,
            "yoy_pct": round((current / prior_year - 1) * 100, 1) if prior_year else None,
            "cum_yoy_pct": round((cum / cum_prior - 1) * 100, 1) if cum is not None and cum_prior else None,
            "mom_seq_pct": seq, "months_available": len(months)}


def _differential(companies: list) -> Optional[dict]:
    """R6.6 读法:台光(2383)同时供英伟达链与 AWS Trainium,不能单独归因 → 与金像电(2368,ASIC / Trainium 侧 PCB)差分。"""
    by = {c["ticker"]: c for c in companies}
    a, b = by.get("2383"), by.get("2368")
    if not a or not b or a.get("mom_pct") is None or b.get("mom_pct") is None:
        return None
    ccl, pcb = a["mom_pct"], b["mom_pct"]
    if ccl > 0 and pcb > 0:
        reading = "台光与金像电环比同增:更可能是 Trainium / ASIC 链在拉,不能单独归因英伟达链"
    elif ccl > 0 and pcb <= 0:
        reading = "台光环比增而金像电平 / 负:更像英伟达链在拉"
    elif ccl <= 0 and pcb <= 0:
        reading = "台光与金像电环比同弱:真降温信号(第一警讯)"
    else:
        reading = "台光环比转负而金像电增:ASIC 侧独强,英伟达链排产需警惕"
    return {"ccl_2383_mom_pct": ccl, "pcb_2368_mom_pct": pcb, "reading": reading, "raw_ref_2383": a.get("raw_ref"), "raw_ref_2368": b.get("raw_ref"),
            "period_2383": a.get("latest_period"), "period_2368": b.get("latest_period")}


def tw_monthly_revenue(tickers: str = TW_DEFAULT, years: int = 2, now: Optional[datetime] = None) -> dict:
    """台股法定月营收(每月 10 日前披露,滞后 ~10 天):英伟达链排产最快的硬数据。返回 {companies, errors, differential, checked_at}。
    全部失败 → 抛(信封 failed);部分失败 / 资料期过期 → 由 mapper 标 partial 出声。"""
    now_tw = _now_taipei(now)
    start = f"{now_tw.year - int(years)}-01-01"
    companies, errors, raws = [], [], {}
    for t in [x.strip() for x in str(tickers).split(",") if x.strip()]:
        try:
            months, raw = _finmind_months(t, start, now_tw)
            c = _build_company(t, months, now_tw)
            c["raw_ref"] = raw
            companies.append(c)
        except Exception as e:  # noqa: BLE001 — 每家单独记错,最后再判全灭
            errors.append({"ticker": t, "error": f"{type(e).__name__}: {str(e)[:160]}"})
    if not companies:
        raise IndustryError("台系月营收全部失败:" + "; ".join(e["error"] for e in errors)[:300])
    return {"companies": companies, "errors": errors, "differential": _differential(companies),
            "checked_at": now_tw.strftime("%Y-%m-%d"), "checked_tz": "Asia/Taipei", "source": "FinMind TaiwanStockMonthRevenue(零鉴权)"}


def _vast_spot(gpu: str) -> dict:
    """任何异常都收敛成 error 项(不让一张卡拖垮整个端点);顶层 offers 字段缺失 / 非列表 = 契约变化,不是"无报价"。"""
    query = {"gpu_name": {"eq": gpu}, "rentable": {"eq": True}, "order": [["dph_total", "asc"]], "limit": 30}
    try:
        r = http_get(VAST_BASE + urllib.parse.quote(json.dumps(query)), headers={"User-Agent": "Python-urllib/3.12"}, timeout=40, ext="json")
    except Exception as e:  # noqa: BLE001
        return {"gpu": gpu, "error": f"Vast 请求失败:{type(e).__name__}: {str(e)[:120]}"}
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code >= 400:
        return {"gpu": gpu, "error": f"Vast HTTP {r.status_code}", "raw_ref": raw}
    try:
        body = r.json()
    except Exception as e:  # noqa: BLE001
        return {"gpu": gpu, "error": f"Vast 响应不是 JSON:{type(e).__name__}", "raw_ref": raw}
    offers = body.get("offers") if isinstance(body, dict) else None
    if not isinstance(offers, list):
        return {"gpu": gpu, "error": "Vast 响应缺少 offers 列表(契约可能已变)", "raw_ref": raw}
    prices, bad = [], 0
    for o in offers:
        try:
            if not isinstance(o, dict) or isinstance(o.get("dph_total"), bool):
                raise ValueError("offer 不是对象或 dph_total 非数值")
            total = float(o["dph_total"])
            n = int(o.get("num_gpus") or 1)
            if total <= 0 or n <= 0:
                raise ValueError("dph_total / num_gpus 非正")
            prices.append(total / n)
        except (KeyError, TypeError, ValueError):
            bad += 1  # 单条报价坏不击穿整张卡;全坏才是契约错
    prices.sort()
    if not prices:
        if offers:
            return {"gpu": gpu, "error": f"返回 {len(offers)} 条报价但无一可解析(坏条目 {bad};契约可能已变)", "raw_ref": raw}
        return {"gpu": gpu, "unavailable": True, "note": "无在租报价(市场状态不是故障;旧卡常态)", "n_offers": 0, "raw_ref": raw}
    mid = statistics.median(prices)  # 偶数样本取中间两值平均(真中位数;V2 取上中位是错的)
    return {"gpu": gpu, "n_offers": len(prices), "bad_offers": bad, "median_usd_per_gpu_hr": round(mid, 2), "min": round(prices[0], 2), "max": round(prices[-1], 2),
            "below_depreciation_line": mid < DEPRECIATION_LINE, "raw_ref": raw}


_MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6, "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}


def _contract_month(token: str) -> Optional[str]:
    """Kalshi ticker 的合约月记号 '26SEP' → '2026-09';认不出 → None。"""
    mm = re.fullmatch(r"(\d{2})([A-Z]{3})", token or "")  # 严格整体匹配:'26SEPT' / '26SEPXYZ' 不算合约月(格式变了要出声)
    if not mm or mm.group(2) not in _MONTHS:
        return None
    return f"20{mm.group(1)}-{_MONTHS[mm.group(2)]:02d}"


def _kalshi_forward() -> dict:
    """同一 series 下可能同时有多个合约月:按合约月分组,只用**最近的一个月**(不跨月混排),并把该月写进结果。"""
    try:
        r = http_get(KALSHI_API, timeout=40, ext="json")
    except Exception as e:  # noqa: BLE001
        return {"error": f"Kalshi 请求失败:{type(e).__name__}: {str(e)[:120]}"}
    raw = getattr(r, "_vra_raw_ref", None)
    if r.status_code >= 400:
        return {"error": f"Kalshi HTTP {r.status_code}", "raw_ref": raw}
    try:
        body = r.json()
    except Exception as e:  # noqa: BLE001
        return {"error": f"Kalshi 响应不是 JSON:{type(e).__name__}", "raw_ref": raw}
    ms = body.get("markets") if isinstance(body, dict) else None
    if not isinstance(ms, list):
        return {"error": "Kalshi 响应缺少 markets 列表(契约可能已变)", "raw_ref": raw}
    by_month: dict[str, list] = {}
    parseable = 0
    for m in ms:
        if not isinstance(m, dict):
            continue
        t = str(m.get("ticker", ""))
        mm = re.search(r"-(\d+\.?\d*)$", t)
        parts = t.split("-")
        month = _contract_month(parts[1]) if len(parts) >= 3 else None
        if not mm or not month:
            continue
        parseable += 1
        bid, ask = m.get("yes_bid"), m.get("yes_ask")
        px = (bid + ask) / 2 if isinstance(bid, (int, float)) and isinstance(ask, (int, float)) else m.get("last_price")
        if not isinstance(px, (int, float)):
            continue
        by_month.setdefault(month, []).append({"strike": float(mm.group(1)), "p_above": px / 100})
    if not by_month:
        if ms and not parseable:
            return {"error": f"返回 {len(ms)} 个市场但无一可解析为档位 / 合约月(ticker 格式可能已变)", "raw_ref": raw}
        return {"unavailable": True, "n_rungs": 0, "note": "阶梯市场无有效报价(未开盘或无成交)", "raw_ref": raw}
    month = min(by_month)  # 最近的合约月
    rungs = sorted(by_month[month], key=lambda x: x["strike"])
    low = rungs[0]
    return {"contract_month": month, "n_rungs": len(rungs), "lowest_strike": low["strike"], "p_below_lowest": round(1 - low["p_above"], 3),
            "ladder": [{"strike": x["strike"], "p_above": round(x["p_above"], 3)} for x in rungs[:6]], "other_months": sorted(k for k in by_month if k != month), "raw_ref": raw}


def gpu_rent_thermometer(gpus: str = "B200,H100", now: Optional[datetime] = None) -> dict:
    """GPU 租金温度计:现货(Vast 撮合市场,中位数)+ 远期(Kalshi KXB200MS 阶梯市场 → P(月均 < 最低档))。
    现货与远期都拿不到 → 抛;单边失败由 mapper 标 partial。"""
    n = now or datetime.now(timezone.utc)
    now = (n if n.tzinfo else n.replace(tzinfo=timezone.utc)).astimezone(SHANGHAI)
    spot = []
    for i, g in enumerate([x.strip() for x in str(gpus).split(",") if x.strip()]):
        if i:
            time.sleep(1.0)  # Vast 连续请求会 429(实测第二张卡常撞),隔 1 秒
        spot.append(_vast_spot(g))
    forward = _kalshi_forward()
    # 只有"现货每张卡都是 error 且远期也 error"才算全部失败;"无在租报价"是市场状态(有效响应),不算失败
    spot_all_failed = bool(spot) and all("error" in s for s in spot)
    if spot_all_failed and "error" in forward:
        raise IndustryError("GPU 租金现货与远期全部失败:" + "; ".join(str(s.get("error")) for s in spot) + "; " + str(forward.get("error")))
    return {"spot": spot, "forward": forward, "depreciation_line_usd": DEPRECIATION_LINE, "checked_at": now.strftime("%Y-%m-%d"), "checked_tz": "Asia/Shanghai",
            "source": "Vast.ai bundles(零鉴权)+ Kalshi trade-api v2(零鉴权)"}
