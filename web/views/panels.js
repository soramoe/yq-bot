/**
 * 数字面板。
 *
 * 关键做法：**节点只建一次，之后只改 textContent。**
 * 每秒重建 4 张卡的 DOM 会让人眼看到轻微的跳动，也会让"选中文字"这种
 * 操作被打断。所以这里全部是"建结构 + 增量更新值"。
 */

import { el, replaceChildren } from '../core/dom.js';
import { ago, battery, connLabel, n, yuan } from '../core/format.js';
import { api, hasToken, setToken } from '../core/api.js';

/* ══════════════════════ 顶部统计条 ══════════════════════ */

export function createStats(container) {
  const cells = [
    { key: 'danmaku', label: '本场弹幕' },
    { key: 'enter', label: '进场人次' },
    { key: 'gift', label: '本场礼物', accent: true },
    { key: 'guard', label: '本场舰长' },
    { key: 'sc', label: '醒目留言', accent: true },
  ].map((d) => {
    const v = el('div', { class: `v${d.accent ? ' accent' : ''}`, text: '0' });
    const sub = el('div', { class: 'sub', text: '—' });
    container.append(
      el('div', { class: 'stat', children: [el('div', { class: 'k', text: d.label }), v, sub] }),
    );
    return { v, sub };
  });

  return {
    update(b) {
      if (!b) return;
      const g = b.grand ?? {};

      cells[0].v.textContent = n(b.danmaku);
      cells[0].sub.textContent = `累计 ${n(g.danmaku)} 条`;

      cells[1].v.textContent = n(b.enterCount);
      cells[1].sub.textContent = `活跃观众 ${n(b.uniqueViewers)} 人`;

      cells[2].v.textContent = n(b.giftCount);
      cells[2].sub.textContent = `${battery(b.giftBattery)} 电池 · ¥${yuan(b.giftBattery)}`;

      cells[3].v.textContent = n(b.guardCount);
      cells[3].sub.textContent = `${battery(b.guardBattery)} 电池`;

      // SC 是全场单价最高的一类，单独一格。数字不对时一眼能看出来
      //（这里曾经因为单位算错，100 元显示成 0.1 元）
      cells[4].v.textContent = n(b.scCount);
      cells[4].sub.textContent = `¥${yuan(b.scBattery)}`;
    },
  };
}

/* ══════════════════════ 侧栏 ══════════════════════ */

/**
 * @param {HTMLElement} container
 * @param {{toast?:(text:string, level?:string)=>void}} [opts]
 */
