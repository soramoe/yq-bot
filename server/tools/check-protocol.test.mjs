/**
 * 协议层自检（全离线）。
 *
 * 这个文件的价值在于**把领域知识固化成断言**。
 * 下面每一条"荣耀等级取 info[16][0]""房管标志不是主播标志""100 金瓜子 = 1 电池"
 * 都是二代用真实报文核对出来的结论 —— 写在这里，以后谁改错就是测试红，
 * 而不是等主播发现"欢迎语叫错了人"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { deflateSync, brotliCompressSync } from 'node:zlib';

import { encode, decode, parseJson, parsePopularity, OP, VER, HEADER_LEN } from '../bili/packet.mjs';
import { readPb, pbNum, pbStr } from '../bili/pb.mjs';
import { normalize, baseCmd, toBattery, COIN_PER_BATTERY } from '../bili/normalize.mjs';
import { LiveClient, STATUS } from '../bili/live-client.mjs';
import { EVENT } from '../core/events.mjs';

/* ---------------- 二进制包 ---------------- */

test('packet：单包编解码往返', () => {
  const buf = encode(OP.MESSAGE, { cmd: 'DANMU_MSG', hello: '世界' }, VER.PLAIN);
  assert.equal(buf.readUInt16BE(4), HEADER_LEN, '头长度必须是 16');

  const packets = decode(buf);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].op, OP.MESSAGE);
  assert.equal(packets[0].ver, VER.PLAIN);
  assert.equal(parseJson(packets[0].body).cmd, 'DANMU_MSG');
});

test('packet：一个 TCP 包里塞多个逻辑包，要全部拆出来', () => {
  const merged = Buffer.concat([
    encode(OP.MESSAGE, { cmd: 'A' }),
    encode(OP.MESSAGE, { cmd: 'B' }),
    encode(OP.HEARTBEAT_REPLY, ''),
  ]);

  const packets = decode(merged);
  assert.equal(packets.length, 3);
  assert.equal(parseJson(packets[0].body).cmd, 'A');
  assert.equal(parseJson(packets[1].body).cmd, 'B');
  assert.equal(packets[2].op, OP.HEARTBEAT_REPLY);
});

test('packet：zlib 里套着多个包，必须递归拆开（只拆一层会丢一整批弹幕）', () => {
  const inner = Buffer.concat([
    encode(OP.MESSAGE, { cmd: 'X1' }),
    encode(OP.MESSAGE, { cmd: 'X2' }),
    encode(OP.MESSAGE, { cmd: 'X3' }),
  ]);

  const packets = decode(encode(OP.MESSAGE, deflateSync(inner), VER.ZLIB));
  assert.equal(packets.length, 3, '压缩包里的三条消息都要出来');
  assert.deepEqual(
    packets.map((p) => parseJson(p.body).cmd),
    ['X1', 'X2', 'X3'],
    '顺序不能乱',
  );
});

test('packet：brotli 包同样能解开', () => {
  const inner = Buffer.concat([encode(OP.MESSAGE, { cmd: 'B1' }), encode(OP.MESSAGE, { cmd: 'B2' })]);
  const packets = decode(encode(OP.MESSAGE, brotliCompressSync(inner), VER.BROTLI));
  assert.equal(packets.length, 2);
});

test('packet：坏数据不至于打崩，只是解不出东西', () => {
  // 长度字段声称 1000 字节，实际只有 20
  const bad = Buffer.alloc(20);
  bad.writeUInt32BE(1000, 0);
  bad.writeUInt16BE(16, 4);

  assert.deepEqual(decode(bad), [], '长度不合法就直接放弃，不能越界读');

  // 压缩包内容坏掉
  const broken = encode(OP.MESSAGE, Buffer.from('not really zlib'), VER.ZLIB);
  assert.deepEqual(decode(broken), []);
});

test('packet：人气值只读前 4 字节', () => {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(12345, 0);
  assert.equal(parsePopularity(buf), 12345);
  assert.equal(parsePopularity(Buffer.alloc(0)), 0);
});

/* ---------------- protobuf ---------------- */

/** 手工拼一个最小的 protobuf 消息：字段号 + varint */
function varint(n) {
  const out = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function pbFieldStr(fieldNo, text) {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(payload.length), payload]);
}

