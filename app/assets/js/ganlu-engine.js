// ganlu-engine.js — 甘露影视源：规则引擎 + 公开数据源客户端
// 忠实移植参考实现（XPath 双选择器规则 / JSON API 规则 / 剧集 URL 归一化 / 线路模型），
// 数据源客户端：番剧公开 API（目录/搜索/时间表/条目详情）、识图搜索、弹幕源（可选凭据签名）。
// 引擎本身不发请求：所有 HTTP 经注入的 fetcher（主进程代理）完成，渲染层零 CORS 问题。
;(function () {
  'use strict';

  // ---------- 剧集 URL 归一化（1:1 移植参考实现 episode_url 语义）----------
  // 相对路径按 baseUrl 补全；同站 URL 协议统一到 baseUrl 声明的协议；去尾斜杠/空 query；幂等。
  function normalizeEpisodeUrl(baseUrl, raw) {
    const trimmed = String(raw == null ? '' : raw).trim();
    if (!trimmed) return '';
    const base = String(baseUrl == null ? '' : baseUrl).trim();

    let rawUri = null;
    try { rawUri = new URL(trimmed); } catch (e) { rawUri = null; }
    let baseUri = null;
    try { baseUri = new URL(base); } catch (e) { baseUri = null; }
    const hasValidBase = !!(baseUri && baseUri.protocol.startsWith('http'));

    let resolved = null;
    if (rawUri && rawUri.protocol.startsWith('http') && rawUri.host) resolved = rawUri;
    else if (hasValidBase) {
      try { resolved = new URL(trimmed, baseUri); } catch (e) { resolved = null; }
    }
    if (!resolved || !resolved.host) return trimmed;

    // 同站协议统一到 baseUrl 声明的协议（跨站/异端口不动）
    if (hasValidBase && resolved.host === baseUri.host &&
        (resolved.port || (resolved.protocol === 'https:' ? '443' : '80')) ===
        (baseUri.port || (baseUri.protocol === 'https:' ? '443' : '80')) &&
        resolved.protocol !== baseUri.protocol) {
      try {
        const s = resolved.toString().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:/, baseUri.protocol);
        resolved = new URL(s);
      } catch (e) { /* 保留原样 */ }
    }

    // 去 path 尾斜杠（根路径保留）
    let p = resolved.pathname || '/';
    while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    const portPart = resolved.port ? ':' + resolved.port : '';
    const qs = resolved.search || '';
    const frag = resolved.hash || '';
    return resolved.protocol + '//' + resolved.host + portPart + p + qs + frag;
  }

  // ---------- 随机 UA（规则请求缺省 User-Agent）----------
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  ];
  const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  function buildHttpHeaders(plugin) {
    const h = { 'user-agent': plugin.userAgent ? plugin.userAgent : randomUA() };
    if (plugin.referer) h['referer'] = plugin.referer;
    return h;
  }

  // ---------- 规则模型（Plugin / Road / SearchItem，1:1 移植）----------
  const RULE_MODE = { XPATH: 'xpath', API: 'api' };

  function emptyAntiCrawler() {
    return { enabled: false, captchaType: 1, captchaImage: '', captchaInput: '', captchaButton: '',
             captchaDetectType: 1, captchaDetectValue: '', captchaScript: '' };
  }

  function pluginFromJson(json) {
    const p = {
      api: String(json.api ?? '9'),
      type: json.type || 'anime',
      name: json.name || '',
      version: String(json.version ?? ''),
      muliSources: json.muliSources !== false,
      usePost: !!json.usePost,
      useLegacyParser: !!json.useLegacyParser,
      adBlocker: !!json.adBlocker,
      userAgent: json.userAgent || '',
      baseUrl: json.baseURL || json.baseUrl || '',
      searchURL: json.searchURL || '',
      searchList: json.searchList || '',
      searchName: json.searchName || '',
      searchResult: json.searchResult || '',
      chapterRoads: json.chapterRoads || '',
      chapterResult: json.chapterResult || '',
      referer: json.referer || '',
      searchMode: json.searchMode === RULE_MODE.API ? RULE_MODE.API : RULE_MODE.XPATH,
      chapterMode: json.chapterMode === RULE_MODE.API ? RULE_MODE.API : RULE_MODE.XPATH,
      searchApiConfig: json.searchApiConfig && typeof json.searchApiConfig === 'object' ? json.searchApiConfig : {},
      chapterApiConfig: json.chapterApiConfig && typeof json.chapterApiConfig === 'object' ? json.chapterApiConfig : {},
      antiCrawlerConfig: json.antiCrawlerConfig && typeof json.antiCrawlerConfig === 'object'
        ? Object.assign(emptyAntiCrawler(), json.antiCrawlerConfig) : emptyAntiCrawler(),
    };
    return p;
  }

  function pluginToJson(p) {
    const o = {
      api: p.api, type: p.type, name: p.name, version: p.version,
      muliSources: p.muliSources !== false, usePost: !!p.usePost,
      useLegacyParser: !!p.useLegacyParser, adBlocker: !!p.adBlocker,
      userAgent: p.userAgent || '', baseURL: p.baseUrl || '',
      searchURL: p.searchURL || '', searchList: p.searchList || '',
      searchName: p.searchName || '', searchResult: p.searchResult || '',
      chapterRoads: p.chapterRoads || '', chapterResult: p.chapterResult || '',
      referer: p.referer || '',
      searchMode: p.searchMode || RULE_MODE.XPATH,
      chapterMode: p.chapterMode || RULE_MODE.XPATH,
    };
    if ((p.searchMode === RULE_MODE.API) || (p.searchApiConfig && p.searchApiConfig.request && p.searchApiConfig.request.url)) o.searchApiConfig = p.searchApiConfig;
    if ((p.chapterMode === RULE_MODE.API) || (p.chapterApiConfig && p.chapterApiConfig.request && p.chapterApiConfig.request.url)) o.chapterApiConfig = p.chapterApiConfig;
    o.antiCrawlerConfig = p.antiCrawlerConfig || emptyAntiCrawler();
    return o;
  }

  function pluginFromTemplate() {
    return pluginFromJson({});
  }

  // ---------- 受限 JSONPath（$.a.b[0][*]['k'] 子集，1:1 移植校验与取值语义）----------
  function jsonPathValidate(expr) {
    if (!expr || !expr.startsWith('$')) throw new Error('JSONPath 必须以 $ 开头: ' + expr);
    let i = 1;
    while (i < expr.length) {
      const ch = expr[i];
      if (ch === '.') {
        i++;
        const start = i;
        while (i < expr.length && /[A-Za-z0-9_$-]/.test(expr[i])) i++;
        if (i === start) throw new Error('不支持的 JSONPath: ' + expr);
        continue;
      }
      if (ch === '[') {
        let end = -1, quote = null;
        for (let j = i + 1; j < expr.length; j++) {
          const c = expr[j];
          if (quote) { if (c === quote) quote = null; continue; }
          if (c === "'" || c === '"') { quote = c; continue; }
          if (c === ']') { end = j; break; }
        }
        if (end < 0) throw new Error('JSONPath 缺少 ]: ' + expr);
        const content = expr.slice(i + 1, end).trim();
        const ok = /^\d+$/.test(content) || content === '*' ||
          (content.length >= 2 && ((content[0] === "'" && content.endsWith("'")) || (content[0] === '"' && content.endsWith('"'))));
        if (!ok) throw new Error('不支持的 JSONPath 片段: [' + content + ']');
        i = end + 1;
        continue;
      }
      throw new Error('不支持的 JSONPath: ' + expr);
    }
  }

  // 按段解析 JSONPath：返回 token 序列 [{kind:'name',v} | {kind:'index',v} | {kind:'wild'} | {kind:'key',v}]
  function jsonPathTokens(expr) {
    const tokens = [];
    let i = 1;
    while (i < expr.length) {
      const ch = expr[i];
      if (ch === '.') {
        i++;
        const start = i;
        while (i < expr.length && /[A-Za-z0-9_$-]/.test(expr[i])) i++;
        tokens.push({ kind: 'name', v: expr.slice(start, i) });
      } else if (ch === '[') {
        let end = -1, quote = null;
        for (let j = i + 1; j < expr.length; j++) {
          const c = expr[j];
          if (quote) { if (c === quote) quote = null; continue; }
          if (c === "'" || c === '"') { quote = c; continue; }
          if (c === ']') { end = j; break; }
        }
        const content = expr.slice(i + 1, end).trim();
        if (/^\d+$/.test(content)) tokens.push({ kind: 'index', v: Number(content) });
        else if (content === '*') tokens.push({ kind: 'wild' });
        else tokens.push({ kind: 'key', v: content.slice(1, -1) });
        i = end + 1;
      } else i++;
    }
    return tokens;
  }

  function jsonPathReads(doc, expr) {
    jsonPathValidate(expr);
    const tokens = jsonPathTokens(expr);
    let current = [doc];
    for (const t of tokens) {
      const next = [];
      for (const v of current) {
        if (v == null) continue;
        if (t.kind === 'name' || t.kind === 'key') {
          if (typeof v === 'object') next.push(v[t.v]);
        } else if (t.kind === 'index') {
          if (Array.isArray(v)) next.push(v[t.v]);
          else if (typeof v === 'object') next.push(v[String(t.v)]);
        } else if (t.kind === 'wild') {
          if (Array.isArray(v)) for (const x of v) next.push(x);
          else if (typeof v === 'object') for (const k of Object.keys(v)) next.push(v[k]);
        }
      }
      current = next;
    }
    return current;
  }

  function jsonPathFirst(doc, expr) {
    const v = jsonPathReads(doc, expr);
    return v.length ? v[0] : null;
  }

  // ---------- 模板渲染（@var；精确 @var 整体替换；缺变量即报错，1:1 移植）----------
  const VAR_RE = /(?<![A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9_]*)/g;
  function renderTemplate(template, vars, encode) {
    return String(template).replace(VAR_RE, (m, name) => {
      if (!(name in vars)) throw new Error('缺少模板变量 @' + name);
      const v = vars[name] == null ? '' : String(vars[name]);
      return encode ? encodeURIComponent(v) : v;
    });
  }

  function renderValue(value, vars) {
    if (typeof value === 'string') {
      const m = value.match(/^@([A-Za-z_][A-Za-z0-9_]*)$/);
      if (m) {
        if (!(m[1] in vars)) throw new Error('缺少模板变量 @' + m[1]);
        return vars[m[1]];
      }
      return renderTemplate(value, vars);
    }
    if (Array.isArray(value)) return value.map((x) => renderValue(x, vars));
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = renderValue(value[k], vars);
      return out;
    }
    return value;
  }

  function renderMap(input, vars) {
    const out = {};
    for (const k of Object.keys(input || {})) out[renderTemplate(k, vars)] = renderValue(input[k], vars);
    return out;
  }

  // ---------- XPath 执行（Chromium 原生：DOMParser + XPathResult）----------
  function parseHtml(html) {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    return doc;
  }

  function queryXPath(doc, node, expr) {
    if (!expr || !expr.trim()) throw new Error('XPath 不能为空');
    const res = node.evaluate(expr, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const out = [];
    for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i));
    return out;
  }

  function nodeHref(node) {
    if (!node || typeof node.getAttribute !== 'function') return '';
    return (node.getAttribute('href') || '').trim();
  }

  function nodeText(node) {
    return node ? (node.textContent || '').trim() : '';
  }

  // ---------- 请求准备 ----------
  function preparedRequest(method, url, extra) {
    return Object.assign({
      method, url, headers: {}, query: {}, bodyType: 'none', body: null, includeCookies: false,
    }, extra || {});
  }

  function prepareSearchRequest(plugin, keyword) {
    if (plugin.searchMode === RULE_MODE.API) {
      const cfg = plugin.searchApiConfig || {};
      const req = cfg.request || {};
      const method = String(req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') throw new Error('API 仅支持 GET/POST，当前为 ' + method);
      const url = String(req.url || '').trim();
      if (!url) throw new Error('API 请求 URL 不能为空');
      const vars = { keyword };
      return preparedRequest(method, renderTemplate(url, vars, true), {
        headers: renderMap(req.headers || {}, vars),
        query: renderMap(req.query || {}, vars),
        bodyType: req.bodyType === 'json' ? 'json' : (req.bodyType === 'form' ? 'form' : 'none'),
        body: method === 'POST' && req.bodyType !== 'none' ? renderValue(req.body, vars) : null,
        includeCookies: true,
      });
    }
    // XPath 模式
    const url = String(plugin.searchURL || '').replace(/@keyword/g, encodeURIComponent(keyword));
    let uri;
    try { uri = new URL(url); } catch (e) { throw new Error('搜索 URL 无效: ' + url); }
    if (!uri.host) throw new Error('搜索 URL 无效: ' + url);
    if (!plugin.usePost) return preparedRequest('GET', url, { includeCookies: true });
    const q = {};
    for (const [k, v] of uri.searchParams) (q[k] = (q[k] || [])).push ? q[k].push(v) : (q[k] = [q[k], v].filter(Boolean));
    uri = new URL(url);
    uri.search = '';
    return preparedRequest('POST', uri.toString(), {
      bodyType: 'form', body: q, includeCookies: true,
    });
  }

  function prepareChapterRequest(plugin, source) {
    if (plugin.chapterMode === RULE_MODE.API) {
      const cfg = plugin.chapterApiConfig || {};
      const req = cfg.request || {};
      const method = String(req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') throw new Error('API 仅支持 GET/POST，当前为 ' + method);
      const url = String(req.url || '').trim();
      if (!url) throw new Error('API 请求 URL 不能为空');
      const vars = { source };
      return preparedRequest(method, renderTemplate(url, vars, true), {
        headers: renderMap(req.headers || {}, vars),
        query: renderMap(req.query || {}, vars),
        bodyType: req.bodyType === 'json' ? 'json' : (req.bodyType === 'form' ? 'form' : 'none'),
        body: method === 'POST' && req.bodyType !== 'none' ? renderValue(req.body, vars) : null,
        includeCookies: true,
      });
    }
    const url = normalizeEpisodeUrl(plugin.baseUrl, source);
    let uri;
    try { uri = new URL(url); } catch (e) { throw new Error('章节 URL 无效: ' + url); }
    if (!uri.host) throw new Error('章节 URL 无效: ' + url);
    return preparedRequest('GET', url, {}); // XPath 章节请求历史上不带 cookie
  }

  // ---------- 验证码检测 ----------
  function detectCaptcha(plugin, raw, rootDoc) {
    const ac = plugin.antiCrawlerConfig || emptyAntiCrawler();
    if (!ac.enabled) return false;
    const detectValue = String(ac.captchaDetectValue || '').trim();
    if (detectValue) {
      const t = Number(ac.captchaDetectType || 1);
      if (t === 2) return String(raw).includes(detectValue);
      if (t === 3) {
        try { return new RegExp(detectValue, 'is').test(String(raw)); } catch (e) { return false; }
      }
      try {
        if (queryXPath(rootDoc, rootDoc, detectValue).length) return true;
      } catch (e) { /* 无效 xpath 落空 */ }
    }
    for (const sel of [ac.captchaImage, ac.captchaButton]) {
      if (!sel || !String(sel).trim()) continue;
      try {
        const root = rootDoc || parseHtml(raw);
        if (queryXPath(root, root, sel).length) return true;
      } catch (e) { /* 忽略 */ }
    }
    return false;
  }

  // ---------- 搜索解析 ----------
  function parseSearch(plugin, raw, pluginName) {
    if (plugin.searchMode === RULE_MODE.API) {
      const cfg = plugin.searchApiConfig || {};
      let doc;
      try { doc = JSON.parse(raw); } catch (e) { throw new Error('API 响应不是有效 JSON: ' + e.message); }
      const listPath = cfg.listPath || '$.data[*]';
      const namePath = cfg.namePath || '$.name';
      const sourcePath = cfg.sourcePath || '$.url';
      const template = String(cfg.sourceTemplate || '').trim();
      if (template && !template.includes('@source')) throw new Error('详情页地址模板必须引用 @source');
      const items = [], diagnostics = [];
      const nodes = jsonPathReads(doc, listPath);
      nodes.forEach((node, index) => {
        try {
          const name = String(jsonPathFirst(node, namePath) ?? '').trim();
          const source = String(jsonPathFirst(node, sourcePath) ?? '').trim();
          if (!name || !source) { diagnostics.push('搜索节点 ' + index + ' 缺少名称或来源，已跳过'); return; }
          const src = template ? template.replace(/@source/g, encodeURIComponent(source)) : source;
          items.push({ name, src });
        } catch (e) { diagnostics.push('搜索节点 ' + index + ' 解析失败: ' + e.message); }
      });
      return { items, diagnostics };
    }
    // XPath 模式
    const root = parseHtml(raw);
    if (detectCaptcha(plugin, raw, root)) throw new Error('CAPTCHA');
    const items = [], diagnostics = [];
    let nodes;
    try { nodes = queryXPath(root, root, plugin.searchList); }
    catch (e) { throw new Error('搜索结果列表 XPath 无效: ' + e.message); }
    nodes.forEach((node, index) => {
      try {
        const name = nodeText(node).trim();
        const source = nodeHref(node);
        if (!name || !source) { diagnostics.push('搜索节点 ' + index + ' 缺少名称或来源，已跳过'); return; }
        items.push({ name, src: source });
      } catch (e) { diagnostics.push('搜索节点 ' + index + ' 解析失败: ' + e.message); }
    });
    return { items, diagnostics };
  }

  // ---------- 章节（线路）解析 ----------
  function resolveEpisodeUrl(chapterCfg, rootVars, rawUrl, roadIndex, episodeIndex, baseUrl) {
    const page = chapterCfg.episodePage;
    if (!page) return normalizeEpisodeUrl(baseUrl, rawUrl);
    if (!String(page.url || '').trim()) throw new Error('播放页地址模板不能为空');
    const vars = Object.assign({}, rootVars, {
      episodeUrl: rawUrl,
      roadIndex, roadNumber: roadIndex + 1,
      episodeIndex, episodeNumber: episodeIndex + 1,
    });
    const path = renderTemplate(page.url, vars, true);
    let uri;
    try { uri = new URL(path); } catch (e) { throw new Error('剧集页面 URL 无效: ' + path); }
    const renderedQuery = renderMap(page.query || {}, vars);
    const merged = new URLSearchParams(uri.search);
    for (const [k, v] of Object.entries(renderedQuery)) merged.set(k, String(v));
    let out = uri.toString();
    if (merged.toString()) out = out.replace(/\?[^#]*$/, '' + '?' + merged.toString());
    return normalizeEpisodeUrl(baseUrl, out);
  }

  function parseChapters(plugin, raw, source) {
    if (plugin.chapterMode === RULE_MODE.API) {
      const cfg = plugin.chapterApiConfig || {};
      let doc;
      try { doc = JSON.parse(raw); } catch (e) { throw new Error('API 响应不是有效 JSON: ' + e.message); }
      const rootVars = { source };
      for (const [k, pathExpr] of Object.entries(cfg.variables || {})) {
        const v = jsonPathFirst(doc, pathExpr);
        if (v == null) throw new Error('章节响应变量 ' + k + ' 未匹配到值: ' + pathExpr);
        rootVars[k] = v;
      }
      const diagnostics = [];
      const roads = cfg.format === 'delimited'
        ? parseDelimitedChapters(doc, cfg, rootVars, plugin.baseUrl, diagnostics)
        : parseNestedChapters(doc, cfg, rootVars, plugin.baseUrl, diagnostics);
      return { roads, diagnostics };
    }
    // XPath 模式
    const root = parseHtml(raw);
    const roads = [], diagnostics = [];
    let roadNodes;
    try { roadNodes = queryXPath(root, root, plugin.chapterRoads); }
    catch (e) { throw new Error('播放线路列表 XPath 无效: ' + e.message); }
    roadNodes.forEach((roadNode, roadIndex) => {
      try {
        const urls = [], names = [];
        let episodeNodes;
        try { episodeNodes = queryXPath(root, roadNode, plugin.chapterResult); }
        catch (e) { throw new Error('剧集列表 XPath 无效: ' + e.message); }
        episodeNodes.forEach((episodeNode, episodeIndex) => {
          try {
            const sourceHref = nodeHref(episodeNode);
            if (!sourceHref) { diagnostics.push('线路 ' + roadIndex + ' 的剧集节点 ' + episodeIndex + ' 缺少 URL，已跳过'); return; }
            const name = (episodeNode.textContent || '').replace(/\s+/g, '');
            urls.push(normalizeEpisodeUrl(plugin.baseUrl, sourceHref));
            names.push(name || '第' + (episodeIndex + 1) + '集');
          } catch (e) { diagnostics.push('线路 ' + roadIndex + ' 的剧集节点 ' + episodeIndex + ' 解析失败: ' + e.message); }
        });
        if (!urls.length) { diagnostics.push('线路 ' + roadIndex + ' 没有有效剧集，已跳过'); return; }
        roads.push({ name: '播放线路' + (roads.length + 1), data: urls, identifier: names });
      } catch (e) { diagnostics.push('线路节点 ' + roadIndex + ' 解析失败: ' + e.message); }
    });
    return { roads, diagnostics };
  }

  function parseNestedChapters(doc, cfg, rootVars, baseUrl, diagnostics) {
    const hasRoads = String(cfg.roadsPath || '').trim().length > 0;
    const roadNodes = hasRoads ? jsonPathReads(doc, cfg.roadsPath || '$') : [doc];
    const roads = [];
    roadNodes.forEach((roadNode, roadIndex) => {
      try {
        const roadName = (hasRoads && String(cfg.roadNamePath || '').trim())
          ? String(jsonPathFirst(roadNode, cfg.roadNamePath || '$.name') ?? '').trim() : '';
        const episodeNodes = jsonPathReads(roadNode, cfg.episodesPath || '$.episodes[*]');
        const urls = [], names = [];
        episodeNodes.forEach((episodeNode, episodeIndex) => {
          try {
            const episodeName = String(jsonPathFirst(episodeNode, cfg.episodeNamePath || '$.name') ?? '').trim();
            const rawUrl = String(cfg.episodeUrlPath || '').trim()
              ? String(jsonPathFirst(episodeNode, cfg.episodeUrlPath) ?? '') : '';
            const pageUrl = resolveEpisodeUrl(cfg, rootVars, rawUrl, roadIndex, episodeIndex, baseUrl);
            if (!pageUrl) { diagnostics.push('线路 ' + roadIndex + ' 的剧集节点 ' + episodeIndex + ' 缺少 URL，已跳过'); return; }
            urls.push(pageUrl);
            names.push(episodeName || '第' + (episodeIndex + 1) + '集');
          } catch (e) { diagnostics.push('线路 ' + roadIndex + ' 的剧集节点 ' + episodeIndex + ' 解析失败: ' + e.message); }
        });
        if (!urls.length) { diagnostics.push('线路节点 ' + roadIndex + ' 没有有效剧集，已跳过'); return; }
        roads.push({
          name: roadName || '播放线路' + (roads.length + 1),
          data: urls, identifier: names,
        });
      } catch (e) { diagnostics.push('线路节点 ' + roadIndex + ' 解析失败: ' + e.message); }
    });
    return roads;
  }

  function parseDelimitedChapters(doc, cfg, rootVars, baseUrl, diagnostics) {
    const roadNamesValue = String(jsonPathFirst(doc, cfg.roadNamesPath || '$') ?? '');
    const episodesValue = String(jsonPathFirst(doc, cfg.roadEpisodesPath || '$') ?? '');
    if (!episodesValue) return [];
    const sep = cfg.roadSeparator || '$$$';
    const epSep = cfg.episodeSeparator || '#';
    const fieldSep = cfg.fieldSeparator || '$';
    if (!sep || !epSep || !fieldSep) throw new Error('章节分隔符不能为空');
    const roadNames = roadNamesValue.split(sep);
    const groups = episodesValue.split(sep);
    const roads = [];
    groups.forEach((group, roadIndex) => {
      const urls = [], names = [];
      group.split(epSep).forEach((entryRaw, episodeIndex) => {
        const entry = entryRaw.trim();
        if (!entry) return;
        const si = entry.indexOf(fieldSep);
        if (si < 0) { diagnostics.push('线路 ' + roadIndex + ' 的剧集条目 ' + episodeIndex + ' 缺少字段分隔符，已跳过'); return; }
        const name = entry.slice(0, si).trim();
        const rawUrl = entry.slice(si + fieldSep.length).trim();
        try {
          const pageUrl = resolveEpisodeUrl(cfg, rootVars, rawUrl, roadIndex, episodeIndex, baseUrl);
          if (!pageUrl) { diagnostics.push('线路 ' + roadIndex + ' 的剧集条目 ' + episodeIndex + ' 缺少 URL，已跳过'); return; }
          urls.push(pageUrl);
          names.push(name || '第' + (episodeIndex + 1) + '集');
        } catch (e) { diagnostics.push('线路 ' + roadIndex + ' 的剧集条目 ' + episodeIndex + ' 解析失败: ' + e.message); }
      });
      if (!urls.length) { diagnostics.push('线路 ' + roadIndex + ' 没有有效剧集，已跳过'); return; }
      const configured = roadNames[roadIndex] ? String(roadNames[roadIndex]).trim() : '';
      roads.push({ name: configured || '播放线路' + (roads.length + 1), data: urls, identifier: names });
    });
    return roads;
  }

  // ---------- 规则导入 / 分享 ----------
  // 导入：JSON 对象 / JSON 数组 / base64(JSON)；分享：紧凑 JSON 数组文本（可回填导入）
  function importRuleText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('内容为空');
    let candidates = [trimmed];
    if (trimmed.startsWith('ganlu://') || trimmed.startsWith('kazumi://')) {
      candidates.push(trimmed.split('://')[1] || '');
    }
    for (const c of candidates) {
      try { return parseRuleJson(c); } catch (e) { /* 尝试下一种 */ }
      // base64(JSON)
      try {
        const b64 = c.replace(/[\r\n\s]+/g, '');
        if (/^[A-Za-z0-9+/=_-]+$/.test(b64) && b64.length % 4 <= 2 && b64.length >= 8) {
          const json = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
          return parseRuleJson(json);
        }
      } catch (e) { /* 忽略 */ }
    }
    throw new Error('无法识别的规则内容（需为 JSON / JSON 数组 / base64 分享文本）');
  }

  function parseRuleJson(text) {
    const obj = JSON.parse(text);
    const list = Array.isArray(obj) ? obj : [obj];
    const out = [];
    list.forEach((it) => {
      if (!it || typeof it !== 'object') return;
      const p = pluginFromJson(it);
      if (!p.name && !p.searchURL && !p.baseUrl) return;
      out.push(p);
    });
    if (!out.length) throw new Error('未识别到有效规则');
    return out.map(pluginToJson);
  }

  function shareText(plugins) {
    return JSON.stringify((plugins || []).map(pluginToJson));
  }

  // ---------- 规则编排（fetcher 注入：fetcher(prepared, plugin) → Promise<string>）----------
  async function searchPlugin(plugin, keyword, fetcher) {
    const p = prepareSearchRequest(plugin, keyword);
    const raw = await fetcher(p, plugin);
    const res = parseSearch(plugin, raw);
    return { items: res.items, diagnostics: res.diagnostics };
  }

  async function chaptersPlugin(plugin, source, fetcher) {
    const p = prepareChapterRequest(plugin, source);
    const raw = await fetcher(p, plugin);
    return parseChapters(plugin, raw, source);
  }

  // 多源并发搜索：返回 { results: { [源名]: {items,diagnostics} }, errors: { [源名]: msg } }
  async function searchAll(plugins, keyword, fetcher, concurrency) {
    const conc = Math.max(1, Number(concurrency) || 4);
    const results = {}, errors = {};
    const queue = [...(plugins || [])];
    const workers = Array.from({ length: Math.min(conc, queue.length) }, async () => {
      while (queue.length) {
        const p = queue.shift();
        if (!p) break;
        const key = p.name || '(未命名)';
        try {
          const { items, diagnostics } = await searchPlugin(p, keyword, fetcher);
          if (detectCaptchaNow(p, items, diagnostics)) { /* CAPTCHA 异常在 searchPlugin 中抛出 */ }
          results[key] = { items, diagnostics };
        } catch (e) {
          if (e && e.message === 'CAPTCHA') errors[key] = '需要验证码（可在规则设置中配置反反爬虫）';
          else errors[key] = String(e.message || e);
        }
      }
    });
    await Promise.all(workers);
    return { results, errors };
  }

  function detectCaptchaNow() { return false; } // 占位保持接口稳定

  // ---------- 番剧公开数据（api.bgm.tv / next.bgm.tv，匿名可用）----------
  const BGM_V0 = 'https://api.bgm.tv/v0';
  const BGM_P1 = 'https://next.bgm.tv/p1';
  const BGM_MIRROR = 'https://api.kazumi.fyi';
  // 访问加速：镜像后端可达面优先（大陆直连 bgm 系域名不通），失败回落官方直连
  function seasonRange(year, month) {
    const q = Math.floor((month - 1) / 3); // 0..3 → 季度首月
    const sm = q * 3 + 1;
    const em = sm + 2;
    const lastDay = new Date(year, em, 0).getDate();
    return {
      start: year + '-' + String(sm).padStart(2, '0') + '-01',
      end: year + '-' + String(em).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0'),
    };
  }
  function currentSeasonRange() {
    const now = new Date();
    return seasonRange(now.getFullYear(), now.getMonth() + 1);
  }
  async function fetchWithFallback(urls, opts, fetcher, meta) {
    let lastErr = null;
    for (const u of urls) {
      try {
        return await fetcher(preparedRequest('GET', u, opts), meta);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('请求失败');
  }

  const bgm = {
    // 条目搜索（type=2 番剧；官方直连）
    async search(keyword, fetcher) {
      const text = await fetcher(preparedRequest('POST', BGM_V0 + '/search/subjects?limit=24', {
        bodyType: 'form',
        body: { keyword, type: '2', limit: '24' },
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        includeCookies: false,
      }), { name: 'bgm' });
      const j = JSON.parse(text);
      return (j.data || []).map(normalizeBgmSubject);
    },
    // 热门趋势（镜像专用端点优先，回落官方）
    async trending(fetcher) {
      try {
        const text = await fetcher(preparedRequest('GET', BGM_MIRROR + '/kazumi/v1/popular/subjects?limit=24&offset=0', {
          headers: { 'accept': 'application/json' },
        }), { name: 'bgm' });
        let j;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        if (j) {
          const arr = Array.isArray(j) ? j : (j.data || []);
          const list = arr.map((x) => normalizeBgmSubject(x.subject || x)).filter((s) => s.id != null);
          if (list.length) return list;
        }
      } catch (e) { /* 镜像失败 → 官方直连 */ }
      const text2 = await fetcher(preparedRequest('GET', BGM_P1 + '/trending/subjects?type=2&limit=24', {
        headers: { 'accept': 'application/json' },
      }), { name: 'bgm' });
      let j2;
      try { j2 = JSON.parse(text2); } catch (e) { throw new Error('趋势数据解析失败'); }
      const arr2 = Array.isArray(j2) ? j2 : (j2.data || []);
      return arr2.map(normalizeBgmSubject);
    },
    // 标签流：多标签 POST 搜索（type=2 + tag filter；官方直连）
    async tagFlow(tags, fetcher, page) {
      const filter = { type: [2], tag: tags || ['全部'] };
      const body = { limit: '24', offset: String((page || 0) * 24), filter: JSON.stringify(filter) };
      const text = await fetcher(preparedRequest('POST', BGM_V0 + '/search/subjects', {
        bodyType: 'form',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }), { name: 'bgm' });
      const j = JSON.parse(text);
      return (j.data || []).map(normalizeBgmSubject);
    },
    // 当前季日历（镜像季度端点优先 → 官方直连；键 0-6 / 1-7 都归一到周一..周日 7 桶）
    async calendar(fetcher) {
      const r = currentSeasonRange();
      let j = null;
      try {
        const text = await fetcher(preparedRequest('GET', BGM_MIRROR + '/kazumi/v1/calendar/season?start=' + r.start + '&end=' + r.end, {
          headers: { 'accept': 'application/json' },
        }), { name: 'bgm' });
        j = JSON.parse(text);
      } catch (e) { j = null; }
      if (!j) {
        const text2 = await fetchWithFallback([BGM_P1 + '/calendar'], {}, fetcher, { name: 'bgm' });
        try { j = JSON.parse(text2); } catch (e) { throw new Error('时间表数据解析失败'); }
      }
      return normalizeCalendar(j);
    },
    // 历史季日历（按年/月；镜像季度端点优先）
    async seasonCalendar(year, month, fetcher) {
      const r = seasonRange(year, month);
      let j = null;
      try {
        const text = await fetcher(preparedRequest('GET', BGM_MIRROR + '/kazumi/v1/calendar/season?start=' + r.start + '&end=' + r.end, {
          headers: { 'accept': 'application/json' },
        }), { name: 'bgm' });
        j = JSON.parse(text);
      } catch (e) { j = null; }
      if (!j) {
        const text2 = await fetchWithFallback([BGM_P1 + '/calendar/' + year + '/' + month], {}, fetcher, { name: 'bgm' });
        try { j = JSON.parse(text2); } catch (e) { throw new Error('历史时间表数据解析失败'); }
      }
      return normalizeCalendar(j);
    },
    // 条目详情（镜像 /p1 优先，回落官方 /v0）
    async subject(id, fetcher) {
      const text = await fetchWithFallback([BGM_MIRROR + '/p1/subjects/' + id, BGM_V0 + '/subjects/' + id], {
        headers: { 'accept': 'application/json' },
      }, fetcher, { name: 'bgm' });
      return normalizeBgmSubject(JSON.parse(text));
    },
    // 条目评论（前 2 条；需签名的端点在无凭据环境不可用 → 静默空）
    async comments(id, fetcher) {
      try {
        const text = await fetchWithFallback([BGM_P1 + '/subjects/' + id + '/comments?limit=2'], {}, fetcher, { name: 'bgm' });
        const j = JSON.parse(text);
        return (j.comments || j.data || []).slice(0, 2).map((c) => ({
          user: (c.user && c.user.name) || '',
          content: c.content || (c.version && c.version.content) || '',
          score: c.score,
        }));
      } catch (e) { return []; }
    },
    // 角色（镜像 /v0 代理面优先，回落官方）
    async characters(id, fetcher) {
      const text = await fetchWithFallback([BGM_MIRROR + '/v0/subjects/' + id + '/characters', BGM_P1 + '/subjects/' + id + '/characters?limit=20'], {
        headers: { 'accept': 'application/json' },
      }, fetcher, { name: 'bgm' });
      const j = JSON.parse(text);
      const arr = j.data || j || [];
      return arr.map((c) => ({
        name: c.name || '',
        pic: c.pic || c.image || (c.images && (c.images.large || c.images.common || c.images.medium)) || '',
        role: c.role || '',
      }));
    },
    // 制作人员（镜像 /v0 代理面优先，回落官方）
    async staff(id, fetcher) {
      const text = await fetchWithFallback([BGM_MIRROR + '/v0/subjects/' + id + '/persons', BGM_P1 + '/subjects/' + id + '/persons?limit=20'], {
        headers: { 'accept': 'application/json' },
      }, fetcher, { name: 'bgm' });
      const j = JSON.parse(text);
      const arr = j.data || j || [];
      return arr.map((c) => ({
        name: c.name || '',
        pic: c.pic || c.image || (c.images && (c.images.large || c.images.common || c.images.medium)) || '',
      }));
    },
    // 相关条目（镜像 /v0 代理面优先，回落官方；v0 结构 = [{relation, items:[subject]}]）
    async relations(id, fetcher) {
      const text = await fetchWithFallback([BGM_MIRROR + '/v0/subjects/' + id + '/subjects', BGM_P1 + '/subjects/' + id + '/subjects?limit=12'], {
        headers: { 'accept': 'application/json' },
      }, fetcher, { name: 'bgm' });
      const j = JSON.parse(text);
      const arr = Array.isArray(j) ? j : (j.data || []);
      const out = [];
      for (const r of arr) {
        if (r && Array.isArray(r.items)) {
          for (const sub of r.items) {
            out.push({
              relation: r.relation || r.relations || '',
              id: sub.id,
              name: sub.name || '',
              cover: (sub.images && (sub.images.large || sub.images.common)) || '',
            });
          }
        } else {
          const sub = (r && r.subject) || r;
          if (sub && sub.id != null) {
            out.push({
              relation: (r && (r.relation || r.relations)) || '',
              id: sub.id,
              name: sub.name || '',
              cover: (sub.images && (sub.images.large || sub.images.common)) || '',
            });
          }
        }
      }
      return out.filter((r) => r.id != null);
    },
  };

  function normalizeBgmSubject(raw) {
    const images = raw.images || {};
    return {
      id: raw.id,
      name: raw.name || '',
      nameCn: raw.name_cn || '',
      cover: images.large ? images.large : (images.common || ''),
      summary: (raw.summary || '').replace(/<[^>]+>/g, '').trim(),
      eps: raw.eps || 0,
      rating: raw.rating && raw.rating.score != null ? raw.rating.score : null,
      ratingCount: raw.rating && raw.rating.total != null ? raw.rating.total : 0,
      tags: (raw.tags || []).map((t) => t.tag || t),
      season: raw.season,
      aired: raw.aired,
      airWeekday: raw.air_weekday,
      airTime: raw.air_time,
      raw,
    };
  }

  function normalizeCalendar(j) {
    const out = { week: Array.from({ length: 7 }, () => []), seasons: [] };
    const src = j && !Array.isArray(j) ? j.data ?? j : j;
    const mapKey = (k) => {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 1 && n <= 7) return n - 1;
      if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
      return -1;
    };
    if (src && typeof src === 'object') {
      for (const k of Object.keys(src)) {
        const idx = mapKey(k);
        if (idx >= 0 && Array.isArray(src[k])) out.week[idx] = src[k].map(normalizeBgmSubject);
      }
    }
    if (src && Array.isArray(src.seasons) && !Array.isArray(src[0])) {
      out.seasons = src.seasons.map((s) => s || '').slice(0, 24);
    }
    return out;
  }

  // 弹幕（dandanplay v2；签名头由主进程恒附，凭据可空）
  const DANDAN_DOMAIN = 'https://api.dandanplay.net';
  function dandanGet(path, fetcher, credentials) {
    const url = DANDAN_DOMAIN + path;
    const p = preparedRequest('GET', url, {});
    p.sign = { appId: (credentials && credentials.appId) || '', appKey: (credentials && credentials.appKey) || '' };
    return fetcher(p, { name: 'dandan', sign: p.sign }).then((text) => JSON.parse(text));
  }

  // /api/v2/bangumi/... 响应形如 { success, errorCode, bangumi: { animeId, episodes:[{episodeId, episodeTitle}] } }
  function normDandanBangumi(j) {
    const b = (j && j.bangumi) || {};
    return {
      animeId: Number(b.animeId) || 0,
      episodes: Array.isArray(b.episodes) ? b.episodes.map((e) => ({ episodeId: Number(e.episodeId), episodeTitle: e.episodeTitle || '' })) : [],
      success: !!(j && j.success),
    };
  }

  // 弹幕条目：{ m: 内容, p: "时间,类型,颜色,来源" }；类型 1=滚动 4=底部 5=顶部（照 dandanplay 约定）
  function normDanmakuComments(j) {
    const list = (j && Array.isArray(j.comments) ? j.comments : (Array.isArray(j) ? j : []));
    return list.map((c) => {
      const text = String(c.m != null ? c.m : '');
      const parts = String(c.p || '').split(',');
      const type = Number(parts[1]) || 1;
      const colorHex = Number(parts[2]) || 0xffff00;
      return {
        text,
        time: Number(parts[0]) || 0,
        color: '#' + ('000000' + colorHex.toString(16)).slice(-6),
        mode: type === 4 ? 'bottom' : type === 5 ? 'top' : 'scroll',
        source: parts[3] || '',
      };
    });
  }

  const dandan = {
    // bgm 番剧 ID → 弹幕侧自身份剧 ID
    byBgmId: (bgmId, f, c) => dandanGet('/api/v2/bangumi/bgmtv/' + bgmId, f, c).then(normDandanBangumi),
    // 弹幕自身份剧 ID → 分集
    episodes: (dandanAnimeId, f, c) => dandanGet('/api/v2/bangumi/' + dandanAnimeId, f, c).then(normDandanBangumi),
    // 分集弹幕
    danmaku: (episodeId, f, c) => dandanGet('/api/v2/comment/' + episodeId + '?withRelated=true&chConvert=0', f, c).then(normDanmakuComments),
    // 按标题搜弹幕分剧（v2 免 25 条上限）
    search: (keyword, f, c) => dandanGet('/api/v2/search/episodes?anime=' + encodeURIComponent(keyword) + '&v2=true', f, c)
      .then((j) => (Array.isArray(j && j.animes) ? j.animes.map((a) => ({ animeId: Number(a.animeId), animeTitle: a.animeTitle || '', typeDescription: a.typeDescription || '' })) : [])),
    // 自动匹配约定：弹幕分剧 ID + 4 位补零集数（bgmId 需先经 byBgmId 换弹幕分剧 ID）
    episodeId: (animeId, epNumber) => String(animeId) + String(epNumber).padStart(4, '0'),
  };

  // ---------- 在线源目录（规则仓库 index.json 双通道：国内镜像优先（GitHub raw 常被墙），官方 raw 兜底）----------
  const RULES_HOSTS = [
    'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/',
    'https://raw.githubusercontent.com/Predidit/KazumiRules/main/',
  ];
  let rulesHostIdx = 0;
  const catalog = {
    hosts: RULES_HOSTS,
    async list(fetcher) {
      let lastErr = null;
      for (let i = 0; i < RULES_HOSTS.length; i++) {
        const idx = (rulesHostIdx + i) % RULES_HOSTS.length;
        try {
          const text = await fetcher(preparedRequest('GET', RULES_HOSTS[idx] + 'index.json', {}), { name: 'catalog' });
          const j = JSON.parse(text);
          if (!Array.isArray(j)) throw new Error('目录格式无效');
          rulesHostIdx = idx;
          return j.map((it, n) => ({
            name: String((it && it.name) || n),
            version: String((it && it.version) || ''),
            author: String((it && it.author) || ''),
            lastUpdate: Number(it && it.lastUpdate) || 0,
          })).filter((it) => it.name && it.name !== '');
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('在线目录不可用');
    },
    async get(name, fetcher) {
      let lastErr = null;
      for (let i = 0; i < RULES_HOSTS.length; i++) {
        const idx = (rulesHostIdx + i) % RULES_HOSTS.length;
        try {
          const text = await fetcher(preparedRequest('GET', RULES_HOSTS[idx] + encodeURIComponent(name) + '.json', {}), { name: 'catalog' });
          return pluginFromJson(JSON.parse(text));
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('下载源规则失败');
    },
  };

  // ---------- 识图搜索（api.trace.moe：图片字节直接 POST 为请求体，或用 ?url= 传图片地址）----------
  const TRACE_API = 'https://api.trace.moe/search';
  async function traceImage(fileBase64, url, fetcher) {
    const p = preparedRequest('POST', TRACE_API + '?anilistInfo=2', {});
    if (url) p.query = { url: String(url) };
    else {
      const b64 = String(fileBase64 || '').replace(/^data:[^,]*,/, '');
      if (!b64) throw new Error('需要图片地址或图片文件');
      p.body = b64;
      p.bodyType = 'raw';
      p.headers = Object.assign({}, p.headers, { 'content-type': 'image/jpeg' });
    }
    const text = await fetcher(p, { name: 'trace' });
    const j = JSON.parse(text);
    return (j.results || []).map((r) => ({
      anime: r.anime || '',
      mal: r.mal,
      title: r.title || '',
      at: r.at != null ? r.at : null,
      score: r.score != null ? r.score : null,
      filename: r.filename,
      bgmId: (r.external && r.external.bangumi && r.external.bangumi.id) || null,
    }));
  }

  window.GanluEngine = {
    normalizeEpisodeUrl, randomUA, buildHttpHeaders,
    RULE_MODE,
    pluginFromJson, pluginToJson, pluginFromTemplate,
    importRuleText, shareText,
    jsonPathValidate, jsonPathReads, jsonPathFirst,
    parseHtml, queryXPath,
    prepareSearchRequest, prepareChapterRequest,
    parseSearch, parseChapters, detectCaptcha,
    searchPlugin, chaptersPlugin, searchAll,
    bgm, traceImage, dandan, catalog,
    emptyAntiCrawler,
  };
})();
