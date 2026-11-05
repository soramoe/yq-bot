/**
 * 点歌队列：把弹幕（或 SC）里的「点歌 xxx」变成一条可管理的队列。
 *
 * 为什么放在内核层而不是 sc 插件里：
 * - 队列状态要持久化（`data/songs.json`），关掉插件不该把队伍清空；
 * - 页面和接口读的是同一份状态，不能一边插件记、一边页面猜；
 * - 播报只是队列的副作用，队列本身与"说没说出去"无关。
 *
 * 弹幕点歌没有金额，item.yuan 记 0；SC 点歌也兼容，金额照旧记。
 * 免费不等于无限：同一个人同一首歌还在队里时不会重复进队。
 */

/** 队列最多保留多少条（含已播放的当前条） */
export const MAX_SONG_ITEMS = 100;

/** 点歌前缀。只认开头，避免聊到一半带出「点歌」也被收走 */
export const SONG_KEYWORD = '点歌';

/** 歌曲名最长多少字，超过截断（页面一行放得下，也不至于把日志撑爆） */
export const SONG_MAX_LEN = 40;

/** 播放中 / 排队中 */
const ACTIVE = new Set(['playing', 'queued']);

/**
 * 从一条事件里解析点歌请求。
 *
 * 弹幕和 SC 都认：SC 里发「点歌 xxx」和普通弹幕发是完全一样的语义，
 * 金额只影响条目上的展示，不影响排队。
 *
 * @returns {{ song: string } | null} 不是弹幕/SC、不是点歌、或歌名为空 → null
 */
export function parseSongRequest(ev) {
  if (ev?.type !== 'DANMAKU' && ev?.type !== 'SUPER_CHAT') return null;
  const p = ev.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;

  let text = String(p.text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text.startsWith(SONG_KEYWORD)) return null;

  text = text
    .slice(SONG_KEYWORD.length)
    .replace(/^[\s:：,，、.!！?？-]+/, '')
    .trim();
  if (!text) return null;

  return { song: text.slice(0, SONG_MAX_LEN) };
}

/** 显示名：trim uname → trim name → `uid X` → 匿名观众 */
export function songNameOf(p) {
  const uname = String(p?.uname ?? '').trim();
  if (uname) return uname;
  const name = String(p?.name ?? '').trim();
  if (name) return name;
  const uid = String(p?.uid ?? '').trim();
  return uid && uid !== '0' ? `uid ${uid}` : '匿名观众';
}

/**
 * 队列的对外视图。
 *
 * `current` 是播放中的那条（没有就取队首排队的那条，页面可以直接显示
 * "下一首"）；`queued` 只数还在排队的，不含播放中。
 */
export function songQueueView(items = []) {
  const list = Array.isArray(items) ? items : [];
  const current = list.find((it) => it.status === 'playing') ?? list.find((it) => it.status === 'queued') ?? null;
  const queued = list.filter((it) => it.status === 'queued').length;
  return { current, queued, items: list.map((it) => ({ ...it })) };
}

/**
 * 把一条解析好的点歌请求放进队列。
 *
 * 同一个人点同一首歌、且还在队里（排队或播放中）就不重复加；
 * 队列满了先丢「已播放/已完成」的旧记录，再丢最老的。
 */
export function pushSong(items, request, ev, { now = Date.now(), max = MAX_SONG_ITEMS } = {}) {
  if (!request?.song) return null;
  const p = ev.payload ?? {};
  const uid = String(p.uid ?? '').trim();
  if (!uid || uid === '0') return null;

  const dup = items.find(
    (it) => it.uid === uid && it.song === request.song && ACTIVE.has(it.status),
  );
  if (dup) return null;

  const roomId = String(ev.roomId ?? '').trim();
  const item = {
    // 队列是全机器一份，但 seq 是各房间自己的；带上房间号才不会让
    // 两个房间的第 100 条 SC 生成同一个 id、页面删错行。
    id: roomId ? `s${roomId}-${ev.seq}-${uid}` : `s${ev.seq}-${uid}`,
    seq: Number(ev.seq) || 0,
    ts: Number(ev.ts) || now,
    uid,
    name: songNameOf(p),
    song: request.song,
    yuan: Number(p.yuan) || 0,
    status: 'queued',
  };
  items.push(item);

  const limit = Math.max(1, Math.floor(Number(max) || MAX_SONG_ITEMS));
  while (items.length > limit) {
    const idle = items.findIndex((it) => !ACTIVE.has(it.status));
    if (idle >= 0) items.splice(idle, 1);
    else items.shift();
  }
  return item;
}

/**
 * 队列位置：从 1 开始，按列表顺序数到这条为止（含播放中）。
 * 找不到返回 0。
 */
export function songPosition(items, id) {
  const list = Array.isArray(items) ? items : [];
  const idx = list.findIndex((it) => it.id === id);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * 执行一个队列动作。
 * - play：把当前播放中的放回排队，再把目标设为播放中；
 * - done / skip：从队列里移除；
 * - 找不到 id → null。
 */
export function applySongAction(items, id, action) {
  const list = Array.isArray(items) ? items : [];
  const idx = list.findIndex((it) => it.id === id);
  if (idx < 0) return null;

  const item = list[idx];
  if (action === 'play') {
    for (const it of list) if (it.status === 'playing') it.status = 'queued';
    item.status = 'playing';
    return item;
  }
  if (action === 'done' || action === 'skip') {
    list.splice(idx, 1);
    return item;
  }
  return null;
}
