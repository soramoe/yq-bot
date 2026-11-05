/**
 * PK 开场情报：从 getInfoByRoom 里抠出当前 PK 和双方成员。
 *
 * 为什么不用弹幕报文：
 * - PK_BATTLE_* 要先解析类型和字段，断线还会漏；
 * - 这个接口本来就被页面用，字段稳定，`pk_info_v2.pk_basic.status` 就能判断在不在 PK。
 *
 * 只读公开数据，不发言、不改房间状态。
 */

export const PK_INFO_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从 getInfoByRoom 的 JSON 里取 PK 快照。
 * 返回 { active, pkId, startAt, endAt, members:[{uid,roomId,name}] }。
 * 不在 PK / 数据不全时 active=false，其余字段为空。
 */
export function battleOf(json, now = Date.now()) {
  const data = json?.data ?? json;
  const v2 = data?.pk_info_v2 ?? null;
  const basic = v2?.pk_basic ?? null;
  if (!basic || typeof basic !== 'object') {
    return { active: false, pkId: '', startAt: 0, endAt: 0, members: [] };
  }

  const pkId = String(basic.pk_id ?? '').trim();
  const status = num(basic.status);
  const startAt = num(basic.start_time) * 1000;
  const endAt = num(basic.end_time) * 1000;
  // 201/202 是进行中的状态；有的房间只给 end_time，按时间兜底
  const active = Boolean(pkId) && (status === 201 || status === 202 || (endAt > 0 && endAt > now));

  const members = [];
  const list = Array.isArray(v2?.members) ? v2.members : [];
  for (const m of list) {
    const uid = String(m?.uid ?? '').trim();
    const roomId = String(m?.room_id ?? '').trim();
    if (!uid || uid === '0' || !roomId || roomId === '0') continue;
    members.push({
      uid,
      roomId,
      name: String(m?.uname ?? '').trim() || `房间 ${roomId}`,
    });
  }

  return { active, pkId, startAt, endAt, members };
}

/** 拉当前房间的 PK 快照；网络/接口错误直接抛，由调用方决定降级。 */
export async function fetchPkBattle({
  roomId,
  cookie = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
} = {}) {
  const id = String(roomId ?? '').trim();
  if (!id) throw new Error('缺少房间号');
  if (typeof fetchImpl !== 'function') throw new Error('no fetch');

  const url = new URL(PK_INFO_URL);
  url.searchParams.set('room_id', id);
  const res = await fetchImpl(url, {
    headers: {
      'user-agent': UA,
      referer: `https://live.bilibili.com/${id}`,
      ...(cookie ? { cookie } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`getInfoByRoom ${res.status}`);
  const json = await res.json();
  if (json?.code !== 0) throw new Error(json?.message || `getInfoByRoom code ${json?.code}`);
  return battleOf(json);
}

export default fetchPkBattle;
