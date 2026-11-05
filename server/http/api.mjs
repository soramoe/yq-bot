/**
 * API 路由表。
 *
 * 全部接口都在这一张表里，`router.list()` 能一次打完 —— 二代的 54 个
 * if 分支没法这样自检，加接口只能靠全文搜索。
 */

import { Router } from './router.mjs';
import { readJson, securityHeaders, sendError, sendJson } from './json.mjs';
import { upTo } from '../app.mjs';
import { reconcile, formatReport } from '../core/reconcile.mjs';
import { dayKey } from '../core/event-log.mjs';
import { buildReports, summarizeReports, auditReports, buildDailySeries } from '../core/report.mjs';
import { buildReportHtml, reportFileName } from '../core/export-report.mjs';
import { buildTimeline, normalizeStep } from '../core/timeline.mjs';
import { replay } from '../core/sandbox.mjs';
import { buildPatrons } from '../core/patrons.mjs';

/**
 * @param {import('../app.mjs').App} app
 */
export function buildRoutes(app) {
  const r = new Router();

  /* ---------------- 只读 ---------------- */

  r.get('/api/status', ({ res }) => {
    sendJson(res, app.status());
  });

  r.get('/api/events', ({ res, url }) => {
    const after = Number(url.searchParams.get('after') ?? 0) || 0;
    const limit = Number(url.searchParams.get('limit') ?? 200) || 200;
    const page = app.recentEvents({ after, limit });
    sendJson(res, { ok: true, ...page, total: app.events.length });
  });

  r.get('/api/plugins', ({ res }) => {
    const snap = app.runner?.host?.snapshot() ?? null;
    sendJson(res, { ok: true, plugins: snap?.plugins ?? [], errors: snap?.errors ?? [] });
  });
  /**
   * 手动对账。
   *
   * 每次重启会自动跑一次；这个接口是"我现在就想确认一下"用的。
   *
   * 两处刻意的实现：
   * 1. **用 readAllAsync() 而不是 readAll()。** 同步读几万条会把事件循环
   *    整个停住，弹幕和 WS 推送一起卡；这偏偏是个随手点的按钮。
   * 2. **并发保护。** 连点两下会同时跑两遍全量重算，第二遍毫无意义，
   *    只是让卡顿翻倍。忙的时候直接告诉用户，不排队。
   */
  let reconciling = false;
  r.get('/api/reconcile', async ({ res }) => {
    if (!app.runner?.log_) {
      sendError(res, 503, 'not_ready', '房间还没启动，无法对账');
      return;
    }
    if (reconciling) {
      sendError(res, 429, 'busy', '上一次对账还没跑完，稍等一下');
      return;
    }
    reconciling = true;
    try {
      const snapshot = app.runner.stats();
      const events = await app.runner.log_.readAllAsync();
      // 裁到快照那一刻：读日志和取快照之间有新事件进来，不裁会永远差几条
      const report = reconcile({ events: upTo(snapshot, events), snapshot });
      sendJson(res, { ok: true, report, text: formatReport(report) });
    } finally {
      reconciling = false;
    }
  });

  /* ---------------- 战报与回放 ---------------- */

  /** 日志体检：有哪些天、多大、归档了几个 */
  r.get('/api/logs', ({ res }) => {
    if (!app.runner?.log_) {
      sendError(res, 503, 'not_ready', '房间还没启动，读不到日志');
      return;
    }
    sendJson(res, { ok: true, ...app.runner.log_.stats() });
  });

  /**
   * 场后战报。
   *
   * 全部从日志重放算 —— 不读内存统计。所以进程重启过、跨天、
   * 甚至服务刚起来还没连上房间，都能算出正确结果。
   *
   * 两道保护（审计补的）：
   * 1. **并发保护**：连点两下会同时跑两遍全量重放，第二遍没有任何意义。
   * 2. **5 秒缓存**：实测 9000 条日志 127ms，十万条就是 1.5 秒以上。
   *    而这是个"打开面板就会调"的接口，来回切范围会重复付这个代价。
   *    战报本来就是场后看的，5 秒的滞后不影响任何判断。
   */
  let reportsBusy = false;
  let reportsCache = null;

  /**
   * 从日志重算一份战报。
   *
   * 页面（`/api/reports`）和导出页（`/api/reports/export`）都走这里。
   * 两处各算一遍的话，迟早会出现"页面上写 12 场、导出的文件写 11 场"——
   * 而两边的每个数字单独看都完全正常，没人能看出哪边对。口径只有一处的道理，
   * 和 Projection 里 `batteryOf` 被三个路径共用是同一条。
   */
  async function computeReports(days) {
    const all = await app.runner.log_.readAllAsync();
    // 按事件时间过滤，不是按分片文件名：跨天的那一场会被切开，
    // 但"最近 7 天"这类问题本来就只关心时间窗内的部分
    const picked = days > 0 ? all.filter((e) => e.ts >= Date.now() - days * 86400000) : all;

    const reports = buildReports(picked, { roomId: String(app.roomId) });
    return {
      picked,
      reports,
      summary: summarizeReports(reports),
      /**
       * 趋势图的数据。按天聚合、口径与战报完全同源（见 buildDailySeries 的注释）：
       * 前端一根柱子都不许自己算，否则图上和卡片上的数会互相打架。
       */
      series: buildDailySeries(reports),
      // 哪些数字来自"已知有偏差的历史数据"，必须跟着战报一起返回 ——
      // 让用户自己发现"这数字明显不对"，等于没做
      warnings: auditReports(picked),
    };
  }

  r.get('/api/reports', async ({ res, url }) => {
    if (!app.runner?.log_) {
      sendError(res, 503, 'not_ready', '房间还没启动，读不到日志');
      return;
    }
    const days = Math.max(0, Math.floor(Number(url.searchParams.get('days') ?? 0) || 0));

    if (
      reportsCache &&
      reportsCache.days === days &&
      reportsCache.roomId === String(app.roomId) &&
      Date.now() - reportsCache.at < 5000
    ) {
      sendJson(res, { ...reportsCache.payload, cached: true });
      return;
    }
    if (reportsBusy) {
      sendError(res, 429, 'busy', '上一次战报还在算，稍等一下');
      return;
    }

    reportsBusy = true;
    try {
      const data = await computeReports(days);
      const payload = {
        ok: true,
        days,
        reports: data.reports,
        summary: data.summary,
        series: data.series,
        warnings: data.warnings,
        log: app.runner.log_.stats(),
      };
      reportsCache = { days, roomId: String(app.roomId), at: Date.now(), payload };
      sendJson(res, payload);
    } finally {
      reportsBusy = false;
    }
  });

  /**
   * 导出一份自包含的复盘页（单文件 HTML）。
   *
   * 生成逻辑全在 `core/export-report.mjs`（纯函数、可在自检里直接断言），
   * 这里只负责取数据、套文件名、按附件返回。
   *
   * 和 `/api/reports` 共用 `reportsBusy`：两边都在读同一份全量日志，
   * 同时跑两遍只会让卡顿翻倍。撞上了就 429，前端会提示稍后再试。
   */
  r.get('/api/reports/export', async ({ res, url }) => {
    if (!app.runner?.log_) {
      sendError(res, 503, 'not_ready', '房间还没启动，读不到日志');
      return;
    }
    const days = Math.max(0, Math.floor(Number(url.searchParams.get('days') ?? 0) || 0));

    if (reportsBusy) {
      sendError(res, 429, 'busy', '战报还在算，稍等一下再导出');
      return;
    }

    reportsBusy = true;
    try {
      const data = await computeReports(days);
      const roomId = String(app.runner?.realRoomId || app.roomId || '');
      const at = new Date();

      const html = buildReportHtml({
        reports: data.reports,
        summary: data.summary,
        series: data.series,
        warnings: data.warnings,
        meta: {
          roomId,
          title: app.runner?.info?.title ?? '',
          rangeLabel: days > 0 ? `最近 ${days} 天` : '全部',
          at,
          version: app.version,
        },
      });

      const filename = reportFileName({ roomId, at });
      const body = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        ...securityHeaders(),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(body.length),
        // 文件名是纯 ASCII，不需要 RFC 5987 那套 filename*= 编码
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } finally {
      reportsBusy = false;
    }
  });

  /**
   * 时间轴回看：拖一条时间轴，看"到这一刻"这一场是什么样。
   *
   * 与战报同一个数据源（日志重放），但形状是**累积量序列**，
   * 所以必须按需给窗口 —— 用户点的是"这一场"，就只算这一场那一段。
   *
   * 三道校验都是有意义的：
   *   · from/to 必须是数字且 to > from —— 否则算出来的格数没有意义
   *   · 跨度上限 7 天 —— 防止有人顺手把整年的日志拖进来，
   *     那会读几百万条事件、生成一堆没人看的格子
   *   · 并发保护 —— 连点两下不该同时跑两遍全量重放
   */
  const MAX_SPAN_MS = 7 * 86400000;
  let timelineBusy = false;
  r.get('/api/timeline', async ({ res, url }) => {
    if (!app.runner?.log_) {
      sendError(res, 503, 'not_ready', '房间还没启动，读不到日志');
      return;
    }

    /**
     * 注意不用 Number(get('x')) 直接判：缺失时 get 返回 null，而 Number(null) 是 0，
     * 于是 `?to=1700000000000`（忘了 from）会被当成 from=0 一路走到"跨度太大"，
     * 报出"最长支持 7 天"这种和真实原因无关的话。
     */
    const num = (v) => {
      if (v === null || v === '') return NaN
      const n = Number(v)
      return Number.isFinite(n) ? n : NaN
    };
    const from = num(url.searchParams.get('from'));
    const to = num(url.searchParams.get('to'));
    const stepSec = normalizeStep(url.searchParams.get('step'));

    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      sendError(res, 400, 'bad_range', '需要 from / to 两个毫秒时间戳，且 to 必须大于 from');
      return;
    }
    if (to - from > MAX_SPAN_MS) {
      sendError(res, 400, 'too_wide', '时间轴最长支持 7 天，请缩小范围');
      return;
    }

    if (timelineBusy) {
      sendError(res, 429, 'busy', '上一次时间轴还在算，稍等一下');
      return;
    }

    timelineBusy = true;
    try {
      const all = await app.runner.log_.readAllAsync();
      const tl = buildTimeline(all, { from, to, stepSec, roomId: String(app.roomId) });
      sendJson(res, { ok: true, ...tl });
    } finally {
      timelineBusy = false;
    }
  });

  /**
   * 沙盒回放：用当前配置重跑历史日志，返回"会说什么"，一条都不真发。
   *
   * 与对账一样加并发保护：回放要加载一整套独立插件实例，
   * 跑两遍既慢又会让前端看到两份交错的结果。
   */
  let sandboxing = false;
  r.post('/api/sandbox', async ({ req, res }) => {
    if (!app.runner?.log_) {
      sendError(res, 503, 'not_ready', '房间还没启动，读不到日志');
      return;
    }
    if (!app.pluginsDir) {
      sendError(res, 400, 'no_plugins', '启动时没有加载插件（--no-plugins），没有可回放的玩法');
      return;
    }
    if (sandboxing) {
      sendError(res, 429, 'busy', '上一次回放还没跑完，稍等一下');
      return;
    }

    const body = (await readJson(req)) ?? {};
    if (body && typeof body !== 'object') {
      sendError(res, 400, 'bad_request', '请求体必须是对象');
      return;
    }
    const day = typeof body.day === 'string' ? body.day : '';

    sandboxing = true;
    try {
      const events = await app.runner.log_.readAllAsync();
      const picked = day ? events.filter((e) => dayKey(e.ts) === day) : events;
      if (picked.length === 0) {
        sendError(res, 404, 'empty', `${day || '日志'} 里没有事件`);
        return;
      }

      // 上限既是保护内存，也是保护浏览器：一次回放吐出两万条弹幕没人看得完
      const maxSaid = Math.min(Math.max(Math.floor(Number(body.maxSaid) || 500), 1), 5000);

      const result = await replay({
        events: picked,
        pluginsDir: app.pluginsDir,
        configs: app.pluginConfigs,
        enabled: app.pluginEnabled,
        roomId: String(app.roomId),
        maxSaid,
      });

      sendJson(res, { ok: true, day: day || null, ...result });
    } finally {
      sandboxing = false;
    }
  });

  /* ---------------- 插件配置 ---------------- */

  /**
   * 改一个插件的配置。
   *
   * body 直接就是 patch 对象（`{"template": "..."}`），不用包一层 `{patch:...}`：
   * 多一层只是多一个可以写错的地方。
   *
   * 返回收敛后的**完整**配置，前端拿它回填表单 —— 不能回显自己传来的值，
   * 因为 manifest 有 min/max 约束，用户填 100000 而插件实际用 600。
   */
  r.post('/api/plugins/:id/config', async ({ req, res, params }) => {
    const patch = await readJson(req);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      sendError(res, 400, 'bad_request', '请求体必须是 { "字段": 值 } 形式的对象');
      return;
    }
    const config = app.updatePluginConfig(params.id, patch);
    sendJson(res, { ok: true, id: params.id, config });
  });

  r.post('/api/plugins/:id/reset', ({ res, params }) => {
    const config = app.resetPluginConfig(params.id);
    sendJson(res, { ok: true, id: params.id, config });
  });

  r.post('/api/plugins/:id/enabled', async ({ req, res, params }) => {
    const body = await readJson(req);
    if (!body || typeof body.enabled !== 'boolean') {
      sendError(res, 400, 'bad_request', '需要 { "enabled": true|false }');
      return;
    }
    const r = app.setPluginEnabled(params.id, body.enabled);
    sendJson(res, { ok: true, ...r });
  });

  /* ---------------- 账号凭证 ---------------- */

  r.get('/api/auth', ({ res }) => {
    sendJson(res, { ok: true, ...app.authStatus() });
  });

  /**
   * 主动校验 Cookie 还有没有效。
   *
   * 归到**写操作**（POST）而不是 GET：它会联网、会更新昵称、会写日志。
   * 让它能被跨站反复触发没有任何好外 —— 每次一次外网请求 + 50ms CPU，
   * 正好是攻击者最喜欢的形状。
   */
  r.post('/api/auth/check', async ({ res }) => {
    const result = await app.checkAuth();
    sendJson(res, { ok: true, ...result });
  });

  /**
   * 退出登录。会删 `data/auth.json` 并重建运行体 ——
   * 不重建的话长连还攥着旧 Cookie 在跑，界面说"已退出"而实际还在用旧身份。
   */
  r.post('/api/auth/logout', async ({ res }) => {
    const account = await app.logout();
    sendJson(res, { ok: true, account });
  });

  /* ---------------- 访问口令 ---------------- */

  r.get('/api/access', ({ res }) => {
    sendJson(res, { ok: true, ...app.accessStatus() });
  });

  /**
   * 解锁。
   *
   * 这是**唯一**不需要口令的写接口（在 http/write-guard.mjs 的白名单里），
   * 否则一旦设了口令就再也没有入口能把它打开。Origin 检查对它仍然生效。
   */
  r.post('/api/access/unlock', async ({ req, res }) => {
    const body = (await readJson(req)) ?? {};
    try {
      const status = app.unlockAccess(typeof body?.token === 'string' ? body.token : '');
      sendJson(res, { ok: true, ...status });
    } catch (err) {
      sendError(res, err?.status ?? 401, err?.code ?? 'bad_token', err?.message ?? '解锁失败');
    }
  });

  r.post('/api/access/password', async ({ req, res }) => {
    const body = (await readJson(req)) ?? {};
    try {
      const status = app.setAccessPassword(body?.password);
      sendJson(res, { ok: true, ...status });
    } catch (err) {
      sendError(res, err?.status ?? 400, err?.code ?? 'bad_password', err?.message ?? '口令设置失败');
    }
  });

  r.post('/api/access/disable', ({ res }) => {
    sendJson(res, { ok: true, ...app.disableAccess() });
  });

  /* ---------------- 更新检查 ---------------- */

  r.post('/api/update/check', async ({ req, res }) => {
    const body = (await readJson(req)) ?? {};
    const result = await app.checkUpdate({ force: body?.force === true });
    sendJson(res, { ok: true, ...result });
  });

  r.post('/api/update/url', async ({ req, res }) => {
    const body = (await readJson(req)) ?? {};
    try {
      const r = app.setUpdateUrl(body?.url);
      sendJson(res, { ok: true, ...r });
    } catch (err) {
      sendError(res, err?.status ?? 400, err?.code ?? 'bad_url', err?.message ?? '更新源设置失败');
    }
  });

  /* ---------------- 诊断包 ---------------- */

  /**
   * 生成并**直接返回 zip**（不走 JSON）。
   *
   * 用 POST 而不是 GET：包里含配置和状态快照，而 GET 不经过口令闸门
   * （写操作才查）。虽然跨站读不到响应内容（没有 CORS 头），
   * 但"开着口令还留一个免检的读取口"没有道理。
   *
   * 前端用 fetch 拿 blob 再触发下载，见 web/core/api.js 的 `api.diagnostic()`。
   */
  r.post('/api/diagnostic', ({ res }) => {
    const { filename, buffer } = app.makeDiagnostic();
    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'application/zip',
      'Content-Length': String(buffer.length),
      // 文件名是纯 ASCII（yuyue3-diag-2026-11-04_10-30-00.zip），
      // 不需要 RFC 5987 那套 filename*= 编码
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    res.end(buffer);
  });

  /* ---------------- 写操作 ---------------- */

  r.post('/api/dryrun', async ({ req, res }) => {
    const body = await readJson(req);
    if (body === null || typeof body.dryRun !== 'boolean') {
      sendError(res, 400, 'bad_request', '需要 { "dryRun": true|false }');
      return;
    }
    const v = app.setDryRun(body.dryRun);
    sendJson(res, { ok: true, dryRun: v });
  });

  r.post('/api/room', async ({ req, res }) => {
    const body = await readJson(req);
    if (!body || body.roomId === undefined) {
      sendError(res, 400, 'bad_request', '需要 { "roomId": "12345" }');
      return;
    }
    const status = await app.switchRoom(body.roomId);
    sendJson(res, { ok: true, status });
  });

  /**
   * 在跑的房间一览。
   *
   * 每次请求现算：房间数最多 10 个，而"哪个房间在播、有多少弹幕"
   * 是随时在变的东西 —— 缓存它只会让页面显示过期状态。
   */
  r.get('/api/rooms', ({ res }) => {
    sendJson(res, { ok: true, active: app.activeKey, rooms: app.roomsList() });
  });

  /** 关掉一个房间（至少要留一个）。 */
  r.post('/api/rooms/close', async ({ req, res }) => {
    const body = await readJson(req);
    if (!body || body.roomId === undefined) {
      sendError(res, 400, 'bad_request', '需要 { "roomId": "12345" }');
      return;
    }
    const status = await app.closeRoom(body.roomId);
    sendJson(res, { ok: true, status });
  });

  /* 开播/下播提醒的 webhook 配置。
     GET 不是"只是读地址"：企微/钉钉把 key 放在 query、飞书放在路径里，
     这个地址本身就是能往群里发消息的**写凭据**。所以开了访问口令时，
     读它也要口令 —— 否则口令只挡了写、没挡住把钥匙拿走。 */
  r.get('/api/notify', ({ req, res }) => {
    if (app.access?.enabled && !app.access.verify(req?.headers?.['x-access-token'])) {
      sendError(res, 401, 'locked_out', '需要访问口令（在侧栏「访问口令」里解锁）');
      return;
    }
    sendJson(res, { ok: true, webhook: app.notifyWebhook ?? '', report: app.notifyReport === true });
  });

  r.post('/api/notify', async ({ req, res }) => {
    const body = await readJson(req);
    const hasWebhook = typeof body?.webhook === 'string';
    const hasReport = typeof body?.report === 'boolean';
    if (!hasWebhook && !hasReport) {
      sendError(
        res,
        400,
        'bad_request',
        '需要 { "webhook": "https://…", "report": false }；webhook 空串表示关闭',
      );
      return;
    }
    const saved = app.setNotifySettings({
      webhook: hasWebhook ? body.webhook : undefined,
      report: hasReport ? body.report : undefined,
    });
    sendJson(res, { ok: true, ...saved });
  });

  /* 付费用户档案。
     与战报同一个数据源（日志重放）、同一套金额口径（电池），
     区别只在于按 uid 跨场次聚合 —— 页面上的名字和数字不能自己再算一遍。 */
  r.get('/api/patrons', async ({ res, url }) => {
    if (!app.runner?.log_) {
      sendError(res, 503, 'not_ready', '房间还没启动，读不到日志');
      return;
    }

    const daysParam = url.searchParams.get('days');
    const days = daysParam === null ? 30 : Math.max(0, Math.floor(Number(daysParam) || 0));
    const limitParam = url.searchParams.get('limit');
    const limit = Math.min(200, Math.max(1, Math.floor(Number(limitParam) || 30)));

    const all = await app.runner.log_.readAllAsync();
    const data = buildPatrons(all, { days, limit });
    sendJson(res, {
      ok: true,
      ...data,
      bigSpendBattery: app.bigSpendBattery ?? 0,
    });
  });

  /* 单笔大额提醒的阈值。单位是电池：1 元 = 10 电池，0 = 关闭。 */
  r.post('/api/patrons/alert', async ({ req, res }) => {
    const body = await readJson(req);
    if (typeof body?.battery !== 'number') {
      sendError(res, 400, 'bad_request', '需要 { "battery": 10000 }（单位：电池，0 = 关闭）');
      return;
    }
    const battery = app.setBigSpendBattery(body.battery);
    sendJson(res, { ok: true, battery });
  });

  return r;
}

export default buildRoutes;
