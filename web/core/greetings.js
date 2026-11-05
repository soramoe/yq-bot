/**
 * 招呼文案预设：**自动打招呼出厂自带的文案，改动只改这一处**。
 *
 * 放在 web/core：设置页直接 import '../core/greetings.js'（静态服务本来就能发 .js），
 * Node 自检也能 import 同一份 URL（根 package.json 是 "type": "module"，.js 按 ESM 解析）。
 * 它是纯数据、不碰 document/window，所以自检读到的数组和页面读到的是同一个模块实例；
 * manifest 里的默认值由自检逐句比对，改了文案包忘了改 manifest 会立刻变红。
 *
 * 运行时插件不认识"预设"这个概念：设置页选一套，就把整包文案写进
 * `plugins.autocall.templates` 配置，插件只读配置。换文案不用改插件，
 * 也不用给插件加一条读取前端文件的依赖。
 *
 * ## 三条文案硬规矩（自检盯着，改文案前先看）
 *
 * 1. **不写 @名字。** 结构化 @ 由 B站 收到 reply_mid 后自己挂可点的粉色标签，
 *    文案里再写一遍就成了「@小明 你好呀 小明」。
 * 2. **不带 {用户} 占位符。** 预设是给"自动挑人"用的，昵称长度不可控：
 *    一个 30 字的昵称会把整句顶过弹幕上限，然后被静默截断。不写名字，
 *    长度就是固定的、可断言的；用户自定义文案仍可以用 {用户}。
 * 3. **按码位 ≤ 20 字（MAX_TEXT），且尽量短。** 普通弹幕上限 20 字；
 *    预设全部控制在 10 字以内，给自定义文案和长昵称留余量。
 */

/** @typedef {{id:string,name:string,desc:string,lines:string[]}} GreetingPack */

/** @type {GreetingPack[]} */
export const GREETING_PACKS = [
  {
    id: 'daily',
    name: '轻松日常',
    desc: '不出错的默认款，像顺口搭句话',
    lines: [
      '抓到一只野生观众！',
      '别潜水啦，冒个泡～',
      '这局由你发言！',
      '刚好想找人聊天～',
    ],
  },
  {
    id: 'playful',
    name: '整活玩梗',
    desc: '热闹房间用，带点起哄的味道',
    lines: [
      '点名了，起来回答～',
      '逮到你了，别跑！',
      '本场幸运观众是你',
      '弹幕区交给你了',
    ],
  },
  {
    id: 'warm',
    name: '温柔治愈',
    desc: '深夜场、聊天向，不催人说话',
    lines: [
      '来了就好，坐会儿吧',
      '今天也辛苦啦～',
      '慢慢聊，不着急',
      '有你在就热闹了',
    ],
  },
  {
    id: 'game',
    name: '抽签游戏',
    desc: '把主动 @ 包装成一次随机点名',
    lines: [
      '骰子停在你这儿！',
      '抽中今日幸运星～',
      '轮到你发言啦',
      '恭喜获得发言权',
    ],
  },
  {
    id: 'tiny',
    name: '极简短句',
    desc: '昵称普遍很长、或经常降级成纯文本 @ 时用',
    lines: [
      '在呀？',
      '冒个泡～',
      '看这边！',
      '聊会儿？',
    ],
  },
];

/** 出厂默认：manifest 的 templates 默认值就是这一套（自检逐句比对） */
export const DEFAULT_PACK_ID = 'daily';

export function findPack(id) {
  return GREETING_PACKS.find((p) => p.id === id) ?? null;
}

/**
 * 当前 templates 用的是哪一套？完全一样才算，改过一句就是「自定义」。
 * 用来在设置页显示"当前预设"，避免用户以为选了其实没生效。
 */
export function matchPack(lines) {
  const arr = (Array.isArray(lines) ? lines : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  if (arr.length === 0) return null;
  return (
    GREETING_PACKS.find(
      (p) => p.lines.length === arr.length && p.lines.every((s, i) => s === arr[i]),
    ) ?? null
  );
}

export default GREETING_PACKS;
