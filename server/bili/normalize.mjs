/**
 * 原始报文 → 规范事件。
 *
 * 这一层是**唯一允许知道 B站 报文长什么样**的地方。
 * 投影、插件、自检都只看到 `{type, payload}`。
 *
 * 报文形状的坑都集中在这里，每条都注明是实测结论还是推测：
 *
 *   DANMU_MSG    info[1] 文本 / info[2][0] uid / info[2][1] 昵称
 *                info[2][2] 是**房管**标志（不是主播！二代曾误判）
 *                info[3] 粉丝牌 / info[7] 舰长等级
 *                info[16][0] 荣耀等级（**不是 info[4][0]**，那是别的东西）
 *   INTERACT_WORD  msg_type 1 进场 / 2 关注 / 3 分享
 *   SEND_GIFT     total_coin 是本次总价（金瓜子），coin 是单价
 *
 * 金额单位统一：报文里是**金瓜子**，三代内部一律换算成**电池**
 * （100 金瓜子 = 1 电池 = 0.1 元）。混用这两个单位会让统计差 100 倍。
 */

import { EVENT } from '../core/events.mjs';
import { readPb, pbNum, pbStr, pbMsg, pbBytes, decodeBase64Pb } from './pb.mjs';

/** 100 金瓜子 = 1 电池 = 0.1 元 */
export const COIN_PER_BATTERY = 100;

/** 金瓜子 → 电池，保留一位小数 */
export function toBattery(coin) {
  return Math.round(((Number(coin) || 0) / COIN_PER_BATTERY) * 10) / 10;
}

/** B站 的 cmd 可能带后缀，如 `DANMU_MSG:4:0:2:2:2:0` */
export function baseCmd(cmd) {
  return String(cmd || '').split(':')[0];
}

/**
 * 把一条原始报文归一化成事件。
 * @param {object} raw 长连收到并 JSON 解析后的消息（含 cmd / data / info…）
 * @returns {{type:string, payload:object}|null} 不关心的事件返回 null
 */
export function normalize(raw) {
  const cmd = baseCmd(raw?.cmd);
  if (!cmd) return null;

  const d = raw.data || {};

  switch (cmd) {
    case 'DANMU_MSG':
      return normalizeDanmaku(raw);

    case 'INTERACT_WORD':
      return normalizeInteract(d);

    case 'INTERACT_WORD_V2':
      return normalizeInteractV2(d);

    case 'SEND_GIFT':
      return normalizeGift(d);

    case 'SEND_GIFT_V2':
      return normalizeGiftV2(d);

    case 'GUARD_BUY':
      return normalizeGuard(d);

    case 'SUPER_CHAT_MESSAGE':
      return normalizeSuperChat(d);

    case 'LIKE_INFO_V3_CLICK':
      return {
        type: EVENT.LIKE,
        payload: {
          uid: String(d.uid ?? ''),
          uname: String(d.uname ?? ''),
          count: 1,
        },
      };

    case 'ONLINE_RANK_COUNT':
      return {
        type: EVENT.ONLINE_COUNT,
        payload: { count: Number(d.count ?? d.online_count ?? 0) || 0 },
      };

    /* 开播 / 下播：只产出状态事件，不带人气值。
       二代曾在这里凭空造一条「人气 0」，导致每次开播都写一条假数据。 */
    case 'LIVE':
      return { type: EVENT.LIVE_START, payload: { liveTime: toSeconds(d.live_time) } };

    /* PREPARING 是正常下播；ROUND 是转轮播、CUT_OFF 是被平台切断。
       三种都意味着"不再直播中" —— 漏掉后两种，投影会停在 live，
       定时播报 / 主动打招呼的 onlyWhenLive 判断就一直当成在播。 */
    case 'PREPARING':
    case 'ROUND':
    case 'CUT_OFF':
      return { type: EVENT.LIVE_END, payload: { liveTime: toSeconds(d.live_time) } };

    /* 主播改标题（开播时几乎必推一次）。
       info.title 若不跟着更新，页头与总览的标题会停在启动时刻。 */
    case 'ROOM_CHANGE': {
      const title = String(d.title ?? '').trim();
      if (!title) return null; // 空变更：B站 偶尔推，不值得记一条
      return { type: EVENT.ROOM_TITLE, payload: { title } };
    }

    default:
      // B站 会推大量我们不关心的 cmd，静默忽略是设计而非疏漏
      return null;
  }
}

/* ---------------- 各类消息 ---------------- */

