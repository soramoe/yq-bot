/**
 * 登录页 HTML。
 *
 * 单独成文件而不是塞进 server：这个页面会越来越长（以后还要放"粘贴 Cookie"
 * 和"多账号切换"），混在路由里三个月后就没人愿意改了。
 *
 * 样式内联是刻意的：登录页必须在**主服务还没起来**的时候也能打开，
 * 不能依赖任何静态资源路径。
 */

/**
 * @param {string} nonce CSP 用的 nonce
 */
export function renderLoginPage(nonce) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>扫码登录 · 渔情B站直播助手机器人</title>
<style nonce="${nonce}">
  :root {
    --bg: #f4f5f7;
    --card: #ffffff;
    --line: #e6e8eb;
    --text: #16181c;
    --sub: #6b7280;
    --accent: #00a1d6;
    --ok: #16a34a;
    --warn: #d97706;
    --err: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101216;
      --card: #1a1d23;
      --line: #2a2f37;
      --text: #e8eaed;
      --sub: #9aa0a6;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 360px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 28px 24px 24px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 32px -16px rgba(0,0,0,.18);
    text-align: center;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--sub);
    letter-spacing: .02em;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  h1 { margin: 12px 0 4px; font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
  .hint { margin: 0 0 20px; font-size: 13px; color: var(--sub); }

  .qr-wrap {
    position: relative;
    width: 232px;
    height: 232px;
    margin: 0 auto;
    border-radius: 12px;
    background: #fff;
    border: 1px solid var(--line);
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .qr-wrap svg { width: 216px; height: 216px; display: block; }
  .qr-empty { color: #b8bcc2; font-size: 13px; }

  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    gap: 10px;
    background: rgba(255,255,255,.94);
    color: #16181c;
    font-size: 13px;
    font-weight: 500;
    text-align: center;
    padding: 20px;
    white-space: pre-line;
    line-height: 1.7;
  }
  .overlay[hidden] { display: none; }

  .status {
    min-height: 22px;
    margin: 16px 0 0;
    font-size: 13px;
    color: var(--sub);
    transition: color .15s;
  }
  .status[data-tone="ok"] { color: var(--ok); }
  .status[data-tone="warn"] { color: var(--warn); }
  .status[data-tone="err"] { color: var(--err); }
  .status[data-tone="info"] { color: var(--accent); }

  button {
    margin-top: 16px;
    width: 100%;
    padding: 9px 14px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.06); }
  button:active { transform: translateY(.5px); }
  button[hidden] { display: none; }

  .account {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 18px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    text-align: left;
  }
  .account[hidden] { display: none; }
  .account img {
    width: 40px; height: 40px; border-radius: 50%;
    object-fit: cover; background: var(--bg); flex: none;
  }
  .account .name { font-size: 13px; font-weight: 600; }
  .account .meta { font-size: 12px; color: var(--sub); }

  .foot {
    margin-top: 18px;
    font-size: 11px;
    color: var(--sub);
    line-height: 1.5;
  }
</style>
</head>
<body>
<main class="card">
  <span class="brand"><span class="dot"></span>渔情 · 直播助手</span>
  <h1>扫码登录</h1>
  <p class="hint">用 B站 手机客户端扫描二维码</p>

  <div class="qr-wrap">
    <div id="qr"><span class="qr-empty">正在生成…</span></div>
    <div id="overlay" class="overlay" hidden></div>
  </div>

  <p id="status" class="status">正在获取二维码</p>
  <button id="retry" hidden>刷新二维码</button>

  <div id="account" class="account" hidden>
    <img id="face" alt="">
    <div>
      <div class="name" id="uname"></div>
      <div class="meta" id="uid"></div>
    </div>
  </div>

  <p class="foot">凭证只保存在本机 data/auth.json，不会上传任何服务器。</p>
</main>

<script nonce="${nonce}">
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var qrBox = $('qr'), statusEl = $('status'), retryBtn = $('retry');
  var overlay = $('overlay'), accountEl = $('account');

  var key = '';
  var timer = null;
  var stopped = false;

  function setStatus(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.setAttribute('data-tone', tone);
    else statusEl.removeAttribute('data-tone');
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function showOverlay(text) {
    overlay.textContent = text;
    overlay.hidden = false;
  }

  async function requestQr() {
    stop();
    stopped = false;
    retryBtn.hidden = true;
    accountEl.hidden = true;
    overlay.hidden = true;
    qrBox.innerHTML = '<span class="qr-empty">正在生成…</span>';
    setStatus('正在获取二维码');

    try {
      var res = await fetch('/api/qr', { method: 'POST' });
      var data = await res.json();

      if (!data.ok) {
        qrBox.innerHTML = '<span class="qr-empty">获取失败</span>';
        setStatus(data.message || '获取二维码失败', 'err');
        retryBtn.hidden = false;
        return;
      }

      qrBox.innerHTML = data.svg;
      key = data.key;
      setStatus('等待扫码', null);
      poll();
    } catch (e) {
      qrBox.innerHTML = '<span class="qr-empty">网络错误</span>';
      setStatus('连不上本地服务，请确认窗口没有关闭', 'err');
      retryBtn.hidden = false;
    }
  }

  async function poll() {
    if (stopped || !key) return;
    try {
      var res = await fetch('/api/qr/poll?key=' + encodeURIComponent(key));
      var data = await res.json();

      if (data.status === 'confirmed') {
        stop();
        setStatus('登录成功', 'ok');
        showAccount(data.account || {});
        setTimeout(function () {
          showOverlay('已登录 ✓');
        }, 600);
        return;
      }

      if (data.status === 'scanned') {
        setStatus(data.message || '已扫码，请在手机上确认', 'info');
        showOverlay('已扫码\\n请在手机上点击确认');
      } else if (data.status === 'expired') {
        stop();
        setStatus('二维码已过期', 'warn');
        showOverlay('二维码已过期');
        retryBtn.hidden = false;
        return;
      } else if (data.status === 'error') {
        stop();
        setStatus(data.message || '登录失败', 'err');
        retryBtn.hidden = false;
        return;
      } else {
        setStatus('等待扫码', null);
      }
    } catch (e) {
      // 单次网络抖动不该终止整个流程，继续轮询
    }

    timer = setTimeout(poll, 2000);
  }

  function showAccount(acc) {
    if (!acc.uname && !acc.uid) return;
    $('uname').textContent = acc.uname || '未知昵称';
    $('uid').textContent = acc.uid ? 'UID ' + acc.uid : '';
    var face = $('face');
    if (acc.face) { face.src = acc.face; face.hidden = false; } else { face.hidden = true; }
    accountEl.hidden = false;
  }

  retryBtn.addEventListener('click', requestQr);

  // 页面切到后台就暂停轮询，切回来继续：避免用户在别的标签页时白打接口
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer) { clearTimeout(timer); timer = null; }
    } else if (!stopped && key && !timer) {
      poll();
    }
  });

  // 已登录就别再弹二维码了 —— 用户打开页面多半只是想确认"我登的是哪个号"
  async function init() {
    try {
      var res = await fetch('/api/auth');
      var data = await res.json();
      if (data.loggedIn) {
        showAccount(data);
        setStatus('已登录，无需扫码', 'ok');
        retryBtn.textContent = '重新扫码';
        retryBtn.hidden = false;
        return;
      }
    } catch (e) { /* 读不到状态就按未登录处理 */ }
    requestQr();
  }

  init();
})();
</script>
</body>
</html>`;

  return html;
}
