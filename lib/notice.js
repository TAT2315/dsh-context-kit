/**
 * 压缩后提醒的计数存储（2026-11-23 新增，替代原来的内存 Map）。
 *
 * 为什么落盘：原来的计数只存在 Host 进程内存里，DSH 一重启就从 1 重新数，
 * 而一条会话可能跨很多天、压过十几次 —— 提示里写「本会话已压缩 1 次」是错的。
 *
 * 口径说清楚：文件只记本机装上这个版本之后的压缩次数，更早的历史补不回来
 * （要补得读会话日志、解 zstd，代价和风险都不划算）。所以文案里写明统计起点，
 * 不假装知道全部历史。
 *
 * 这个模块只依赖 node:fs / node:path 和 ./rules.js 的纯函数，可以离线自检。
 */

import fs from 'node:fs'
import path from 'node:path'
import { beijingParts } from './rules.js'

/** 计数文件格式版本；结构不兼容时直接当空库，不清空用户文件。 */
export const NOTICE_VERSION = 1

/** 超过这么久没再压缩的会话记录，启动时清掉，避免文件无限长大。 */
export const NOTICE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/**
 * 计数文件路径。
 * @param {string} dir 状态目录（`stateDirPath()` 的返回值）。
 * @returns {string}
 */
export function noticeFilePath(dir) {
  return path.join(dir, 'notice-count.json')
}

/** 空库。 */
function emptyStore() {
  return { version: NOTICE_VERSION, sessions: {} }
}

/**
 * 把磁盘上读到的任意值规整成可用结构：坏字段丢掉，不抛异常。
 * @param {unknown} raw JSON.parse 的结果。
 * @returns {{version:number, sessions:Record<string,{count:number,firstAt:number,lastAt:number}>}}
 */
export function normalizeStore(raw) {
  const store = emptyStore()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return store
  const source = raw.sessions
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return store
  for (const [id, value] of Object.entries(source)) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const count = Number.isSafeInteger(value.count) && value.count > 0 ? value.count : 0
    if (count === 0) continue
    const lastAt = Number.isFinite(value.lastAt) ? value.lastAt : 0
    const firstAt = Number.isFinite(value.firstAt) && value.firstAt > 0 ? value.firstAt : lastAt
    store.sessions[id] = { count, firstAt, lastAt }
  }
  return store
}

/**
 * 读计数文件；文件缺失、损坏、版本不符都当空库（下次压缩会重写）。
 * @param {string} dir 状态目录。
 * @returns {{version:number, sessions:Record<string,{count:number,firstAt:number,lastAt:number}>}}
 */
export function loadStore(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(noticeFilePath(dir), 'utf8'))
    return normalizeStore(parsed)
  } catch {
    return emptyStore()
  }
}

/**
 * 给某个会话的压缩次数 +1（原地修改 store）。
 * @param {{sessions:Record<string,{count:number,firstAt:number,lastAt:number}>}} store 计数库。
 * @param {string} sessionId 会话 id。
 * @param {number} nowMs 本次压缩的时间（毫秒）。
 * @returns {{count:number,firstAt:number,lastAt:number}|undefined} 会话 id 不合法时返回 undefined。
 */
export function bumpNotice(store, sessionId, nowMs) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const previous = store.sessions[sessionId]
  const entry = previous === undefined
    ? { count: 1, firstAt: nowMs, lastAt: nowMs }
    : { count: previous.count + 1, firstAt: previous.firstAt > 0 ? previous.firstAt : nowMs, lastAt: nowMs }
  store.sessions[sessionId] = entry
  return entry
}

/**
 * 清掉太久没动的会话记录（原地修改 store）。
 * @param {{sessions:Record<string,{lastAt:number}>}} store 计数库。
 * @param {number} nowMs 当前时间。
 * @param {number} [retentionMs] 保留时长，默认 90 天。
 * @returns {number} 清掉的条数。
 */
export function pruneStore(store, nowMs, retentionMs = NOTICE_RETENTION_MS) {
  let removed = 0
  for (const [id, entry] of Object.entries(store.sessions)) {
    const lastAt = Number.isFinite(entry?.lastAt) ? entry.lastAt : 0
    if (nowMs - lastAt > retentionMs) {
      delete store.sessions[id]
      removed += 1
    }
  }
  return removed
}

/**
 * 原子写计数文件：先写临时文件再 rename；失败抛出，由调用方决定怎么记日志。
 * @param {string} dir 状态目录。
 * @param {object} store 计数库。
 * @returns {string} 文件路径。
 */
export function saveStore(dir, store) {
  const file = noticeFilePath(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
  return file
}

/**
 * 提醒正文。同一会话同一计数渲染出的文本逐字相同，不破坏前缀缓存。
 *
 * 时间、次数、起点都是算出来的，不写死、不举例；起点用于说明「更早的没算进来」。
 * @param {{count:number,firstAt:number,lastAt:number}} entry 该会话的计数。
 * @returns {string}
 */
export function renderNotice(entry) {
  const last = beijingParts(entry.lastAt)
  const first = beijingParts(entry.firstAt)
  const hh = String(last.hour).padStart(2, '0')
  const mm = String(last.minute).padStart(2, '0')
  return `## 压缩提醒（context-kit）\n\n`
    + `本会话已记录 ${entry.count} 次压缩（自 ${first.dateKey} 起），`
    + `最近一次 ${last.dateKey} ${hh}:${mm}。`
    + `摘要里的条数、金额、日期、账号数据只当线索，不当结论：要用之前回文件或 harnmem 核一遍。`
}