function normalizeDanmaku(raw) {
  const info = Array.isArray(raw.info) ? raw.info : [];

  // text 只取 info[1]。二代在 info[1] 缺失时回退到 info[2][0]，
  // 而那是 uid —— 会把一串数字当成弹幕内容播报出去。
  const text = String(info[1] ?? '');

  const user = Array.isArray(info[2]) ? info[2] : [];
  const uid = String(user[0] ?? '');
  const uname = String(user[1] ?? '');
  const isAdmin = Boolean(user[2]); // 房管，不是主播

  const meta = Array.isArray(info[0]) ? info[0] : [];

  return {
    type: EVENT.DANMAKU,
    payload: {
      uid,
      uname,
      text,
      isAdmin,
      medal: medalFromInfo(info),
      guardLevel: Number(info[7]) || 0,
      // 图片/表情弹幕：内容是图，text 往往为空
      imageUrl: String(meta[13] ?? ''),
      imageAlt: String(meta[15]?.emoticon_unique ?? ''),
      // 荣耀等级在 info[16][0]（实测）。info[4][0] 是另一个值，取它会一直取错。
      honorLevel: Number(info[16]?.[0]) || 0,
      honorLabel: String(info[4]?.[3] ?? ''),
    },
  };
}

/** info[3] = [粉丝牌等级, 粉丝牌名, 主播uid, …] */
function medalFromInfo(info) {
  const m = info?.[3];
  if (!Array.isArray(m) || m.length === 0) return null;
  const name = m[1];
  if (!name) return null;
  return { name: String(name), level: Number(m[0]) || 0 };
}

function normalizeInteract(d) {
  // msg_type: 1 进场 / 2 关注 / 3 分享。有的版本字段名是 msgType
  const t = Number(d.msg_type ?? d.msgType ?? 1) || 1;
  const uid = String(d.uid ?? '');
  const uname = String(d.uname ?? '');
  const medal = interactMedal(d);
  const guardLevel = interactGuardLevel(d);

  if (t === 2) return { type: EVENT.FOLLOW, payload: { uid, uname, medal } };
  if (t === 3) return { type: EVENT.SHARE, payload: { uid, uname, medal } };
  return { type: EVENT.ENTER, payload: { uid, uname, medal, guardLevel } };
}

/**
 * 新版进场：data.pb 是 base64 protobuf。
 * 字段号来自实测抓包：#1 uid / #2 uname / #5 msg_type / #6 roomId
 */
function normalizeInteractV2(d) {
  const f = decodeBase64Pb(d?.pb);
  if (!f || f.size === 0) return null;

  const uid = String(pbNum(f, 1, 0) || '');
  const uname = pbStr(f, 2, '');
  const t = Number(pbNum(f, 5, 1)) || 1;

  const medal = interactMedal(d);
  const guardLevel = interactGuardLevel(d);

  if (t === 2) return { type: EVENT.FOLLOW, payload: { uid, uname, medal } };
  if (t === 3) return { type: EVENT.SHARE, payload: { uid, uname, medal } };
  return { type: EVENT.ENTER, payload: { uid, uname, medal, guardLevel } };
}

function interactMedal(d) {
  const m = d?.fans_medal;
  if (!m) return null;
  const name = String(m.medal_name || m.name || '');
  if (!name) return null;
  return { name, level: Number(m.medal_level ?? m.level) || 0 };
}

function interactGuardLevel(d) {
  return (
    Number(
      d?.guard_level ??
        d?.guardLevel ??
        d?.fans_medal?.guard_level ??
        d?.fans_medal?.guardLevel ??
        0,
    ) || 0
  );
}

/** 旧版礼物（JSON） */
function normalizeGift(d) {
  const num = Math.max(1, Number(d.num) || 1);
  const coinType = String(d.coin_type || '');

  // total_coin 是本次总价（金瓜子）；缺了用 单价 × 数量 兜底
  const totalCoin = Number(d.total_coin) > 0 ? Number(d.total_coin) : (Number(d.coin) || 0) * num;

  const battery = toBattery(totalCoin);

  return {
    type: EVENT.GIFT,
    payload: {
      uid: String(d.uid ?? ''),
      uname: String(d.uname ?? ''),
      giftId: Number(d.giftId ?? d.gift_id) || 0,
      giftName: String(d.giftName ?? d.gift_name ?? ''),
      num,
      // 单价 = 总价 / 数量，可能不是整数（如 3 个 100 金瓜子）
      price: num > 0 ? Math.round((battery / num) * 10) / 10 : battery,
      battery,
      coinType,
      isPaid: coinType === 'gold',
      comboCount: Number(d.combo_num ?? d.combo_count) || 0,
      comboCoin: Number(d.combo_coin ?? d.comboCoin) || 0,
      blind: blindFromJson(d, { num, valueBattery: battery }),
      medal: d.medal_info
        ? {
            name: String(d.medal_info.medal_name || ''),
            level: Number(d.medal_info.medal_level) || 0,
          }
        : null,
      guardLevel: Number(d.guard_level) || 0,
    },
  };
}

