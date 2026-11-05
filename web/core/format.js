/**
 * 格式化。
 *
 * 三个单位必须分清，混用会让数字差 10 倍或 100 倍：
 *   金瓜子  B站 报文里的原始单位（内部不使用）
 *   电池    三代内部的统一金额单位，100 金瓜子 = 1 电池
 *   元      1 电池 = 0.1 元
 */

/** 时间戳 → 时分秒 */
export function hhmmss(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 千分位。空值显示 0 而不是 NaN */
export function n(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return '0';
  return Math.round(x).toLocaleString('zh-CN');
}

/** 电池数：整数不带小数点，小数保留一位 */
export function battery(v) {
  const x = Number(v) || 0;
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

/** 电池 → 元 */
export function yuan(v) {
  const x = (Number(v) || 0) / 10;
  if (x >= 1000) return `${(x / 1000).toFixed(1)}k`;
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

/** 毫秒 → "1分23秒" / "12秒" */
export function duration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

/** 毫秒 → "3 分钟前" 这种相对时间，用于"上次收到数据" */
export function ago(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(Number(ms) / 1000);
  if (s < 2) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

/** 大板等级 → 名称 */
export function guardName(level) {
  return { 1: '总督', 2: '提督', 3: '舰长' }[Number(level)] || '大航海';
}

/** 连接状态 → 中文 */
export function connLabel(status) {
  return (
    {
      idle: '未连接',
      connecting: '连接中',
      authenticating: '认证中',
      live: '已连接',
      open: '已连接',
      reclosing: '重连中',
      closed: '已断开',
      error: '连接出错',
    }[status] || status || '未知'
  );
}