function pbFieldNum(fieldNo, num) {
  return Buffer.concat([varint((fieldNo << 3) | 0), varint(num)]);
}

test('pb：能按字段号取到字符串和数字', () => {
  const buf = Buffer.concat([pbFieldNum(1, 1970515035), pbFieldStr(2, '小明'), pbFieldNum(5, 1)]);
  const fields = readPb(buf);

  assert.equal(pbNum(fields, 1), 1970515035);
  assert.equal(pbStr(fields, 2), '小明');
  assert.equal(pbNum(fields, 5), 1);
});

test('pb：坏字节不抛异常，能取多少取多少', () => {
  assert.doesNotThrow(() => readPb(Buffer.from([0xff, 0xff, 0xff])));
  assert.equal(readPb(Buffer.alloc(0)).size, 0);
  assert.equal(readPb(null).size, 0);
});

/* ---------------- 归一化：弹幕 ---------------- */

/** 造一条 DANMU_MSG 的 info 数组（索引位置必须准确，这正是被测的东西） */
function danmakuInfo(overrides = {}) {
  const info = [];
  info[0] = [];
  info[1] = '晚上好呀';
  info[2] = [12345, '小明', 0, 0, 0];
  info[3] = [21, '渔月崽', 3273440];
  info[4] = [0, 0, 0, '>50000', 1]; // ← 这个位置的 [0] 不是荣耀等级
  for (let i = 5; i <= 15; i++) info[i] = 0;
  info[7] = 3; // 舰长
  info[16] = [35]; // ← 荣耀等级在这里

  return Object.assign(info, overrides);
}

test('归一化：弹幕的文本、用户、粉丝牌都能取对', () => {
  const ev = normalize({ cmd: 'DANMU_MSG:4:0:2:2:2:0', info: danmakuInfo() });

  assert.equal(ev.type, EVENT.DANMAKU);
  assert.equal(ev.payload.text, '晚上好呀');
  assert.equal(ev.payload.uid, '12345');
  assert.equal(ev.payload.uname, '小明');
  assert.deepEqual(ev.payload.medal, { name: '渔月崽', level: 21 });
  assert.equal(ev.payload.guardLevel, 3);
});

test('归一化：荣耀等级取 info[16][0]，不是 info[4][0]', () => {
  const ev = normalize({ cmd: 'DANMU_MSG', info: danmakuInfo() });

  // info[4][0] 是 0，info[16][0] 是 35 —— 取错位置会一直显示 0 或别的数字
  assert.equal(ev.payload.honorLevel, 35, '荣耀等级必须是 info[16][0]');
  assert.equal(ev.payload.honorLabel, '>50000');
});

test('归一化：弹幕文本缺失时不能把 uid 当成文本', () => {
  const info = danmakuInfo();
  info[1] = undefined;

  const ev = normalize({ cmd: 'DANMU_MSG', info });
  assert.equal(ev.payload.text, '', 'info[1] 缺失就该是空字符串，绝不能取 info[2][0]');
  assert.notEqual(ev.payload.text, '12345');
});

test('归一化：info[2][2] 是房管标志，不是主播标志', () => {
  const info = danmakuInfo();
  info[2] = [12345, '小明', 1]; // 房管

  const ev = normalize({ cmd: 'DANMU_MSG', info });
  assert.equal(ev.payload.isAdmin, true);
  assert.equal('isOwner' in ev.payload, false, '主播身份由内核按 anchorUid 判定，适配层不猜');
});

test('归一化：图片弹幕能取到图地址', () => {
  const info = danmakuInfo();
  info[0] = [];
  info[0][13] = 'https://i0.hdslb.com/bfs/emote/abc.png';
  info[0][15] = { emoticon_unique: 'room_123' };
  info[1] = '';

  const ev = normalize({ cmd: 'DANMU_MSG', info });
  assert.match(ev.payload.imageUrl, /hdslb\.com/);
  assert.equal(ev.payload.imageAlt, 'room_123');
});

/* ---------------- 归一化：进场 / 关注 / 分享 ---------------- */

