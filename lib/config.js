/**
 * context-kit 的配置单一来源。
 *
 * 这个包有两种挂载：
 * - Host 行（bundle 的 cordis.patch.yml 插入 `context-kit`）承载 dsh.client，
 *   并把行 config 发布成“生效配置”；
 * - 预设行（preset-standard 的 compaction 组里的 `context-guard`）加载 ./guard.js，
 *   五条规则从同一份“生效配置”读。
 *
 * 数字只写一次：
 * - 部署值写在 bundle 的 cordis.patch.yml 那一行；
 * - 这里的 DEFAULTS 只是缺省兜底；
 * - 半侧之间不互相写死：Host 行 apply 时调 publishEffectiveConfig()，
 *   生效配置同时放进进程内单例和 `$DSH_HOME/dsh-context-kit/effective.json`；
 *   guard.js 只从 getEffectiveConfig() 取，不在别处再写一份阈值。
 *
 * 显示半侧（client.js）拿到的是同一行 config：thresholdRatio 决定自动压缩线，
 * thresholdTokens 决定提前压线；它没有自己的阈值常量。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 缺省值。与 bundle 行 config 保持一致；任何一项缺失或类型不对时用它兜底。
 * 规则字段的类型校验与 lib/rules.js 的 normalizeConfig 完全同义，避免两套解释。
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  thresholdTokens: 350000,
  sessionThresholds: {},
  idleOnly: true,
  dailyLimit: 5,
  confirmBefore: true,
  handoffFreshMinutes: 30,
  compactNotice: true,
  thresholdRatio: 0.43,
  contextWindowFallback: 1048576,
})

/** 进程内生效配置；由 Host 行的 apply 设置。 */
let effective = null
/** 生效配置的来源：host / disk / defaults，只用于日志与自检。 */
let effectiveSource = 'defaults'

/**
 * 状态目录：`$DSH_HOME/dsh-context-kit/`。
 * 计数、激活日志、生效配置都放这里，只在这一个函数里拼路径。
 * @returns {string} 绝对路径。
 */
export function stateDirPath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-context-kit')
}

/** 生效配置文件的路径。 */
export function effectiveConfigPath() {
  return path.join(stateDirPath(), 'effective.json')
}

/**
 * 非负整数；不合法就退回缺省值。
 * @param {unknown} value 待校验值。
 * @param {number} fallback 缺省值。
 * @returns {number}
 */
function nonNegativeInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

/**
 * 正数；不合法就退回缺省值。
 * @param {unknown} value 待校验值。
 * @param {number} fallback 缺省值。
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

/** 纯对象判断（数组、null 都不算）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把任意行 config 规整成完整配置；不抛异常。
 * 只做取值与类型兜底，不改变五条规则的判定逻辑（那在 lib/rules.js）。
 * @param {unknown} raw 行 config。
 * @returns {object} 完整配置。
 */
export function normalizeEffective(raw) {
  const source = isPlainObject(raw) ? raw : {}
  return {
    enabled: source.enabled !== false,
    thresholdTokens: nonNegativeInt(source.thresholdTokens, DEFAULTS.thresholdTokens),
    sessionThresholds: isPlainObject(source.sessionThresholds) ? source.sessionThresholds : {},
    idleOnly: source.idleOnly !== false,
    dailyLimit: nonNegativeInt(source.dailyLimit, DEFAULTS.dailyLimit),
    confirmBefore: source.confirmBefore !== false,
    handoffFreshMinutes: nonNegativeInt(source.handoffFreshMinutes, DEFAULTS.handoffFreshMinutes) || DEFAULTS.handoffFreshMinutes,
    compactNotice: source.compactNotice !== false,
    thresholdRatio: positiveNumber(source.thresholdRatio, DEFAULTS.thresholdRatio),
    contextWindowFallback: positiveNumber(source.contextWindowFallback, DEFAULTS.contextWindowFallback),
  }
}

/**
 * 发布生效配置：更新进程内单例，并把带 pid 的快照写到磁盘。
 * Guard 半侧与 Host 行在同一进程时直接命中单例；跨加载器时退到磁盘。
 * @param {unknown} raw Host 行的 config。
 * @returns {object} 规整后的完整配置。
 */
export function publishEffectiveConfig(raw) {
  effective = normalizeEffective(raw)
  effectiveSource = 'host'
  writeEffectiveFile(effective)
  return effective
}

/**
 * 读取生效配置。
 * 顺序：进程内单例 → 同进程写出的 effective.json → DEFAULTS。
 * @returns {{config: object, source: 'host'|'disk'|'defaults'}}
 */
export function getEffectiveConfig() {
  if (effective !== null) return { config: effective, source: effectiveSource }
  const fromDisk = readEffectiveFile()
  if (fromDisk !== null) {
    effective = fromDisk
    effectiveSource = 'disk'
    return { config: effective, source: 'disk' }
  }
  effective = normalizeEffective(undefined)
  effectiveSource = 'defaults'
  return { config: effective, source: 'defaults' }
}

/** 只读自检用：清掉进程内单例，模拟另一个加载器。 */
export function resetEffectiveConfigForTest() {
  effective = null
  effectiveSource = 'defaults'
}

/**
 * 原子写生效配置；失败只返回 false，不影响任何判定。
 * @param {object} config 已规整的配置。
 * @returns {boolean} 是否写成功。
 */
function writeEffectiveFile(config) {
  try {
    const file = effectiveConfigPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    const record = { ...config, pid: process.pid, updatedAt: new Date().toISOString() }
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 读回同进程写出的生效配置；pid 不同（上一次进程的旧配置）就当作没有。
 * @returns {object|null}
 */
function readEffectiveFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(effectiveConfigPath(), 'utf8'))
    if (!isPlainObject(parsed) || parsed.pid !== process.pid) return null
    return normalizeEffective(parsed)
  } catch {
    return null
  }
}
