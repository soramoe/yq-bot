/**
 * 多房间总览：把 `/api/rooms` 的数据整理成"一行一间"。
 *
 * 抽成纯函数而不是直接写在 `app.js` 里，理由和 `core/greetings.js` 一样：
 * **这里最容易写错的判断全都看不见**。比如把"没连上"当成"未开播"，
 * 页面上一样是个灰点加一行小字，不会报错、不会抛异常，
 * 只有用户自己盯着一个永远没数字的房间纳闷。
 *
 * 纯函数之后，`npm run check:web` 能直接喂几个假房间断言这些判断。
 */

import { connLabel, n } from '../core/format.js';

/** 在播？两种状态都算：`live_unknown` 是"有事件在来，但不知道几点开的播" */
const isLiveState = (state) => state === 'live' || state === 'live_unknown';

/**
 * 顶部那一行汇总：几间在跑、几间在播、几间没连上。
 *
 * **不把各间的弹幕/礼物加在一起**：不同直播间的数字加起来说明不了任何事
 * （服务端 `roomsList()` 也刻意不做这件事）。这里只数房间。
 *
 * @param {Array<object>} rooms
 * @returns {{total:number, live:number, broken:number}}
 */
export function summarizeRooms(rooms) {
  const list = Array.isArray(rooms) ? rooms : [];
  return {
    total: list.length,
    live: list.filter((r) => isLiveState(r?.state)).length,
    // `started === false` 才是"没连上"；字段缺失时按"不知道"处理，不诬陷
    broken: list.filter((r) => r?.started === false).length,
  };
}

/**
 * 每一行的展示模型。
 *
 * @param {Array<object>} rooms `GET /api/rooms` 里的 rooms
 * @returns {Array<{
 *   key:string, roomId:string, subtitle:string, title:string,
 *   dot:'live'|'err'|'idle', dotTitle:string,
 *   live:boolean, broken:boolean, active:boolean,
 *   cells:Array<{k:string, v:string}>
 * }>}
 */
export function buildRoomRows(rooms) {
  const list = Array.isArray(rooms) ? rooms : [];

  return list.map((r) => {
    const live = isLiveState(r?.state);
    const broken = r?.started === false;

    return {
      key: String(r?.key ?? r?.roomId ?? ''),
      roomId: String(r?.roomId ?? ''),
      /** 原始对象：点"切到这间"/"关闭"时要把它原样传回去 */
      raw: r,
      /**
       * 副标题。三件事的优先级不能反：
       *   1. 没连上 —— 这是**故障**，不能用"未开播"盖过去（等多久都不会有数据）；
       *   2. 有标题就用标题；
       *   3. 都没有才退回状态词。
       */
      subtitle: broken ? '没连上（再点一次会重试）' : r?.title || (live ? '直播中' : '未开播'),
      title: r?.title || '',
      dot: broken ? 'err' : live ? 'live' : 'idle',
      dotTitle: broken ? '启动失败，没连上 B站' : live ? '直播中' : '未开播',
      live,
      broken,
      active: Boolean(r?.active),
      cells: [
        { k: '弹幕', v: n(r?.danmaku) },
        { k: '礼物', v: n(r?.giftCount) },
        // 0 是"还没收到人气采样"，显示 0 会让人以为直播间没人
        { k: '人气', v: Number(r?.popularity) > 0 ? n(r.popularity) : '—' },
        // 连接状态读 `conn`（机器和 B站 之间），不是 `state`（主播开没开播）
        { k: '连接', v: broken ? '未连上' : connLabel(r?.conn) },
      ],
    };
  });
}
