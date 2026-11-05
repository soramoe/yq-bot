/**
 * 本场礼物目标的设置。
 *
 * 和提醒设置一样，这里有两个容易忽略、却不会白屏的点：
 *   1. 输入框写的是**元**，存的是**电池**（1 元 = 10 电池）。回填时
 *      不能再除一遍，也不能用 `format.yuan()` 那种带 `k` 的写法 ——
 *      输入框里出现 `1k` 是存不回去的。
 *   2. 保存失败时保留用户输入。网络抖一下就清空目标，比不保存更让人困惑。
 */

/**
 * @param {{
 *   input: HTMLInputElement,
 *   announceBox: HTMLInputElement,
 *   button: HTMLButtonElement,
 *   api: { goal: () => Promise<any>, saveGoal: (v:{goalBattery:number,announce:boolean}) => Promise<any> },
 *   toast?: (text:string, level?:string) => void,
 * }} opts
 */
export function createGoalConfig({ input, announceBox, button, api, toast = () => {} }) {
  let saving = false;
  /** 打开总览的序号：慢请求回来时不能覆盖用户刚保存的值 */
  let loadSeq = 0;

  /** 电池 → 输入框里的元；整数不带 .0，避免 "2000.0" 这种别扭值 */
  function yuanOf(battery) {
    const v = Math.max(0, Number(battery) || 0) / 10;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  function applyServer(r) {
    input.value = yuanOf(r?.goalBattery);
    announceBox.checked = Boolean(r?.announce);
  }

  async function load() {
    if (saving) return;
    const seq = ++loadSeq;
    try {
      const r = await api.goal();
      if (seq !== loadSeq) return;
      applyServer(r);
    } catch (err) {
      if (seq !== loadSeq) return;
      toast(`读不到礼物目标：${err.message}`, 'warn');
    }
  }

  async function save() {
    if (saving) return;

    const raw = String(input.value ?? '').trim();
    const yuan = Number(raw);
    // 空串不能当 0：用户只是没填，不等于"关掉目标"
    if (!raw || !Number.isFinite(yuan) || yuan < 0) {
      toast('礼物目标要写成 0 或正数（单位：元，0 = 关闭）', 'error');
      return;
    }

    saving = true;
    button.disabled = true;
    const seq = ++loadSeq;
    try {
      const r = await api.saveGoal({
        goalBattery: Math.round(yuan * 10),
        announce: Boolean(announceBox.checked),
      });
      if (seq !== loadSeq) return;
      applyServer(r);
      const goal = Number(r?.goalBattery) || 0;
      if (!goal) {
        toast('已关闭礼物目标', 'warn');
      } else if (r?.announce) {
        toast(`已设定礼物目标 ¥${yuanOf(goal)}，过半/达成时播报`, 'info');
      } else {
        toast(`已设定礼物目标 ¥${yuanOf(goal)}（不播报）`, 'info');
      }
    } catch (err) {
      // 输入框保持原样：失败时把用户刚填的目标清掉是最气人的一种
      toast(err.message, 'error');
    } finally {
      saving = false;
      button.disabled = false;
    }
  }

  button.addEventListener('click', () => {
    save().catch(() => {});
  });

  // 这个输入框在 <form method="dialog"> 里：不拦 Enter 会直接提交"打开这间"，
  // 目标还没保存就被表单带走了。
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    save().catch(() => {});
  });

  return { load, save };
}

export default createGoalConfig;
