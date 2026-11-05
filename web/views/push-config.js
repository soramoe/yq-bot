/**
 * 手机推送设置。
 *
 * 目标（Bark key / ntfy topic / Server酱 SendKey）是凭据，不是普通文案：
 * 保存失败要保留输入，别让人以为存上了、重启后又没了。
 * 和 webhook 分开配：群里和手机上是两拨接收人，混在一起必然有人被吵到。
 */

const PROVIDERS = [
  { id: '', label: '关闭', hint: '不推手机；开播 / 下播 / 大额只在页面和群里提醒。' },
  {
    id: 'bark',
    label: 'Bark（iOS）',
    hint: '在 Bark App 里复制 key；也可以粘贴完整的 https://api.day.app/<key>。',
  },
  {
    id: 'ntfy',
    label: 'ntfy（全平台）',
    hint: '填 topic（例如 yuyue3）；自建服务可以填完整地址 https://ntfy.sh/<topic>。',
  },
  {
    id: 'serverchan',
    label: 'Server酱（微信）',
    hint: '填 SendKey（一般以 SCT 开头），消息会到绑定的微信。',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    hint: '填 bot_token|chat_id：token 从 @BotFather 拿，chat_id 可以先给 bot 发条消息，再用 getUpdates 查。',
  },
];

function providerLabel(id) {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

export function createPushConfig({ select, input, saveButton, testButton, hint, weekBox = null, api, toast = () => {} }) {
  let saving = false;
  let testing = false;
  let loadSeq = 0;

  function updateHint() {
    if (!hint) return;
    hint.textContent = PROVIDERS.find((p) => p.id === select.value)?.hint ?? '';
  }

  function applyServer(provider, target, weekly = false) {
    select.value = PROVIDERS.some((p) => p.id === provider) ? provider : '';
    if (input) input.value = target ?? '';
    if (weekBox) weekBox.checked = Boolean(weekly);
    updateHint();
  }

  async function load() {
    if (saving) return;
    const seq = ++loadSeq;
    try {
      const r = await api.push();
      if (seq !== loadSeq) return;
      applyServer(r?.provider ?? '', r?.target ?? '', r?.weekly === true);
    } catch (err) {
      if (seq === loadSeq) toast(`读不到手机推送设置：${err.message}`, 'warn');
    }
  }

  async function save() {
    if (saving) return;
    const provider = select.value;
    const target = String(input?.value ?? '').trim();

    if (!provider && target) {
      toast('先选一个推送渠道', 'error');
      return;
    }
    if (provider && !target) {
      toast('填一下推送目标（key / topic / SendKey）', 'error');
      return;
    }
    if (/\s/.test(target)) {
      toast('推送目标不能有空格', 'error');
      return;
    }
    const weekly = weekBox ? Boolean(weekBox.checked) : undefined;
    if (weekly && (!provider || !target)) {
      toast('周报要推到手机，先把手机推送配好', 'warn');
      return;
    }

    saving = true;
    if (saveButton) saveButton.disabled = true;
    if (testButton) testButton.disabled = true;
    try {
      const s = await api.savePush(provider, target, weekly);
      ++loadSeq;
      applyServer(s?.provider ?? provider, s?.target ?? target, s?.weekly === true);
      const label = provider ? `已保存手机推送（${providerLabel(s?.provider ?? provider)}）` : '已关闭手机推送';
      toast(s?.weekly ? `${label}，每周一 10:00 推周报` : label, 'info');
    } catch (err) {
      toast(`保存手机推送失败：${err.message}`, 'error');
    } finally {
      saving = false;
      if (saveButton) saveButton.disabled = false;
      if (testButton) testButton.disabled = false;
    }
  }

  async function test() {
    if (testing || saving) return;
    if (!select.value || !String(input?.value ?? '').trim()) {
      toast('先保存一个推送渠道，再发测试', 'warn');
      return;
    }
    testing = true;
    if (testButton) testButton.disabled = true;
    try {
      const r = await api.testPush();
      if (r?.sent) {
        toast('测试推送发出去了，去手机看看', 'info');
      } else {
        toast(`测试推送失败：${r?.error || `HTTP ${r?.status ?? '?'}`}`, 'error');
      }
    } catch (err) {
      toast(`测试推送失败：${err.message}`, 'error');
    } finally {
      testing = false;
      if (testButton) testButton.disabled = false;
    }
  }

  select?.addEventListener('change', updateHint);
  saveButton?.addEventListener('click', save);
  testButton?.addEventListener('click', test);
  input?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // 在 form method=dialog 里，Enter 默认会提交「打开这间」
    e.preventDefault();
    save();
  });

  updateHint();
  return { load, save, test };
}
