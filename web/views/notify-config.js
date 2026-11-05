/**
 * 开播 / 下播提醒的 webhook 设置。
 *
 * 从 `app.js` 里拆出来，理由和 `room-overview.js` 一样：这段逻辑有两个
 * 容易写错、又不会白屏所以最容易被忽略的地方 ——
 *   1. **回填的是服务端收敛后的值**。地址要 trim、限制长度、只收 http(s)，
 *      前端自己 `input.value` 当成"已保存"的话，用户看到的是自己输的，
 *      实际存进去的却是另一个东西。
 *   2. **保存失败不能把输入框清空**。网络抖一下，用户刚粘的地址没了，
 *      还得回去找机器人后台重新复制一遍。
 *
 * 纯函数式的小模块让自检可以用假 api 把这两条都跑一遍。
 */

/** 服务端同款校验：只认 http(s)，且整串不能有空白（粘贴时最常见的脏字符） */
const OK_URL = /^https?:\/\/\S+$/i;

/**
 * @param {{
 *   input: HTMLInputElement,
 *   button: HTMLButtonElement,
 *   reportBox?: HTMLInputElement|null,
 *   api: { notify: () => Promise<any>, saveNotify: (v:string, report?:boolean) => Promise<any> },
 *   toast?: (text:string, level?:string) => void,
 * }} opts
 */
export function createNotifyConfig({ input, button, reportBox = null, api, toast = () => {} }) {
  let saving = false;
  /** 打开弹窗的序号：连点两次、先发的后到，不能让旧结果覆盖新结果 */
  let loadSeq = 0;

  function applyServer(value) {
    const v = typeof value === 'string' ? value : '';
    // 用 value 而不是 setAttribute：输入框的"当前值"就是 value
    input.value = v;
    return v;
  }

  /** 打开总览时读一次。失败只提示，不挡用户手动填。 */
  async function load() {
    // 保存还没落地时读回来的必然是旧值，读它只会把输入框改回去
    if (saving) return;
    const seq = ++loadSeq;
    try {
      const r = await api.notify();
      if (seq !== loadSeq) return; // 期间又打开了/保存过，这次结果已经过期
      applyServer(r?.webhook);
      if (reportBox) reportBox.checked = Boolean(r?.report);
    } catch (err) {
      if (seq !== loadSeq) return;
      toast(`读不到提醒设置：${err.message}`, 'warn');
    }
  }

  async function save() {
    if (saving) return;

    const raw = String(input.value ?? '').trim();
    if (raw && !OK_URL.test(raw)) {
      toast('webhook 地址要以 http:// 或 https:// 开头，且不能有空格', 'error');
      return;
    }
    // 没有地址就不存在"战报发到哪儿"：清空地址等于把外发整体关掉，
    // 不能留下一个勾着却永远发不出去的开关。
    //
    // 页面缓存旧了、没有 #notify-report 时（只有地址输入框），必须发
    // `undefined` 而不是 `false`：显式 false 会把服务端已经开着的战报
    // 悄悄关掉，而用户只是来改个地址。
    const wantReport = reportBox ? Boolean(raw && reportBox.checked) : undefined;

    saving = true;
    button.disabled = true;
    // 作废可能在路上的 load()：它比这次保存更早发出，回来时不能把
    // 用户刚存的地址又改回旧值（打开弹窗后手快就是这个时序）。
    const seq = ++loadSeq;
    try {
      const r = await api.saveNotify(raw, wantReport);
      if (seq !== loadSeq) return; // 期间又保存了一次，以最后那次为准
      const saved = applyServer(r?.webhook ?? raw);
      if (reportBox) reportBox.checked = Boolean(r?.report ?? wantReport);
      const reportOn = Boolean(r?.report ?? wantReport);
      const msg = saved
        ? reportOn
          ? '已保存提醒 webhook，下播后会推战报'
          : '已保存提醒 webhook'
        : '已关闭 webhook 外发，页内提示照旧';
      toast(msg, saved ? 'info' : 'warn');
    } catch (err) {
      // 输入框保持原样：失败时把用户刚粘的地址清掉是最气人的一种
      toast(err.message, 'error');
    } finally {
      saving = false;
      button.disabled = false;
    }
  }

  button.addEventListener('click', () => {
    save().catch(() => {});
  });

  // 输入框在 <form method="dialog"> 里：不拦 Enter 的话，输完地址一回车
  // 会直接提交"打开这间"表单，把地址连同房间号一起发出去。
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    save().catch(() => {});
  });

  return { load, save };
}

export default createNotifyConfig;
