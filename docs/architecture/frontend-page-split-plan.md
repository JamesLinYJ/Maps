# Frontend Page Split Plan

## Goal

将面向普通用户的地图讲解主流程，与运行设置、Provider 绑定、技术诊断等系统信息拆分为两个独立页面。

## Scope

- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/app.test.tsx`

## Assumptions

- 不引入新的路由依赖，优先使用轻量的前端页面状态和 URL 参数完成切页。
- 用户主页面保留语音输入、地图展示、讲解内容、会话记录和必要的来源说明。
- 系统页承载运行设置、架构摘要、Provider 绑定、诊断追踪等非普通用户主流程信息。

## Risks

- 拆页后如果按钮入口不明显，用户可能不知道如何进入系统页。
- 如果 URL 状态与页面状态不同步，刷新后可能回到错误页面。
- 既有测试可能依赖旧文案和旧单页结构，需要同步更新。

## Validation

- `npm run typecheck`
- `npm run build`
- 手动验证主页面与系统页都可进入、返回，并且按钮行为正确
