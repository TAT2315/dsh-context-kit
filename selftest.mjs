/**
 * context-kit 离线自检：控制半侧的五条规则 + 共享配置 + 客户端两线显示。
 *
 * 覆盖：
 * - 时段判定（含 12:00 / 09:00 / 14:00 / 18:00 边界与周末）、跨天 0 点重置、
 *   按会话阈值覆盖命中与未命中、阈值比较（含正好等于）、每日次数上限（含超限）；
 * - 配置单一来源：DEFAULTS → 自动压缩线 / 提前压线；Host 发布 → guard 读回；
 * - 加载真实的 client.js（与模块加载器同样的 window.__ModuleLoader__ 入口），
 *   断言底栏读数不变、弹窗同时出现两条线、更近标记随上下文切换、缺配置不编数字。
 *
 * 用法（在包目录）： node selftest.mjs
 * 全通过退出码 0，有失败退出码 1。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULTS,
  bumpDaily,
  beijingParts,
  decide,
  effectiveThreshold,
  isIdleWindow,
  isPeakWindow,
  isWeekend,
  handoffHint,
  normalizeConfig,
  normalizeSessionThresholds,
  resolveDailyCount,
} from './lib/rules.js'
import {
  getEffectiveConfig,
  normalizeEffective,
  publishEffectiveConfig,
  resetEffectiveConfigForTest,
  stateDirPath,
} from './lib/config.js'
import {
  bumpNotice,
  loadStore,
  normalizeStore,
  noticeFilePath,
  pruneStore,
  renderNotice,
  saveStore,
} from './lib/notice.js'

// 自检不碰真实状态目录：Host 发布的 effective.json 写进临时 DSH_HOME。
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-selftest-'))
process.env.DSH_HOME = tempHome

const here = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
const failures = []

function eq(actual, expected, label) {
  const isObject = (value) => value !== null && typeof value === 'object'
  const same = isObject(actual) || isObject(expected)
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : Object.is(actual, expected)
  if (same) {
    passed += 1
    return
  }
  failures.push(`${label}：期望 ${format(expected)}，实际 ${format(actual)}`)
}

function ok(condition, label) {
  eq(Boolean(condition), true, label)
}

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

function section(title) {
  console.log(`\n## ${title}`)
}

function line(label, value) {
  console.log(`  ${label}: ${value}`)
}

/** 北京时间 → 毫秒时间戳。 */
function bj(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) - 8 * 60 * 60 * 1000
}

/** 在给定年月里找第一个符合条件的星期。0=周日 … 6=周六。 */
function findDay(year, month, weekday) {
  for (let day = 1; day <= 28; day += 1) {
    if (beijingParts(bj(year, month, day, 12, 0)).weekday === weekday) {
      return { year, month, day }
    }
  }
  throw new Error(`找不到 ${year}-${month} 的 weekday=${weekday}`)
}

const monday = findDay(2026, 11, 1)
const saturday = findDay(2026, 11, 6)
const sunday = findDay(2026, 11, 0)
const baseConfig = normalizeConfig(DEFAULTS)

// ---------------------------------------------------------------------------
section('时段判定（北京时间，工作日）')
const timeCases = [
  ['08:59', 8, 59, false],
  ['09:00（上界起点，属高峰）', 9, 0, true],
  ['11:59', 11, 59, true],
  ['12:00（边界，属空闲）', 12, 0, false],
  ['12:01', 12, 1, false],
  ['13:59', 13, 59, false],
  ['14:00（下界起点，属高峰）', 14, 0, true],
  ['17:59', 17, 59, true],
  ['18:00（边界，属空闲）', 18, 0, false],
  ['23:59', 23, 59, false],
  ['00:00', 0, 0, false],
]
for (const [label, hour, minute, peak] of timeCases) {
  const ts = bj(monday.year, monday.month, monday.day, hour, minute)
  eq(isPeakWindow(ts), peak, `周一 ${label} 是否高峰`)
  eq(isIdleWindow(ts), !peak, `周一 ${label} 是否空闲`)
  line(`周一 ${label}`, peak ? '高峰' : '空闲')
}

section('时段判定（周末全天空闲）')
for (const [name, day] of [['周六', saturday], ['周日', sunday]]) {
  for (const [hour, minute] of [[0, 0], [9, 30], [12, 0], [15, 0], [18, 0], [23, 59]]) {
    const ts = bj(day.year, day.month, day.day, hour, minute)
    eq(isWeekend(ts), true, `${name} ${hour}:${minute} 应是周末`)
    eq(isPeakWindow(ts), false, `${name} ${hour}:${minute} 不应是高峰`)
    eq(isIdleWindow(ts), true, `${name} ${hour}:${minute} 应是空闲`)
  }
  line(`${name} 06:00/10:00/15:00/22:00`, '全部空闲')
}

