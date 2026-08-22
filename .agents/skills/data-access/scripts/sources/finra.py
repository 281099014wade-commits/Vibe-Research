"""FINRA Reg SHO 每日空头成交量(B 级,仅美股):全市场快照 / 单票序列 / 占比排行。移植自 global-stock-data Layer 9;经 _http.official_get 限流。"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import DataNotAvailable, assert_us_ticker, last_raw_ref, official_get  # noqa: E402


def _recent_weekdays(days_back: int = 7) -> list[str]:
    d, out = datetime.utcnow(), []
    while len(out) < days_back:
        if d.weekday() < 5:
            out.append(d.strftime("%Y%m%d"))
        d -= timedelta(days=1)
    return out


def short_volume_all(date: Optional[str] = None, market: str = "CNMS") -> dict:
    """{date, market, count, data:{SYMBOL:{short, short_exempt, total, ratio}}};market: CNMS / FNSQ / FNYX / FNRA"""
    for d in ([date] if date else _recent_weekdays(7)):
        try:
            raw = official_get(f"https://cdn.finra.org/equity/regsho/daily/{market}shvol{d}.txt")
        except DataNotAvailable:
            continue
        rows = {}
        for line in raw.splitlines()[1:]:
            p = line.split("|")
            if len(p) < 5 or not p[1]:
                continue
            try:
                sv, se, tv = float(p[2]), float(p[3]), float(p[4])
            except ValueError:
                continue
            rows[p[1]] = {"short": sv, "short_exempt": se, "total": tv, "ratio": round(sv / tv, 4) if tv else None}
        if rows:
            return {"date": d, "market": market, "count": len(rows), "data": rows, "_raw": last_raw_ref()}
    raise DataNotAvailable(f"未找到 {market} {'该日' if date else '近 7 个工作日'}的 Reg SHO 数据")


def short_volume_symbol(symbol: str, days: int = 5, market: str = "CNMS") -> list[dict]:
    """单票近 N 个交易日空头成交占比:[{date, short, short_exempt, total, ratio}]"""
    t = assert_us_ticker(symbol)
    out = []
    for d in _recent_weekdays(days * 2):
        if len(out) >= days:
            break
        try:
            snap = short_volume_all(date=d, market=market)
        except DataNotAvailable:
            continue
        rec = snap["data"].get(t)
        if rec:
            out.append({"date": d, **rec, "_raw": snap.get("_raw")})
    return out


def short_volume_ranking(snapshot: dict, min_total: float = 1_000_000, top: int = 20) -> list[dict]:
    rows = [{"symbol": s, **v} for s, v in snapshot["data"].items() if v["total"] >= min_total and v["ratio"] is not None]
    return sorted(rows, key=lambda x: -x["ratio"])[:top]


def short_volume_ranking_latest(min_total: float = 1_000_000, top: int = 20, market: str = "CNMS", date: Optional[str] = None) -> dict:
    """端点函数:最近一日全市场快照 → 占比排行:{date, market, count, ranking:[...]}"""
    snap = short_volume_all(date=date, market=market)
    return {"date": snap["date"], "market": market, "count": snap["count"], "ranking": short_volume_ranking(snap, min_total=min_total, top=top)}
