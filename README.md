# dsh-context-kit

> **v1.1.0** · MIT License
>
> 本仓库原名 `dsh-context-autopilot`。那份 1.x 代码**从未工作过**：它把自己挂在 Host 层，
> 而 `compaction` 服务只存在于 preset 的 isolate realm 里，Host 层 `ctx.get('compaction')`
> 永远是 `undefined`，所以一次也没触发过。本版是重写——控制半侧改挂 `preset-standard`
> 的 `compaction` 组，显示半侧仍是 Host 行。旧代码留在 git 历史里，不再维护。

一个包，两种挂载：

1. **显示半侧**（bundle 插入的 Host 行 `context-kit`，承载 `dsh.client`）
   在聊天输入框下方那排统计条里加一个「上下文 11.6 万 · 11%」读数；点开是明细弹窗，
   同时显示**两条压缩线**：自动压缩线（450,887）与提前压线（350,000），并标出当前
   上下文离哪条更近。
2. **控制半侧**（`guard.js`，挂在 `preset-standard` 的 `compaction` 组里）
   在上下文明显退化之前主动压缩一次：绝对阈值提前、按会话覆盖、只在空闲时段、
   每日次数上限、压缩前先问一句。

两半共用同一份配置，不再各写一遍阈值。

## 为什么需要它

模型上下文超过约 42 万 token 后开始明显退化（本机实测：40–50 万 1.9%，50–55 万 6.4%，
55–60 万 10.1% 的「只思考不输出」失败率）。内置 `@deepseek-ai/dsh-compaction-basic`
只按窗口比例触发，当前 `thresholdRatio: 0.43`，即 1,048,576 × 0.43 ≈ **450,887** token；
退化在它之前就开始了，所以再加一条更早的线（默认 **350,000**）由守卫主动压。

> 历史：`dsh-context-autopilot` 1.x 想做同一件事，但它挂在 Host 层，永远拿不到
> `compaction` 服务（Host 层的 `ctx.get('compaction')` 是 undefined），所以从来没触发过。
> 这个包的 `guard.js` 不再犯这个错：它必须挂在预设的 `compaction` 隔离组里。
> 该旧包已删除，其阈值论证与退化数据保留在本文件。

## 两个挂载点，为什么必须分开

| 挂载点 | 位置 | 作用 | 为什么必须在这里 |
| --- | --- | --- | --- |
| Host 行 `context-kit` | bundle 的 `cordis.patch.yml`（`- insert:`） | 承载 `dsh.client`：底栏控件 + 弹窗；发布生效配置 | Web 客户端只认 Host 层的 `dsh.client` 行；预设行进不了客户端模块图 |
| 预设行 `context-guard` | profile 的 `cordis.patch.yml` → `preset-standard` → `compaction` 组（`cordis:group` + `isolate: { compaction: true }`） | 五条规则，调 `ctx.compaction.compactNow()` | 只有这个 isolate realm 里才有 `compaction` 服务实例；Host 层拿不到 |

两行都指向同一个包：Host 行用包名 `dsh-context-kit`（`exports["."]` → `index.js`），
预设行用子路径 `dsh-context-kit/guard.js`（`exports["./guard.js"]`）。
用子路径还有一个副作用：它让宿主按一个新的模块 URL 加载控制半侧，改完代码不必等下一次
重启才换掉已被 ESM 缓存的模块。

## 配置：只有一份

部署值写在 bundle 的 `cordis.patch.yml` 里 `context-kit` 那一行的 `config`：

```yaml
- insert:
    - id: context-kit
      name: 'dsh-context-kit'
      config:
        thresholdTokens: 350000
        thresholdRatio: 0.43
        contextWindowFallback: 1048576
        idleOnly: true
        dailyLimit: 5
        confirmBefore: true
        handoffFreshMinutes: 30
        compactNotice: true
```

