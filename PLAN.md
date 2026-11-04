# PLAN

> 由 `plan` 工具维护，请勿直接编辑。步骤级进度以 `todo` 工具为准；决策与踩坑写入 DECISIONS.md。

<!-- plan-bridge:state -->
current: 
auto-breakpoint: false
<!-- /plan-bridge:state -->

## Milestones

- [x] M1 — 机场与地面模型（跑道/滑行道/停机坪 + 起落架/刹车/前轮转向/起飞着陆物理）
- [x] M2 — 座舱系统（电瓶/主电/FLCS/EPU/JFS 起动/液压/燃油/起落架/襟翼/减速板/配平）
- [x] M3 — 导航系统（TACAN 方位+测距、ILS 航向台/下滑台、HSI/CDI、雷达高度表）
- [x] M4 — 无线电与 ATC（UHF/VHF、20 个预置频道、ATIS 广播、放行/地面/塔台/进近菜单式对话）
- [x] M5 — 膝板系统（分工卡、可勾选检查单、机场图、ILS 进近图、频率卡）
- [x] M6 — 着陆 HUD 与仪表（AOA 括号、ILS 操纵杆、雷达高度、HSI/ADI）
- [x] M7 — 流程联调：冷舱起动→滑行→起飞→ILS 进近→着陆→关车，自动化测试
- [x] M8 — 飞控拟真（FLCS/风场/地面效应/横航向）详见 #3-#7
- [x] M9 — 起降流程/无线电/字幕/座舱边缘 UI 详见 #3-#8

## Current

goal: 飞控/拟真、起降、无线电、字幕、座舱边缘 UI 全部落地并通过测试
breakpoint: 五项已完成，6 个 smoke 全绿；如需继续可做座舱真机截图校对
