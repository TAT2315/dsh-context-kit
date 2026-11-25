# 上下文套件（context-kit）实现说明

## 文件分工

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 行：发布生效配置，写 `host-apply` 激活记录；不注册工具、不监听事件 |
| `guard.js` | 控制半侧：五条规则的取值、确认、`compactNow()`、计数落盘 |
| `client.js` | 浏览器半侧：`conversation.composer.dock` 的 `context-kit` 条目与弹窗 |
| `lib/config.js` | 配置单一来源：`DEFAULTS`、发布/读回、状态目录 |
| `lib/rules.js` | 纯决策层：时段、阈值、计数、`decide()`，无 I/O |
| `cordis.patch.yml` | bundle 层：只插入一行 Host 行 `context-kit` |
| `selftest.mjs` | 离线自检（规则 + 配置 + 真实 client.js 两线显示） |

## 为什么控制半侧必须在预设里

`ctx.compaction.compactNow()` 来自 `@deepseek-ai/dsh-compaction-basic` 所在的 isolate realm：
`preset-standard` 的 `compaction` 组是 `cordis:group` + `isolate: { compaction: true }`，
组内行才 inject 得到该 realm 的 `compaction` 服务实例。

- Host 层：`ctx.get('compaction')` 为 undefined，永远不触发（`dsh-context-autopilot` 1.x 的教训）。
- 预设组内：拿得到。服务可能晚于本行就绪（同组并行挂载），所以不用静态 `inject`
  （那会被登记成 pending 而静默不激活），改为每次用时 `ctx.get()` 取，缺了只记日志。

`guard.js` 的 `apply` 位于每个 agent 的 preset 组合里；`index.js` 的 Host 行在 profile 启动时
执行一次。两者在同一个 Node 进程里，`lib/config.js` 的模块单例是它们之间的通道；
跨加载器时退回 `effective.json`（带 `pid`，只认本进程写出的）。

## 配置流

```
profile/cordis.patch.yml (preset-standard → compaction → context-guard 行，无 config)
        └─ guard.js  apply → getEffectiveConfig()
                                   ├─ 进程内单例（Host 行 publish 过）
                                   ├─ $DSH_HOME/dsh-context-kit/effective.json（pid 相同）
                                   └─ lib/config.js DEFAULTS
bundle/cordis.patch.yml (Host 行 context-kit 的 config)
        └─ index.js apply → publishEffectiveConfig() → 单例 + effective.json
        └─ webserver/index-inject → <script>window.__DSH_CONTEXT_KIT__ = {...}</script>
        └─ client.js apply → resolveDisplayConfig()
              → thresholdTokens / thresholdRatio / contextWindowFallback
```

浏览器插件行的 `apply(ctx, config)` 拿不到行 config（客户端模块图只带 id/url/rev/inject），
所以显示半侧走页面全局注入；`resolveDisplayConfig()` 的优先级是行 config（若存在）> 页面
全局 > 内置兜底，`thresholdTokens` 没有兜底。

预设行仍然支持自己的 `config` 覆盖（`{...shared, ...row}` 合并后交给 `normalizeConfig`），
但常规部署不要在预设里重复阈值；唯一的部署配置就是 bundle 那一行。

## 显示口径

- 主读数分母是上下文窗口（与右侧圆环同口径），不是压缩线；压缩线只用于颜色与弹窗。
- 自动压缩线 `floor(contextWindow × thresholdRatio)`；窗口取 `contextPressure.contextWindow`，
  缺失才用 `contextWindowFallback`。
- 提前压线直接取 `thresholdTokens`，不做比例换算；缺失时整块提前线 UI 不渲染。
- 更近判断：`nearerLine(used, autoLine, earlyLine)`——未过提前线→`early`；过了提前线未过
  自动线→`auto`；都过→`none`；没有提前线→`undefined`。
- 配色三档仍按自动压缩线（70% / 90%），与合并前完全一致。

弹窗结构：标题（百分比）→ 两线摘要 → 分隔线 → 明细 `dl`。摘要与明细的数字都来自
同一次 render 的 `used / contextWindow / line / earlyLine`。

## 五条规则的判定顺序

`decide()` 顺序固定：`enabled` → 测量有效性 → 绝对阈值（含会话覆盖）→ 空闲时段 → 每日上限。
边界：`tokens >= threshold` 触发；09:00/14:00 算高峰，12:00/18:00 算空闲；跨天按北京时间 0 点。

## 状态与日志

- `state.json` 只在压缩成功后 `bumpDaily` 写入；读失败/缺失按 0 计。
- `activation.log` 记录 `host-apply` / `apply` / `first-check`，字段：
  `stage, source, config, services`（Host 行记录没有 `services`）。超过 200 行截断到最近 100 行。
- 所有 I/O 都包在 try/catch，失败只写日志，不影响会话。

## 已知失败模式

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件行 active，但 activation.log 没有 apply | 预设行没进新会话；preset 声明只对新会话生效 | 开新会话再看 |
| `拿不到 compaction 服务` | guard 行挂错层（Host 或不在 compaction 组） | 检查 preset-standard 的 compaction 组 |
| `拿不到 userQuestions` | 提问服务未启用/晚就绪 | 本次跳过，不影响内置压缩 |
| 弹窗只有一条线 | 行 config 没有 `thresholdTokens`（覆盖时漏字段） | 补全 config，整行重述 |
| 数字与预期不符 | 改的是预设行旧 config 或旧的 `thresholdTokens` | 只改 bundle 行 / 用 `effective.json` 核对 |

## 验证

```powershell
# 离线自检（220 项）
$env:ELECTRON_RUN_AS_NODE='1'; & $env:DSH_NODE_EXECUTABLE ./selftest.mjs
```

页面验证：打开任一 Web 页面 → 底栏应出现「上下文 …」→ 点开看到两条线与更近标记。
自检输出在 `evidence/selftest-output.txt`。

控制侧激活证据：`$DSH_HOME/dsh-context-kit/activation.log` 里的
`{"stage":"apply","source":"host",...}`，`services.compaction` 为 `true`。

## 压缩前后的两条护栏（2026-11-23）

压缩是续命手段，不是存档。摘要会重新表述、丢细节、把推出来的数字写成结论，所以：

1. **压缩前**：确认卡的 `detail` 里列出三件事（结论落文件 / 写交接记忆 / 列未核实数字），
   其中第 2 件由 `handoffHint()` 真核——`newestMemoryWriteMs()` 扫
   `$HARNMEM_HOME/memories/{user,projects/<id>}/*.md` 的 mtime（只下钻两层，几十个文件，
   开销可忽略），和 `handoffFreshMinutes` 比出「新鲜 / 过期 / 读不到」。
   纯判定在 `lib/rules.js` 的 `handoffHint()`，没有 I/O，可离线自检。
2. **压缩后**：Host 行订阅 `compaction/summary` 与 `compaction/end`（3 秒内去重），
   把压缩次数按会话 id 累加进 `notice-count.json`（原子写，重启不清零；超过 90 天没再压缩的
   记录在启动时清掉），再用 `systemPrompt.section`（`context-kit:compaction-notice`，order 4060）
   注入一行提醒：次数、统计起点、最近一次时间，以及「摘要里的数字只当线索」。
   起点那一项说明本机更早的压缩没算进来——2026-11-23 之前计数只在内存里，重启就从 1 重来，
   提示里的「已压缩 1 次」与实际的 14 次不符。

`systemPrompt` 是 Host 服务，行加载时可能尚未就绪，因此用 `ctx.inject(['systemPrompt'], …)`
等服务出现再挂段；拿不到只记日志，不影响压缩规则本身。

