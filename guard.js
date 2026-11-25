/**
 * context-kit 的控制半侧：在上下文明显退化之前主动触发一次会话压缩。
 *
 * 挂载位置很关键：本入口必须作为 `preset-standard` 里 `compaction` 组
 * （`cordis:group` + `isolate: { compaction: true }`）的一行，才能拿到该 realm 内的
 * `compaction` 服务实例。挂在 Host 层拿不到（dsh-context-autopilot 1.x 就是这么废掉的）。
 *
 * 配置来源只有一份：Host 行（bundle 插入的 `context-kit`）apply 时把行 config 发布成
 * 生效配置；这里用 `getEffectiveConfig()` 读回，五条规则本身不改。预设行里不再写一遍
 * 阈值；如果确实要按本次挂载覆盖，那一行的 config 仍然优先（合并语义），但常规部署
 * 不要在预设里重复配置。
 *
 * 五条规则见 ./lib/rules.js 的 decide()；本文件只做取值、确认、调用和落盘。
 * 触发点选在 agent 转 idle 之后：公开的手动压缩入口 compactNow() 要求 agent 空闲
 * （内部走 agent.runMaintenance()），回合中间调用会得到 busy。
 *
 * 任何异常都在这里被吃掉并记日志，绝不影响宿主，也不影响内置的
 * compaction-basic（它的 auto 仍然是 true，作为安全网）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getEffectiveConfig, stateDirPath } from './lib/config.js'
import {
  beijingParts,
  bumpDaily,
  decide,
  handoffHint,
  normalizeConfig,
} from './lib/rules.js'

/** 插件名，仅用于日志。 */
export const name = 'context-guard'

/**
 * 用到的服务：
 * - `compaction`：本组 isolate realm 内的压缩服务实例（唯一可用的手动压缩入口）。
 * - `tokenMeter`：Host 层的度量服务，给出会话当前上下文 token 数。
 * - `userQuestions`：Host 层的人类提问服务，用来发可作答的确认请求。
 *
 * 这里故意不写静态 `inject`：预设组合里任一行「等待服务」会被登记成 pending 而静默
 * 不激活（见 dsh-agent-preset-registry/mount.ts 的 auditRows），静态 inject 一旦对不上就
 * 完全没有痕迹。改成每次用时用 ctx.get() 取，缺哪个就记一条明确的日志并跳过本次，
 * 插件本身仍处于激活状态，也不影响同组其它行。
 */
const REQUIRED_SERVICES = ['compaction', 'tokenMeter', 'userQuestions']

const LOG_PREFIX = '[context-guard]'

/** 确认请求里的两个选项文案；命中「同意」才压缩。 */
const APPROVE_LABEL = '立即压缩'
const DECLINE_LABEL = '这次跳过'

/** agent 报告 idle 后稍等再动手，避免抢在驱动真正收尾之前触发 busy。 */
const SETTLE_DELAY_MS = 800

