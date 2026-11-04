# DECISIONS

> 决策与踩坑日志，只追加，不参与日常上下文。可用 grep 检索。条目按文件顺序编号（第一个 `##` 是 #1）。

## 2026-11-03 — 座舱 UI 采用五槽位分屏面板

宽屏（≥980px）用 CSS grid 同时显示 UP/LEFT/CENTER/RIGHT/DOWN 五块，模拟真机俯视图；窄屏降级为单选（顶部槽位标签）+ 可选分屏（两块各占 50%）。面板内容由 js/data/cockpit.js 的数据描述生成（sel/tog/btn/ro/bar/freq/preset/atc 七种条目），避免为每个开关手写 DOM。膝板放在 DOWN 槽，无线电/UFC 放在 UP 槽，与真机位置对应。

## 2026-11-03 — 地面模型与接地判定

接地时若把进近迎角(11°)原样搬到地面，升力仍大于重量会立刻"再次起飞"。修法：接地时 pitchAtt = clamp(alpha*0.6, 2, 9)，并加 1.2s groundLock 锁定；离地条件改为 升力>W*1.02 且 pitchAtt>6 且 V>52 且 杆量>0.15 且 groundLock 已解除。前轮转向用 ω=V·tan(δ)/轴距 并限幅 20°/s，δ 取杆量^1.7×35°，否则全杆会在 20kt 时以 75°/s 原地打转。

## 2026-11-03 — 起降流程：默认跑道热机 + 返场着陆才算完成

World 新增 startMode（cold/runway/air）。游戏界面默认传 runway：飞机停在 RWY 09 入口、发动机慢车、系统全通、NWS 接通、停机刹车松开，检查单阶段 LINEUP。所有非 TRAINING/AIRFIELD 场景 requiresLanding=true：击落全部敌机只把 objective 切到「返场着陆 VIPER POINT」，必须接地并滑跑到 V<1.5 才 finish(true)。为了不破坏既有数值测试，构造器默认 startMode='air'（requiresLanding=false），只有 UI 显式传 runway/cold 才走起降流程。测试需要确定性时传 wind:false。

## 2026-11-03 — 风场符号 / 地速踩坑

风矢量按「吹向」存储（气象风 dir 是来向，所以 vec 用 dir+180）。地面滑跑的地速 = 空速 + (W·机头方向)：初版写成 V − alongWind，导致停机时顶风把飞机往后推 4 m/s、刹车后仍以 0.23 m/s 爬行。另一处：ground.js 里 `if (V<0.3 && F<0) F=0` 让 V 永远停在 0.23 → 改成直接用 Math.max(0, V+Vdot·dt)。空中位置积分改成 (空速矢量 + 风)，所以空速≠地速，顶风缩短起飞滑跑、顺风增加接地速度。

## 2026-11-03 — 字幕层改为消息 id 增量更新

旧 renderLog 每 0.5 s 重建整块 innerHTML，导致入场动画反复触发（闪）、消息被硬挤掉、长句 nowrap 截断。新 js/ui/subtitle.js 按 world.log 的 id 做增量 diff：只在新消息时 createElement + appendChild，过期才 remove，尾部 30% 时间加 is-stale 淡出；ATC/本机/ATIS/SYS 四种配色与说话人标签。radio.push 的消息通过 World._drainRadio 桥接成 kind=atc/pilot/atis 的日志，主字幕和音频静噪都能收到。

## 2026-11-03 — 座舱边缘 UI 实现路线

不用真 3D 立方体（面与面会 z-fighting、canvas 在透视变换里发虚）。做法：五块 .ck-face 全部 position:absolute; inset: peek，非当前面板 translate3d(±100%) 移出视口，只留下贴近边缘的 peek 像素条；当前面板 transform:none 并 z-index 6，中心面板非激活时退到 translateZ(-160px) scale(.965)。切换就是 CSS transform 过渡，"视角转动"的观感来自 perspective:1600px + 轻微 rotateY/X(5°) + 滑入。边缘条内容是面板自身的一小条（竖排文字 + 实时数据），不是伪元素。全览模式用 .is-grid 把 viewport 变回 grid-template-areas。

## 2026-11-03 — 底部高度反馈环 / 慢车推力曲线

原来 .screen-game 上 JS 把测得的高度写回 --console-h，而 .console{min-height:var(--console-h)} 会跟着长——旧版刚好没差（测的也是 console），加了无线电条后 bottom-ui 比 console 高 26px，会无限自增长。改为 JS 只写 --bottom-h（字幕定位专用），--console-h 保持为纯设计 token。发动机慢车推力改成凸曲线 spoolFrac^2.2：原来 idle 有 12 kN，跑道热机松刹车后会自己加速；现在约 4.8 kN，怠速只缓慢滑行，符合真实地慢车需要踩刹车的观感。

## 2026-11-03 — 地面阶段敌机不交战 + 无线电接线

玩家没离地时敌机不进 ENGAGE（Bandit.update 里加 playerAirborne 条件），否则新手在跑道上读检查单的 3 分钟里会被 Su-27 打成 92% 损伤。起飞后立即恢复交战。无线电：Radio 构造时调用 _updateStation（COM1 默认 257.800=TOWER，之前 station 为 null，塔台请求全部返回"无管制单位"）；World 每帧把 radio.messages 的新 id 桥接成 kind=atc/pilot/atis 的 log，主字幕/音频/战果都读得到。primeRequest 按阶段自动挑请求（地面 lineup→takeoff，空中 land）。
