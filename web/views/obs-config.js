/**
 * 房间总览里的 OBS 场景联动设置。
 *
 * 只负责"把页面上的值发给服务端、把服务端的值填回来"。
 * 密码走单向：读回来永远没有密码原文，输入框留空表示"不改"。
 */

export function createObsConfig({
  enabledBox,
  urlInput,
  passwordInput,
  liveInput,
  offlineInput,
  saveButton,
  clearButton,
  hint,
  api,
  toast = () => {},
} = {}) {
  let saving = false;
  let loadSeq = 0;
  let passwordSet = false;

  const OK_URL = /^wss?:\/\/\S+$/i;

  function renderHint(loaded) {
    if (!hint) return;
    if (!loaded) {
      hint.textContent = 'OBS 28+ 默认开着 WebSocket 服务；地址一般在 ws://127.0.0.1:4455。';
    } else if (!enabledBox?.checked) {
      hint.textContent = '现在关着，开播/下播不会动 OBS。';
    } else if (!urlInput?.value.trim()) {
      hint.textContent = '要开联动得先填 OBS WebSocket 地址。';
    } else {
      hint.textContent = passwordSet
        ? '已保存密码；输入框留空表示不改。'
        : '没设密码就留空；OBS 里关了 WebSocket 认证的话不需要密码。';
    }
  }

  function applyView(r) {
    if (enabledBox) enabledBox.checked = Boolean(r?.enabled);
    if (urlInput) urlInput.value = r?.url ?? '';
    if (liveInput) liveInput.value = r?.liveScene ?? '';
    if (offlineInput) offlineInput.value = r?.offlineScene ?? '';
    passwordSet = Boolean(r?.passwordSet);
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.placeholder = passwordSet
        ? '已设置密码，留空表示不改'
        : 'OBS WebSocket 密码（没设密码就留空）';
    }
    renderHint(true);
  }

  async function load() {
    if (saving) return;
    const seq = ++loadSeq;
    try {
      const r = await api.obs();
      if (seq !== loadSeq) return;
      applyView(r);
    } catch (err) {
      if (seq !== loadSeq) return;
      toast(`读不到 OBS 设置：${err.message}`, 'warn');
    }
  }

  async function save(clearPassword = false) {
    if (saving) return;
    const url = urlInput?.value.trim() ?? '';
    if (enabledBox?.checked && !url) {
      toast('OBS 地址不能为空（例如 ws://127.0.0.1:4455）', 'error');
      return;
    }
    if (url && !OK_URL.test(url)) {
      toast('OBS 地址要以 ws:// 或 wss:// 开头，且不能有空格', 'error');
      return;
    }

    saving = true;
    ++loadSeq;
    if (saveButton) saveButton.disabled = true;
    try {
      const password = clearPassword ? '' : passwordInput?.value ?? '';
      const r = await api.saveObs({
        enabled: Boolean(enabledBox?.checked),
        url,
        password: password || undefined,
        clearPassword,
        liveScene: liveInput?.value.trim() ?? '',
        offlineScene: offlineInput?.value.trim() ?? '',
      });
      applyView(r);
      const on = Boolean(r?.enabled);
      toast(
        on ? '已保存 OBS 场景联动' : '已保存 OBS 设置（联动关着）',
        on ? 'success' : 'info',
      );
    } catch (err) {
      toast(`保存 OBS 设置失败：${err.message}`, 'error');
    } finally {
      saving = false;
      if (saveButton) saveButton.disabled = false;
    }
  }

  saveButton?.addEventListener('click', () => save(false));
  clearButton?.addEventListener('click', () => save(true));
  for (const input of [urlInput, passwordInput, liveInput, offlineInput]) {
    input?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      save(false);
    });
  }
  enabledBox?.addEventListener('change', () => renderHint(true));

  return { load, save };
}