/** 用户拒绝后，上下文至少要再涨这么多 token 才重新问一次，避免每轮回合都弹窗。 */
const REASK_DELTA_TOKENS = 20000

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 插件入口：Cordis 以 (ctx, config) 调用。 */
export function apply(ctx, rawConfig) {
  let config
  let configSource
  try {
    const shared = getEffectiveConfig()
    const overrides = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? rawConfig
      : {}
    const hasOverrides = Object.keys(overrides).length > 0
    config = normalizeConfig({ ...shared.config, ...overrides })
    configSource = hasOverrides ? `${shared.source}+preset` : shared.source
  } catch (error) {
    safeLog(ctx, 'error', `配置解析失败，插件不启用：${errorMessage(error)}`)
    return
  }
  if (!config.enabled) {
    safeLog(ctx, 'info', '配置里 enabled=false，插件不启用')
    return
  }

  /** 正在等用户回答的会话，避免同一会话弹出第二个确认。 */
  const pending = new Set()
  /** sessionId → 上次问用户时的 token 数，用于抑制重复提问。 */
  const lastAskedTokens = new Map()
  /** sessionId → 待执行的 setTimeout，卸载时清掉。 */
  const timers = new Map()
  /** 只在第一次真正用服务时汇总一次可用性，避免刷日志。 */
  let reportedServices = false

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }, 'context-guard: timers')

  safeLog(ctx, 'info', `已启用：阈值 ${config.thresholdTokens} token`
    + `（会话覆盖 ${Object.keys(config.sessionThresholds).length} 条），`
    + `idleOnly=${String(config.idleOnly)}，dailyLimit=${config.dailyLimit}，`
    + `confirmBefore=${String(config.confirmBefore)}；配置来源 ${configSource}`)
  recordActivation(ctx, config, 'apply', configSource)

  ctx.on('agent/status', (payload) => {
    try {
      if (payload?.status !== 'idle') return
      schedule(payload.agent)
    } catch (error) {
      safeLog(ctx, 'warn', `agent/status 处理失败：${errorMessage(error)}`)
    }
  })

  /**
   * 排一次延迟检查；同一会话同时只排一个。
   * @param {object} agent 触发闲状态的 agent。
   */
  function schedule(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    if (timers.has(sessionId) || pending.has(sessionId)) return
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      void check(agent).catch((error) => {
        safeLog(ctx, 'warn', `检查失败：${errorMessage(error)}`)
      })
    }, SETTLE_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    timers.set(sessionId, timer)
  }

  /**
   * 真正跑一次判定；需要压缩时先确认、再调用 compactNow。
   * @param {object} agent 目标 agent。
   */
  async function check(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    if (pending.has(sessionId)) return
    // 子会话不弹确认：userQuestions.ask() 会以 DELEGATED_CALLER 拒绝。
    if (isSubagent(agent)) return
    if (agent.status !== 'idle') return

    if (!reportedServices) {
      reportedServices = true
      recordActivation(ctx, config, 'first-check', configSource)
    }
    const meter = ctx.get('tokenMeter')
    if (meter === undefined) {
      safeLog(ctx, 'warn', '拿不到 tokenMeter 服务，本次跳过')
      return
    }
    const measured = measure(meter, agent)
    if (!Number.isFinite(measured)) {
      safeLog(ctx, 'warn', '读不到上下文 token 数，本次跳过')
      return
    }
    const dailyState = readState(ctx)
    const decision = decide({
      nowMs: Date.now(),
      sessionId,
      measuredTokens: measured,
      dailyState,
      config,
    })
    if (decision.action !== 'compact') {
      explainSkip(agent, decision)
      return
    }

    let tokens = measured
    if (config.confirmBefore) {
      const previous = lastAskedTokens.get(sessionId)
      if (previous !== undefined && tokens < previous + REASK_DELTA_TOKENS) return
      lastAskedTokens.set(sessionId, tokens)
      pending.add(sessionId)
      let answer
      try {
        answer = await askForConfirmation(agent, decision)
      } catch (error) {
        safeLog(ctx, 'warn', `确认请求失败，本次不压缩：${errorMessage(error)}`)
        return
      } finally {
        pending.delete(sessionId)
      }
      if (!isApproved(answer)) {
        safeLog(ctx, 'info', '用户选择跳过，本次不压缩')
        return
      }
      if (agent.status !== 'idle') {
        safeLog(ctx, 'info', '用户确认时会话已开始新回合，本次不压缩')
        return
      }
      tokens = measure(meter, agent)
      if (!Number.isFinite(tokens)) {
        safeLog(ctx, 'warn', '压缩前重新测量失败，本次不压缩')
        return
      }
    }

    await runCompaction(agent, { sessionId, tokens, decision })
  }

  /**
   * 调一次手动压缩，成功后记一次当日计数并落到磁盘。
   * @param {object} agent 目标 agent。
   * @param {{sessionId:string, tokens:number, decision:object}} input 本次触发信息。
   */
  async function runCompaction(agent, { sessionId, tokens, decision }) {
    const before = tokens
    // 压缩前的三件事里，只有「交接记忆」核得到；另外两件靠弹窗提醒（自动路径没有弹窗，只记日志）。
    const hint = handoffHint({
      nowMs: Date.now(),
      newestWriteMs: newestMemoryWriteMs(),
      freshWindowMinutes: config.handoffFreshMinutes,
    })
    safeLog(ctx, hint.fresh ? 'info' : 'warn',
      `压缩前检查：${hint.fresh ? '交接记忆新鲜' : '交接记忆可能过期'}（${hint.text}）`)
    const compaction = ctx.get('compaction')
    if (compaction === undefined) {
      safeLog(ctx, 'warn', '拿不到 compaction 服务（是否不在 compaction 隔离组里？），本次跳过')
      return
    }
    let result
    try {
      result = await compaction.compactNow(agent, new AbortController().signal)
    } catch (error) {
      // busy / cancelled / summary / commit / persistence 都是预期内失败，
      // 交给内置 compaction-basic 兜底，这里只记日志。
      safeLog(ctx, 'warn', `compactNow 失败（会话 ${sessionId}）：${errorMessage(error)}`)
      return
    }
    if (result === null || result === undefined) {
      safeLog(ctx, 'info', `没有可安全压缩的历史区间（会话 ${sessionId}，阈值 ${decision.threshold}）`)
      return
    }
    const meter = ctx.get('tokenMeter')
    const after = meter === undefined ? Number.NaN : measure(meter, agent)
    const next = bumpDaily(readState(ctx), Date.now())
    writeState(ctx, next)
    safeLog(ctx, 'info', `已压缩（会话 ${sessionId}）：${result.shadowedSeqs.length} 个历史节点，`
      + `约 ${result.shadowedTokenCount} token，`
      + `上下文 ${before} → ${Number.isFinite(after) ? after : '未知'} token；`
      + `今日第 ${next.count}/${config.dailyLimit} 次（${next.date}）`)
  }

  /**
   * 向当前会话发一条可作答的确认请求，等用户点选。
   *
   * 2026-11-23 加：压缩前的「三件事」清单。插件只核得到第 2 件（记忆库上次写入时间），
   * 另外两件（结论落文件、未核实数字清单）只能靠提醒，不能替用户判断。
   * @param {object} agent 目标 agent（必须是登记在案的活实例）。
   * @param {object} decision 本次判定结果，用来写文案。
   * @returns {Promise<object>} userQuestions 的答案对象。
   */
  async function askForConfirmation(agent, decision) {
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions === undefined) {
      throw new Error('拿不到 userQuestions 服务，无法征求确认')
    }
    const now = beijingParts(Date.now())
    const hint = handoffHint({
      nowMs: Date.now(),
      newestWriteMs: newestMemoryWriteMs(),
      freshWindowMinutes: config.handoffFreshMinutes,
    })
    return userQuestions.ask({
      agent,
      questions: [{
        id: 'context-guard-compact',
        header: '上下文压缩',
        question: `当前会话约 ${decision.tokens} token，已达到阈值 ${decision.threshold}。现在压缩吗？`,
        detail: '压缩会把较早的历史换成一份摘要，并产生一次额外的摘要模型调用（约增加一次请求费用）。'
          + `本次是今天第 ${decision.count + 1}/${decision.dailyLimit} 次。`
          + `现在北京时间 ${now.dateKey} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}。`
          + '\n\n压缩前先做完三件事：'
          + '\n1. 结论先写进文件 —— 摘要不是存档，文件才是'
          + `\n2. 交接记忆：${hint.text}`
          + '\n3. 列出「哪些数字是推出来的」—— 这条清单不会进摘要，只能自己记着'
          + '\n\n选「这次跳过」本轮不压缩，内置的 0.43 阈值仍然会在更晚的时候兜底。',
        options: [
          { label: APPROVE_LABEL, description: '立刻压缩，历史替换为摘要' },
          { label: DECLINE_LABEL, description: '这次不压，继续当前会话' },
        ],
      }],
    })
  }

  /** 记录一次"为什么没压"，只在非 below-threshold 时记 info，避免刷屏。 */
  function explainSkip(agent, decision) {
    if (decision.reason === 'below-threshold') {
      debug(`会话 ${sessionIdOf(agent)} 未达阈值：${decision.tokens} < ${decision.threshold}`)
      return
    }
    if (decision.reason === 'disabled') return
    const table = {
      'peak-hours': `处于高峰时段（北京时间 ${beijingParts(Date.now()).hour} 点），本次不压`,
      'daily-limit': `今日已压 ${decision.count}/${decision.dailyLimit} 次，达到上限`,
      'invalid-measurement': '测得的 token 数不可用，本次跳过',
    }
    safeLog(ctx, 'info', `${table[decision.reason] ?? decision.reason}（会话 ${sessionIdOf(agent)}）`)
  }

  /** debug 级日志同样不能抛。 */
  function debug(message) {
    try {
      ctx.logger.debug(`${LOG_PREFIX} ${message}`)
    } catch {
      /* 日志失败就丢掉 */
    }
  }
}