test('归一化：INTERACT_WORD 按 msg_type 分流', () => {
  const base = { uid: 1, uname: '甲', fans_medal: { medal_name: '渔月崽', medal_level: 5 } };

  const enter = normalize({ cmd: 'INTERACT_WORD', data: { ...base, msg_type: 1 } });
  const follow = normalize({ cmd: 'INTERACT_WORD', data: { ...base, msg_type: 2 } });
  const share = normalize({ cmd: 'INTERACT_WORD', data: { ...base, msg_type: 3 } });

  assert.equal(enter.type, EVENT.ENTER);
  assert.equal(follow.type, EVENT.FOLLOW);
  assert.equal(share.type, EVENT.SHARE);
  assert.deepEqual(enter.payload.medal, { name: '渔月崽', level: 5 });
});

test('归一化：INTERACT_WORD 缺 msg_type 时按进场处理', () => {
  const ev = normalize({ cmd: 'INTERACT_WORD', data: { uid: 1, uname: '甲' } });
  assert.equal(ev.type, EVENT.ENTER, '缺字段时宁可当成进场，也不要丢事件');
});

test('归一化：INTERACT_WORD_V2 能从 base64 protobuf 里取出 uid 和昵称', () => {
  const pb = Buffer.concat([pbFieldNum(1, 14431147), pbFieldStr(2, 'Emilia_Clark'), pbFieldNum(5, 1)]);
  const ev = normalize({
    cmd: 'INTERACT_WORD_V2',
    data: { pb: pb.toString('base64'), guard_level: 2 },
  });

  assert.equal(ev.type, EVENT.ENTER);
  assert.equal(ev.payload.uid, '14431147');
  assert.equal(ev.payload.uname, 'Emilia_Clark');
  assert.equal(ev.payload.guardLevel, 2);
});

test('归一化：V2 的 pb 解不出内容时返回 null，不能抛', () => {
  assert.equal(normalize({ cmd: 'INTERACT_WORD_V2', data: { pb: '' } }), null);
  assert.equal(normalize({ cmd: 'INTERACT_WORD_V2', data: { pb: '@@@不是base64@@@' } }), null);
});

/* ---------------- 归一化：金额换算 ---------------- */

test('金额：100 金瓜子 = 1 电池（差 100 倍是这里最容易犯的错）', () => {
  assert.equal(COIN_PER_BATTERY, 100);
  assert.equal(toBattery(100), 1);
  assert.equal(toBattery(198000), 1980); // 舰长 198 元 = 1980 电池
  assert.equal(toBattery(30000), 300); // 30 元醒目留言
  assert.equal(toBattery(0), 0);
  // B站 不会返回负金额。真出现了也要能看出来，而不是被悄悄抹成 0
  assert.equal(toBattery(-100), -1);
});

test('归一化：礼物用 total_coin 算总价，单价由总价除数量', () => {
  const ev = normalize({
    cmd: 'SEND_GIFT',
    data: {
      uid: 1,
      uname: '甲',
      giftId: 31036,
      giftName: '小花花',
      num: 2,
      total_coin: 200,
      coin_type: 'gold',
    },
  });

  assert.equal(ev.type, EVENT.GIFT);
  assert.equal(ev.payload.num, 2);
  assert.equal(ev.payload.battery, 2, '200 金瓜子 = 2 电池');
  assert.equal(ev.payload.price, 1, '单价 = 2 / 2');
  assert.equal(ev.payload.isPaid, true);
});

test('归一化：礼物缺 total_coin 时用 单价 × 数量 兜底', () => {
  const ev = normalize({
    cmd: 'SEND_GIFT',
    data: { uid: 1, giftName: 'x', num: 3, coin: 100, coin_type: 'gold' },
  });
  assert.equal(ev.payload.battery, 3, '3 个 100 金瓜子 = 300 金瓜子 = 3 电池');
});

test('归一化：银瓜子礼物不算付费', () => {
  const ev = normalize({
    cmd: 'SEND_GIFT',
    data: { uid: 1, giftName: '辣条', num: 1, total_coin: 100, coin_type: 'silver' },
  });
  assert.equal(ev.payload.isPaid, false);
});

