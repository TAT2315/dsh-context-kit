/**
 * context-kit 的 Host 半侧（bundle 插入的那一行，id: context-kit）。
 *
 * 这一行本身不提供压缩能力，只做两件事：
 * 1. 承载 dsh.client（聊天底栏的「上下文」控件与明细弹窗）；
 * 2. 把行 config 发布成两个入口共用的生效配置 —— 显示用 thresholdRatio /
 *    thresholdTokens / contextWindowFallback，控制用五条规则的同名字段。
 *
 * 它不注册任何工具、不监听事件，也不碰 compaction 服务：压缩相关的一切在
 * ./guard.js，那一半必须挂在 preset-standard 的 compaction 隔离组里。
 */

import fs from 'node:fs'
import path from 'node:path'
import { publishEffectiveConfig, stateDirPath } from './lib/config.js'
import {
  bumpNotice,
  loadStore,
  noticeFilePath,
  pruneStore,
  renderNotice,
  saveStore,
} from './lib/notice.js'

/** 行名，仅用于日志。 */
export const name = 'context-kit'

const LOG_PREFIX = '[context-kit]'

/**
 * 压缩后提醒用的系统提示段。
 *
 * 为什么放在 Host 行：这是唯一能拿到 `systemPrompt` 服务、又能看到 `session/event`
 * 的位置；guard 在 compaction 隔离组里，只看得到压缩服务。
 *
 * 文本只在会话压缩过之后才出现，且同一会话内除压缩次数变化外逐字不变，
 * 不会破坏前缀缓存。
 */
const NOTICE_SECTION = 'context-kit:compaction-notice'
const NOTICE_ORDER = 4060
/** 摘要与结束事件可能隔几毫秒连着来，三秒内不重复计数。 */
const NOTICE_DEDUPE_MS = 3000

/**
 * 挂载 Host 行：发布生效配置并记一条激活日志。
 * @param {object} ctx Host 上下文。
 * @param {object} [rawConfig] 行 config（bundle 的 cordis.patch.yml 或 profile 覆盖）。
 */
export function apply(ctx, rawConfig) {
  const effective = publishEffectiveConfig(rawConfig)
  const file = recordActivation(effective)
  installCompactionNotice(ctx, effective)

  // 浏览器半侧拿不到行 config（客户端插件行的 config 不会随模块图下发），
  // 所以把同一份生效配置作为页面全局注入：webserver 每次渲染 index.html 时
  // 发一次 `webserver/index-inject`，这里追加一行 global。
  // 数值只来自 effective，不在这里另写一份。
  try {
    ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      table.push({
        kind: 'global',
        name: '__DSH_CONTEXT_KIT__',
        value: {
          thresholdTokens: effective.thresholdTokens,
          thresholdRatio: effective.thresholdRatio,
          contextWindowFallback: effective.contextWindowFallback,
        },
      })
    }), 'context-kit: index injection')
  } catch (error) {
    safeLog(ctx, 'warn', `页面配置注入失败：${error instanceof Error ? error.message : String(error)}`)
  }

  safeLog(ctx, 'info', `配置已发布：提前压线 ${effective.thresholdTokens} token，`
    + `自动压缩线比例 ${effective.thresholdRatio}，窗口兜底 ${effective.contextWindowFallback}；`
    + `五条规则 idleOnly=${String(effective.idleOnly)}，dailyLimit=${effective.dailyLimit}，`
    + `confirmBefore=${String(effective.confirmBefore)}；生效文件 ${file}`)
}

/**
 * 装「压缩后提醒」：记住每个会话压缩过几次，并把它注入系统提示。
 *
 * 目的：压缩摘要里的条数、金额、日期、账号数据只当线索，
 * 要用之前必须回文件或记忆库核一遍。提醒只在压缩过的会话里出现，不增加无用 token。
 *
 * @param {object} ctx Host 上下文。
 * @param {object} effective 已发布的生效配置（只读 compactNotice 一个开关）。
 */