| 字段 | 默认 | 谁用 | 说明 |
| --- | --- | --- | --- |
| `thresholdTokens` | `350000` | 显示 + 控制 | 提前压线；弹窗显示它，guard 用它判定 |
| `thresholdRatio` | `0.43` | 显示 | 自动压缩线 = `floor(上下文窗口 × 比例)`，须与 `compaction-basic` 一致 |
| `contextWindowFallback` | `1048576` | 显示 | 路由尚未上报窗口时的兜底 |
| `idleOnly` | `true` | 控制 | 只在空闲时段压（北京时间工作日 09–12、14–18 之外，含周末） |
| `dailyLimit` | `5` | 控制 | 每日次数上限，按北京时间 0 点重置 |
| `confirmBefore` | `true` | 控制 | 压之前先发一张可作答的确认卡 |
| `handoffFreshMinutes` | `30` | 控制 | 确认卡里「交接记忆」那一项的新鲜窗口；超过就提示先写一条 |
| `compactNotice` | `true` | 控制 | 压缩过后在系统提示里加一行「摘要里的数字要回文件核」 |
| `sessionThresholds` | `{}` | 控制 | 按会话覆盖阈值，如 `{"<sessionId>": 500000}` |
| `enabled` | `true` | 控制 | 急停开关 |

流程：Host 行 `apply` 收到这行 config → `publishEffectiveConfig()` 写入进程内单例和
`$DSH_HOME/dsh-context-kit/effective.json` → `guard.js` 的 `apply` 用 `getEffectiveConfig()`
读回。同一进程命中单例，跨加载器命中磁盘，都没有才退回 `lib/config.js` 的 `DEFAULTS`。

浏览器半侧拿不到行 config（客户端插件行的 `config` 不随模块图下发，`apply(ctx, config)`
里的 `config` 是空的），所以 Host 行同时把同一份生效配置通过 `webserver/index-inject`
注入页面全局 `__DSH_CONTEXT_KIT__`。`client.js` 从那里读 `thresholdTokens` /
`thresholdRatio` / `contextWindowFallback`；这不是第二份配置，是同一份 `effective` 的
只读拷贝，每次页面加载时重新注入。没有这行注入时，弹窗只显示自动压缩线，不编提前线。
预设行里**不要**再写一遍阈值。

> 注意：loader 的 patch 覆盖会**整体替换** `config`。如果要在 profile 的
> `cordis.patch.yml` 里按 `- id: context-kit` 覆盖，请把所有字段重述一遍，不要只写一个。

## 两条线怎么读

| 量 | 来源 |
| --- | --- |
| 已用 token | `contextPressure` 投影的 `projectedTokens`，缺失时退回 `pressureTokens` |
| 上下文窗口 | 投影里的 `contextWindow`，没有时用 `contextWindowFallback` |
| 自动压缩线 | `floor(上下文窗口 × thresholdRatio)` = **450,887** |
| 提前压缩线 | `thresholdTokens` = **350,000** |
| 主读数 | `已用 / 上下文窗口 × 100`，整数、封顶 100 —— 与输入框右侧圆环同一口径 |
| 颜色阈值 | 仍按自动压缩线算：到它的 70% / 90% 转琥珀 / 红色（合并前行为，不变） |
| 更近的一条 | 按「下一条会被碰到的线」：未过提前线→提前线；过了提前线未过自动线→自动线；都过→没有 |

底栏主读数保持合并前的形式：`上下文 11.6 万 · 11%`，不显示窗口分母。

弹窗顶部是一行两线摘要：`压缩线 自动 450,887 提前 350,000 更近：提前压缩线`；
下面是明细行：

| 行 | 值 |
| --- | --- |
| 当前上下文 | 精确 token 数（千分位） |
| 占模型窗口 | 百分比 + 窗口 token 数 |
| 自动压缩线 | token 数 + 占窗口比例（更近时带 `· 更近`） |
| 提前压缩线 | token 数 + 占窗口比例（更近时带 `· 更近`） |
| 已到压缩线 / 已到提前线 | 占对应线的百分比 |
| 距压缩线还剩 / 距提前线还剩 | token 数；越过时改显示「已超出…」 |
| 最近一次请求 · 输入 / 缓存读取 / 输出 | 最新一条带 usage 的 assistant 节点 |
| 会话累计 / 缓存命中 | `tokenUsage` 投影 |

数字全部来自真实配置与投影；`thresholdTokens` 缺失时弹窗**不显示**提前线，也不会
自己编一个默认值。

## 五条规则

