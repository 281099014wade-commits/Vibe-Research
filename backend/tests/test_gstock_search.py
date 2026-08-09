"""证券搜索：备用端点 + 「接口不可用」必须与「查无此票」区分开（#26）。

报告者在自己的网络下所有美股/港股/韩股查询都失败，而产品只回一句
「未找到对应美股/港股/韩股代码」——他只能自己逆向排查到底哪一步坏了。
根因是 `except Exception: return None` 把两种完全不同的情况压成了同一个返回值。
"""
import pytest

import gstock


class FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


AAPL_ROW = {
    "Code": "AAPL", "Name": "苹果", "MktNum": "105",
}


def test_falls_back_to_second_endpoint(monkeypatch):
    """主端点挂了要自动换备用，而不是整块功能瘫痪。"""
    tried = []

    def fake_get(url, params=None, headers=None, timeout=10):
        tried.append(url)
        if url == gstock._SEARCH_ENDPOINTS[0]:
            raise ConnectionError("primary down")
        return FakeResp({"QuotationCodeTable": {"Data": [AAPL_ROW]}})

    monkeypatch.setattr(gstock.astock, "em_get", fake_get)

    hit = gstock._search("AAPL")
    assert hit["code"] == "AAPL"
    assert len(tried) == 2, "主端点失败后应当试备用端点"


def test_all_endpoints_down_raises_instead_of_returning_none(monkeypatch):
    """🔴 全部端点失败 ≠ 查无此票。压成同一个 None 正是 #26 里用户无从下手的原因。"""
    def fake_get(url, params=None, headers=None, timeout=10):
        raise ConnectionError("blocked")

    monkeypatch.setattr(gstock.astock, "em_get", fake_get)

    with pytest.raises(gstock.SearchUnavailable) as exc:
        gstock._search("AAPL")
    message = str(exc.value)
    assert "查无此代码" in message, "报错要点破这与「查无此票」不是一回事"
    assert "ConnectionError" in message, "要带上真实的底层错误，便于排查"


def test_unknown_symbol_still_returns_none(monkeypatch):
    """接口正常但确实没这只票 → None（不是异常）。这条边界不能被上面的改动搞混。"""
    def fake_get(url, params=None, headers=None, timeout=10):
        return FakeResp({"QuotationCodeTable": {"Data": []}})

    monkeypatch.setattr(gstock.astock, "em_get", fake_get)

    assert gstock._search("ZZZZ") is None


def test_malformed_payload_is_not_treated_as_not_found(monkeypatch):
    """返回体变形（如被包成 JSONP）时 json() 会抛，同样属于「接口不可用」。"""
    def fake_get(url, params=None, headers=None, timeout=10):
        raise ValueError("Expecting value: line 1 column 1 (char 0)")

    monkeypatch.setattr(gstock.astock, "em_get", fake_get)

    with pytest.raises(gstock.SearchUnavailable):
        gstock._search("AAPL")
