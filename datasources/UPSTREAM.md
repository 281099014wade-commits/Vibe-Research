# 上游对账单

本产品的数据层是从三个上游仓库**移植代码**(不是依赖引用),所以**上游更新不会自动流过来**。
这份文件记录「移植自哪个 tag、上次核到哪、哪些上游修复不适用」,以后再核只看这一个文件。

> 为什么不做成依赖:产品要求 clone 即用、自包含零外部文件(见 `.agents/skills/data-access/SKILL.md` §7)。
> 代价就是这里记的漂移风险,因此**每次发布前应对一次账**(见 `docs/release-checklist.md`)。

| 上游 | 移植自 | 上次核对 | 上游当时最新 | 结论 |
|---|---|---|---|---|
| [a-stock-data](https://github.com/simonlin1212/a-stock-data) | **v3.7.0** | 2026-08-24 | v3.7.1 | 见下 ①,**无需跟进** |
| [global-stock-data](https://github.com/simonlin1212/global-stock-data) | **v2.0.3** | 2026-08-24 | v2.0.3 | 已对齐 |
| [investment-news](https://github.com/simonlin1212/investment-news) | 源清单(`sources.json`) | 2026-08-24 | v1.0.3 | 见下 ②,**不适用** |

## ① a-stock-data v3.7.1 的 `get_prefix()` 路由 bug:本产品**架构上不适用**

上游 v3.7.1 修的是:`get_prefix()` 不认 `.SH` 后缀写法 → `em_secid("000016.SH")` 落到深市分支,
secid 拼成 `0.000016`(\*ST康佳A)而非 `1.000016`(上证50),**静默返回另一只标的的数据**。

本产品不会发生,因为拼 secid 的路径不同:

| | 上游 v3.7.0 | 本产品 |
|---|---|---|
| 调用形态 | `em_secid(原始用户串)`,函数内部再猜市场 | `norm_ticker(code)` → `(digits, market)`,再 `em_secid(digits, market)` |
| 猜错的可能 | 有(原串直接进号段推断) | 无(拼接只接受已归一化的两个值) |

`common.py` 的 `norm_ticker()` 明确支持前缀式与后缀式两种写法,且**解析失败抛 `ValueError` 绝不猜**;
矛盾写法(`SZ600519` / `BJ000001`)与股票接口收到指数写法都会被拒。2026-08-24 实测:

```
000016.SH → 1.000016      600519.SH → 1.600519      000016 → 0.000016
SZ600519  → 拒绝(市场标识与号段矛盾)   000016.SH(股票模式) → 拒绝(沪市指数,本接口只服务个股)
```

⚠️ 上游发布说明里那句总原则——「**拿到用户输入先过 `norm_ticker()`**」——正是本产品的既有做法。
**新增任何 A 股端点时都要守住它**:不要把用户原串直接拼进 secid / URL。

## ② investment-news:只移植了源清单,抓取端修复不适用

产品只取了 `sources.json`(106 个 tier-1 策展源 × 12 行业 + `redline_keywords`)→ `datasources/rss_sources.json`;
**抓取逻辑是产品自有的 `sources/rss.py`**,不是上游代码。

上游 v1.0.1–v1.0.3 修的都是抓取端(安全加固 / 中文 Windows 兼容 / 条目层去重 / 去重基准时间),
与本产品无关。**需要跟进的只有源清单本身的增删。**

2026-08-24 核对:产品副本与上游 `sources.json` 的 `fetch` / `industries` / `sources` / `redline_keywords`
四个业务键**逐字节一致**。

## 怎么再对一次账

```bash
gh release list --repo simonlin1212/a-stock-data --limit 5
gh release list --repo simonlin1212/global-stock-data --limit 5
gh release list --repo simonlin1212/investment-news --limit 5
```

比对上表的「移植自」列;有新版本就读 release notes,逐条判断**是否适用于本产品的移植形态**
(如 ① 那样架构不同就不适用),然后更新本表的「上次核对」与结论。

🔴 **判据是「这个修复在本产品的代码路径上会不会发生」,不是「版本号是否落后」。**
一个上游 bug 修复,可能因为移植时结构不同而根本不存在;也可能一个看似无关的小版本
恰好改了本产品直接照抄的那段。**必须读 release notes 逐条对,不能只比版本号。**