| 规则 | 配置键 | 默认值 | 行为 |
| --- | --- | --- | --- |
| 绝对阈值提前压 | `thresholdTokens` | `350000` | 会话上下文达到该值即可触发（`>=`，与内置一致） |
| 按会话覆盖 | `sessionThresholds` | `{}` | 命中则顶替全局阈值 |
| 只在空闲时段 | `idleOnly` | `true` | 北京时间周一至周五 09:00–12:00、14:00–18:00 之外才压，含周末全天 |
| 每日次数上限 | `dailyLimit` | `5` | 跨天按北京时间 0 点重置，计数持久化 |
| 压缩前先问 | `confirmBefore` | `true` | 先发「立即压缩 / 这次跳过」的确认卡 |

时段边界左闭右开：09:00 算高峰，12:00 算空闲，14:00 算高峰，18:00 算空闲。

触发点在 agent 转 idle 之后：`compactNow()` 内部走 `agent.runMaintenance()`，要求 agent 空闲；
回合中间调用会得到 busy。用户拒绝后，上下文再涨 20,000 token 才会重新问。

## 压缩前后的两条护栏（2026-11-23 新增）

设定来源：压缩会把较早的历史换成摘要，摘要会重新表述、丢细节、把猜测写成结论。
所以定下两件事，插件负责其中能自动核的部分。

**1. 压缩前先做完三件事**（`confirmBefore: true` 时的确认卡里逐条列出）

| # | 事情 | 插件能做什么 |
| --- | --- | --- |
| 1 | 结论先写进文件 | 只能提醒，核不到 |
| 2 | 写一条交接记忆 | **能核**：扫 `$HARNMEM_HOME/memories/{user,projects/*}/*.md` 的 mtime，和 `handoffFreshMinutes`（默认 30 分钟）比，卡片上直接写「几分钟前写过」或「超过 30 分钟，建议先写一条」 |
| 3 | 列出「哪些数字是推出来的」 | 只能提醒 |

读不到记忆库时如实说「读不到」，不会假装新鲜。`confirmBefore: false`（纯自动）时没有卡片，
这条检查改为在压缩前写一行日志（新鲜 info / 过期 warn）。

**2. 压缩过后，系统提示里多一行提醒**

`compactNotice: true` 时，Host 行订阅 `compaction/summary` 与 `compaction/end`（3 秒内去重），
把该会话的压缩次数累加进 `notice-count.json`（按会话 id 存，重启不清零），
再通过 `systemPrompt.section`（`context-kit:compaction-notice`，order 4060）注入：

```
## 压缩提醒（context-kit）

本会话压缩过 <次数> 次（本机记录自 <YYYY-MM-DD> 起），最近一次 <YYYY-MM-DD HH:MM>。摘要里的条数、金额、日期、账号数据只当线索，不当结论：要用之前回文件或 harnmem 核一遍。
```

三个阶段的值都是运行期算出来的，文档里不写死示例（2026-11-23 之前写过具体时间，
被当成了真实输出，已改）。起点那一项说明「本机更早的压缩没算进来」，不假装知道全部历史。

只在压缩过的会话里出现；同一会话同一计数的文本逐字相同，不破坏前缀缓存。
拿不到 `systemPrompt` 服务时只记日志，其他功能不受影响。


## 状态目录

`$DSH_HOME/dsh-context-kit/`：

- `effective.json`：Host 行发布的生效配置（带 `pid`，只认本进程写出的那份）。
- `notice-count.json`：压缩提醒的次数来源，`{ version, sessions: { <sessionId>: { count, firstAt, lastAt } } }`；
  每次压缩原子写一次，超过 90 天没再压缩的记录在启动时清掉。
- `state.json`：`{ date, count, updatedAt }`，每日计数；临时文件 + rename 原子写。
- `activation.log`：Host `host-apply`、控制侧 `apply`、首次判定 `first-check` 各记一行，
  含生效配置、配置来源和三个依赖服务是否拿到；超过 200 行自动截断。

## 自检

