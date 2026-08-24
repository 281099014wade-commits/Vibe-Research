"""产业温度计(第 13 层)离线测试:FinMind 月营收 / Vast 现货 / Kalshi 远期的取数、三分判定、差分读法与 mapper 证据形状。不访问网络。"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(SCRIPTS, "..", "..", "..", ".."))
sys.path.insert(0, SCRIPTS)
from sources import industry, mappers_industry  # noqa: E402

NOW = datetime(2026, 8, 23, tzinfo=timezone.utc)


class R:
    def __init__(self, status, body, raw="raw/x.json"):
        self.status_code, self._body, self._vra_raw_ref = status, body, raw
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return self._body if not isinstance(self._body, str) else json.loads(self._body)


def _months(ticker, base, months=20, growth=1.05):
    rows, v = [], base
    y, m = 2025, 1
    for _ in range(months):
        rows.append({"revenue_year": y, "revenue_month": m, "revenue": v, "stock_id": ticker})
        v *= growth
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return rows


def test_tw_monthly_revenue_rows_differential_and_partial(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None, ext=None, **kw):
        t = params["data_id"]
        if t == "3081":
            return R(402, "Payment Required: quota exceeded")
        data = _months(t, 1e10 if t == "2383" else 5e9, growth=1.05 if t != "2368" else 0.98)
        return R(200, {"data": data}, raw=f"raw/finmind_{t}.json")

    monkeypatch.setattr(industry, "http_get", fake_get)
    r = industry.tw_monthly_revenue("2383,6274,2368,3081", now=NOW)
    assert [c["ticker"] for c in r["companies"]] == ["2383", "6274", "2368"] and r["errors"][0]["ticker"] == "3081" and "402" in r["errors"][0]["error"]
    c = r["companies"][0]
    assert c["latest_period"] == "2026-08" and c["mom_pct"] == 5.0 and c["yoy_pct"] == round((1.05 ** 12 - 1) * 100, 1) and c["raw_ref"] == "raw/finmind_2383.json"
    assert len(c["mom_seq_pct"]) == 4 and c["cum_yoy_pct"] is not None and c["stale"] is False
    assert r["differential"]["reading"].startswith("台光环比增而金像电平 / 负"), r["differential"]
    m = mappers_industry.tw_monthly_revenue_map(r, {"script": "tw_monthly_revenue", "symbol": "MARKET", "market": "CN", "source": "finmind", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert m["status"] == "partial" and "402" in m["degraded"]
    f = [e for e in m["evidence"] if e["field"] == "tw_monthly_revenue" and e["symbol"] == "2383"][0]
    assert f["market"] == "TW" and f["currency"] == "TWD" and f["unit"] == "亿新台币" and f["period"] == "2026-08-01..2026-08-31" and f["raw_ref"] == "raw/finmind_2383.json"
    assert "读法:" in f["note"] and "差分" in f["note"]
    diff = [e for e in m["evidence"] if e["field"] == "tw_chain_differential"][0]
    assert diff["unit"] == "text" and "ccl_2383_mom_pct=5.0" in diff["note"]
    keys = [(e["field"], e["symbol"]) for e in m["evidence"]]
    assert len(keys) == len(set(keys))


def test_tw_monthly_revenue_all_fail_and_stale(monkeypatch):
    monkeypatch.setattr(industry, "http_get", lambda *a, **k: R(500, "boom"))
    with pytest.raises(industry.IndustryError, match="全部失败"):
        industry.tw_monthly_revenue("2383", now=NOW)
    # 资料期过期(最新 2026-03,now 2026-08)→ stale → mapper partial
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": _months(params["data_id"], 1e9, months=15)}))
    r = industry.tw_monthly_revenue("2383", now=NOW)
    assert r["companies"][0]["latest_period"] == "2026-03" and r["companies"][0]["stale"] is True
    m = mappers_industry.tw_monthly_revenue_map(r, {"script": "x", "symbol": "MARKET", "market": "CN", "source": "finmind", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert m["status"] == "partial" and "过期" in m["degraded"]
    # 数值无效 → 该家报错
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": [{"revenue_year": 2026, "revenue_month": 7, "revenue": -5}]}))
    with pytest.raises(industry.IndustryError):
        industry.tw_monthly_revenue("2383", now=NOW)


def test_gpu_rent_three_way_and_mapper(monkeypatch):
    offers = {"offers": [{"dph_total": 13.0, "num_gpus": 2}, {"dph_total": 7.0, "num_gpus": 1}, {"dph_total": 20.0, "num_gpus": 4}]}
    kalshi = {"markets": [{"ticker": "KXB200MS-26SEP-3", "yes_bid": 60, "yes_ask": 70}, {"ticker": "KXB200MS-26SEP-5", "last_price": 20}, {"ticker": "KXB200MS-26SEP-X"}]}
    calls = []

    def fake_get(url, params=None, headers=None, timeout=None, ext=None, **kw):
        calls.append((url[:40], headers))
        if "vast.ai" in url:
            if "H100" in url:
                return R(200, {"offers": []}, raw="raw/vast_h100.json")
            return R(200, offers, raw="raw/vast_b200.json")
        return R(200, kalshi, raw="raw/kalshi.json")

    monkeypatch.setattr(industry, "http_get", fake_get)
    g = industry.gpu_rent_thermometer("B200,H100", now=NOW)
    assert calls[0][1]["User-Agent"].startswith("Python-urllib"), "Vast 必须用 urllib UA(浏览器 UA 会 403)"
    b = g["spot"][0]
    assert b["median_usd_per_gpu_hr"] == 6.5 and b["n_offers"] == 3 and b["min"] == 5.0 and b["max"] == 7.0 and b["below_depreciation_line"] is False
    assert g["spot"][1]["unavailable"] is True
    f = g["forward"]
    assert f["n_rungs"] == 2 and f["lowest_strike"] == 3.0 and f["p_below_lowest"] == 0.35
    m = mappers_industry.gpu_rent_thermometer_map(g, {"script": "gpu_rent_thermometer", "symbol": "MARKET", "market": "CN", "source": "vast+kalshi", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert m["status"] == "ok"
    fields = {(e["field"], e["symbol"]): e for e in m["evidence"]}
    spot = fields[("gpu_spot_median_usd_per_gpu_hr", "B200")]
    assert spot["market"] == "US" and spot["currency"] == "USD" and spot["unit"] == "美元/卡时" and spot["value"] == 6.5 and spot["raw_ref"] == "raw/vast_b200.json" and "折旧参考线" in spot["note"]
    assert fields[("gpu_spot_offer_count", "H100")]["value"] == 0
    assert fields[("gpu_forward_p_below_lowest_strike", "B200")]["value"] == 0.35 and fields[("gpu_forward_lowest_strike_usd", "B200")]["currency"] == "USD"


def test_gpu_rent_failure_modes(monkeypatch):
    # offers 有内容却无 dph_total → 真故障;Kalshi ticker 全不可解析 → 真故障;两边全失败 → 抛
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, {"offers": [{"foo": 1}]}) if "vast" in url else R(200, {"markets": [{"ticker": "WEIRD"}]}))
    with pytest.raises(industry.IndustryError, match="全部失败"):
        industry.gpu_rent_thermometer("B200", now=NOW)
    # 现货 429 但远期正常 → 不抛,mapper partial 出声
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(429, "rate limited") if "vast" in url else R(200, {"markets": [{"ticker": "KXB200MS-26SEP-3", "last_price": 50}]}))
    g = industry.gpu_rent_thermometer("B200", now=NOW)
    m = mappers_industry.gpu_rent_thermometer_map(g, {"script": "x", "symbol": "MARKET", "market": "CN", "source": "v", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert m["status"] == "partial" and "429" in m["degraded"] and any(e["field"] == "gpu_forward_p_below_lowest_strike" for e in m["evidence"])


def test_registry_endpoints_and_tag_table():
    """标签表与注册表**双向**一致:每个 tag 的 thermometers 都是真端点、端点的 industry_tags 必须回指该 tag;
    每个端点的 module / mapper_module 都能导入且参数对得上(端点可以来自不同源模块,如大宗走 commodity)。"""
    import importlib
    import inspect
    reg = json.load(open(os.path.join(REPO, "datasources", "registry.json"), encoding="utf-8"))
    eps = {e["id"]: e for e in reg["endpoints"]}
    tags = json.load(open(os.path.join(REPO, "datasources", "industry_tags.json"), encoding="utf-8"))["tags"]
    seen = set()
    for tag, td in tags.items():
        assert td["thermometers"], f"{tag} 没有温度计"
        for i in td["thermometers"]:
            e = eps[i]
            seen.add(i)
            assert e["layer"] == "13 产业温度计" and e["stages"] == {"risk": "optional"} and e["symbol_kind"] == "none"
            assert tag in e["industry_tags"], f"{i} 的 industry_tags 必须回指 {tag}(单向声明会让门控与提示词对不上)"
            mod = importlib.import_module(f"sources.{e['module']}")
            mappers = importlib.import_module(f"sources.{e['mapper_module']}")
            assert hasattr(mod, e["function"]) and hasattr(mappers, e["mapper"])
            params = inspect.signature(getattr(mod, e["function"])).parameters
            assert all(k in params for k in e.get("args", {})), f"{i} 注册表参数必须被函数接受"
    # 反向:**第 13 层**带 industry_tags 的端点必须被某个 tag 的 thermometers 收录(否则取了数、提示词却不列它 → 没人写进报告);
    # 其它层(如第 15 层数据日历的 us_anchor_earnings)可以借用同一套产业门控但不算温度计,由各自的提示词条目介绍。
    tagged13 = {e["id"] for e in reg["endpoints"] if e.get("industry_tags") and e.get("layer") == "13 产业温度计"}
    assert tagged13 == seen, f"第 13 层端点与标签表不一致:仅端点声明 {tagged13 - seen} / 仅标签表列出 {seen - tagged13}"
    other = [e["id"] for e in reg["endpoints"] if e.get("industry_tags") and e.get("layer") != "13 产业温度计"]
    for i in other:
        assert all(t in tags for t in eps[i]["industry_tags"]), f"{i} 借用了不存在的产业标签"
    assert set(tags["ai_compute"]["thermometers"]) == {"tw_monthly_revenue", "gpu_rent_thermometer", "cn_commodity_futures"}
    assert "折旧参考线" in tags["ai_compute"]["guard"] and "采购价" in tags["ai_compute"]["guard"]
    assert set(tags["storage_memory"]["thermometers"]) == {"dram_spot_thermo"}
    assert "不是 HBM 价格" in tags["storage_memory"]["guard"] and "社区" in tags["storage_memory"]["guard"]


# ---------- Codex industry-r1 补的用例 ----------
def _ctx(script="x"):
    return {"script": script, "symbol": "MARKET", "market": "CN", "source": "s", "endpoint": "x", "as_of": None, "raw_ref": "raw/last.json", "args": {}}


def test_finmind_duplicates_future_and_missing_basis(monkeypatch):
    # 同月两个不同值 → 该家报错;完全相同重复行 → 去重放行
    rows = _months("2383", 1e9, months=19) + [{"revenue_year": 2026, "revenue_month": 7, "revenue": 123.0}]
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": rows}))
    with pytest.raises(industry.IndustryError, match="全部失败"):
        industry.tw_monthly_revenue("2383", now=NOW)
    dup = _months("2383", 1e9, months=19); dup.append(dict(dup[-1]))
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": dup}))
    assert industry.tw_monthly_revenue("2383", now=NOW)["companies"][0]["latest_period"] == "2026-07"
    # 未来月份(now 台北 2026-08)→ 报错
    fut = _months("2383", 1e9, months=19) + [{"revenue_year": 2026, "revenue_month": 9, "revenue": 5e9}]
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": fut}))
    with pytest.raises(industry.IndustryError, match="全部失败"):
        industry.tw_monthly_revenue("2383", now=NOW)
    # 只有 2026-01 与 2026-03:缺前月 / 去年同月 / 累计基数 → 不抛但 missing,mapper partial
    sparse = [{"revenue_year": 2026, "revenue_month": 1, "revenue": 1e9}, {"revenue_year": 2026, "revenue_month": 3, "revenue": 2e9}]
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": sparse}))
    r = industry.tw_monthly_revenue("2383", now=NOW)
    c = r["companies"][0]
    assert c["mom_pct"] is None and c["yoy_pct"] is None and c["cum_yoy_pct"] is None and len(c["missing"]) == 3 and c["stale"] is True
    m = mappers_industry.tw_monthly_revenue_map(r, _ctx())
    assert m["status"] == "partial" and m["missing"] and all("读法:" in e["note"] for e in m["evidence"] if e["unit"] != "text")
    # 台北时区:UTC 2026-08-31 17:00 = 台北 9-1 01:00 → "当前月"是 9 月,8 月数据不算未来
    aug = _months("2383", 1e9, months=20)
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": aug}))
    r2 = industry.tw_monthly_revenue("2383", now=datetime(2026, 8, 31, 17, 0, tzinfo=timezone.utc))
    assert r2["companies"][0]["latest_period"] == "2026-08" and r2["checked_at"] == "2026-09-01"


def test_differential_binds_both_raws_and_all_numeric_notes_have_guard(monkeypatch):
    monkeypatch.setattr(industry, "http_get", lambda url, params=None, **k: R(200, {"data": _months(params["data_id"], 1e9)}, raw=f"raw/fm_{params['data_id']}.json"))
    r = industry.tw_monthly_revenue("2383,6274,2368,3081", now=NOW)
    m = mappers_industry.tw_monthly_revenue_map(r, _ctx())
    d = [e for e in m["evidence"] if e["field"] == "tw_chain_differential"][0]
    assert d["raw_ref"] == "raw/fm_2383.json" and "raw_ref_2368=raw/fm_2368.json" in d["note"] and d["period"].startswith("2026-08-01")
    for e in m["evidence"]:
        if e["unit"] != "text":
            assert "读法:" in e["note"], e["field"]


def test_vast_true_median_contract_errors_and_isolation(monkeypatch):
    def fake(url, params=None, headers=None, timeout=None, ext=None, **kw):
        if "vast.ai" in url:
            if "H100" in url:
                raise ConnectionError("boom")
            return R(200, {"offers": [{"dph_total": 2.0, "num_gpus": 1}, {"dph_total": 10.0, "num_gpus": 1}]})
        return R(200, {"markets": [{"ticker": "KXB200MS-26OCT-2", "last_price": 40}, {"ticker": "KXB200MS-26SEP-3", "yes_bid": 60, "yes_ask": 70}, {"ticker": "KXB200MS-26SEP-5", "last_price": 20}]})
    monkeypatch.setattr(industry, "http_get", fake)
    g = industry.gpu_rent_thermometer("B200,H100", now=NOW)
    assert g["spot"][0]["median_usd_per_gpu_hr"] == 6.0, "偶数样本取真中位数"
    assert "ConnectionError" in g["spot"][1]["error"], "单卡异常隔离成 error 项"
    f = g["forward"]
    assert f["contract_month"] == "2026-09" and f["n_rungs"] == 2 and f["lowest_strike"] == 3.0 and f["other_months"] == ["2026-10"], "只用最近合约月,不跨月混排"
    m = mappers_industry.gpu_rent_thermometer_map(g, _ctx())
    assert m["status"] == "partial" and "ConnectionError" in m["degraded"]
    fw = [e for e in m["evidence"] if e["field"] == "gpu_forward_p_below_lowest_strike"][0]
    assert fw["period"] == "2026-09-01..2026-09-30" and "contract_month=2026-09" in fw["note"] and "折旧参考线" in fw["note"]
    assert all("读法:" in e["note"] for e in m["evidence"])
    # 顶层字段缺失 = 契约错,不是"无报价"
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, {}) if "vast" in url else R(200, {"markets": [{"ticker": "KXB200MS-26SEP-3", "last_price": 50}]}))
    g2 = industry.gpu_rent_thermometer("B200", now=NOW)
    assert "缺少 offers" in g2["spot"][0]["error"]
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, {"offers": []}) if "vast" in url else R(200, {}))
    g3 = industry.gpu_rent_thermometer("B200", now=NOW)
    assert g3["spot"][0]["unavailable"] is True and "缺少 markets" in g3["forward"]["error"]
    # Kalshi 抛异常 + Vast 成功 → 不抛,partial
    def fake2(url, **k):
        if "kalshi" in url:
            raise TimeoutError("slow")
        return R(200, {"offers": [{"dph_total": 7.0, "num_gpus": 1}]})
    monkeypatch.setattr(industry, "http_get", fake2)
    g4 = industry.gpu_rent_thermometer("B200", now=NOW)
    assert "TimeoutError" in g4["forward"]["error"] and mappers_industry.gpu_rent_thermometer_map(g4, _ctx())["status"] == "partial"


# ---------- Codex industry-r2 补的用例 ----------
def test_r2_offer_row_isolation_contract_month_fullmatch_and_tz(monkeypatch):
    # 单条 num_gpus="unknown" 不击穿整张卡;全坏才是契约错
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, {"offers": [{"dph_total": 10.0, "num_gpus": "unknown"}, {"dph_total": 8.0, "num_gpus": 2}]}) if "vast" in url else R(200, {"markets": []}))
    g = industry.gpu_rent_thermometer("B200", now=NOW)
    assert g["spot"][0]["median_usd_per_gpu_hr"] == 4.0 and g["spot"][0]["bad_offers"] == 1 and g["spot"][0]["n_offers"] == 1
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, {"offers": [{"dph_total": 10.0, "num_gpus": "unknown"}]}) if "vast" in url else R(200, {"markets": []}))
    g2 = industry.gpu_rent_thermometer("B200", now=NOW)
    assert "无一可解析" in g2["spot"][0]["error"]
    # 合约月严格整体匹配
    assert industry._contract_month("26SEP") == "2026-09" and industry._contract_month("26SEPT") is None and industry._contract_month("26SEPXYZ") is None and industry._contract_month("") is None
    # GPU 快照日期按 UTC+8:UTC 08-23 17:00 = 本地 08-24
    monkeypatch.setattr(industry, "http_get", lambda url, **k: R(200, {"offers": [{"dph_total": 7.0, "num_gpus": 1}]}) if "vast" in url else R(200, {"markets": []}))
    g3 = industry.gpu_rent_thermometer("B200", now=datetime(2026, 8, 23, 17, 0, tzinfo=timezone.utc))
    assert g3["checked_at"] == "2026-08-24" and g3["checked_tz"] == "Asia/Shanghai"
    assert mappers_industry.gpu_rent_thermometer_map(g3, _ctx())["extra"]["checked_tz"] == "Asia/Shanghai"
    # naive datetime 当 UTC
    g4 = industry.gpu_rent_thermometer("B200", now=datetime(2026, 8, 23, 17, 0))
    assert g4["checked_at"] == "2026-08-24"