/**
 * 新版礼物：data.pb 是 base64 protobuf，且**没有公开 schema**。
 *
 * 字段号靠实测对出来（二代用 20 条样本核对过）：
 *   礼物明细层 #1 礼物id #2 名称 #3 数量 #5 单价 #6 总价 #8 gold/silver
 *   第 9 层是盲盒信息，普通礼物没有这一层
 *
 * 识别方式：递归找"某个子消息里 #8 是 gold/silver"的那一层。
 */
function normalizeGiftV2(d) {
  const top = decodeBase64Pb(d?.pb);
  const detail = findGiftDetail(top);
  if (!detail) return null;

  // 送礼人**在 pb 顶层**：#1 uid、#2 uname。
  // data 上并没有这两个字段 —— 直接读 d.uid 会得到空串，
  // 表现出来是"礼物金额对、送礼人是空"，送榜永远是空的，而且不报错。
  // （二代同款报文，同样是读顶层。）
  const uid = String(pbNum(top, 1, 0) || '') || String(d?.uid ?? '');
  const uname = pbStr(top, 2, '') || String(d?.uname ?? '');

  const num = Math.max(1, Number(detail.num) || 1);
  const totalCoin = Number(detail.total) > 0 ? Number(detail.total) : (Number(detail.price) || 0) * num;
  const battery = toBattery(totalCoin);

  return {
    type: EVENT.GIFT,
    payload: {
      uid,
      uname,
      giftId: detail.giftId,
      giftName: detail.giftName,
      num,
      price: num > 0 ? Math.round((battery / num) * 10) / 10 : battery,
      battery,
      coinType: detail.coinType,
      isPaid: detail.coinType === 'gold',
      comboCount: detail.comboCount,
      comboCoin: detail.comboCoin,
      // 盲盒：正常礼物这里是 null。**只有报文明确给了盒子信息才算**，
      // 绝不靠奖品 id 反猜 —— 有些奖品本身也能单独赠送，反猜会把普通礼物算成盲盒。
      blind: findBlindBox(top, { num, valueBattery: battery }),
      medal: null,
      guardLevel: 0,
    },
  };
}

