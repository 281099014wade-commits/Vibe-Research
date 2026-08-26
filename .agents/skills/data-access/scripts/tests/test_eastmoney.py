"""东财取数层的单测。全程不联网(`_push2_json` 一律 monkeypatch)。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sources import eastmoney  # noqa: E402



def test_board_fund_flow_paging_does_not_assume_requested_page_size(monkeypatch):
    """🔴 别假设上游认你请求的页大小。

    实测:代码请求 pz=200,东财每页只给 100 ⇒ 原来的 `len(more) < 200 就停` 在第 2 页就断了,
    上游 total=496 而我们只拿 200,**界面上完全看不出来**(看着像"就这么多板块"),
    于是"净流出最多"那一栏里全是净流入的板块 —— 标题在撒谎。
    """
    TOTAL = 496
    PAGE = 100          # 上游真实页大小,**小于**代码请求的 pz
    calls = []

    def fake(_path, params=None, headers=None, timeout=None):
        pn = int((params or {}).get("pn", 1))
        calls.append(pn)
        start = (pn - 1) * PAGE
        diff = [{"f12": f"B{i:04d}", "f14": f"板块{i}", "f3": 1.0, "f62": (TOTAL // 2 - i) * 1e8, "f184": 1.0}
                for i in range(start, min(start + PAGE, TOTAL))]
        return {"data": {"diff": diff, "total": TOTAL}}

    monkeypatch.setattr(eastmoney, "_push2_json", fake)
    r = eastmoney.board_fund_flow("industry", "today", 500)
    assert len(r["rows"]) == TOTAL, f"该取全 {TOTAL} 个,实际 {len(r['rows'])}(第一版只拿到一页 {PAGE})"
    assert r["total"] == TOTAL
    # 尾部必须真的是负数 —— 这正是"净流出最多"那一栏要用的
    assert r["rows"][-1]["main_net"] < 0, "取全之后才看得到净流出侧"
    assert len(calls) >= 5, f"应当翻够页,实际只请求了 {calls}"


def test_board_fund_flow_stops_on_empty_page(monkeypatch):
    """空页要停,不能无限翻(上游少给了 total 时的兜底)。"""
    def fake(_path, params=None, headers=None, timeout=None):
        pn = int((params or {}).get("pn", 1))
        diff = [{"f12": "B1", "f14": "x", "f3": 1.0, "f62": 1e8, "f184": 1.0}] * 100 if pn == 1 else []
        return {"data": {"diff": diff, "total": 0}}

    monkeypatch.setattr(eastmoney, "_push2_json", fake)
    r = eastmoney.board_fund_flow("industry", "today", 500)
    assert len(r["rows"]) == 100