export function createSide(container, { toast = () => {} } = {}) {
  /* ── 连接 ── */
  const conn = panel(container, '连接');
  const connState = kv(conn.body, '状态');
  const connPopularity = kv(conn.body, '人气');
  const connSilent = kv(conn.body, '最近收包');
  const connRecv = kv(conn.body, '事件数');
  const connRetry = kv(conn.body, '重连次数');

  /* ── 账号 ── */
  const account = panel(container, '账号');
  const accState = kv(account.body, '状态');
  const accName = kv(account.body, '昵称');
  const accUid = kv(account.body, 'uid');
  const accCheck = el('div', { class: 'side-note' });
  const accVerify = el('button', { class: 'btn small', attrs: { type: 'button' }, text: '校验凭证' });
  const accOut = el('button', { class: 'btn small', attrs: { type: 'button' }, text: '退出登录' });
  account.body.append(
    el('div', { class: 'side-actions', children: [accVerify, accOut] }),
    accCheck,
  );

  accVerify.addEventListener('click', async () => {
    accVerify.disabled = true;
    accCheck.textContent = '正在校验…';
    accCheck.className = 'side-note';
    try {
      const r = await api.checkAuth();
      const at = r.at ? new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      accCheck.textContent = r.valid ? `凭证有效（${at}）` : `凭证无效：${r.reason || '未知原因'}`;
      accCheck.className = `side-note${r.valid ? '' : ' is-warn'}`;
    } catch (err) {
      accCheck.textContent = err.message;
      accCheck.className = 'side-note is-error';
    } finally {
      accVerify.disabled = false;
    }
  });

  accOut.addEventListener('click', async () => {
    // 这是不可撤销的（要重新扫码），必须问一次
    if (!window.confirm('退出登录会删除本地保存的 Cookie，并以游客身份重连。要继续吗？')) return;
    accOut.disabled = true;
    try {
      await api.logout();
      toast('已退出登录，现在以游客身份连接', 'warn');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      accOut.disabled = false;
    }
  });

  /* ── 访问口令 ── */
  // 常驻的只留连接与账号；其余收进折叠层，右栏不再是一列永远滚不到底的面板
  const more = el('details', { class: 'side-more' });
  const moreBody = el('div', { class: 'side-more-body' });
  more.append(el('summary', { text: '更多状态与排行' }), moreBody);
  container.append(more);

  const access = panel(moreBody, '访问口令');
  const acState = kv(access.body, '状态');
  const acInput = el('input', {
    class: 'plg-input',
    attrs: {
      type: 'password',
      placeholder: '设置一个口令（至少 6 位）',
      'aria-label': '访问口令',
      autocomplete: 'current-password',
    },
  });
  const acBtn = el('button', { class: 'btn primary small', attrs: { type: 'button' }, text: '开启' });
  const acOff = el('button', { class: 'btn small', attrs: { type: 'button' }, text: '关闭口令' });
  const acNote = el('div', { class: 'side-note', text: '默认不启用：跨站请求已由 Origin 检查挡住' });
  access.body.append(
    el('div', { class: 'side-form', children: [acInput] }),
    el('div', { class: 'side-actions', children: [acBtn, acOff] }),
    acNote,
  );

  /** 最近一次从服务端拿到的口令状态。按钮的行为要靠它决定 */
  let accessEnabled = false;

  /** 上次已经渲染过的校验结论时间戳，用来避免重复覆盖 */
  let lastCheckAt = 0;

  function renderAccess(a) {
    accessEnabled = Boolean(a?.enabled);
    acState.v.textContent = accessEnabled ? '已启用' : '未启用';
    acState.v.classList.toggle('strong', accessEnabled);

    if (!accessEnabled) {
      acInput.placeholder = '设置一个口令（至少 6 位）';
      acBtn.textContent = '开启';
      acOff.hidden = true;
    } else if (hasToken()) {
      acInput.placeholder = '输入新口令可修改';
      acBtn.textContent = '修改口令';
      acOff.hidden = false;
    } else {
      acInput.placeholder = '输入口令解锁';
      acBtn.textContent = '解锁';
      acOff.hidden = true;
    }
  }

  acBtn.addEventListener('click', async () => {
    const value = String(acInput.value ?? '').trim();
    if (!value) {
      acNote.textContent = '先输入口令';
      acNote.className = 'side-note is-error';
      return;
    }

    acBtn.disabled = true;
    // 两个分支的反馈不能共用一句话：解锁成功说"口令设置成功"，
    // 用户会以为自己刚改了口令（明明什么都没改）
    const unlocking = accessEnabled && !hasToken();
    try {
      // 已启用 + 手里没凭据 = 这是"解锁"；其余都是"设置/修改"
      if (unlocking) {
        const st = await api.unlock(value);
        setToken(value);
        renderAccess(st);
        acNote.textContent = '已解锁，本页的写操作现在可以用了';
      } else {
        const st = await api.setPassword(value);
        // 口令一设，**新口令立刻是之后所有写操作的凭据**。
        // 不记下来的话，下一次点击就会 401，而用户完全不知道发生了什么。
        setToken(value);
        renderAccess(st);
        acNote.textContent = '口令已生效，本次会话已记住';
      }
      acNote.className = 'side-note';
      acInput.value = '';
      toast(unlocking ? '已解锁' : '访问口令已更新', 'info');
    } catch (err) {
      acNote.textContent = err.message;
      acNote.className = 'side-note is-error';
    } finally {
      acBtn.disabled = false;
    }
  });

  acOff.addEventListener('click', async () => {
    if (!window.confirm('关掉口令后，本机任何页面都能改配置（跨站请求仍会被 Origin 拦住）。确定？')) {
      return;
    }
    acOff.disabled = true;
    try {
      const st = await api.disablePassword();
      setToken('');
      renderAccess(st);
      acNote.textContent = '口令已关闭';
      acNote.className = 'side-note';
      toast('访问口令已关闭', 'warn');
    } catch (err) {
      acNote.textContent = err.message;
      acNote.className = 'side-note is-error';
    } finally {
      acOff.disabled = false;
    }
  });

  /* ── 发送闸门 ── */
  const gate = panel(moreBody, '发送闸门');
  const gateMode = kv(gate.body, '模式');
  const gateSent = kv(gate.body, '真实发送');
  const gateDry = kv(gate.body, '演练通过');
  const gateInterval = kv(gate.body, '限速丢弃');
  const gateDedupe = kv(gate.body, '重复丢弃');
  const gateFail = kv(gate.body, '失败');

  /* ── 长期观众簿 ── */
  const roster = panel(moreBody, '长期观众簿');
  const rosterPeople = kv(roster.body, '认识的人');
  const rosterKeep = kv(roster.body, '保留期');

  /* ── 插件 ── */
  const plugins = panel(moreBody, '插件');
  const pluginList = el('div');
  plugins.body.append(pluginList);
  let pluginSignature = '';

  /* ── 本场排行 ── */
  const rankGifters = panel(moreBody, '本场送礼 TOP');
  const rankGifts = panel(moreBody, '礼物排行');

  return {
    /** 每秒一次，用精简状态 */
    updateBrief(b) {
      if (!b) return;

      // 连接
      const c = b.conn ?? {};
      connState.v.textContent = connLabel(c.status);
      connState.v.classList.toggle('strong', Boolean(c.status));
      // 0 通常表示"这次还没收到"，显示成 0 会让人以为是数据错了
      connPopularity.v.textContent = c.popularity > 0 ? String(c.popularity) : '—';
      connSilent.v.textContent = c.silentMs != null ? ago(c.silentMs) : '—';

      const cs = c.stats ?? {};
      connRecv.v.textContent = cs.events != null ? `${n(cs.events)} 条` : '—';
      connRecv.v.title = cs.unparsed ? `${cs.unparsed} 条无法解析` : '';
      connRetry.v.textContent = n(c.reconnectAttempts ?? 0);

      // 闸门
      const g = b.gate ?? {};
      gateMode.v.textContent = b.dryRun ? '演练（不发送）' : '真实发送';
      gateMode.v.classList.toggle('strong', true);
      gateSent.v.textContent = n(g.sent ?? 0);
      gateDry.v.textContent = n(g.dryRun ?? 0);
      gateInterval.v.textContent = n(g.blockedInterval ?? 0);
      gateDedupe.v.textContent = n(g.blockedDedupe ?? 0);
      gateFail.v.textContent = n(g.failed ?? 0);

      // 观众簿：人数是"这个机器人积累了多少老观众"，最直观的功能是否生效的证据。
      // 只显示聚合数字，名单不下发到 1Hz 通道（服务端 brief() 也不给）
      const rb = b.roster;
      rosterPeople.v.textContent = rb ? `${n(rb.people)} 人` : '—';
      rosterKeep.v.textContent = rb ? `${n(rb.keepDays)} 天` : '—';
      rosterKeep.v.title = rb ? `磁盘上有 ${rb.days} 个按天分片` : '';

      // 插件：只有数量或 id 变了才重建，否则只刷数字
      const list = b.plugins ?? [];
      const sig = list.map((p) => p.id).join(',');
      if (sig !== pluginSignature) {
        pluginSignature = sig;
        replaceChildren(
          pluginList,
          list.length
            ? list.map((p) => pluginRow(p))
            : [el('div', { class: 'empty-hint', text: '没有加载插件（--no-plugins）' })],
        );
      } else {
        for (const p of list) {
          const row = pluginList.querySelector(`[data-p="${p.id}"] .pstat`);
          if (row) {
            row.textContent = `${n(p.claimed)} 认领 · ${n(p.sent)} 发言`;
            row.title = p.errors ? `${p.errors} 次出错` : '';
          }
        }
      }
    },

    /** 变化慢的东西：排行、账号 */
    updateFull(status) {
      if (!status) return;
      const stats = status.room?.stats ?? {};

      // 账号：来自 /api/status 的 account 字段（1Hz 的 brief 里没有它）
      const acct = status.account ?? {};
      accState.v.textContent = acct.loggedIn ? '已登录' : '未登录（游客）';
      accState.v.classList.toggle('strong', Boolean(acct.loggedIn));
      accName.v.textContent = acct.uname || '—';
      accUid.v.textContent = acct.uid ? String(acct.uid) : '—';
      accOut.disabled = !acct.loggedIn;

      // 校验结论只在"有了新结论"时覆盖，否则每秒一次的状态刷新
      // 会把用户刚点出来的那句提示冲掉（看起来像点了没反应）
      const chk = acct.check;
      if (chk?.at && chk.at !== lastCheckAt) {
        lastCheckAt = chk.at;
        const at = new Date(chk.at).toLocaleTimeString('zh-CN', { hour12: false });
        accCheck.textContent = chk.valid ? `凭证有效（${at}）` : `凭证无效：${chk.reason || '未知原因'}`;
        accCheck.className = `side-note${chk.valid ? '' : ' is-warn'}`;
      } else if (!chk && !lastCheckAt) {
        accCheck.textContent = acct.loggedIn ? '还没校验过，点一下确认凭证是否有效' : '没有登录凭证';
        accCheck.className = 'side-note';
      }

      // 口令状态。renderAccess 只改 placeholder / 按钮文字，不碰提示行
      renderAccess(status.access);

      const gifters = stats.topGifters ?? [];
      replaceChildren(
        rankGifters.body,
        gifters.length
          ? gifters
              .slice(0, 6)
              .map((g, i) =>
                el('div', {
                  class: 'rank-row',
                  children: [
                    el('span', { class: 'idx', text: String(i + 1) }),
                    el('span', { class: 'nm', text: g.name || (g.uid ? `uid ${g.uid}` : '匿名') }),
                    el('span', { class: 'amt', text: `${battery(g.battery)}` }),
                  ],
                }),
              )
          : [el('div', { class: 'empty-hint', text: '本场还没有人送礼' })],
      );

      const gifts = stats.giftRank ?? [];
      replaceChildren(
        rankGifts.body,
        gifts.length
          ? gifts.slice(0, 6).map((g, i) =>
              el('div', {
                class: 'rank-row',
                children: [
                  el('span', { class: 'idx', text: String(i + 1) }),
                  el('span', { class: 'nm', text: g.name }),
                  el('span', { class: 'amt', text: `${n(g.count)} 个` }),
                ],
              }),
            )
          : [el('div', { class: 'empty-hint', text: '暂无' })],
      );
    },
  };
}

/* ── 小工具 ── */

function panel(container, title) {
  const body = el('div');
  container.append(
    el('div', { class: 'panel', children: [el('div', { class: 'panel-head', children: [el('h3', { text: title })] }), body] }),
  );
  return { body };
}

function kv(parent, label) {
  const v = el('span', { class: 'v', text: '—' });
  parent.append(el('div', { class: 'kv', children: [el('span', { class: 'k', text: label }), v] }));
  return { v };
}

function pluginRow(p) {
  return el('div', {
    class: 'plugin-row',
    dataset: { p: p.id },
    attrs: { title: p.name },
    children: [
      el('span', { class: 'pname', text: p.name || p.id }),
      el('span', { class: 'pstat', text: `${n(p.claimed)} 认领 · ${n(p.sent)} 发言` }),
    ],
  });
}
