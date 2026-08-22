# 数据源 adapter + registry(Phase 1)

`registry.yaml` 每源登记:许可/ToS 状态、鉴权、地域可用性、限流、可否再分发、商用限制、降级路径、schema 契约、最后验证日期。
首发只默认启用许可与稳定性清楚的源;高风险接口做成用户自行启用的 adapter。