section('时段判定（偏移按 UTC+8，不按 UTC）')
// UTC 01:30 = 北京 09:30 → 高峰；若错按 UTC 判定会算成 01:30 空闲。
const utcCross = Date.UTC(monday.year, monday.month - 1, monday.day, 1, 30, 0, 0)
eq(isPeakWindow(utcCross), true, `UTC 01:30（北京 09:30）应判为高峰`)
line('UTC 01:30 对应北京时间', `${beijingParts(utcCross).hour}:${beijingParts(utcCross).minute}`)

// ---------------------------------------------------------------------------
section('阈值比较（含正好等于阈值）')
const idleTs = bj(monday.year, monday.month, monday.day, 22, 0)
const thresholdDecision = (tokens) => decide({
  nowMs: idleTs,
  sessionId: 'sess-plain',
  measuredTokens: tokens,
  dailyState: null,
  config: baseConfig,
})
eq(thresholdDecision(349999).action, 'skip', '349999 token 应跳过')
eq(thresholdDecision(349999).reason, 'below-threshold', '349999 的原因应是 below-threshold')
eq(thresholdDecision(350000).action, 'compact', '350000 token（正好等于阈值）应压缩')
eq(thresholdDecision(350001).action, 'compact', '350001 token 应压缩')
eq(thresholdDecision(350000).threshold, 350000, '默认阈值应是 350000')
line('349999 / 350000 / 350001', [
  thresholdDecision(349999).action,
  thresholdDecision(350000).action,
  thresholdDecision(350001).action,
].join(' / '))

// ---------------------------------------------------------------------------
section('按会话阈值覆盖（命中与未命中）')
const overrideConfig = normalizeConfig({ ...DEFAULTS, sessionThresholds: { 'sess-special': 500000 } })
const overrideDecision = (sessionId, tokens) => decide({
  nowMs: idleTs,
  sessionId,
  measuredTokens: tokens,
  dailyState: null,
  config: overrideConfig,
})
eq(effectiveThreshold(overrideConfig, 'sess-special'), 500000, '命中覆盖时阈值应是 500000')
eq(effectiveThreshold(overrideConfig, 'sess-other'), 350000, '未命中覆盖时阈值应是全局 350000')
eq(effectiveThreshold(overrideConfig, undefined), 350000, '没有会话 id 时用全局阈值')
eq(overrideDecision('sess-special', 400000).action, 'skip', '覆盖会话 400000 < 500000 应跳过')
eq(overrideDecision('sess-special', 400000).threshold, 500000, '覆盖会话判定里应回显 500000')
eq(overrideDecision('sess-special', 500000).action, 'compact', '覆盖会话正好 500000 应压缩')
eq(overrideDecision('sess-other', 400000).action, 'compact', '未覆盖会话 400000 > 350000 应压缩')
line('覆盖命中/未命中', [
  `sess-special@400000=${overrideDecision('sess-special', 400000).reason}`,
  `sess-special@500000=${overrideDecision('sess-special', 500000).action}`,
  `sess-other@400000=${overrideDecision('sess-other', 400000).action}`,
].join('，'))

section('会话覆盖的脏数据被丢弃')
const dirtyOverrides = normalizeSessionThresholds({
  good: 500000,
  zero: 0,
  negative: -1,
  text: '500000',
  notFinite: Number.POSITIVE_INFINITY,
  '': 123,
})
eq(Object.keys(dirtyOverrides).length, 1, '只应保留 1 条合法覆盖')
eq(dirtyOverrides.good, 500000, '合法覆盖值应保留')
line('脏数据输入 6 条，保留', `${Object.keys(dirtyOverrides).length} 条`)