function installCompactionNotice(ctx, effective) {
  if (effective.compactNotice === false) {
    safeLog(ctx, 'info', '压缩后提醒已关闭（compactNotice=false）')
    return
  }
  // 计数落盘：重启后接着数，而不是从 1 重来（原来只放内存，见 lib/notice.js 顶部说明）。
  const dir = stateDirPath()
  const store = loadStore(dir)
  const pruned = pruneStore(store, Date.now())
  if (pruned > 0) {
    try {
      saveStore(dir, store)
    } catch {
      /* 清理失败不影响提醒 */
    }
    safeLog(ctx, 'info', `清理了 ${pruned} 条过期会话计数`)
  }
  /** sessionId → 上次计数的时间，用来把 summary 与 end 这对事件合并成一次。 */
  const lastCountedAt = new Map()
  try {
    ctx.on('session/event', (payload, event) => {
      const type = event?.type
      if (type !== 'compaction/summary' && type !== 'compaction/end') return
      const sessionId = sessionIdOf(payload)
      if (sessionId === undefined) return
      const now = Date.now()
      const previous = lastCountedAt.get(sessionId)
      if (previous !== undefined && now - previous < NOTICE_DEDUPE_MS) {
        lastCountedAt.set(sessionId, now)
        return
      }
      lastCountedAt.set(sessionId, now)
      const entry = bumpNotice(store, sessionId, now)
      if (entry === undefined) return
      try {
        saveStore(dir, store)
      } catch (error) {
        safeLog(ctx, 'warn', `压缩计数落盘失败：${error instanceof Error ? error.message : String(error)}`)
      }
      safeLog(ctx, 'info', `会话 ${sessionId} 已压缩 ${entry.count} 次，计数已写入 ${noticeFilePath(dir)}`)
    })
  } catch (error) {
    safeLog(ctx, 'warn', `订阅压缩事件失败，压缩提醒不生效：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  try {
    // systemPrompt 是 Host 服务，行加载时可能还没就绪：用 inject 等服务出现再挂段，
    // 拿不到就只记日志（提醒不生效，但不影响其他功能）。
    const register = (scope) => {
      const target = scope ?? ctx
      const systemPrompt = typeof target.get === 'function' ? target.get('systemPrompt') : undefined
      if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
        safeLog(ctx, 'warn', '拿不到 systemPrompt 服务，压缩提醒只记在内存里')
        return
      }
      systemPrompt.section({
        name: NOTICE_SECTION,
        order: NOTICE_ORDER,
        text: (context) => {
          const sessionId = sessionIdOf(context?.agent)
          if (sessionId === undefined) return ''
          const entry = store.sessions[sessionId]
          if (entry === undefined || entry.count <= 0) return ''
          return renderNotice(entry)
        },
      })
      safeLog(ctx, 'info', '压缩提醒已注册到系统提示')
      recordStage({ stage: 'notice-registered', section: NOTICE_SECTION, order: NOTICE_ORDER })
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], (scope) => register(scope))
    } else {
      register(ctx)
    }
  } catch (error) {
    safeLog(ctx, 'warn', `注册压缩提醒失败：${error instanceof Error ? error.message : String(error)}`)
    recordStage({ stage: 'notice-failed', error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 往 activation.log 追加一条阶段记录（只用于观察，失败静默）。
 * @param {object} record 阶段对象。
 * @returns {void}
 */
function recordStage(record) {
  try {
    const file = path.join(stateDirPath(), 'activation.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    /* 观察用，失败就丢掉 */
  }
}

/**
 * 从事件负载里取会话 id。宿主不同事件给的形状不一样，
 * 这里按 dsh-harnmem 的那套兼容写法取，取不到就当这条事件不管。
 * @param {unknown} payload session/event 的第一个参数。
 * @returns {string|undefined}
 */
function sessionIdOf(payload) {
  try {
    const record = payload
    if (record === null || typeof record !== 'object') return undefined
    const direct = record.session?.id ?? record.id
    if (typeof direct === 'string' && direct.length > 0) return direct
    const fromAgent = record.agent?.session?.id
    if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent
  } catch {
    /* 取不到就算了 */
  }
  return undefined
}

/** 日志失败不影响启动。 */
function safeLog(ctx, level, message) {
  try {
    const logger = ctx?.logger
    const write = typeof logger?.[level] === 'function' ? logger[level] : logger?.info
    if (typeof write === 'function') write.call(logger, `${LOG_PREFIX} ${message}`)
  } catch {
    /* 日志失败就丢掉 */
  }
}

/**
 * 把 Host 行的 apply 也记进同一个 activation.log，证明“生效配置确实来自这一行”。
 * 激活日志只用于观察，写失败不影响任何逻辑。
 * @param {object} config 已发布的生效配置。
 * @returns {string} 日志文件路径（写失败也返回，方便排查）。
 */
function recordActivation(config) {
  const file = path.join(stateDirPath(), 'activation.log')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const record = { stage: 'host-apply', source: 'bundle-row', config }
    fs.appendFileSync(file, `${new Date().toISOString()} ${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    /* 激活日志只是观察手段，失败就丢掉 */
  }
  return file
}