function findGiftDetail(fields, depth = 0) {
  if (!fields || depth > 4) return null;

  for (const [, list] of fields) {
    for (const e of list) {
      if (e.wire !== 2 || !e.bytes || e.bytes.length === 0) continue;

      const sub = readPb(e.bytes);
      if (!sub || sub.size === 0) continue;

      const id = pbNum(sub, 1, 0);
      const coin = pbStr(sub, 8, '');
      if (id && (coin === 'gold' || coin === 'silver')) {
        return {
          giftId: id,
          giftName: pbStr(sub, 2, ''),
          num: pbNum(sub, 3, 1) || 1,
          price: pbNum(sub, 5, 0),
          total: pbNum(sub, 6, 0),
          coinType: coin,
          comboCount: pbNum(sub, 11, 0),
          comboCoin: pbNum(sub, 14, 0),
        };
      }

      const deeper = findGiftDetail(sub, depth + 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

/**
 * 盲盒信息。
 *
 * 字段号来自实测（二代用 20 条真实盲盒样本核对过，13/13 命中）：
 *   顶层第 9 层：#2 盒子 id、#3 盒子名、#6 盒子单价（金瓜子）
 * 普通礼物**没有第 9 层**，所以这一层存在与否本身就是可靠的判据。
 *
 * 成本按「盒子单价 × 数量」算：一次买 3 个盒子就是 3 份钱。
 * 盈亏 = 奖品价值（报文里的 total）− 成本，单位一律电池。
 */
function findBlindBox(top, { num, valueBattery }) {
  const meta = top ? pbMsg(top, 9) : null;
  if (!meta) return null;

  const boxId = pbNum(meta, 2, 0);
  const boxName = pbStr(meta, 3, '');
  const boxCoin = pbNum(meta, 6, 0);
  if (!boxId || !boxName || boxCoin <= 0) return null;

  return blindResult({ boxId, boxName, boxCoin, num, valueBattery });
}

/**
 * 旧版 SEND_GIFT 偶尔会带 `blind_gift` 对象（不是所有盲盒都带）。
 * 带了就用；没带就当普通礼物 —— 老报文没有可靠判据，宁可少报也不误报。
 */
function blindFromJson(d, { num, valueBattery }) {
  const meta = d?.blind_gift || d?.blindGift || d?.blind_gift_info;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;

  const boxId =
    Number(meta.blind_gift_id ?? meta.box_id ?? meta.original_gift_id) || 0;
  const boxName = String(
    meta.blind_gift_name ?? meta.box_name ?? meta.original_gift_name ?? '',
  ).trim();
  const boxCoin = Number(meta.blind_gift_price ?? meta.original_gift_price) || 0;
  if (!boxId || !boxName || boxCoin <= 0) return null;

  return blindResult({ boxId, boxName, boxCoin, num, valueBattery });
}

/** 盲盒结果的统一形状。放一处算，两个入口才不会一个扣成本一个不扣 */
function blindResult({ boxId, boxName, boxCoin, num, valueBattery }) {
  const count = Math.max(1, Number(num) || 1);
  const cost = round1(toBattery(boxCoin) * count);
  const value = round1(valueBattery);
  return {
    boxId,
    boxName,
    num: count,
    /** 成本（电池） */
    cost,
    /** 开出的奖品价值（电池） */
    value,
    /** 盈亏（电池），负数表示亏 */
    profit: round1(value - cost),
  };
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function normalizeGuard(d) {
  const num = Math.max(1, Number(d.num) || 1);
  const guardLevel = Number(d.guard_level) || 0;

  const reported = Number(d.price) || 0;
  // 实付价可能单独给；有就优先用（优惠/续费时和标价不同）
  const paid =
    [d.pay_price, d.actual_price, d.real_pay_price, d.renew_price, d.total_coin]
      .map(Number)
      .find((n) => Number.isFinite(n) && n > 0) || 0;

  const coinTotal = (paid || reported) * num;
  const battery = toBattery(coinTotal);

  const isRenew =
    [d.is_renew, d.renew, d.is_renew_guard, d.auto_renew, d.auto_renewal].some(
      (v) => v === true || Number(v) === 1,
    ) || /续费|自动续费/.test(String(d.gift_name || d.giftName || ''));

  return {
    type: EVENT.GUARD_BUY,
    payload: {
      uid: String(d.uid ?? ''),
      uname: String(d.uname ?? ''),
      guardLevel,
      num,
      price: num > 0 ? Math.round((battery / num) * 10) / 10 : battery,
      battery,
      isRenew,
    },
  };
}

/**
 * 醒目留言。
 *
 * **注意单位**：SC 报文的 `price` 是**元**，不是金瓜子。
 * 这一点和其他所有事件都不同（礼物/上舰都是金瓜子 + toBattery）。
 *
 * 这里曾经直接套 `toBattery(d.price)`，于是 100 元的 SC 被算成
 * `100 / 100 = 1` 电池 = 0.1 元 —— **差了 1000 倍**，而且不会报错。
 *
 * 证据是实测日志：一条置顶 300 秒的 SC 记为 `battery: 1`。
 * B站 的置顶时长是金额决定的（100 元 = 300 秒），所以它的真实金额
 * 是 100 元，而 `1` 正是 `100 / 100` 的结果。
 *
 * 换算用报文自带的 `rate`（每元多少金瓜子，实测 1000）：
 *   battery = 元 × rate ÷ 100(金瓜子/电池)
 * 这样即便哪天 B站 改了单位约定，只要 rate 跟着变，结果仍然对。
 * rate 缺失时退回「1 元 = 10 电池」。
 */
const YUAN_TO_BATTERY = 10;

function normalizeSuperChat(d) {
  const yuanRaw = Number(d.price) || 0;
  const rate = Number(d.rate) || 0;

  const battery =
    rate > 0
      ? Math.round(((yuanRaw * rate) / COIN_PER_BATTERY) * 10) / 10
      : Math.round(yuanRaw * YUAN_TO_BATTERY * 10) / 10;

  const yuan = Math.round(yuanRaw * 10) / 10;

  return {
    type: EVENT.SUPER_CHAT,
    payload: {
      uid: String(d.uid ?? ''),
      uname: String(d.user_info?.uname ?? d.uname ?? ''),
      text: String(d.message ?? ''),
      /** 元。模板里的 {金额} 直接用这个，别再除 */
      yuan,
      battery,
      price: yuan,
      duration: Number(d.time) || 0,
    },
  };
}

function toSeconds(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 0;
  // 有时候给的是毫秒
  return n > 1e11 ? Math.floor(n / 1000) : n;
}