// ---------------------------------------------------------------------------
section('每日次数上限（含超限）')
const limitDecision = (count, limit, date) => decide({
  nowMs: idleTs,
  sessionId: 'sess-plain',
  measuredTokens: 400000,
  dailyState: { date, count },
  config: normalizeConfig({ ...DEFAULTS, dailyLimit: limit }),
})
const todayKey = beijingParts(idleTs).dateKey
eq(limitDecision(4, 5, todayKey).action, 'compact', '第 5 次之前应允许压缩')
eq(limitDecision(5, 5, todayKey).action, 'skip', '已达 5 次上限应跳过')
eq(limitDecision(5, 5, todayKey).reason, 'daily-limit', '超限原因应是 daily-limit')
eq(limitDecision(9, 5, todayKey).action, 'skip', '远超上限也应跳过')
eq(limitDecision(0, 0, todayKey).action, 'skip', 'dailyLimit=0 应永远跳过')
line('count=4 / 5 / 9（limit=5）', [
  limitDecision(4, 5, todayKey).action,
  limitDecision(5, 5, todayKey).action,
  limitDecision(9, 5, todayKey).action,
].join(' / '))

// ---------------------------------------------------------------------------
section('跨天重置（按北京时间 0 点）')
const day1 = bj(monday.year, monday.month, monday.day, 23, 59)
const day2 = bj(monday.year, monday.month, monday.day + 1, 0, 0)
const day1Key = beijingParts(day1).dateKey
const day2Key = beijingParts(day2).dateKey
eq(day1Key === day2Key, false, '23:59 与次日 00:00 应属于不同日期')
eq(resolveDailyCount({ date: day1Key, count: 5 }, day1).count, 5, '同一天保留原计数')
eq(resolveDailyCount({ date: day1Key, count: 5 }, day2).count, 0, '跨到次日（北京时间 0 点）应清零')
eq(resolveDailyCount({ date: '2000-01-01', count: 5 }, day2).count, 0, '很旧的状态应清零')
eq(resolveDailyCount(null, day2).count, 0, '没有状态时计数为 0')
eq(resolveDailyCount({ date: day2Key, count: -3 }, day2).count, 0, '负数计数应归零')
eq(bumpDaily({ date: day1Key, count: 4 }, day1).count, 5, '同一天记一次 +1')
eq(bumpDaily({ date: day1Key, count: 4 }, day1).date, day1Key, '同一天记一次日期不变')
eq(bumpDaily({ date: day1Key, count: 4 }, day2).count, 1, '跨天记一次应从 1 开始')
eq(bumpDaily({ date: day1Key, count: 4 }, day2).date, day2Key, '跨天记一次日期应更新')

// 关键：UTC 16:00 = 北京次日 00:00，重置必须按北京时间发生，不能等到 UTC 0 点。
const beijingMidnightInUtc = Date.UTC(monday.year, monday.month - 1, monday.day, 16, 0, 0, 0)
eq(beijingParts(beijingMidnightInUtc).dateKey, day2Key, 'UTC 16:00 应等于北京时间次日 00:00')
eq(resolveDailyCount({ date: day1Key, count: 5 }, beijingMidnightInUtc).count, 0,
  '北京时间 0 点（UTC 16:00）应立即重置')
const beforeBeijingMidnight = Date.UTC(monday.year, monday.month - 1, monday.day, 15, 59, 0, 0)
eq(resolveDailyCount({ date: day1Key, count: 5 }, beforeBeijingMidnight).count, 5,
  '北京时间 23:59（UTC 15:59）仍算当天，不重置')
line('UTC 15:59 / 16:00 的计数', [
  resolveDailyCount({ date: day1Key, count: 5 }, beforeBeijingMidnight).count,
  resolveDailyCount({ date: day1Key, count: 5 }, beijingMidnightInUtc).count,
].join(' → '))

// 跨天重置后配额恢复
eq(decide({
  nowMs: day2,
  sessionId: 'sess-plain',
  measuredTokens: 400000,
  dailyState: { date: day1Key, count: 5 },
  config: baseConfig,
}).action, 'compact', '跨天重置后即使昨天已满也应允许压缩')

// ---------------------------------------------------------------------------
section('idleOnly 开关')
const peakTs = bj(monday.year, monday.month, monday.day, 10, 0)
eq(decide({
  nowMs: peakTs,
  sessionId: 'sess-plain',
  measuredTokens: 400000,
  dailyState: null,
  config: normalizeConfig({ ...DEFAULTS, idleOnly: true }),
}).reason, 'peak-hours', 'idleOnly=true 时高峰应跳过')
eq(decide({
  nowMs: peakTs,
  sessionId: 'sess-plain',
  measuredTokens: 400000,
  dailyState: null,
  config: normalizeConfig({ ...DEFAULTS, idleOnly: false }),
}).action, 'compact', 'idleOnly=false 时高峰也压')

