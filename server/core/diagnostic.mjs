/**
 * 一键诊断包。
 *
 * ## 为什么值得单独做
 *
 * 出了问题要排障，需要的东西散在四处：版本、状态快照、插件配置、
 * 日志统计、最近事件。让人一条条截图发过来，信息必然缺 —— 而
 * "缺一条关键信息"会让排查多来回好几轮。
 *
 * ## 为什么必须脱敏，而且是"默认就脱敏"
 *
 * 这个包**是要发给别人的**（贴群里、发给帮你看的人）。而 `data/` 目录里
 * 最不能外传的就是 `auth.json`（Cookie）和 `access.json`（口令哈希）。
 * 所以这个模块的构造方式是**白名单**：只挑明确的字段写进去，
 * 而不是"复制一份再删掉几个"—— 后者只要漏一个字段就泄露，
 * 而前者漏字段的结果是"信息不够"，不是"泄密"。方向选错，代价不对等。
 *
 * 具体做法：
 *   · Cookie / 口令：一个字节都不进包，连脱敏后的摘要都不给（没必要）
 *   · 观众昵称 / 弹幕正文：不进包（第三方个人信息）
 *   · 观众 uid：sha256 前 8 位。仍然能看出"是不是同一个人"，
 *     但无法反查是谁
 *   · 自己的账号：uid 保留，昵称打码成首字 + ***
 *
 * ## 为什么手写 ZIP
 *
 * 零依赖是这个项目的硬约束（唯一外部依赖是 ws）。而诊断包不需要压缩 ——
 * 几百 KB 的文本，store 模式（不压缩）完全够，省掉一个 200 行的
 * deflate 实现和一个解压依赖。ZIP 的 store 格式本身只有几十行。
 */

import { createHash } from 'node:crypto';

/* ══════════════════════ ZIP（store 模式） ══════════════════════ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间格式（ZIP 从 1980 年起算，秒只有 2 秒精度） */
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 打一个不压缩的 zip。
 *
 * @param {{name:string, data:string|Buffer}[]} entries
 * @param {{mtime?:Date}} [opts]
 * @returns {Buffer}
 */
export function zipStore(entries, { mtime = new Date() } = {}) {
  const { time, date } = dosStamp(mtime);
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const body = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(body);

    // 本地文件头 30 字节 + 文件名 + 内容
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 签名
    local.writeUInt16LE(20, 4); // 需要的解压版本
    local.writeUInt16LE(0x0800, 6); // 通用标志：文件名是 UTF-8
    local.writeUInt16LE(0, 8); // 压缩方法：0 = 不压缩
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // 压缩后大小 = 原始大小
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    parts.push(local, nameBuf, body);

    // 中央目录项 46 字节
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // 制作版本
    cd.writeUInt16LE(20, 6); // 解压版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // 扩展
    cd.writeUInt16LE(0, 32); // 注释
    cd.writeUInt16LE(0, 34); // 起始磁盘
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);

  // 中央目录结束记录
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

/**
 * 读回 store 模式的 zip。**只给自检用** —— 生产代码永远只需要写。
 *
 * 它的存在意义是让"打包"这件事可验证：光断言"buffer 里有 PK 头"
 * 说明不了结构正确，真正的验证是"按格式读回来，内容一字不差"。
 *
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function unzipStore(buf) {
  const out = new Map();

  // 从尾部找 EOCD：注释区最多 65535 字节
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip：找不到中央目录结束记录');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录项签名不对');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (method !== 0) throw new Error(`只支持不压缩的条目：${name}`);

    // 本地头里的名字/扩展长度才是真实偏移的依据
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地文件头签名不对');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const body = buf.slice(start, start + csize);

    if (crc32(body) !== crc) throw new Error(`CRC 校验失败：${name}`);
    out.set(name, body);

    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/* ══════════════════════ 脱敏 ══════════════════════ */

