/**
 * context-kit 控制半侧的纯决策层。
 *
 * 这个模块不含任何 I/O、不读系统时间、不 import 任何第三方包：每个入口都从参数
 * 拿时钟（毫秒时间戳）和当前计数状态，因此可以完全离线自检（见 ../selftest.mjs）。
 * 插件本体 ../guard.js 只负责取值、弹确认、调压缩和落盘。
 *
 * 时区固定按北京时间（UTC+8，无夏令时）计算，不依赖 ICU / 系统本地时区，
 * 所以在任何机器上结果一致。
 *
 * DEFAULTS 从 ./config.js 取：那是本包唯一的阈值来源，显示半侧也读同一份。
 */

import { DEFAULTS } from './config.js'

export { DEFAULTS }

/** 北京时间的固定偏移（UTC+8，中国不实行夏令时）。 */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 高峰时段（单价翻倍、压缩要重发整个前缀，所以要避开）：
 * 北京时间周一至周五 09:00–12:00、14:00–18:00，左闭右开。
 * 区间之外（含整段周末）都算“空闲时段”。
 */
export const PEAK_WINDOWS = Object.freeze([
  Object.freeze([9, 12]),
  Object.freeze([14, 18]),
])

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 把毫秒时间戳换算成北京时间的日历字段。
 * @param {number} nowMs 毫秒时间戳（UTC）。
 * @returns {{year:number, month:number, day:number, weekday:number, hour:number, minute:number, dateKey:string}}
 *   `weekday` 0=周日 … 6=周六；`dateKey` 形如 `2026-11-22`，用作跨天重置的键。
 */