// ---------------------------------------------------------------------------
section('停用与异常输入')
eq(decide({
  nowMs: idleTs,
  sessionId: 'sess-plain',
  measuredTokens: 900000,
  dailyState: null,
  config: normalizeConfig({ ...DEFAULTS, enabled: false }),
}).reason, 'disabled', 'enabled=false 应直接跳过')
eq(decide({
  nowMs: idleTs,
  sessionId: 'sess-plain',
  measuredTokens: Number.NaN,
  dailyState: null,
  config: baseConfig,
}).reason, 'invalid-measurement', 'NaN token 应判为不可用')
eq(decide({
  nowMs: idleTs,
  sessionId: 'sess-plain',
  measuredTokens: 900000,
  dailyState: null,
  config: undefined,
}).action, 'compact', 'config 缺失时用默认值继续工作')
eq(decide({
  nowMs: idleTs,
  sessionId: 'sess-plain',
  measuredTokens: undefined,
  dailyState: null,
  config: baseConfig,
}).reason, 'invalid-measurement', 'undefined token 应判为不可用')

section('配置规整（默认值必须保守）')
const normalized = normalizeConfig(undefined)
eq(normalized.thresholdTokens, 350000, '默认 thresholdTokens=350000')
eq(normalized.idleOnly, true, '默认 idleOnly=true')
eq(normalized.dailyLimit, 5, '默认 dailyLimit=5')
eq(normalized.confirmBefore, true, '默认 confirmBefore=true')
eq(normalized.enabled, true, '默认 enabled=true')
eq(normalizeConfig({ thresholdTokens: '大', dailyLimit: -1 }).thresholdTokens, 350000, '非法 thresholdTokens 退回默认')
eq(normalizeConfig({ dailyLimit: -1 }).dailyLimit, 5, '非法 dailyLimit 退回默认')
eq(normalizeConfig({ idleOnly: 'yes' }).idleOnly, true, '非 false 的 idleOnly 视为 true')
eq(normalizeConfig({ confirmBefore: 0 }).confirmBefore, true, '只有 false 才关闭 confirmBefore')
eq(normalizeConfig(null).thresholdTokens, 350000, 'null 配置退回默认')
eq(normalizeConfig([]).thresholdTokens, 350000, '数组配置退回默认')

// ---------------------------------------------------------------------------
section('两条压缩线来自同一份配置')
eq(stateDirPath(), path.join(tempHome, 'dsh-context-kit'), '状态目录由 DSH_HOME 派生')
eq(DEFAULTS.thresholdTokens, 350000, '配置里提前压线是 350000')
eq(DEFAULTS.thresholdRatio, 0.43, '配置里自动线比例是 0.43')
eq(DEFAULTS.contextWindowFallback, 1048576, '配置里窗口兜底是 1048576')
eq(Math.floor(DEFAULTS.contextWindowFallback * DEFAULTS.thresholdRatio), 450887,
  '自动压缩线由同一份配置算出 450,887')
eq(normalizeConfig(DEFAULTS).thresholdTokens, DEFAULTS.thresholdTokens,
  'guard 规整后的提前压线与显示同源')

const beforePublish = getEffectiveConfig()
eq(beforePublish.source, 'defaults', '没有 Host 行时使用默认配置')
eq(beforePublish.config.thresholdTokens, 350000, '默认配置的提前压线')

const published = publishEffectiveConfig({
  thresholdTokens: 360000,
  thresholdRatio: 0.5,
  dailyLimit: 4,
})
eq(published.thresholdTokens, 360000, 'Host 行发布后提前压线改为 360000')
eq(published.dailyLimit, 4, 'Host 行发布后每日上限改为 4')
eq(getEffectiveConfig().source, 'host', '同进程读回的是 Host 发布的配置')
eq(getEffectiveConfig().config.thresholdTokens, 360000, '同进程读回 360000')

resetEffectiveConfigForTest()
const fromDisk = getEffectiveConfig()
eq(fromDisk.source, 'disk', '另一个加载器从 effective.json 读回')
eq(fromDisk.config.thresholdTokens, 360000, '磁盘生效配置与 Host 行一致')
eq(fromDisk.config.thresholdRatio, 0.5, '磁盘生效配置也带着显示比例')
line('发布/读回', `host=${published.thresholdTokens}，disk=${fromDisk.config.thresholdTokens}`)

// ---------------------------------------------------------------------------
section('客户端两线显示（加载真实 client.js）')
let registeredId
let factory
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registeredId = entry.id
      factory = entry.factory
    },
  },
}
// createPortal 的目标；组件本体只用到 document.body（事件监听在 useEffect 里，被桩掉了）。
globalThis.document = { body: {} }
const clientSource = fs.readFileSync(path.join(here, 'client.js'), 'utf8')
new Function(clientSource)()