/** 日志失败不影响任何逻辑。 */
function safeLog(ctx, level, message) {
  try {
    const logger = ctx?.logger
    const write = typeof logger?.[level] === 'function' ? logger[level] : logger?.info
    if (typeof write === 'function') write.call(logger, `${LOG_PREFIX} ${message}`)
  } catch {
    /* 日志失败就丢掉 */
  }
}

/** 取会话 id；取不到就当这条会话不管。 */
function sessionIdOf(agent) {
  try {
    const id = agent?.session?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/** 子会话由父会话负责，本插件不在子会话上弹确认或私自动手。 */
function isSubagent(agent) {
  try {
    return agent?.session?.header?.origin === 'subagent'
  } catch {
    return false
  }
}

/** 读会话当前上下文 token 数（与 compaction-basic 用的是同一个度量）。 */
function measure(meter, agent) {
  try {
    const measurement = meter.measure(agent.session)
    const total = measurement?.totalTokens
    return typeof total === 'number' ? total : Number.NaN
  } catch {
    return Number.NaN
  }
}

/** 用户点的是不是「立即压缩」。 */
function isApproved(answer) {
  try {
    const items = answer?.answers
    if (!Array.isArray(items)) return false
    return items.some((item) => Array.isArray(item?.selected) && item.selected.includes(APPROVE_LABEL))
  } catch {
    return false
  }
}

/** 计数文件的路径。目录与 Host 行、激活日志共用 stateDirPath()。 */
function statePath() {
  return path.join(stateDirPath(), 'state.json')
}

/**
 * 记忆库根目录：`$HARNMEM_HOME` 或 `~/.harnmem`（与 dsh-harnmem 一致的取值）。
 * @returns {string}
 */
function harnmemHome() {
  const fromEnv = process.env.HARNMEM_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.harnmem')
}

/**
 * 记忆库里最新一条记录的写入时间（毫秒）。
 *
 * 只读文件系统，不依赖 harnmem 插件：扫 memories/user 和 memories/projects/<id>
 * 下的 *.md，取最大的 mtime。读不到返回 null，让判定层说「读不到」而不是当成「没写过」。
 * 一次压缩最多调一次，目录很小（几十个文件），开销可以忽略。
 * @returns {number|null}
 */
function newestMemoryWriteMs() {
  let newest = null
  const visit = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // 只下钻一层：projects/<projectId>/，再深就不是记忆库的布局了
        if (path.basename(dir) === 'memories' || path.basename(dir) === 'projects') visit(full)
        continue
      }
      if (!entry.name.endsWith('.md') || entry.name === 'MEMORY.md') continue
      try {
        const stat = fs.statSync(full)
        if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs
      } catch {
        /* 单个文件读失败就跳过 */
      }
    }
  }
  visit(path.join(harnmemHome(), 'memories'))
  return newest
}