`selftest.mjs` 覆盖五条规则与压缩前后护栏的全部离线断言，再加载真实的 `client.js` 验证两线显示：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; & $env:DSH_NODE_EXECUTABLE ./selftest.mjs
```

当前 220 项断言全过。自检会把 `DSH_HOME` 指到临时目录，不污染真实计数。

## 验证记录（2026-11-22）

- **自检**：172 项断言，0 失败（命令同上）。
- **页面**：底栏只保留一个「上下文 …」控件；点开后同时显示
  「自动 450,887 / 提前 350,000 / 更近：提前压缩线」和两线各自的余量。
  自检完整输出：`evidence/selftest-output.txt`。
- **控制侧激活日志**（`$DSH_HOME/dsh-context-kit/activation.log`）：
  `{"stage":"apply","source":"host","config":{"enabled":true,"thresholdTokens":350000,...},"services":{"compaction":true,"tokenMeter":true,"userQuestions":true}}`
  —— `source: host` 表示五条规则的配置来自 Host 行发布的同一份 `effective`；
  `compaction: true` 表示它确实进了 `compaction` 隔离组。
- **热生效方式**：这次 preset 行改名的热生效，是通过一次 `plugin_manager` 的 bundle
  操作（`set_bundle @local/dsh-context-guard` 重新启用）触发 profile 重读与预设重挂载完成的；
  直接改文件不保证被 HMR 重读（本次一开始就没重读，且中间一次手写还把 YAML 写坏过，
  已从备份恢复后改用字节安全写入重做）。旧会话保留各自启动时的 revision，不受影响。

## 已知限制

- **只对新会话生效**：preset 声明变化要等新会话才组合进去，正在跑的会话沿用启动时的版本。
- preset 行改名后如果宿主没有重读 profile patch，可用插件页对任意 bundle 做一次启用/停用，
  或重启 DSH；本次没有重启。
- 长回合中途不触发（没有 idle 边界）；那种情况由内置 `compaction-basic`（0.43）兜底。
- 子会话不处理：`userQuestions.ask()` 会以 `DELEGATED_CALLER` 拒绝子会话。
- 用户一直不回答时，提问卡会一直挂着，该会话此后不再重复提问。
- 压缩范围由后端决定：`compactNow()` 与手动 `/compact` 完全一致。
- `compaction` 服务在组合时可能晚于本插件就绪，所以不在静态 `inject` 里写死，而是每次
  用 `ctx.get('compaction')` 取；拿不到就记日志并跳过本次，不影响同组其它行。
- 只改显示侧（`thresholdTokens`）而不改 `thresholdRatio` 时，两条线可能非常接近；
  两个值都来自同一行 config，改完对新会话生效。

## 从旧包迁移（2026-11-22）

- `@local/dsh-context-meter`：底栏读数与弹窗的规则、排版、配色、口径全部搬进本包；
  新增提前线显示。旧 bundle 已卸载、旧目录已删除。
- `@local/dsh-context-guard`：五条规则、状态文件、激活日志、自检断言全部搬进本包；
  旧包目录和 bundle 注册**保留**（不再被任何 preset 引用，行数为 0），便于回滚。
- `@local/dsh-context-autopilot`：废弃包，从未工作过（Host 层拿不到 compaction 服务）。
  旧 bundle 已卸载、旧目录已删除，其退化数据与阈值论证并入本 README。

删除前在本地留过完整备份（`dsh-context-meter.zip`、`dsh-context-autopilot.zip`），未随本仓库发布。

## 回滚

1. **只回滚控制半侧**（新包仍装着的快速办法）：
   把 profile 的 `cordis.patch.yml` 里 compaction 组那一行改回
   `name: '@local/dsh-context-guard/plugin.js'` 并补回原来的四个 config 字段，
   新会话生效（若宿主没重读，用插件页对任意 bundle 启用/停用一次）。
2. **整体回滚**：
   - 还原 `profiles/desktop/cordis.patch.yml` 和 `package.json` 到迁移前的备份
     （迁移前应先备份这两个文件）
   - 把备份里的两个旧包目录放回本地插件目录
   - 在 profile 目录执行 `pnpm install`，或通过插件页重新安装两个旧 bundle
3. **停用**：插件页停用 `dsh-context-kit`，或从 profile 的 `package.json`
   `dsh.profile.bundles` 里移除后 `pnpm install`。


## License

MIT