test('归一化：上舰能识别续费', () => {
  const normal = normalize({
    cmd: 'GUARD_BUY',
    data: { uid: 1, uname: '甲', guard_level: 3, num: 1, price: 198000 },
  });
  assert.equal(normal.payload.battery, 1980);
  assert.equal(normal.payload.isRenew, false);

  const renew = normalize({
    cmd: 'GUARD_BUY',
    data: { uid: 1, uname: '甲', guard_level: 3, num: 1, price: 198000, is_renew: 1 },
  });
  assert.equal(renew.payload.isRenew, true);

  const byName = normalize({
    cmd: 'GUARD_BUY',
    data: { uid: 1, gift_name: '舰长（续费）', guard_level: 3, price: 198000 },
  });
  assert.equal(byName.payload.isRenew, true, '没标记时靠名称里的「续费」判断');
});

/**
 * SC 的 price 单位是**元**，不是金瓜子 —— 这是它和礼物/上舰唯一的区别。
 *
 * 这条断言原来写的是 `price: 30000 → 300 电池`，把元当成金瓜子算，
 * 于是和真实报文对不上：实测一条 100 元的 SC（置顶 300 秒）
 * 被记成 1 电池。单位错了不会抛异常，只会让金额安静地差 1000 倍，
 * 所以必须用真实档位把它钉住。
 */
test('归一化：醒目留言取电池价', () => {
  const ev = normalize({
    cmd: 'SUPER_CHAT_MESSAGE',
    data: { uid: 1, user_info: { uname: '甲' }, message: '加油', price: 100, time: 300, rate: 1000 },
  });
  assert.equal(ev.type, EVENT.SUPER_CHAT);
  assert.equal(ev.payload.yuan, 100, 'price 原样保留为元');
  assert.equal(ev.payload.battery, 1000, '100 元 = 1000 电池');
  assert.equal(ev.payload.duration, 300);
});

test('归一化：醒目留言没有 rate 时按 1 元 = 10 电池换算', () => {
  const ev = normalize({
    cmd: 'SUPER_CHAT_MESSAGE',
    data: { uid: 1, user_info: { uname: '甲' }, message: '加油', price: 30, time: 60 },
  });
  assert.equal(ev.payload.battery, 300);
});

/* ---------------- 归一化：开播 / 下播 / 无关消息 ---------------- */

test('归一化：开播下播只产出状态事件，不凭空造人气值', () => {
  const on = normalize({ cmd: 'LIVE', data: { live_time: 1730000000 } });
  const off = normalize({ cmd: 'PREPARING', data: { live_time: 1730000000 } });

  assert.equal(on.type, EVENT.LIVE_START);
  assert.equal(off.type, EVENT.LIVE_END);
  assert.equal('online' in on.payload, false, '开播报文里没有人气值，不要编一个');
  assert.equal(on.payload.liveTime, 1730000000);
});

test('归一化：毫秒级的 live_time 会转成秒', () => {
  const ev = normalize({ cmd: 'LIVE', data: { live_time: 1730000000123 } });
  assert.equal(ev.payload.liveTime, 1730000000);
});

test('归一化：主播改标题会产出 ROOM_TITLE（否则页头标题永远停在启动时刻）', () => {
  const ev = normalize({ cmd: 'ROOM_CHANGE', data: { title: '新的一天，新的标题' } });
  assert.equal(ev.type, EVENT.ROOM_TITLE);
  assert.equal(ev.payload.title, '新的一天，新的标题');

  // cmd 可能带后缀（同 DANMU_MSG:4:0:2:2:2:0）
  const suffixed = normalize({ cmd: 'ROOM_CHANGE:4:0:2:2:2:0', data: { title: 'x' } });
  assert.equal(suffixed.type, EVENT.ROOM_TITLE);

  // 空标题不该产事件（B站偶尔推空变更）
  const empty = normalize({ cmd: 'ROOM_CHANGE', data: { title: '' } });
  assert.equal(empty, null);
});

test('归一化：轮播与被切断也算下播（投影不能停在「直播中」）', () => {
  // ROUND：主播下播后房间转轮播。收到它却不算下播的话，
  // 投影 state 停在 live，schedule/autocall 的 onlyWhenLive 会一直认为在播
  const round = normalize({ cmd: 'ROUND', data: { live_time: 1730000000 } });
  assert.equal(round.type, EVENT.LIVE_END);

  // CUT_OFF：直播被平台切断，同样不是「还在播」
  const cut = normalize({ cmd: 'CUT_OFF', data: {} });
  assert.equal(cut.type, EVENT.LIVE_END);
});

