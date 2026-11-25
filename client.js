/**
 * 「上下文」dock 控件（客户端半侧）：一个读数 + 两条压缩线。
 *
 * 接入方式（全部来自文档记载的扩展点）：
 * - 槽位 `conversation.composer.dock`（dsh-client-ui-conversation 声明，kind=list，scope=session），
 *   新建 id `context-kit`，order 2，排在自带 `activity`(0) / `usage`(1) 之后。
 * - 该槽位的 standardProps 带 `useProjection` / `useChat`：
 *   · `contextPressure`（token-meter）→ 已用 token、上下文窗口
 *   · `tokenUsage`（token-meter）→ 会话累计与缓存命中
 *   · `useChat` 的 legacy.nodes → 最近一次请求的用量桶
 * - 百分比口径与输入框右侧圆环一致：已用 / 上下文窗口。压缩线只用于颜色阈值与弹窗。
 * - 两条线的数字都来自行 config（Host 行 context-kit 的 config，见 lib/config.js）：
 *   `thresholdRatio` 决定自动压缩线，`thresholdTokens` 决定提前压线。
 *   这里不写死任何一个阈值；拿不到提前压线时宁可不显示那一行，也不编一个数。
 * - 排版照宿主统计控件：外层 anchor（共享排版 token）+ 内层 button（同 padding / 同色 token），
 *   不写死字号、字重。
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-kit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'contextKit';

    /** react-dom 在共享模块表里；拿不到就退回内联渲染，不让 factory 抛错。 */
    let createPortal = null;
    try {
      createPortal = require('react-dom').createPortal;
    } catch {
      createPortal = null;
    }

    /** 压缩线比例；与 profile 里 compaction-basic 的 thresholdRatio 保持一致。 */
    const DEFAULT_THRESHOLD_RATIO = 0.43;
    /** 路由还没上报容量时的兜底窗口（deepseek-flash = 1 MiB token）。 */
    const DEFAULT_CONTEXT_WINDOW = 1048576;
    /** 已到压缩线的这个比例转琥珀色。 */
    const WARN_RATIO = 0.7;
    /** 已到压缩线的这个比例转红色。 */
    const DANGER_RATIO = 0.9;

    /**
     * 组件样式：全部使用宿主主题 token，与宿主统计控件同一套排版。
     * 圆角、底色、投影、字号都与统计弹窗保持一致（同 token、同值）。
     */
    const CSS_TEXT = [
      '.ctxmRoot{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.ctxmPill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}',
      '.ctxmPill svg{width:14px;height:14px;flex:none}',
      '@media (hover:hover){.ctxmPill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
      '.ctxmPill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.ctxmPill[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.ctxmPill[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
      '.ctxmPanel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;max-height:calc(100dvh - 12px - max(12px,var(--dsh-frame-overlay-top,12px)));overflow-x:hidden;overflow-y:auto;position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));bottom:max(12px,calc(anchor(top) + 8px));left:max(12px,anchor(left));right:12px;align-self:end;justify-self:start;height:fit-content;margin:0;position-try-fallbacks:--ctxm-window,--ctxm-opposite,--ctxm-viewport}',
      '.ctxmTitle{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.ctxmTitleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.ctxmTitleLabel svg{width:14px;height:14px;flex:none}',
      '.ctxmTitleValue{font-variant-numeric:tabular-nums}',
      '.ctxmLines{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin:0 0 10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.ctxmLinesKey{color:var(--dsw-alias-label-secondary)}',
      '.ctxmLinesNear{color:var(--dsw-alias-label-primary)}',
      '.ctxmRule{margin-bottom:10px;border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.ctxmDetails{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}',
      '.ctxmDetails dt,.ctxmDetails dd{min-width:0;margin:0}',
      '.ctxmDetails dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
      '@position-try --ctxm-window{position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));bottom:max(12px,calc(anchor(top) + 8px));left:12px;right:12px;margin:0;align-self:safe end;justify-self:safe end}',
      '@position-try --ctxm-opposite{top:max(12px,calc(anchor(bottom) + 8px));bottom:12px;align-self:start}',
      '@position-try --ctxm-viewport{position-area:none;inset:max(12px,var(--dsh-frame-overlay-top,12px)) 12px 12px;margin:0;align-self:safe start;justify-self:safe end}',
    ].join('');

    /**
     * 词典：`zh` / `en` 两套基线语言，其余语言沿 en 回退。
     * 文案里的 {name} 由 locale 服务的模板替换处理。
     */
    const DICTS = {
      zh: {
        reading: '上下文 {used} · {percent}%',
        readingNear: '上下文 {used} · {percent}% · 接近压缩线',
        readingOver: '上下文 {used} · {percent}% · 建议 /compact',
        unknown: '上下文 —',
        unknownTip: '尚未收到用量样本，暂时没有上下文占用数据。',
        tooltip: [
          '上下文占用 {percentExact}%（已用 {usedExact} tokens / 上下文窗口 {windowExact} tokens）',
          '自动压缩线 {line}（{lineExact} tokens），当前已到压缩线的 {linePercent}%',
        ].join('\n'),
        tooltipWithEarly: [
          '上下文占用 {percentExact}%（已用 {usedExact} tokens / 上下文窗口 {windowExact} tokens）',
          '自动压缩线 {line}（{lineExact} tokens），当前已到压缩线的 {linePercent}%',
          '提前压缩线 {earlyLine}（{earlyLineExact} tokens），当前已到提前线的 {earlyPercent}%',
        ].join('\n'),
        dialogTitle: '上下文用量',
        linesLabel: '压缩线',
        lineAuto: '自动 {tokens}',
        lineEarly: '提前 {tokens}',
        nearest: '更近：{line}',
        nearestAuto: '自动压缩线',
        nearestEarly: '提前压缩线',
        linesCrossed: '两条线都已超过',
        rowContext: '当前上下文',
        rowWindow: '占模型窗口',
        rowLine: '自动压缩线',
        rowEarlyLine: '提前压缩线',
        rowReached: '已到压缩线',
        rowEarlyReached: '已到提前线',
        rowRemaining: '距压缩线还剩',
        rowOver: '已超出压缩线',
        rowEarlyRemaining: '距提前线还剩',
        rowEarlyOver: '已超出提前线',
        nearMark: ' · 更近',
        rowInput: '最近一次请求 · 输入',
        rowCacheRead: '最近一次请求 · 缓存读取',
        rowOutput: '最近一次请求 · 输出',
        rowSession: '会话累计',
        rowCacheHit: '缓存命中',
        windowHint: '{tokens} tok',
        lineHint: '占窗口 {ratio}',
        inputHint: '未缓存',
      },
      en: {
        reading: 'Context {used} · {percent}%',
        readingNear: 'Context {used} · {percent}% · near compaction line',
        readingOver: 'Context {used} · {percent}% · run /compact',
        unknown: 'Context —',
        unknownTip: 'No usage sample yet, so there is no context occupancy to show.',
        tooltip: [
          'Context occupancy {percentExact}% ({usedExact} of {windowExact} tokens)',
          'Automatic compaction line {line} ({lineExact} tokens); {linePercent}% of it used',
        ].join('\n'),
        tooltipWithEarly: [
          'Context occupancy {percentExact}% ({usedExact} of {windowExact} tokens)',
          'Automatic compaction line {line} ({lineExact} tokens); {linePercent}% of it used',
          'Early compaction line {earlyLine} ({earlyLineExact} tokens); {earlyPercent}% of it used',
        ].join('\n'),
        dialogTitle: 'Context usage',
        linesLabel: 'Compaction lines',
        lineAuto: 'auto {tokens}',
        lineEarly: 'early {tokens}',
        nearest: 'nearer: {line}',
        nearestAuto: 'automatic line',
        nearestEarly: 'early line',
        linesCrossed: 'both lines passed',
        rowContext: 'Current context',
        rowWindow: 'Of model window',
        rowLine: 'Compaction line',
        rowEarlyLine: 'Early line',
        rowReached: 'Line reached',
        rowEarlyReached: 'Early line reached',
        rowRemaining: 'Room before line',
        rowOver: 'Past the line',
        rowEarlyRemaining: 'Room before early line',
        rowEarlyOver: 'Past the early line',
        nearMark: ' · nearer',
        rowInput: 'Last request · input',
        rowCacheRead: 'Last request · cache read',
        rowOutput: 'Last request · output',
        rowSession: 'Session total',
        rowCacheHit: 'Cache hit',
        windowHint: '{tokens} tok',
        lineHint: '{ratio} of window',
        inputHint: 'uncached',
      },
    };

    /**
     * 千分位整数。
     * @param {number} value - 非负整数。
     * @returns {string} 形如 450,887。
     */
    function grouped(value) {
      return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /**
     * 中文「万」单位：保留一位小数，一万以下用千分位。
     * @param {number} value - token 数。
     * @returns {string} 形如 104.9 万。
     */
    function wan(value) {
      return String(Math.round(value / 1000) / 10) + ' 万';
    }

    /**
     * 英文 K / M 单位。
     * @param {number} value - token 数。
     * @returns {string} 形如 116K。
     */
    function metric(value) {
      if (value < 1000) return String(Math.round(value));
      if (value < 1000000) return String(Math.round(value / 100) / 10) + 'K';
      return String(Math.round(value / 10000) / 100) + 'M';
    }

    /**
     * 紧凑显示：中文走「万」，其他语言走 K/M。
     * @param {number} value - token 数。
     * @param {boolean} isZh - 当前界面语言是否为中文。
     * @returns {string} 显示文本。
     */
    function compact(value, isZh) {
      if (!isZh) return metric(value);
      if (value < 10000) return grouped(value);
      return wan(value);
    }

    /**
     * 模板填充，供翻译缺失时兜底使用。
     * @param {string} template - 带 {name} 占位符的模板。
     * @param {object} params - 占位符取值。
     * @returns {string} 填充后的文本。
     */
    function fill(template, params) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (
        params[key] === undefined ? match : String(params[key])
      ));
    }

    /**
     * 取翻译：locale 服务没解析出该 key 时用兜底模板，避免把 key 名显示给用户。
     * @param {Function} t - 槽位注入的翻译函数。
     * @param {string} key - 词典 key。
     * @param {object} params - 占位符取值。
     * @param {object} dict - 当前语言的兜底词典。
     * @returns {string} 文本。
     */
    function tr(t, key, params, dict) {
      let text;
      try {
        text = t(key, params);
      } catch {
        text = undefined;
      }
      if (typeof text !== 'string' || text === key) return fill(dict[key], params);
      return text;
    }

    /**
     * 读一个客户端投影；异常时退化为 undefined，不让槽位崩掉。
     * @param {Function} useProjection - 槽位注入的投影钩子。
     * @param {string} key - 投影 key。
     * @returns {object|undefined} 投影值。
     */
    function useSafeProjection(useProjection, key) {
      try {
        return useProjection(key);
      } catch {
        return undefined;
      }
    }

    /**
     * 订阅 Chat 快照的节点列表（宿主统计控件读的是同一份 legacy.nodes）。
     * @param {Function|undefined} useChat - 槽位注入的 Chat 选择器钩子。
     * @returns {readonly object[]|undefined} 节点数组。
     */
    function useChatNodes(useChat) {
      if (typeof useChat !== 'function') return undefined;
      try {
        return useChat((snapshot) => snapshot.legacy.nodes);
      } catch {
        return undefined;
      }
    }

    /**
     * 从 Chat 节点里找最近一条带用量样本的 assistant 节点。
     * @param {readonly object[]|undefined} nodes - Chat 节点列表。
     * @returns {object|undefined} 该节点的原始 usage 对象。
     */
    function lastRequestUsage(nodes) {
      if (!Array.isArray(nodes)) return undefined;
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (node === null || typeof node !== 'object' || node.kind !== 'assistant') continue;
        const usage = node.usage;
        if (usage === null || typeof usage !== 'object') continue;
        if (typeof usage.inputTokens !== 'number' && typeof usage.outputTokens !== 'number') continue;
        return usage;
      }
      return undefined;
    }

    /**
     * 缓存命中率文本：整数四舍五入会到 100 时保留一位小数，避免把 99.6% 写成 100%。
     * @param {number} cacheReadTokens - 命中缓存的输入 token。
     * @param {number} promptTokens - 全部计费输入 token。
     * @returns {string|null} 百分比文本。
     */
    function cacheHitText(cacheReadTokens, promptTokens) {
      if (!(promptTokens > 0)) return null;
      const percent = (cacheReadTokens / promptTokens) * 100;
      const rounded = Math.round(percent);
      return (rounded < 100 ? String(rounded) : String(Math.round(percent * 10) / 10)) + '%';
    }

    /**
     * 哪条线离当前上下文更近：按“下一条会被碰到的线”算，而不是绝对距离。
     * 已越过提前线但还没到自动线时，更近的是自动线；两条都越过则没有更近的一条。
     * @param {number} used - 已用 token。
     * @param {number} autoLine - 自动压缩线。
     * @param {number|undefined} earlyLine - 提前压线；没有就不判断。
     * @returns {'early'|'auto'|'none'|undefined} 更近的那条。
     */
    function nearerLine(used, autoLine, earlyLine) {
      if (typeof earlyLine !== 'number' || !Number.isFinite(earlyLine)) return undefined;
      const autoRemaining = autoLine - used;
      const earlyRemaining = earlyLine - used;
      if (earlyRemaining >= 0 && autoRemaining >= 0) return earlyRemaining <= autoRemaining ? 'early' : 'auto';
      if (earlyRemaining < 0 && autoRemaining >= 0) return 'auto';
      return 'none';
    }

    /**
     * 弹窗顶部的两线摘要：两条线的精确数字 + 更近的是哪条。
     * @param {object} input - 词典、两条线与更近判断。
     * @returns {{lineText: string, earlyText: string, nearText: string}|undefined} 摘要；没有提前线时返回 undefined。
     */
    function lineSummary(input) {
      const { dict, autoLine, earlyLine, nearer } = input;
      if (typeof earlyLine !== 'number' || !Number.isFinite(earlyLine)) return undefined;
      const nearText = nearer === 'early'
        ? fill(dict.nearest, { line: dict.nearestEarly })
        : nearer === 'auto'
          ? fill(dict.nearest, { line: dict.nearestAuto })
          : dict.linesCrossed;
      return {
        lineText: fill(dict.lineAuto, { tokens: grouped(autoLine) }),
        earlyText: fill(dict.lineEarly, { tokens: grouped(earlyLine) }),
        nearText,
      };
    }

    /**
     * 组装弹窗明细行；缺数据的项直接不进列表。
     * @param {object} input - 已解析的读数与词典。
     * @returns {Array<[string, string]>} 标签/数值对。
     */
    function dialogRows(input) {
      const { dict, used, contextWindow, line, ratio, earlyLine, nearer, tokenUsage, requestUsage } = input;
      const rows = [];
      const push = (label, value) => {
        if (value !== undefined && value !== null && value !== '') rows.push([label, value]);
      };
      const hasEarly = typeof earlyLine === 'number' && Number.isFinite(earlyLine) && earlyLine > 0;

      push(dict.rowContext, grouped(used) + ' tok');
      push(dict.rowWindow, (Math.round((used / contextWindow) * 1000) / 10) + '%'
        + ' · ' + fill(dict.windowHint, { tokens: grouped(contextWindow) }));
      push(dict.rowLine, grouped(line) + ' tok · ' + fill(dict.lineHint, { ratio: Math.round(ratio * 100) + '%' })
        + (nearer === 'auto' ? dict.nearMark : ''));
      if (hasEarly) {
        push(dict.rowEarlyLine, grouped(earlyLine) + ' tok · '
          + fill(dict.lineHint, { ratio: Math.round((earlyLine / contextWindow) * 100) + '%' })
          + (nearer === 'early' ? dict.nearMark : ''));
      }
      push(dict.rowReached, Math.round((used / line) * 100) + '%');
      if (hasEarly) push(dict.rowEarlyReached, Math.round((used / earlyLine) * 100) + '%');
      const remaining = line - used;
      push(remaining >= 0 ? dict.rowRemaining : dict.rowOver, grouped(Math.abs(remaining)) + ' tok');
      if (hasEarly) {
        const earlyRemaining = earlyLine - used;
        push(earlyRemaining >= 0 ? dict.rowEarlyRemaining : dict.rowEarlyOver,
          grouped(Math.abs(earlyRemaining)) + ' tok');
      }

      if (requestUsage !== undefined) {
        if (typeof requestUsage.inputTokens === 'number') {
          push(dict.rowInput, grouped(requestUsage.inputTokens) + ' tok');
        }
        if (typeof requestUsage.cacheReadTokens === 'number') {
          push(dict.rowCacheRead, grouped(requestUsage.cacheReadTokens) + ' tok');
        }
        if (typeof requestUsage.outputTokens === 'number') {
          push(dict.rowOutput, grouped(requestUsage.outputTokens) + ' tok');
        }
      }

      if (tokenUsage !== undefined && tokenUsage !== null) {
        const uncached = typeof tokenUsage.uncachedInputTokens === 'number' ? tokenUsage.uncachedInputTokens : 0;
        const cacheRead = typeof tokenUsage.cacheReadTokens === 'number' ? tokenUsage.cacheReadTokens : 0;
        const cacheWrite = typeof tokenUsage.cacheWriteTokens === 'number' ? tokenUsage.cacheWriteTokens : 0;
        const output = typeof tokenUsage.outputTokens === 'number' ? tokenUsage.outputTokens : 0;
        const prompt = uncached + cacheRead + cacheWrite;
        if (prompt + output > 0) push(dict.rowSession, grouped(prompt + output) + ' tok');
        push(dict.rowCacheHit, cacheHitText(cacheRead, prompt));
      }
      return rows;
    }

    /**
     * 页面级生效配置：Host 行通过 `webserver/index-inject` 注入的 global。
     * 浏览器半侧拿不到行 config，这是把“同一份真实配置”送进页面的通道。
     * @returns {object} 缺失或异常时返回空对象。
     */
    function pageConfig() {
      try {
        const value = window.__DSH_CONTEXT_KIT__;
        return value !== null && typeof value === 'object' ? value : {};
      } catch {
        return {};
      }
    }

    /**
     * 解析显示用的三个数字。优先级：行 config > 页面注入 > 内置兜底。
     * `thresholdTokens` 没有内置兜底：配置没给就不显示提前线，不编数字。
     * @param {object} cfg - 客户端 apply 收到的行 config（可能为空）。
     * @returns {{thresholdRatio: number, contextWindowFallback: number, thresholdTokens: number|undefined}}
     */
    function resolveDisplayConfig(cfg) {
      const page = pageConfig();
      const row = cfg !== null && typeof cfg === 'object' ? cfg : {};
      const pick = (value, fallback) => (
        typeof value === 'number' && Number.isFinite(value) ? value : fallback
      );
      return {
        thresholdRatio: pick(row.thresholdRatio, pick(page.thresholdRatio, DEFAULT_THRESHOLD_RATIO)),
        contextWindowFallback: pick(row.contextWindowFallback, pick(page.contextWindowFallback, DEFAULT_CONTEXT_WINDOW)),
        thresholdTokens: pick(row.thresholdTokens, pick(page.thresholdTokens, undefined)),
      };
    }

    /** 14px 圆环图标，颜色跟随 currentColor，与统计控件图标同尺寸。 */
    function ringIcon(percent) {
      const radius = 5.5;
      const circumference = 2 * Math.PI * radius;
      const filled = Math.max(0, Math.min(100, percent)) / 100 * circumference;
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
        h('circle', {
          cx: 8, cy: 8, r: radius, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.3, strokeWidth: 2,
        }),
        h('circle', {
          cx: 8, cy: 8, r: radius, fill: 'none', stroke: 'currentColor', strokeWidth: 2,
          strokeLinecap: 'round', strokeDasharray: `${filled} ${circumference}`,
          transform: 'rotate(-90 8 8)',
        }));
    }

    /**
     * 控件本体。props 由槽位（standardProps）与注册时的 inject 面合并而成。
     * @param {object} props - 槽位 props。
     * @returns {object|null} 渲染结果。
     */
    function ContextMeter(props) {
      const {
        useProjection, useChat, t, getLocale,
        thresholdRatio, contextWindowFallback, thresholdTokens,
      } = props;
      const isZh = String(typeof getLocale === 'function' ? getLocale() : 'zh').toLowerCase().startsWith('zh');
      const dict = isZh ? DICTS.zh : DICTS.en;

      // 钩子顺序固定：两个投影 + Chat 节点 + 本组件状态。
      const pressure = useSafeProjection(useProjection, 'contextPressure');
      const tokenUsage = useSafeProjection(useProjection, 'tokenUsage');
      const chatNodes = useChatNodes(useChat);
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const anchorName = '--ctxm-' + React.useId().replace(/[:]/g, '');

      // Esc 关闭；面板外 pointerdown 关闭（根节点内的点击交给按钮自己切换）。
      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        const onPointerDown = (event) => {
          const target = event.target;
          if (rootRef.current !== null && rootRef.current.contains(target)) return;
          if (panelRef.current !== null && panelRef.current.contains(target)) return;
          setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [open]);

      const ratio = typeof thresholdRatio === 'number' && thresholdRatio > 0
        ? thresholdRatio
        : DEFAULT_THRESHOLD_RATIO;
      const fallbackWindow = typeof contextWindowFallback === 'number' && contextWindowFallback > 0
        ? contextWindowFallback
        : DEFAULT_CONTEXT_WINDOW;
      // 提前压线只认配置；配置没给就不显示，绝不在这里写死一个 350000。
      const earlyLine = typeof thresholdTokens === 'number' && Number.isFinite(thresholdTokens)
        && thresholdTokens > 0 ? Math.floor(thresholdTokens) : undefined;

      const projected = pressure === undefined || pressure === null ? undefined : pressure.projectedTokens;
      const used = projected !== undefined
        ? projected
        : (pressure === undefined || pressure === null ? undefined : pressure.pressureTokens);
      const contextWindow = pressure !== undefined && pressure !== null && typeof pressure.contextWindow === 'number'
        ? pressure.contextWindow
        : fallbackWindow;
      const line = Math.floor(contextWindow * ratio);
      const nearer = typeof used === 'number' ? nearerLine(used, line, earlyLine) : undefined;
      const requestUsage = lastRequestUsage(chatNodes);
      const rows = typeof used === 'number'
        ? dialogRows({ dict, used, contextWindow, line, ratio, earlyLine, nearer, tokenUsage, requestUsage })
        : [];
      const summary = typeof used === 'number'
        ? lineSummary({ dict, autoLine: line, earlyLine, nearer })
        : undefined;

      const known = typeof used === 'number' && Number.isFinite(used) && used >= 0;
      if (!known) {
        return h('span', { style: { display: 'inline-flex' } },
          h('style', null, CSS_TEXT),
          h('span', { className: 'ctxmRoot', 'data-composer-stat': 'context-kit' },
            h('span', {
              className: 'ctxmPill',
              title: tr(t, 'unknownTip', {}, dict),
              'aria-label': tr(t, 'unknown', {}, dict),
            }, tr(t, 'unknown', {}, dict))));
      }

      // 百分比口径与空间圆环一致：占上下文窗口，封顶 100。
      const windowPercentRaw = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
      const percent = Math.min(100, Math.max(0, Math.round(windowPercentRaw)));
      const percentExact = Math.round(windowPercentRaw * 10) / 10;
      // 颜色阈值仍按自动压缩线算（保持合并前的行为）。
      const linePercentRaw = line > 0 ? (used / line) * 100 : 0;
      const linePercent = Math.round(linePercentRaw);

      const tone = linePercentRaw >= DANGER_RATIO * 100
        ? { tone: 'danger', key: 'readingOver' }
        : linePercentRaw >= WARN_RATIO * 100
          ? { tone: 'warn', key: 'readingNear' }
          : { tone: 'neutral', key: 'reading' };

      const params = {
        used: compact(used, isZh),
        window: compact(contextWindow, isZh),
        line: compact(line, isZh),
        percent,
        percentExact,
        linePercent,
        usedExact: grouped(used),
        windowExact: grouped(contextWindow),
        lineExact: grouped(line),
        ratio: String(Math.round(ratio * 100)) + '%',
        earlyLine: earlyLine === undefined ? undefined : compact(earlyLine, isZh),
        earlyLineExact: earlyLine === undefined ? undefined : grouped(earlyLine),
        earlyPercent: earlyLine === undefined ? undefined : Math.round((used / earlyLine) * 100),
      };
      const reading = tr(t, tone.key, params, dict);
      const tooltip = tr(t, earlyLine === undefined ? 'tooltip' : 'tooltipWithEarly', params, dict);
      const dialogTitle = tr(t, 'dialogTitle', {}, dict);

      const dialog = open && createPortal !== null
        ? createPortal(h('div', {
          ref: panelRef,
          className: 'ctxmPanel',
          role: 'dialog',
          'aria-label': dialogTitle,
          'data-context-kit-dialog': '',
          style: { positionAnchor: anchorName },
        },
        h('div', { className: 'ctxmTitle' },
          h('span', { className: 'ctxmTitleLabel' }, ringIcon(percent), dialogTitle),
          h('span', { className: 'ctxmTitleValue' }, percent + '%')),
        summary === undefined ? null : h('div', { className: 'ctxmLines' },
          h('span', { className: 'ctxmLinesKey' }, tr(t, 'linesLabel', {}, dict)),
          h('span', null, summary.lineText),
          h('span', null, summary.earlyText),
          h('span', { className: 'ctxmLinesNear' }, summary.nearText)),
        h('div', { className: 'ctxmRule', 'aria-hidden': true }),
        h('dl', { className: 'ctxmDetails' }, rows.flatMap(([label, value], index) => [
          h('dt', { key: `dt-${index}` }, label),
          h('dd', { key: `dd-${index}` }, value),
        ]))), document.body)
        : null;

      return h('span', { ref: rootRef, style: { display: 'inline-flex', anchorName } },
        h('style', null, CSS_TEXT),
        h('span', { className: 'ctxmRoot', 'data-composer-stat': 'context-kit' },
          h('button', {
            type: 'button',
            className: 'ctxmPill',
            'data-tone': tone.tone,
            'data-anchor': anchorName,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': reading,
            title: open ? undefined : tooltip,
            onClick: () => { setOpen(!open); },
          }, ringIcon(percent), reading)),
        dialog);
    }

    return {
      // 离线自检用：暴露纯函数与组件本体，不参与渲染、不改变任何行为。
      __test: {
        ContextMeter, compact, grouped, wan, metric, cacheHitText,
        dialogRows, lastRequestUsage, nearerLine, lineSummary, resolveDisplayConfig, DICTS, CSS_TEXT,
      },
      inject: ['slots', 'locale'],
      /**
       * 注册词典与 dock 条目。
       * @param {object} ctx - Client 上下文。
       * @param {object} [config] - 行 config（与 Host 半侧共享）。
       */
      apply(ctx, config) {
        const cfg = config === undefined || config === null ? {} : config;
        const display = resolveDisplayConfig(cfg);
        let activeLocale = ctx.locale.getSnapshot().active;

        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', DICTS.zh);
          const disposeEn = ctx.locale.register(NS, 'en', DICTS.en);
          return () => {
            disposeEn();
            disposeZh();
          };
        }, 'context-kit: dictionaries');

        ctx.effect(() => ctx.locale.subscribe(() => {
          activeLocale = ctx.locale.getSnapshot().active;
        }), 'context-kit: active locale');

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'context-kit',
          order: 2,
          locale: NS,
          inject: () => ({
            getLocale: () => activeLocale,
            thresholdRatio: display.thresholdRatio,
            contextWindowFallback: display.contextWindowFallback,
            // 原样传给组件：没有就不显示提前线。
            thresholdTokens: display.thresholdTokens,
          }),
        }, ContextMeter));
      },
    };
  },
});