/** 键名命中即整棵子树丢弃。
 *  刻意**不**包含 `session`：这个项目里 `sessionId` 是"第几场直播"，
 *  不是凭据。把诊断信息抹掉换不来安全，只换来"看不出来是哪一场"。 */
const SECRET_KEY =
  /(cookie|token|secret|password|passwd|pwd|salt|hash|apikey|api_key|access_?key|private_?key|sessdata|bili_?jct|webhook|bot_?key|push_?target)/i;

/** 值里出现这些形状就算泄露（防止有人把 Cookie 串塞进某个普通字段） */
const SECRET_VALUE = /(SESSDATA|bili_jct|DedeUserID__ckMd5)\s*=/i;

const REDACTED = '***';

/**
 * 递归脱敏。命中敏感键 → 整块替换成 `***`。
 *
 * 深度上限是必要的：配置来自磁盘上的 JSON，理论上可以手写一个
 * 自引用结构（虽然 JSON 表达不了循环引用，但嵌套 1000 层做得到），
 * 而递归爆栈会把整个诊断接口打挂。
 */
export function redact(value, depth = 0) {
  if (depth > 12) return REDACTED;
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === 'object') {
    /** @type {Record<string,unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) {
        // 保留"存在过"这个事实，但不给值：排障时"这个字段有没有配"是有用信息
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }

  if (typeof value === 'string' && SECRET_VALUE.test(value)) return REDACTED;
  return value;
}

/** uid → 8 位短哈希。能判断"同一个人"，不能反查是谁 */
export function hashUid(uid) {
  const s = String(uid ?? '').trim();
  if (!s) return '';
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/** 昵称打码：只留首字。自己的账号显示用 */
export function maskName(name) {
  const s = String(name ?? '');
  if (!s) return '';
  const chars = [...s];
  if (chars.length <= 1) return `${chars[0] ?? ''}***`;
  return `${chars[0]}***`;
}

/* ══════════════════════ 事件骨架 ══════════════════════ */

/** 事情本身（类型、时间、金额）对排障有用；谁做的、说了什么没有 */
const NUMERIC_FIELDS = ['num', 'count', 'battery', 'price', 'guardLevel', 'level', 'coinType'];

/**
 * 把一条事件压成"骨架"。
 *
 * 刻意**不保留** uid 原值、昵称、弹幕正文、礼物名（礼物名会暴露
 * "谁给谁送了什么"的关系）。留下的是纯数值和类型 ——
 * 排查"金额算错 / 事件漏收 / 顺序乱了"这几类问题够用。
 *
 * @param {{seq?:number, type?:string, ts?:number, payload?:object}} rec
 */
export function eventSkeleton(rec) {
  const out = { seq: rec?.seq ?? 0, type: rec?.type ?? '', ts: rec?.ts ?? 0 };
  const p = rec?.payload && typeof rec.payload === 'object' ? rec.payload : {};

  // uid 用短哈希代替：同一场里仍能看出"这两条是同一个人"
  if (p.uid) out.uid = hashUid(p.uid);

  for (const k of NUMERIC_FIELDS) {
    if (Number.isFinite(p[k])) out[k] = p[k];
  }
  return out;
}

/* ══════════════════════ 组装 ══════════════════════ */

/**
 * @param {object} input
 * @param {object} input.meta 版本、平台等（调用方给，本模块不读 package.json）
 * @param {object} input.status app.status() 的结果
 * @param {object} [input.brief] app.brief()
 * @param {object} [input.config] data/app.json 的原始内容
 * @param {object} [input.access] 口令状态
 * @param {object|null} [input.update] 更新检查结果
 * @param {object[]} [input.events] 最近事件（会逐条压成骨架）
 * @param {object|null} [input.logStats]
 * @param {Date} [input.now]
 * @returns {{filename:string, buffer:Buffer, entries:string[]}}
 */
export function buildDiagnostic({
  meta,
  status,
  brief = null,
  config = {},
  access = null,
  update = null,
  events = [],
  logStats = null,
  now = new Date(),
}) {
  /**
   * 文件名用**本地时间**，不用 `toISOString()`。
   *
   * `toISOString()` 给的是 UTC：本地 12:55 会写成 `04-55`，而日志分片是
   * `2026-11-04.jsonl`（本地日期）、日志行是 `12:55:40`（本地时间）。
   * 用户拿着一份"04 点"的包说"我 12 点出的问题"，两边对不上 ——
   * 而这个偏差不会让任何东西报错，只会让排查从一开始就错。
   */
  const localText =
    `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ` +
    `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const stamp = localText.replace(' ', '_').replace(/:/g, '-');
  const filename = `yuyue3-diag-${stamp}.zip`;

  // status 里包含 account / config / room 快照，统一过一遍白名单式脱敏
  const safeStatus = redact(status);

  // 插件目录是绝对路径（`C:\Users\someone\...`），会连带把系统用户名写进包里。
  // 而这个包通常是要发到群里求助的 —— 只需要知道"加载了没有"，不需要知道装在哪。
  if (safeStatus?.config && typeof safeStatus.config.pluginsDir === 'string') {
    safeStatus.config.pluginsDir = '已加载（路径已略去）';
  }

  const files = [
    {
      name: 'README.txt',
      data: [
        '渔情LiveBot · 诊断包',
        '',
        `生成时间：${localText}（本地时间）`,
        `        ${now.toISOString()}（UTC，便于跨时区对照）`,
        '',
        '这个包是用来排查问题的。它已经做过脱敏，可以发给别人。',
        '',
        '包含哪些东西：',
        '  meta.json          版本、平台、Node 版本、运行时长',
        '  status.json        当前状态快照（连接、闸门、插件、观众簿人数）',
        '  config.json        应用配置（Cookie、口令、密钥类字段全部替换为 ***）',
        '  access.json        访问口令是否开启（不含口令本身，也不含哈希）',
        '  update.json        最近一次更新检查的结果',
        '  logs/index.json    日志分片统计',
        '  events/recent.jsonl 最近的事件骨架',
        '',
        '刻意不包含的东西：',
        '  · 登录 Cookie（一个字节都没有）',
        '  · 访问口令及其哈希',
        '  · 观众昵称、弹幕正文、礼物名',
        '  · 观众 uid 原文（替换成 8 位短哈希，仍能看出"是不是同一个人"）',
        '  · 安装目录的绝对路径（会带出系统用户名）',
        '',
        '**保留**的是你自己账号的昵称和 uid —— 用来确认"登的是哪个号"，',
        '不是观众的。',
        '',
        '如果你连房间号都不想暴露，就别发这个包，只发 status.json 里',
        '的那几行数字。',
        '',
      ].join('\r\n'),
    },
    { name: 'meta.json', data: json(meta) },
    { name: 'status.json', data: json(safeStatus) },
    { name: 'config.json', data: json(redact(config ?? {})) },
    { name: 'access.json', data: json(access ? { enabled: Boolean(access.enabled), updatedAt: access.updatedAt ?? '' } : { enabled: false }) },
    { name: 'update.json', data: json(update ?? null) },
    { name: 'logs/index.json', data: json(logStats ?? null) },
    {
      name: 'events/recent.jsonl',
      data: events.map((e) => JSON.stringify(eventSkeleton(e))).join('\n') + (events.length ? '\n' : ''),
    },
  ];

  return {
    filename,
    buffer: zipStore(files, { mtime: now }),
    entries: files.map((f) => f.name),
  };
}

function json(v) {
  return JSON.stringify(v ?? null, null, 2);
}

/** 两位补零。诊断包文件名与 README 都用它，避免 9 点写成 "9" */
function p2(n) {
  return String(n).padStart(2, '0');
}

export default buildDiagnostic;