/** 当前三个服务是否可用，写进激活记录，用来判断"为什么没动"。 */
function serviceAvailability(ctx) {
  const result = {}
  for (const service of REQUIRED_SERVICES) {
    try {
      result[service] = ctx.get(service) !== undefined
    } catch {
      result[service] = false
    }
  }
  return result
}

/**
 * 记一条激活记录到磁盘，用来回答"插件到底有没有在这个会话的 preset 里生效"。
 * 激活日志不参与任何决策，写失败也不影响插件。
 * @param {object} ctx 插件上下文。
 * @param {object} config 本次生效的配置。
 * @param {string} stage 记录时机：apply / first-check。
 * @param {string} source 配置来源：host / disk / defaults（或带 +preset 后缀）。
 */
function recordActivation(ctx, config, stage, source) {
  try {
    const file = path.join(stateDirPath(), 'activation.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const record = { stage, source, config, services: serviceAvailability(ctx) }
    fs.appendFileSync(file, `${new Date().toISOString()} ${JSON.stringify(record)}\n`, 'utf8')
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length > 200) fs.writeFileSync(file, `${lines.slice(-100).join('\n')}\n`, 'utf8')
  } catch {
    /* 激活日志只是观察手段，失败就丢掉 */
  }
}

/** 读状态；文件缺失或损坏都当作"没有计数"，跨天重置由 rules 负责。 */
function readState(ctx) {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      safeLog(ctx, 'warn', `读取计数失败：${errorMessage(error)}`)
    }
    return null
  }
}

/** 原子写状态：先写临时文件再 rename，写失败只记日志。 */
function writeState(ctx, state) {
  try {
    const file = statePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, file)
  } catch (error) {
    safeLog(ctx, 'warn', `写入计数失败：${errorMessage(error)}`)
  }
}