const openFlag = { value: false }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [openFlag.value === true ? true : initial, () => {}],
  useRef: () => ({ current: null }),
  useId: () => ':r1:',
  useEffect: () => {},
}
const reactDomStub = { createPortal: (node) => node }
const mod = factory((name) => {
  if (name === 'react') return reactStub
  if (name === 'react-dom') return reactDomStub
  throw new Error(`unexpected require: ${name}`)
})
const {
  ContextMeter, compact, grouped, wan, cacheHitText, dialogRows,
  lastRequestUsage, nearerLine, lineSummary, resolveDisplayConfig, DICTS, CSS_TEXT,
} = mod.__test

eq(registeredId, 'dsh-context-kit', '客户端模块 id 与包名一致')
ok(Object.keys(mod).includes('apply'), '客户端模块导出 apply')

const requestedKeys = new Set()
const render = (pressure, extra) => ContextMeter({
  useProjection: (key) => {
    requestedKeys.add(key)
    return key === 'contextPressure' ? pressure : undefined;
  },
  useChat: undefined,
  t: (key) => key,
  getLocale: () => 'zh',
  thresholdRatio: 0.43,
  contextWindowFallback: 1048576,
  thresholdTokens: 350000,
  ...extra,
})

const base = { contextWindow: 1048576 }
const neutral = render({ ...base, pressureTokens: 133000 })
const button = neutral.children[1].children[0]
eq(button.children[1], '上下文 13.3 万 · 13%', '底栏主读数形式保持不变')
eq(button.props['data-tone'], 'neutral', '未到自动线的 70% 是中性色')
eq(neutral.children[2], null, '弹窗默认关闭')

const warnButton = render({ ...base, pressureTokens: 340000 }).children[1].children[0]
eq(warnButton.children[1], '上下文 34 万 · 32% · 接近压缩线', '接近自动线的文案不变')
eq(warnButton.props['data-tone'], 'warn', '接近自动线转琥珀色')

const dangerButton = render({ ...base, pressureTokens: 430000 }).children[1].children[0]
eq(dangerButton.children[1], '上下文 43 万 · 41% · 建议 /compact', '超过自动线的文案不变')
eq(dangerButton.props['data-tone'], 'danger', '超过自动线转红色')

const unknown = render(undefined)
eq(unknown.children[1].children[0].children[0], '上下文 —', '没有样本时显示占位读数')
eq(unknown.children[1].props['data-composer-stat'], 'context-kit', '控件标记为 context-kit')
eq([...requestedKeys].sort(), ['contextPressure', 'tokenUsage'], '仍读两个 token-meter 投影')

// 打开弹窗：两条线必须同时出现，并标出更近的一条。
openFlag.value = true
const opened = render({ ...base, pressureTokens: 133000 })
const dialog = opened.children[2]
ok(dialog !== null, '点开后存在弹窗')
const summaryNode = dialog.children[1]
eq(summaryNode.props.className, 'ctxmLines', '弹窗顶部是两线摘要')
eq(summaryNode.children.map((child) => child.children[0] ?? child.children.join('')), [
  '压缩线', '自动 450,887', '提前 350,000', '更近：提前压缩线',
], '弹窗同时显示两条线并标出更近的一条')
line('两线摘要', summaryNode.children.map((child) => child.children.join('')).join(' / '))

const rows = dialogRows({
  dict: DICTS.zh,
  used: 133000,
  contextWindow: 1048576,
  line: 450887,
  ratio: 0.43,
  earlyLine: 350000,
  nearer: 'early',
  tokenUsage: {
    uncachedInputTokens: 1000, cacheReadTokens: 996000, cacheWriteTokens: 0, outputTokens: 3000,
  },
  requestUsage: { inputTokens: 4210, cacheReadTokens: 128000, outputTokens: 512 },
})
eq(rows, [
  ['当前上下文', '133,000 tok'],
  ['占模型窗口', '12.7% · 1,048,576 tok'],
  ['自动压缩线', '450,887 tok · 占窗口 43%'],
  ['提前压缩线', '350,000 tok · 占窗口 33% · 更近'],
  ['已到压缩线', '29%'],
  ['已到提前线', '38%'],
  ['距压缩线还剩', '317,887 tok'],
  ['距提前线还剩', '217,000 tok'],
  ['最近一次请求 · 输入', '4,210 tok'],
  ['最近一次请求 · 缓存读取', '128,000 tok'],
  ['最近一次请求 · 输出', '512 tok'],
  ['会话累计', '1,000,000 tok'],
  ['缓存命中', '99.9%'],
], '明细行同时列出两条线与各自余量')

