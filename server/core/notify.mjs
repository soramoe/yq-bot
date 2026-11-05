/**
 * 开播 / 下播提醒的对外通知。
 *
 * 拆成独立模块（而不是写在 app.mjs 里）的理由和 `export-report.mjs` 一样：
 * 这里最容易错的是**各平台的载荷形状**——企微和钉钉同形、飞书另起一套，
 * 写错一个字段名，机器人那边一声不吭，这边还以为通知发出去过。
 * 纯函数化之后自检可以直接喂 URL 断言形状。
 */

/**
 * 通知文案。
 *
 * 刻意带上房间号：多房间是这个功能的前提——「开播了」三个字只有
 * 配合「哪一间」才有信息量。标题可能还没有（ROOM_CHANGE 通常紧跟
 * LIVE 之后才到），缺了就只说房间号，不硬凑。
 *
 * @param {{kind:'start'|'end', roomId:number|string, title?:string}} o
 * @returns {string}
 */
export function notifyText({ kind, roomId, title = '' }) {
  const head = kind === 'start' ? '开播' : '下播';
  const id = String(roomId ?? '');
  const t = String(title ?? '').trim();
  return t ? `【${head}】房间 ${id} · ${t}` : `【${head}】房间 ${id}`;
}

/** 电池数 → 元的展示串。10 电池 = 1 元；整数不带 `.0`，其余留一位小数。 */
function yuanText(battery) {
  const yuan = (Number(battery) || 0) / 10;
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(1);
}