export function beijingParts(nowMs) {
  const shifted = new Date(Number(nowMs) + BEIJING_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  return {
    year,
    month,
    day,
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
  }
}

/** 北京时间是否为周末（周六、周日）。 */
export function isWeekend(nowMs) {
  const { weekday } = beijingParts(nowMs)
  return weekday === 0 || weekday === 6
}

/**
 * 是否落在高峰期（工作日 09:00–12:00、14:00–18:00）。
 * 12:00 整、18:00 整属于区间外（空闲）；09:00 整、14:00 整属于区间内（高峰）。
 */
export function isPeakWindow(nowMs) {
  const parts = beijingParts(nowMs)
  if (parts.weekday === 0 || parts.weekday === 6) return false
  for (const [start, end] of PEAK_WINDOWS) {
    if (parts.hour >= start && parts.hour < end) return true
  }
  return false
}

/** 是否处于允许自动压缩的空闲时段（高峰时段之外，含周末全天）。 */
export function isIdleWindow(nowMs) {
  return !isPeakWindow(nowMs)
}

/**
 * 规整一份用户配置：缺字段补默认值，类型不对就退回默认值，绝不抛异常。
 * @param {unknown} raw 行 config / 用户传进来的任意值。
 * @returns {{enabled:boolean, thresholdTokens:number, sessionThresholds:Record<string, number>, idleOnly:boolean, dailyLimit:number, confirmBefore:boolean}}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: source.enabled !== false,
    thresholdTokens: normalizeTokenCount(source.thresholdTokens, DEFAULTS.thresholdTokens),
    sessionThresholds: normalizeSessionThresholds(source.sessionThresholds),
    idleOnly: source.idleOnly !== false,
    dailyLimit: normalizeTokenCount(source.dailyLimit, DEFAULTS.dailyLimit),
    confirmBefore: source.confirmBefore !== false,
    handoffFreshMinutes: normalizeMinutes(source.handoffFreshMinutes, DEFAULTS.handoffFreshMinutes),
  }
}

/**
 * 分钟数：正整数，非法值退回默认。
 * @param {unknown} value 待校验值。
 * @param {number} fallback 默认值。
 * @returns {number}
 */
export function normalizeMinutes(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/**
 * 压缩前的「交接记忆新鲜度」判定（纯函数，不碰磁盘）。
 *
 * 规则来源：压缩前要先把结论写进文件、写一条交接记忆、
 * 列出哪些数字是推出来的。插件只能核对第二件——记忆库上次写入的时间。
 *
 * @param {object} input
 * @param {number} input.nowMs 当前毫秒时间戳。
 * @param {number|null|undefined} input.newestWriteMs 记忆库里最新一条记录的写入时间；读不到传 null。
 * @param {number} [input.freshWindowMinutes] 认为「新鲜」的窗口，默认 30 分钟。
 * @returns {{known:boolean, fresh:boolean, ageMinutes:number|null, freshWindowMinutes:number, text:string}}
 */
export function handoffHint({ nowMs, newestWriteMs, freshWindowMinutes }) {
  const windowMinutes = normalizeMinutes(freshWindowMinutes, DEFAULTS.handoffFreshMinutes)
  const windowMs = windowMinutes * 60 * 1000
  const known = typeof newestWriteMs === 'number' && Number.isFinite(newestWriteMs)
  if (!known) {
    return {
      known: false,
      fresh: false,
      ageMinutes: null,
      freshWindowMinutes: windowMinutes,
      text: '读不到记忆库，这项自己确认',
    }
  }
  const ageMs = Math.max(0, Number(nowMs) - newestWriteMs)
  const ageMinutes = Math.floor(ageMs / 60000)
  const fresh = ageMs <= windowMs
  const when = ageMinutes < 1 ? '刚刚' : `${ageMinutes} 分钟前`
  return {
    known: true,
    fresh,
    ageMinutes,
    freshWindowMinutes: windowMinutes,
    text: fresh
      ? `${when}写过（${windowMinutes} 分钟内，算新鲜）`
      : `上次写入是 ${when}，超过 ${windowMinutes} 分钟，建议先写一条再压`,
  }
}

/**
 * 非负整数 token 数。
 * @param {unknown} value 待校验值。
 * @param {number} fallback 不合法时使用的默认值。
 * @returns {number}
 */
export function normalizeTokenCount(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

/**
 * 只保留「会话 id → 正整数」的合法条目；其余丢弃。
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
export function normalizeSessionThresholds(raw) {
  const result = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const [sessionId, value] of Object.entries(raw)) {
    if (!sessionId) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    result[sessionId] = Math.floor(value)
  }
  return result
}

/**
 * 解析某个会话实际生效的阈值：命中覆盖则用覆盖值，否则用全局值。
 * @param {{thresholdTokens:number, sessionThresholds:Record<string, number>}} config 已规整的配置。
 * @param {string|undefined} sessionId 会话 id。
 * @returns {number}
 */
export function effectiveThreshold(config, sessionId) {
  const overrides = config?.sessionThresholds ?? {}
  if (typeof sessionId === 'string' && sessionId.length > 0
    && Object.prototype.hasOwnProperty.call(overrides, sessionId)) {
    const value = overrides[sessionId]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return normalizeTokenCount(config?.thresholdTokens, DEFAULTS.thresholdTokens)
}

/**
 * 读取某一天的有效计数：状态里的日期不是今天（北京时间）就当作 0，实现跨天重置。
 * @param {{date?:string, count?:number}|null|undefined} state 磁盘上读到的状态。
 * @param {number} nowMs 当前毫秒时间戳。
 * @returns {{date:string, count:number}}
 */
export function resolveDailyCount(state, nowMs) {
  const dateKey = beijingParts(nowMs).dateKey
  const storedCount = state !== null && typeof state === 'object' ? state.count : undefined
  const storedDate = state !== null && typeof state === 'object' ? state.date : undefined
  const usable = storedDate === dateKey
    && typeof storedCount === 'number'
    && Number.isSafeInteger(storedCount)
    && storedCount > 0
  return { date: dateKey, count: usable ? storedCount : 0 }
}

/**
 * 记一次压缩：先跨天重置，再 +1。
 * @param {{date?:string, count?:number}|null|undefined} state 磁盘上读到的状态。
 * @param {number} nowMs 当前毫秒时间戳。
 * @returns {{date:string, count:number}}
 */
export function bumpDaily(state, nowMs) {
  const current = resolveDailyCount(state, nowMs)
  return { date: current.date, count: current.count + 1 }
}

/**
 * 五条规则合成一个纯决策。按顺序判定：停用 → 绝对阈值（含会话覆盖）→ 空闲时段 → 每日上限。
 * @param {object} input
 * @param {number} input.nowMs 当前毫秒时间戳。
 * @param {string|undefined} input.sessionId 当前会话 id。
 * @param {number} input.measuredTokens 当前会话测得的上下文 token 数。
 * @param {{date?:string, count?:number}|null|undefined} input.dailyState 磁盘计数的当前内容。
 * @param {object} input.config 已规整的配置（见 normalizeConfig）。
 * @returns {{
 *   action: 'compact'|'skip',
 *   reason: 'ok'|'disabled'|'invalid-measurement'|'below-threshold'|'peak-hours'|'daily-limit',
 *   threshold: number,
 *   tokens: number,
 *   date: string,
 *   count: number,
 *   dailyLimit: number,
 *   peakWindow: boolean,
 *   idleWindow: boolean
 * }}
 */
export function decide({ nowMs, sessionId, measuredTokens, dailyState, config }) {
  const cfg = config ?? normalizeConfig(undefined)
  const threshold = effectiveThreshold(cfg, sessionId)
  const tokens = typeof measuredTokens === 'number' ? measuredTokens : Number.NaN
  const daily = resolveDailyCount(dailyState, nowMs)
  const base = {
    threshold,
    tokens,
    date: daily.date,
    count: daily.count,
    dailyLimit: cfg.dailyLimit,
    peakWindow: isPeakWindow(nowMs),
    idleWindow: isIdleWindow(nowMs),
  }
  if (cfg.enabled === false) return { action: 'skip', reason: 'disabled', ...base }
  // 测不出 token 就不要动：宁可让内置 0.43 兜底，也不要在信息不足时压缩。
  if (!Number.isFinite(tokens) || tokens < 0) return { action: 'skip', reason: 'invalid-measurement', ...base }
  // 达到即触发（与 compaction-basic 的 `totalTokens < thresholdTokens` 判据对齐）。
  if (tokens < threshold) return { action: 'skip', reason: 'below-threshold', ...base }
  if (cfg.idleOnly && base.peakWindow) return { action: 'skip', reason: 'peak-hours', ...base }
  if (daily.count >= cfg.dailyLimit) return { action: 'skip', reason: 'daily-limit', ...base }
  return { action: 'compact', reason: 'ok', ...base }
}