eq(nearerLine(133000, 450887, 350000), 'early', '13.3 万时更近的是提前线')
eq(nearerLine(400000, 450887, 350000), 'auto', '越过提前线后更近的是自动线')
eq(nearerLine(460000, 450887, 350000), 'none', '两条都越过时没有更近的一条')
eq(nearerLine(133000, 450887, undefined), undefined, '没有提前线配置时不判断')
eq(lineSummary({
  dict: DICTS.zh, autoLine: 450887, earlyLine: 350000, nearer: 'auto',
}).nearText, '更近：自动压缩线', '越过提前线后摘要改指自动线')
eq(lineSummary({
  dict: DICTS.zh, autoLine: 450887, earlyLine: undefined, nearer: undefined,
}), undefined, '没有提前线时不显示两线摘要')

const midRows = dialogRows({
  dict: DICTS.zh, used: 400000, contextWindow: 1048576, line: 450887, ratio: 0.43,
  earlyLine: 350000, nearer: 'auto', tokenUsage: undefined, requestUsage: undefined,
})
eq(midRows[2], ['自动压缩线', '450,887 tok · 占窗口 43% · 更近'], '越过提前线后更近标记移到自动线')
eq(midRows[3], ['提前压缩线', '350,000 tok · 占窗口 33%'], '提前线不再带更近标记')
eq(midRows[7], ['已超出提前线', '50,000 tok'], '越过提前线后如实显示已超出')

const pastRows = dialogRows({
  dict: DICTS.zh, used: 460000, contextWindow: 1048576, line: 450887, ratio: 0.43,
  earlyLine: 350000, nearer: 'none', tokenUsage: undefined, requestUsage: undefined,
})
ok(pastRows.every(([, value]) => !value.includes('更近')), '两条都越过时没有更近标记')
eq(pastRows[4], ['已到压缩线', '102%'], '越过自动线后“已到压缩线”如实给出 102%')
eq(pastRows[6], ['已超出压缩线', '9,113 tok'], '越过自动线后显示已超出')

// 没有配置就不显示提前线，也不凭空造一个 350000。
const noEarly = render({ ...base, pressureTokens: 133000 }, { thresholdTokens: undefined })
const noEarlyDialog = noEarly.children[2]
eq(noEarlyDialog.children[1], null, '没有提前线配置时不显示两线摘要')
eq(dialogRows({
  dict: DICTS.zh, used: 133000, contextWindow: 1048576, line: 450887, ratio: 0.43,
  earlyLine: undefined, nearer: undefined, tokenUsage: undefined, requestUsage: undefined,
}).length, 5, '没有提前线配置时明细行仍是原来的 5 行')

// 最近一次请求与缓存命中率的老行为不变。
eq(lastRequestUsage([
  { kind: 'assistant', usage: { inputTokens: 10, outputTokens: 1 } },
  { kind: 'tool-result' },
  { kind: 'assistant', usage: { inputTokens: 4210, cacheReadTokens: 128000, outputTokens: 512 } },
]).inputTokens, 4210, '最近一次请求取最新 assistant 样本')
eq(lastRequestUsage([{ kind: 'assistant' }]), undefined, '没有 usage 的节点被跳过')
eq(cacheHitText(996, 1000), '99.6%', '缓存命中率不会被四舍五入成 100%')
eq(compact(133000, true), '13.3 万', '中文读数用万')
eq(wan(450887), '45.1 万', '万单位保留一位小数')
eq(grouped(133000), '133,000', '千分位格式')

eq(warnButton.props.title,
  '上下文占用 32.4%（已用 340,000 tokens / 上下文窗口 1,048,576 tokens）\n'
  + '自动压缩线 45.1 万（450,887 tokens），当前已到压缩线的 75%\n'
  + '提前压缩线 35 万（350,000 tokens），当前已到提前线的 97%',
  'tooltip 同时给出两条线')

ok(CSS_TEXT.includes('font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px)'),
  '排版沿用宿主共享字号 token')
ok(CSS_TEXT.includes('.ctxmPill{') && CSS_TEXT.includes('font:inherit'),
  '底栏按钮继承宿主字体')
