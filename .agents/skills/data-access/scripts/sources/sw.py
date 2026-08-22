"""申万研究所源:行业分类变迁史(StockClassifyUse_stock.xls),消除行业前视偏差。移植自 a-stock-data SKILL.md §6.7。依赖 pandas + xlrd。"""
from __future__ import annotations

import io
import os
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import norm_ticker, today_str  # noqa: E402
from sources._http import http_get, insecure_tls_allowed  # noqa: E402

SW_URL = "https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls"
_CACHE = None


def sw_industry_history():
    """全表 DataFrame:code / start_date / industry_code / l1_code / l2_code(每只股票每次行业调整一行),进程内缓存。"""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    import pandas as pd
    import requests
    try:
        r = http_get(SW_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=60, ext="xls")
        tls_verified = True
    except requests.exceptions.SSLError as e:
        # 申万站点证书链在部分机器上缺中间证书(certifi 无法验证)。默认失败;只有显式设置 VRA_ALLOW_INSECURE_TLS=1 才降级为不校验重试,并在结果 / 证据里明示。
        if not insecure_tls_allowed():
            raise RuntimeError(f"申万站点证书校验失败({type(e).__name__});若接受风险可设环境变量 VRA_ALLOW_INSECURE_TLS=1 降级(仅研究用)") from e
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        r = http_get(SW_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=60, ext="xls", verify=False)
        tls_verified = False
    r.raise_for_status()
    df = pd.read_excel(io.BytesIO(r.content))
    df.attrs["tls_verified"] = tls_verified
    df = df.rename(columns={"股票代码": "code", "计入日期": "start_date", "行业代码": "industry_code", "更新日期": "update_date"})
    missing = {"code", "start_date", "industry_code"} - set(df.columns)
    if missing:
        raise RuntimeError(f"申万表结构变了,缺列 {sorted(missing)};实际列={list(df.columns)}")
    df["code"] = df["code"].astype(str).str.zfill(6)
    df["industry_code"] = df["industry_code"].astype(str).str.zfill(6)
    df["l1_code"] = df["industry_code"].str[:2] + "0000"
    df["l2_code"] = df["industry_code"].str[:4] + "00"
    df["start_date"] = pd.to_datetime(df["start_date"], errors="coerce")
    _CACHE = df.sort_values(["code", "start_date"]).reset_index(drop=True)
    return _CACHE


def sw_industry(code: str, as_of: Optional[str] = None) -> dict:
    """某股在 as_of(默认今天)的申万行业 + 全部变迁记录:{code, as_of, current:{industry_code,l1_code,l2_code,since}|None, history:[...], table_rows, table_stocks}"""
    import pandas as pd
    digits, _ = norm_ticker(code, stock_only=True)
    as_of = as_of or today_str()
    df = sw_industry_history()
    sub = df[df["code"] == digits]
    hist = [{"industry_code": r.industry_code, "l1_code": r.l1_code, "l2_code": r.l2_code, "since": r.start_date.strftime("%Y-%m-%d") if pd.notna(r.start_date) else ""} for r in sub.itertuples(index=False)]
    cur_rows = sub[sub["start_date"] <= pd.Timestamp(as_of)]
    current = None
    if not cur_rows.empty:
        r = cur_rows.iloc[-1]
        current = {"industry_code": r["industry_code"], "l1_code": r["l1_code"], "l2_code": r["l2_code"], "since": r["start_date"].strftime("%Y-%m-%d")}
    return {"code": digits, "as_of": as_of, "current": current, "history": hist, "table_rows": int(len(df)), "table_stocks": int(df["code"].nunique()), "tls_verified": df.attrs.get("tls_verified", True)}