test('归一化：不关心的 cmd 返回 null（B站 会推很多）', () => {
  assert.equal(normalize({ cmd: 'WATCHED_CHANGE', data: {} }), null);
  assert.equal(normalize({ cmd: 'STOP_LIVE_ROOM_LIST', data: {} }), null);
});

test('归一化：坏报文一律不抛异常', () => {
  const bad = [
    null,
    {},
    { cmd: '' },
    { cmd: 'DANMU_MSG' },
    { cmd: 'DANMU_MSG', info: 'not-an-array' },
    { cmd: 'DANMU_MSG', info: [] },
    { cmd: 'SEND_GIFT' },
    { cmd: 'INTERACT_WORD_V2' },
    { cmd: 'GUARD_BUY', data: null },
  ];

  for (const raw of bad) {
    assert.doesNotThrow(() => normalize(raw), `输入 ${JSON.stringify(raw)} 时崩了`);
  }
});

test('归一化：cmd 后缀能正确剥离', () => {
  assert.equal(baseCmd('DANMU_MSG:4:0:2:2:2:0'), 'DANMU_MSG');
  assert.equal(baseCmd('SEND_GIFT'), 'SEND_GIFT');
  assert.equal(baseCmd(''), '');
});

/* ---------------- 长连客户端的纯逻辑 ---------------- */

test('长连：假活判定只在超过 90 秒无报文时成立', () => {
  const client = new LiveClient({ roomId: 1 });
  const now = Date.now();

  client.lastRecvAt = 0;
  assert.equal(client._isStale(now), false, '还没建立基准就不判定');

  client.lastRecvAt = now - 10_000;
  assert.equal(client._isStale(now), false);

  client.lastRecvAt = now - 89_000;
  assert.equal(client._isStale(now), false, '89 秒还算正常（心跳 30 秒一次）');

  client.lastRecvAt = now - 91_000;
  assert.equal(client._isStale(now), true, '91 秒没任何报文 = 连接已经假活');
});

test('长连：没连上时 isRunning 为 false', () => {
  const client = new LiveClient({ roomId: 1 });
  assert.equal(client.isRunning, false);
  assert.equal(client.status, STATUS.IDLE);
  assert.equal(client.silentMs, 0);
});

test('长连：快照里不含 Cookie', () => {
  const client = new LiveClient({
    roomId: 123,
    cookie: 'SESSDATA=deadbeefdeadbeefdeadbeef; bili_jct=j; DedeUserID=9',
  });

  const snap = client.snapshot();
  const text = JSON.stringify(snap);
  assert.equal(text.includes('deadbeef'), false, '快照会进日志和前端，绝不能带凭证');
  assert.equal(snap.guest, false, '带了 Cookie 就不算游客');
  assert.equal(snap.inputRoomId, 123);
});

/* ---------------- 金额口径：统计与对账必须用同一个 ---------------- */

test('金额口径：报文给了精确总价时，投影和对账路径都要用它', async () => {
  const { Projection } = await import('../core/projection.mjs');
  const { default: sumByType } = await import('../core/sum.mjs');

  // 3 个礼物共 100 金瓜子 = 1 电池。单价是 1/3 电池，四舍五入成 0.3
  // 如果两条路径都用 price × 数量，会算出 0.9 —— 差 0.1 电池，
  // 看起来微不足道，但它会让"对账永远差一点"，那种 bug 最难查。
  const events = [
    { seq: 1, ts: 1, type: 'LIVE_START', payload: {} },
    { seq: 2, ts: 2, type: 'GIFT', payload: { uid: 1, num: 3, price: 0.3, battery: 1 } },
  ];

  const proj = new Projection('r1').applyAll(events);
  const summed = sumByType(events);

  assert.equal(proj.snapshot().giftBattery, 1, '投影要用精确总价');
  assert.equal(summed.giftBattery, 1, '对账路径也要用精确总价');
  assert.equal(proj.snapshot().giftBattery, summed.giftBattery, '两条路径必须相等');
});