ok(CSS_TEXT.includes('.ctxmLines{'), '两线摘要有自己的样式')
ok(CSS_TEXT.includes('.ctxmPill[data-tone="warn"]'), '三档配色样式仍在')

// 页面注入通道：Host 行把同一份生效配置写进 index.html 的 global。
globalThis.window.__DSH_CONTEXT_KIT__ = {
  thresholdTokens: 360000,
  thresholdRatio: 0.5,
  contextWindowFallback: 1000000,
}
eq(resolveDisplayConfig({}).thresholdTokens, 360000, '页面注入的提前压线被采用')
eq(resolveDisplayConfig({}).thresholdRatio, 0.5, '页面注入的比例被采用')
eq(resolveDisplayConfig({}).contextWindowFallback, 1000000, '页面注入的窗口兜底被采用')
eq(resolveDisplayConfig({ thresholdRatio: 0.43 }).thresholdRatio, 0.43, '行 config 优先于页面注入')
eq(resolveDisplayConfig({ thresholdTokens: 340000 }).thresholdTokens, 340000, '行 config 的提前线优先')
delete globalThis.window.__DSH_CONTEXT_KIT__
eq(resolveDisplayConfig({}).thresholdTokens, undefined, '没有页面注入时不编提前线数字')
eq(resolveDisplayConfig({}).thresholdRatio, 0.43, '没有注入时比例退回内置兜底')

// ---------------------------------------------------------------------------
// 压缩前交接检查（handoffHint）：只核「记忆库上次写入」，另外两件只能提醒。

line('handoffHint 新鲜 / 过期 / 读不到', [])
const HINT_NOW = 1_780_000_000_000
eq(DEFAULTS.handoffFreshMinutes, 30, '交接记忆默认新鲜窗口是 30 分钟')

const hFresh = handoffHint({ nowMs: HINT_NOW, newestWriteMs: HINT_NOW - 5 * 60_000 })
eq(hFresh.known, true, '有写入时间就算已知')
eq(hFresh.fresh, true, '5 分钟前写过算新鲜')
eq(hFresh.ageMinutes, 5, '新鲜时分钟数正确')
ok(hFresh.text.includes('5 分钟前'), '新鲜文案带具体分钟数')

const hStale = handoffHint({ nowMs: HINT_NOW, newestWriteMs: HINT_NOW - 90 * 60_000 })
eq(hStale.fresh, false, '90 分钟前写过算过期')
eq(hStale.ageMinutes, 90, '过期时分钟数正确')
ok(hStale.text.includes('超过 30 分钟'), '过期文案提示先写一条')

const hJustNow = handoffHint({ nowMs: HINT_NOW, newestWriteMs: HINT_NOW - 20_000 })
eq(hJustNow.ageMinutes, 0, '半分钟内算 0 分钟')
ok(hJustNow.text.includes('刚刚'), '不到一分钟的文案是「刚刚」')

const hUnknown = handoffHint({ nowMs: HINT_NOW, newestWriteMs: null })
eq(hUnknown.known, false, '读不到记忆库时 known=false')
eq(hUnknown.fresh, false, '读不到时不算新鲜')
eq(hUnknown.ageMinutes, null, '读不到时没有分钟数')
ok(hUnknown.text.includes('读不到'), '读不到时文案说实话，不假装新鲜')
eq(handoffHint({ nowMs: HINT_NOW, newestWriteMs: undefined }).known, false, 'undefined 与 null 同样处理')

const hWide = handoffHint({ nowMs: HINT_NOW, newestWriteMs: HINT_NOW - 90 * 60_000, freshWindowMinutes: 120 })
eq(hWide.fresh, true, '窗口放大到 120 分钟后 90 分钟仍算新鲜')
eq(hWide.freshWindowMinutes, 120, '自定义窗口被采用')
eq(handoffHint({ nowMs: HINT_NOW, newestWriteMs: HINT_NOW - 60_000, freshWindowMinutes: -5 }).freshWindowMinutes, 30,
  '非法窗口退回默认 30 分钟')
const hFuture = handoffHint({ nowMs: HINT_NOW, newestWriteMs: HINT_NOW + 60_000 })
eq(hFuture.ageMinutes, 0, '时钟偏差导致「未来写入」也不出现负数')
eq(hFuture.fresh, true, '未来时间算作新鲜而不是过期')

