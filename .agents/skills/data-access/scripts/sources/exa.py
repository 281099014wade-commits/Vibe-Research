"""市场声音(一手信源)层 · Exa 免 key MCP(https://mcp.exa.ai/mcp)。

2026-08-23 实测(零配置假设验证):
  - Exa 托管的 MCP 端点无需 API key,Streamable HTTP JSON-RPC:initialize → tools/list → tools/call;
    工具 web_search_exa(query, numResults)与 web_fetch_exa(urls[], maxCharacters)。没有域名过滤参数,用查询词引导
    ("雪球 讨论"能命中 xueqiu.com 帖子页;中文公司名 + 英文词能命中英文分析师帖);
  - 搜索结果为文本块:Title / URL / Published / Author / Highlights;
  - web_fetch_exa 能读静态页,JS 页(财联社电报)拿不到正文,微信公众号与雪球帖子正文都读不到;
  - 雪球 / 股吧匿名直连被阿里云 WAF 拦截,Jina 读帖子正文被"IP 频繁"墙挡 → 论坛只做标题 / 作者 / 日期 / 链接。
设计:
  - 查询词由本模块按公司名**确定性**生成(不是 agent 想的),结果按主题分组;同一运行内相同输入得到相同查询;
  - 所有文本经 textsafe.sanitize_untrusted 净化后才进证据 value(原文在 raw);
  - 本层产出只能当**线索**:帖子 / 文章里的数字不得作为事实引用(SOP + 提示词 + 硬测试三处约束);
  - 每次 HTTP 调用经 sources._http.http_post 落盘(raw_ref 可审计)。
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA  # noqa: E402
from sources._http import http_post  # noqa: E402
from sources.textsafe import sanitize_untrusted  # noqa: E402

MCP_URL = os.environ.get("VRA_EXA_MCP_URL", "https://mcp.exa.ai/mcp")
PROTOCOL = "2025-03-26"
TIMEOUT = 45
FORUM_DOMAINS = ("xueqiu.com", "guba.eastmoney.com")
# 主题 → 查询模板(确定性;{name} 公司简称,{code} 6 位代码)
MARKET_QUERIES = [
    ("进展", "{name} 最新 业绩 订单 产能 交付 进展"),
    ("风险", "{name} 风险 减持 解禁 诉讼 处罚 问询函"),
    ("行业", "{name} 行业 竞争格局 技术路线 客户 份额"),
    ("英文", "{name} {code} China analyst outlook orders 2026"),
]
FORUM_QUERIES = [
    ("雪球", "{name} 雪球 讨论 观点 帖子"),
    ("股吧", "{name} 股吧 讨论 热帖"),
]


class ExaError(RuntimeError):
    pass


def _headers(sid: Optional[str] = None) -> dict:
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": UA}
    if sid:
        h["Mcp-Session-Id"] = sid
    return h


def _decode_utf8(body: bytes) -> str:
    """content-type 不带 charset,必须按 UTF-8 解码;非法字节不悄悄 replace(会把传输损坏吞成乱码线索),直接报错。"""
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ExaError(f"MCP 响应不是合法 UTF-8(offset {e.start})") from e


def parse_sse_events(text: str) -> list[str]:
    """SSE 事件流 → 每个事件的 data 文本(多行 data: 按规范以换行拼接;空行结束一个事件;EOF 收尾)。"""
    events, cur = [], []
    for line in text.splitlines():
        if line == "":
            if cur:
                events.append("\n".join(cur))
                cur = []
            continue
        if line.startswith("data:"):
            cur.append(line[5:].lstrip(" "))
    if cur:
        events.append("\n".join(cur))
    return events


def _parse_rpc(body: bytes, rpc_id, content_type: str = "") -> dict:
    """Streamable HTTP 返回 SSE(text/event-stream)或纯 JSON(可为批量数组);取 id 匹配的那条;JSON-RPC error 直接抛。"""
    text = _decode_utf8(body)
    msgs: list = []
    is_sse = "text/event-stream" in (content_type or "").lower() or text.lstrip().startswith(("data:", "event:", ":"))
    if is_sse:
        bad = 0
        for ev_data in parse_sse_events(text):
            try:
                d = json.loads(ev_data)
            except json.JSONDecodeError:
                bad += 1
                continue
            msgs.extend(d if isinstance(d, list) else [d])
        if not msgs:
            raise ExaError(f"SSE 流里没有可解析的 JSON-RPC 消息(坏事件 {bad} 个):{text[:120]!r}")
    else:
        try:
            d = json.loads(text)
        except json.JSONDecodeError as e:
            raise ExaError(f"MCP 响应既不是 SSE 也不是 JSON:{text[:120]!r}") from e
        msgs = d if isinstance(d, list) else [d]
    for d in msgs:
        if isinstance(d, dict) and d.get("jsonrpc") == "2.0" and d.get("id") == rpc_id:
            if "error" in d:
                raise ExaError(f"MCP 错误:{json.dumps(d['error'], ensure_ascii=False)[:300]}")
            return d.get("result") or {}
    raise ExaError(f"MCP 响应里没有 id={rpc_id} 的 JSON-RPC 结果(收到 {len(msgs)} 条消息)")


class ExaClient:
    """一次取数一个会话:initialize 拿 Mcp-Session-Id,之后的 tools/call 复用。每次 RPC 的响应原文经 http_post 落 raw,
    `last_raw_ref` 指向**刚才那次**请求的 raw 文件(逐请求绑定,不是整个端点共用最后一份)。"""

    def __init__(self, url: str = MCP_URL, timeout: int = TIMEOUT):
        self.url, self.timeout, self.sid, self._id, self.last_raw_ref = url, timeout, None, 0, None

    def _rpc(self, method: str, params: dict, notify: bool = False) -> dict:
        self._id += 1
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify:
            payload["id"] = self._id
        try:
            r = http_post(self.url, json_body=payload, headers=_headers(self.sid), timeout=self.timeout, ext="txt")
        except Exception as e:  # noqa: BLE001 — 超时 / 连接错误统一成 ExaError,信封层 fail-fast 出声
            raise ExaError(f"MCP 请求失败({method}):{type(e).__name__}: {str(e)[:160]}") from e
        self.last_raw_ref = getattr(r, "_vra_raw_ref", None)
        if r.status_code >= 400:
            raise ExaError(f"MCP HTTP {r.status_code}({method}):{(r.content or b'').decode('utf-8', 'replace')[:200]}")
        if not self.sid and r.headers.get("Mcp-Session-Id"):
            self.sid = r.headers["Mcp-Session-Id"]
        return {} if notify else _parse_rpc(r.content, self._id, r.headers.get("Content-Type", ""))

    def connect(self) -> "ExaClient":
        self._rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "vibe-research-agent", "version": "0.1"}})
        self._rpc("notifications/initialized", {}, notify=True)
        return self

    def call_text(self, tool: str, arguments: dict) -> tuple[str, Optional[str]]:
        """→ (工具返回的文本, 本次响应的 raw_ref)"""
        res = self._rpc("tools/call", {"name": tool, "arguments": arguments})
        txt = "\n".join(c.get("text", "") for c in res.get("content", []) if isinstance(c, dict))
        if res.get("isError"):
            raise ExaError(f"{tool} 返回错误:{txt[:200]}")
        return txt, self.last_raw_ref


_BLOCK_RE = re.compile(r"^Title: ", re.M)
_FIELD_RE = {"title": re.compile(r"^Title: (.*)$", re.M), "url": re.compile(r"^URL: (\S+)", re.M),
             "published": re.compile(r"^Published: (.*)$", re.M), "author": re.compile(r"^Author: (.*)$", re.M)}
_NO_RESULT_RE = re.compile(r"no results|0 results|没有(找到|搜索到)|未找到", re.I)


def parse_search_text(text: str) -> list[dict]:
    """Exa 文本 → [{title, url, published(YYYY-MM-DD 或 ''), author, highlights}];highlights = 该块里 'Highlights:' 之后的全部文本。
    空文本或明确的"无结果"提示 → [];**有内容却一条都解析不出 → 抛错**(协议 / 文本格式漂移不能静默变成"没线索")。"""
    items = []
    for blk in _BLOCK_RE.split(text):
        blk = "Title: " + blk if blk and not blk.startswith("Title: ") else blk
        m_url = _FIELD_RE["url"].search(blk)
        if not m_url:
            continue
        def f(k: str) -> str:
            m = _FIELD_RE[k].search(blk)
            return (m.group(1) or "").strip() if m else ""
        pub_iso = f("published")
        pub = pub_iso[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", pub_iso) else ""
        hl = blk.split("Highlights:", 1)[1] if "Highlights:" in blk else ""
        items.append({"title": f("title"), "url": m_url.group(1).strip(), "published": pub, "published_iso": pub_iso if pub else "",
                      "author": f("author"), "highlights": hl.strip()})
    if not items and text.strip() and not _NO_RESULT_RE.search(text):
        raise ExaError(f"搜索响应有内容但解析为 0 条(文本格式可能漂移):{text.strip()[:120]!r}")
    return items


def domain_of(url: str) -> str:
    m = re.match(r"^https?://([^/]+)", url or "")
    return m.group(1).lower() if m else ""


def exa_search(query: str, num_results: int = 8, client: Optional[ExaClient] = None) -> list[dict]:
    """每条 item 带 raw_ref = 这次搜索响应的 raw 文件。"""
    c = client or ExaClient().connect()
    txt, raw_ref = c.call_text("web_search_exa", {"query": query, "numResults": int(num_results)})
    return [{**it, "raw_ref": raw_ref} for it in parse_search_text(txt)]


def exa_fetch(url: str, max_chars: int = 1200, client: Optional[ExaClient] = None) -> tuple[str, Optional[str]]:
    """→ (正文文本, raw_ref)"""
    c = client or ExaClient().connect()
    return c.call_text("web_fetch_exa", {"urls": [url], "maxCharacters": int(max_chars)})


def _company_name(code: str) -> str:
    from sources.tencent import tencent_quote
    try:
        q = tencent_quote(code)
        name = next(iter(q.values())).get("name") if q else None
        return str(name).strip() if name else str(code)
    except Exception:  # noqa: BLE001 — 拿不到简称就用代码搜,不让线索层拖垮运行
        return str(code)


def _parse_iso(ts: str) -> Optional[datetime]:
    """'2026-08-21T02:11:00.000Z' / '2026-08-21' / 带偏移 → aware datetime(UTC);解析不了 → None。"""
    t = (ts or "").strip()
    if not t:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}$", t):
        t += "T00:00:00+00:00"
    t = re.sub(r"Z$", "+00:00", t)
    t = re.sub(r"(\.\d{3})\d+(?=[+-]\d{2}:\d{2}$|$)", r"\1", t)  # 纳秒级小数 → 毫秒(fromisoformat 只吃 3/6 位)
    try:
        d = datetime.fromisoformat(t)
    except ValueError:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _normalize_published(published_iso: str, now: Optional[datetime] = None) -> tuple[str, Optional[datetime]]:
    """→ (YYYY-MM-DD 或 '', aware datetime 或 None)。按完整时刻判未来(> now + 1 天容忍时区差)→ 当未注明;非法 → 未注明。"""
    now = now or datetime.now(timezone.utc)
    d = _parse_iso(published_iso)
    if d is None or d > now + timedelta(days=1):
        return "", None
    return d.strftime("%Y-%m-%d"), d


def _is_recent(d: Optional[datetime], days: int, now: Optional[datetime] = None) -> Optional[bool]:
    """近 days 天内(按完整时刻,不是按日期零点)→ True;更早 → False;未注明 → None(语义:不知道,不是"不近")。"""
    if d is None:
        return None
    now = now or datetime.now(timezone.utc)
    return d >= now - timedelta(days=int(days))


def _collect(client: ExaClient, name: str, code: str, templates: list, num_results: int, recent_days: int, only_forum: bool,
             now: Optional[datetime] = None) -> tuple[list, list]:
    now = now or datetime.now(timezone.utc)  # 一次取 now,全部条目同一把尺子
    items, seen, queries = [], set(), []
    for topic, tpl in templates:
        q = tpl.format(name=name, code=code)
        queries.append({"topic": topic, "query": q})
        for it in exa_search(q, num_results, client):
            url = it["url"]
            dom = domain_of(url)
            is_forum = any(dom == d or dom.endswith("." + d) for d in FORUM_DOMAINS)
            if only_forum and not is_forum:
                continue
            if url in seen:
                continue
            seen.add(url)
            pub, pub_dt = _normalize_published(it.get("published_iso") or it.get("published") or "", now)
            items.append({"topic": topic, "kind": "forum" if is_forum else "web", "domain": dom, "url": url,
                          "title": sanitize_untrusted(it["title"], 200), "author": sanitize_untrusted(it["author"], 60),
                          "published": pub, "recent": _is_recent(pub_dt, recent_days, now),
                          "highlights": sanitize_untrusted(it["highlights"], 240), "raw_ref": it.get("raw_ref")})
    # 确定性排序:日期倒序,同日期按 url(查询顺序已固定,去重按首次出现)
    items.sort(key=lambda x: (x["published"] or "", x["url"]), reverse=True)
    return items, queries


def _counts(items: list) -> dict:
    return {"total": len(items), "recent": sum(1 for x in items if x["recent"]), "stale": sum(1 for x in items if x["recent"] is False),
            "undated": sum(1 for x in items if x["recent"] is None)}


def exa_market_voice(code: str, num_results: int = 8, recent_days: int = 60, read_top: int = 3, max_chars: int = 1200, limit: int = 40,
                     now: Optional[datetime] = None) -> dict:
    """全网语义搜索(新闻 / 深度文 / KOL 帖)按主题分组,近 recent_days 天内且非论坛的前 read_top 条再读摘录;items 最多 limit 条。
    返回 {name, code, queries:[{topic,query}], items:[{topic,kind,domain,url,title,author,published,recent,highlights,raw_ref}],
          excerpts:[{url,published,excerpt,chars,raw_ref|error}], counts, recent_days, limit}"""
    name = _company_name(code)
    client = ExaClient().connect()
    items, queries = _collect(client, name, code, MARKET_QUERIES, num_results, recent_days, only_forum=False, now=now)
    items = items[:max(0, int(limit))]
    excerpts = []
    candidates = [x for x in items if x["kind"] == "web" and x["recent"]][:max(0, int(read_top))]
    for it in candidates:
        try:
            txt, raw_ref = exa_fetch(it["url"], max_chars, client)
        except ExaError as e:
            excerpts.append({"url": it["url"], "published": it["published"], "excerpt": "", "chars": 0, "error": str(e)[:160], "raw_ref": client.last_raw_ref})
            continue
        clean = sanitize_untrusted(txt, max_chars)
        excerpts.append({"url": it["url"], "published": it["published"], "excerpt": clean, "chars": len(clean), "raw_ref": raw_ref})
    counts = {**_counts(items), "forum": sum(1 for x in items if x["kind"] == "forum"), "excerpt_candidates": len(candidates),
              "excerpts": sum(1 for x in excerpts if x["chars"]), "excerpt_errors": sum(1 for x in excerpts if not x["chars"])}
    return {"name": name, "code": code, "queries": queries, "items": items, "excerpts": excerpts, "counts": counts, "recent_days": recent_days, "limit": int(limit)}


def exa_forum_voice(code: str, num_results: int = 10, recent_days: int = 90, limit: int = 40, now: Optional[datetime] = None) -> dict:
    """雪球 / 股吧讨论(经 Exa 索引):只保留论坛域名的标题 / 作者 / 日期 / 链接;正文不可读(WAF)。items 最多 limit 条。"""
    name = _company_name(code)
    client = ExaClient().connect()
    items, queries = _collect(client, name, code, FORUM_QUERIES, num_results, recent_days, only_forum=True, now=now)
    items = items[:max(0, int(limit))]
    counts = {**_counts(items), "by_domain": {d: sum(1 for x in items if x["domain"].endswith(d)) for d in FORUM_DOMAINS}}
    return {"name": name, "code": code, "queries": queries, "items": items, "counts": counts, "recent_days": recent_days, "limit": int(limit)}