/** 秒数 → 「1 小时 2 分」；不足一分钟不显示「0 分钟」。 */
function durationText(sec) {
  const totalMin = Math.max(0, Math.round((Number(sec) || 0) / 60));
  if (totalMin < 1) return '不到 1 分钟';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (!h) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/**
 * 下播战报文案。
 *
 * 和开播/下播提醒共用一个 webhook：配一次地址，两类消息都到同一个群。
 * 数字全部来自投影刚封存的那一场，不重新翻日志 —— 下播这条边沿本身就是
 * 「这一场已经结束」的信号，再扫一遍日志只会让消息晚到、还可能读到下一场。
 *
 * `implicit`（起点未知）与 `endedAtEstimated`（结束时间是推算的）都要在
 * 文案里说清楚：战报最怕的是看起来精确、其实拍脑袋。
 *
 * @param {{roomId:number|string, title?:string, summary:object, topGifters?:object[]}} o
 * @returns {string}
 */
export function reportText({ roomId, title = '', summary = {}, topGifters = [] }) {
  const id = String(roomId ?? '');
  const t = String(title ?? '').trim();
  const lines = [`【本场战报】房间 ${id}${t ? ` · ${t}` : ''}`];

  const dur = Math.max(0, Number(summary.durationSec) || 0);
  const approx = summary.implicit || summary.endedAtEstimated ? '约 ' : '';
  const unknown = summary.implicit ? '（起点未知）' : '';
  lines.push(
    `时长 ${approx}${durationText(dur)}${unknown} · 观众 ${Number(summary.uniqueViewers) || 0} · 弹幕 ${Number(summary.danmaku) || 0}`,
  );

  const paid = [];
  if (Number(summary.giftCount) > 0) {
    paid.push(`礼物 ${summary.giftCount} 个 ¥${yuanText(summary.giftBattery)}`);
  }
  if (Number(summary.guardCount) > 0) {
    paid.push(`舰长 ${summary.guardCount} 个 ¥${yuanText(summary.guardBattery)}`);
  }
  if (Number(summary.scCount) > 0) {
    paid.push(`SC ${summary.scCount} 条 ¥${yuanText(summary.scBattery)}`);
  }
  if (paid.length) {
    lines.push(paid.join(' · '));
    lines.push(`总收入 ¥${yuanText(summary.totalBattery)}`);
  } else {
    lines.push('本场没有礼物、舰长或 SC');
  }

  const tops = (Array.isArray(topGifters) ? topGifters : [])
    .filter((g) => g && String(g.name ?? '').trim())
    .slice(0, 3);
  if (tops.length) {
    lines.push(`Top 送礼：${tops.map((g) => `${g.name} ¥${yuanText(g.battery)}`).join('、')}`);
  }

  return lines.join('\n');
}

/**
 * 按目标平台拼 webhook 载荷。
 *
 * 企微（qyapi.weixin.qq.com）与钉钉（oapi.dingtalk.com）用同一形状：
 *   `{ msgtype: 'text', text: { content } }`
 * 飞书（open.feishu.cn）是：
 *   `{ msg_type: 'text', content: { text } }`
 *
 * 认不出的地址按企微/钉钉形状发 —— 那是事实上的通用格式，
 * 大多数自建网关也按它收。
 *
 * @param {string} url
 * @param {string} text
 * @returns {object}
 */
export function buildWebhookPayload(url, text) {
  const content = String(text ?? '');
  const host = String(url ?? '').toLowerCase();

  if (host.includes('open.feishu.cn') || host.includes('open.larksuite.com')) {
    return { msg_type: 'text', content: { text: content } };
  }
  return { msgtype: 'text', text: { content } };
}

/**
 * 日志里用的脱敏地址。
 *
 * webhook 地址本身就是凭证：企微/钉钉把 key 放在 query，飞书把 key 放在路径里。
 * 失败日志原样打出来，等于把机器人钥匙抄进日志文件（而日志会被导出、发给人看）。
 * 只留域名，其余一律省略——够定位"发给了哪家"，不够被别人拿去发消息。
 *
 * @param {string} url
 * @returns {string}
 */
export function maskWebhook(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.origin}/…`;
  } catch {
    return '…';
  }
}

/**
 * 从 HTTP 200 的响应体里找出"其实失败了"。
 *
 * 企微、钉钉、飞书在 key 失效、机器人被删、限流时**照样回 200**，
 * 失败只写在 body 的 errcode / code 里。只看 `res.ok` 的结果是：
 * 群里一条消息没有，这边日志一片安静，用户以为通知发过了。
 *
 * 只对认得出的形状下判断：`errcode` 是企微/钉钉的强特征；飞书的 `code`
 * 才是 0/非 0。别的自建网关可能用 `code: 200` 表示成功 —— 那种不能按
 * 非 0 判失败，所以非飞书地址不读 `code`。
 *
 * @param {string} url
 * @param {object|null} body
 * @returns {string} 空串 = 成功；否则是给日志看的失败原因
 */
export function webhookError(url, body) {
  if (!body || typeof body !== 'object') return '';

  if (body.errcode !== undefined && body.errcode !== null) {
    if (Number(body.errcode) === 0) return '';
    const msg = body.errmsg ?? body.msg ?? '';
    return msg ? `errcode ${body.errcode}: ${msg}` : `errcode ${body.errcode}`;
  }

  const isFeishu = /open\.(feishu\.cn|larksuite\.com)/i.test(String(url ?? ''));
  if (isFeishu) {
    const code = body.code ?? body.StatusCode;
    if (code === undefined || code === null) return '';
    if (Number(code) === 0) return '';
    const msg = body.msg ?? body.StatusMessage ?? '';
    return msg ? `code ${code}: ${msg}` : `code ${code}`;
  }
  return '';
}

/**
 * 发一次 webhook。永不抛出：通知是尽力而为的附属功能，
 * 失败只体现在返回值里（调用方记一条日志就够，不该再往上炸）。
 *
 * @param {string} url
 * @param {string} text
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
export async function sendWebhook(url, text, { fetchImpl, timeoutMs = 8000 } = {}) {
  const fetcher = fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== 'function') return { ok: false, error: 'no fetch' };

  try {
    const res = await fetcher(String(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildWebhookPayload(url, text)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res?.ok) return { ok: false, status: res?.status };

    // 有些地址（自建网关、204）没有 JSON body；读不出来不等于失败
    let body = null;
    if (typeof res.json === 'function') {
      body = await res.json().catch(() => null);
    }

    const bad = webhookError(url, body);
    if (bad) return { ok: false, status: res.status, error: bad };
    return { ok: true, status: res?.status };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