// 配置口径：新字段要能被 normalizeConfig / normalizeEffective 读到。
eq(normalizeConfig(DEFAULTS).handoffFreshMinutes, 30, 'normalizeConfig 带出交接窗口')
eq(normalizeConfig({ handoffFreshMinutes: 5 }).handoffFreshMinutes, 5, '交接窗口可配置')
eq(normalizeConfig({ handoffFreshMinutes: 'x' }).handoffFreshMinutes, 30, '非法交接窗口退回默认')
eq(normalizeEffective(undefined).compactNotice, true, '压缩提醒默认开启')
eq(normalizeEffective({ compactNotice: false }).compactNotice, false, '压缩提醒可以关掉')
eq(normalizeEffective({ compactNotice: 0 }).compactNotice, true, '只有 false 才关闭压缩提醒')

// 压缩提醒的计数存储（落盘，重启不清零）
const noticeDir = path.join(tempHome, 'notice-test')
ok(noticeFilePath(noticeDir).endsWith('notice-count.json'), '计数文件名固定')
eq(loadStore(noticeDir).sessions, {}, '没有文件时读出空库')

const NOTICE_NOW = 1704067200000 // 固定的测试时间戳（2024-01-01 00:00:00 UTC），仅用于时间运算
const NOTICE_SID = 'session-aaa'
const storeA = loadStore(noticeDir)
const noticeFirst = bumpNotice(storeA, NOTICE_SID, NOTICE_NOW)
eq(noticeFirst.count, 1, '第一次压缩记 1 次')
eq(noticeFirst.firstAt, NOTICE_NOW, '起点等于第一次的时间')
eq(bumpNotice(storeA, '', NOTICE_NOW), undefined, '空会话 id 不计数')

const noticeSecond = bumpNotice(storeA, NOTICE_SID, NOTICE_NOW + 3_600_000)
eq(noticeSecond.count, 2, '同一会话再压一次累加')
eq(noticeSecond.firstAt, NOTICE_NOW, '起点不变')
eq(noticeSecond.lastAt, NOTICE_NOW + 3_600_000, '最近一次时间更新')

saveStore(noticeDir, storeA)
const noticeReloaded = loadStore(noticeDir)
eq(noticeReloaded.sessions[NOTICE_SID],
  { count: 2, firstAt: NOTICE_NOW, lastAt: NOTICE_NOW + 3_600_000 }, '落盘后原样读回')
const noticeThird = bumpNotice(noticeReloaded, NOTICE_SID, NOTICE_NOW + 7_200_000)
eq(noticeThird.count, 3, '模拟重启后接着数，不从 1 重来')
eq(noticeThird.firstAt, NOTICE_NOW, '重启后起点仍是最早那次')

eq(normalizeStore(null).sessions, {}, '整份是 null 时当空库')
eq(normalizeStore({ sessions: [] }).sessions, {}, 'sessions 不是对象时当空库')
eq(normalizeStore({ sessions: { a: { count: 0 } } }).sessions, {}, 'count 非正数的记录丢掉')
eq(normalizeStore({ sessions: { a: { count: 2, lastAt: 5 } } }).sessions.a,
  { count: 2, firstAt: 5, lastAt: 5 }, '缺 firstAt 时用 lastAt 兜底')

const pruneTarget = {
  sessions: {
    old: { count: 1, firstAt: 0, lastAt: NOTICE_NOW - 100 * 24 * 3_600_000 },
    fresh: { count: 1, firstAt: NOTICE_NOW, lastAt: NOTICE_NOW },
  },
}
eq(pruneStore(pruneTarget, NOTICE_NOW), 1, '超过 90 天的记录被清掉')
eq(Object.keys(pruneTarget.sessions), ['fresh'], '新鲜记录保留')

const noticeText = renderNotice({ count: 3, firstAt: NOTICE_NOW, lastAt: NOTICE_NOW + 7_200_000 })
ok(noticeText.includes('已记录 3 次压缩'), '文案写记录到的次数（不声称是全部历史）')
ok(noticeText.includes('自 2024-01-01 起'), '文案写统计起点')
ok(noticeText.includes('最近一次 2024-01-01 10:00'), '最近一次按北京时间渲染')
eq(renderNotice({ count: 3, firstAt: NOTICE_NOW, lastAt: NOTICE_NOW + 7_200_000 }), noticeText,
  '同输入逐字相同（不破坏前缀缓存）')
ok(noticeText.includes('不当结论'), '文案保留「回文件核对」的提醒')

// ---------------------------------------------------------------------------
console.log('')
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项（通过 ${passed} 项）：`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`全部通过：${passed} 项断言，0 失败。`)
}
