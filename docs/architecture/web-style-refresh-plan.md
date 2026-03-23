# Web Style Refresh Plan

## Goal

将 Web 首页改造成参考稿的硬边赛博编辑风，同时保持现有语音输入、地图讲解、合规展示、来源卡片和运行时切换能力可用。

## Likely Files

- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`

## Assumptions

- 本次改版以视觉和信息架构调整为主，不改动后端 API 契约。
- 继续保留现有 `SectionCard`、`CompliancePanel`、`SourceCardList` 与地图讲解逻辑。
- 参考设计中的英文信息架构可以转译为中文，但页面仍需保留技术状态与合规信息。

## Risks

- 大幅改版可能影响移动端排版和已有交互区的可读性。
- 参考风格强调零圆角和弱边框，需要额外关注可访问性与信息层级。
- 如果改动时遗漏状态区或来源区，可能削弱真实链路可观测性与合规展示。

## Validation

- `npm run typecheck`
- `npm run build`
- 目视检查主页是否呈现中文化的新布局，并确认语音输入区、地图主舞台、来源与合规区仍然存在