test('金额口径：没有精确总价时退回 单价 × 数量（兼容旧日志）', async () => {
  const { Projection } = await import('../core/projection.mjs');
  const { default: sumByType } = await import('../core/sum.mjs');

  const events = [
    { seq: 1, ts: 1, type: 'LIVE_START', payload: {} },
    { seq: 2, ts: 2, type: 'GIFT', payload: { uid: 1, num: 10, price: 10 } },
  ];

  const proj = new Projection('r2').applyAll(events);
  assert.equal(proj.snapshot().giftBattery, 100);
  assert.equal(sumByType(events).giftBattery, 100);
});

/* ---------------- 新版礼物的送礼人必须在 pb 顶层取 ---------------- */

test('礼物 V2：送礼人从 pb 顶层取，读 data.uid 会得到空', async () => {
  const { normalize } = await import('../bili/normalize.mjs');

  // 手工构造一条 SEND_GIFT_V2 的 pb。
  // 真实报文没有公开 schema，这里是按"字段号 + wire 类型"直接写的字节，
  // 结构对标 2026-11-02 抓到的小花花：
  //   顶层 #1 uid / #2 uname / #20 礼物明细
  //   明细 #1 礼物id / #2 名称 / #3 数量 / #5 单价 / #6 总价 / #8 币种
  const varint = (n) => {
    const out = [];
    let v = n;
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    return Buffer.from(out);
  };
  const tag = (field, wire) => varint((field << 3) | wire);
  const int = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
  const str = (field, s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([tag(field, 2), varint(b.length), b]);
  };

  const detail = Buffer.concat([
    int(1, 31036),
    str(2, '小花花'),
    int(3, 2),
    int(5, 50),
    int(6, 100),
    str(8, 'gold'),
  ]);
  const top = Buffer.concat([
    int(1, 12345),
    str(2, '测试观众'),
    tag(20, 2),
    varint(detail.length),
    detail,
  ]);

  const ev = normalize({
    cmd: 'SEND_GIFT_V2',
    data: {
      pb: top.toString('base64'),
      // 故意留空：顶层 data 上本来就没有这两个字段
      uid: '',
      uname: '',
    },
  });

  assert.equal(ev.type, 'GIFT');
  assert.equal(ev.payload.uid, '12345', 'uid 必须从 pb 顶层 #1 取');
  assert.equal(ev.payload.uname, '测试观众', 'uname 必须从 pb 顶层 #2 取');
  assert.equal(ev.payload.giftName, '小花花');
  assert.equal(ev.payload.num, 2);
  assert.equal(ev.payload.battery, 1, '100 金瓜子 = 1 电池');
});

/* ---------------- 重连与解压的边界 ---------------- */

test('长连：旧连接迟到的 close 不许动当前连接的心跳与重连定时器', () => {
  const client = new LiveClient({ roomId: 1 });

  // 当前连接（新）
  const fresh = new EventEmitter();
  fresh.readyState = 1;
  client.ws = fresh;
  client.heartbeatTimer = setInterval(() => {}, 1000);
  client.reconnectTimer = setTimeout(() => {}, 1000);

  // 一条已经被替换掉的旧连接，它的 close 迟到了。
  // 真实场景：换 Cookie / 假活重连时，旧 socket 的 close 在新连接建立之后才到。
  const old = new EventEmitter();
  client._bindSocket(old);
  old.emit('close', 1006);

  assert.ok(
    client.heartbeatTimer,
    '新连接的心跳被旧连接的 close 清掉了 —— 之后不再发心跳，假活检测也一起失效',
  );
  assert.equal(client.reconnectAttempts, 0, '旧连接的 close 不该额外排一次重连');
  assert.equal(client.ws, fresh, '当前的 socket 不能被旧连接清空');

  clearInterval(client.heartbeatTimer);
  clearTimeout(client.reconnectTimer);
});

test('packet：解压上限必须在解压时就生效，不能先解压再检查', () => {
  /**
   * 这条断言只能读源码：解压完再丢，最终结果和一开始就限长是一样的（都是 0 个包），
   * 差别只在**内存峰值** —— 而内存峰值恰恰是压缩炸弹唯一能造成的伤害。
   * 所以钉住的是"把上限交给了 zlib"这个事实，而不是可观察的返回值。
   */
  const src = readFileSync(new URL('../bili/packet.mjs', import.meta.url), 'utf8');
  assert.match(
    src,
    /maxOutputLength:\s*MAX_INFLATED/,
    'zlib 必须带 maxOutputLength：解压之后再比大小，炸弹已经进内存了',
  );
});
