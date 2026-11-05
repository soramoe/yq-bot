/**
 * 点歌队列面板。
 *
 * 队列由内核在弹幕 / SC 事件里收（`data/songs.json`），这里只做两件事：
 * 展示，以及把「播放 / 完成 / 跳过」这些人工决定发回服务端。
 *
 * 徽标数字是"还在排队"的条数，不含播放中的那条 —— 播放中的已经在
 * 页面上写着，不需要再用红点提醒。
 */

import { el, replaceChildren } from '../core/dom.js';

function yuanText(n) {
  const v = Math.max(0, Number(n) || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function createSongQueue({ dlg, badge = null, api, toast = () => {} }) {
  let data = { current: null, queued: 0, items: [] };
  let loadSeq = 0;
  let busy = false;
  let pendingReload = false;

  const root = el('div', { class: 'song-wrap' });
  const head = el('header', {
    class: 'song-head',
    children: [
      el('h4', { text: '点歌队列' }),
      el('span', { class: 'song-sub', text: '弹幕发「点歌 歌名」就会进来；队列跨重启保留' }),
      el('span', { class: 'song-spacer' }),
      el('button', { class: 'btn', type: 'button', text: '关闭', on: { click: () => dlg.close() } }),
    ],
  });
  const summary = el('div', { class: 'song-summary' });
  const list = el('div', { class: 'song-list' });
  root.append(head, summary, list);
  replaceChildren(dlg, [root]);

  function renderBadge() {
    if (!badge) return;
    const n = data.queued;
    badge.textContent = String(n);
    badge.hidden = n === 0;
  }

  function render() {
    const items = data.items;
    summary.textContent =
      items.length === 0
        ? '队列是空的'
        : `排队中 ${data.queued} 首${data.current?.status === 'playing' ? ` · 正在播放：${data.current.song}` : ''}`;

    if (!items.length) {
      replaceChildren(list, [
        el('div', {
          class: 'song-empty',
          children: [
            el('div', { text: '还没有人点歌' }),
            el('div', { class: 'song-empty-sub', text: '观众发一条「点歌 歌名」的弹幕，就会出现在这里。' }),
          ],
        }),
      ]);
      renderBadge();
      return;
    }

    replaceChildren(
      list,
      items.map((it, i) =>
        el('div', {
          class: `song-row${it.status === 'playing' ? ' is-playing' : ''}`,
          children: [
            el('span', { class: 'song-rank', text: String(i + 1) }),
            el('div', {
              class: 'song-main',
              children: [
                el('div', { class: 'song-title', text: it.song }),
                el('div', {
                  class: 'song-meta',
                  text: `${it.name || '匿名观众'}${it.yuan > 0 ? ` · ¥${yuanText(it.yuan)}` : ' · 弹幕点歌'}`,
                }),
              ],
            }),
            el('span', {
              class: `song-state${it.status === 'playing' ? ' is-playing' : ''}`,
              text: it.status === 'playing' ? '播放中' : '排队中',
            }),
            el('div', {
              class: 'song-actions',
              children: [
                it.status === 'queued'
                  ? el('button', {
                      class: 'btn',
                      type: 'button',
                      text: '播放',
                      on: { click: () => act(it.id, 'play') },
                    })
                  : null,
                el('button', {
                  class: 'btn',
                  type: 'button',
                  text: '完成',
                  on: { click: () => act(it.id, 'done') },
                }),
                el('button', {
                  class: 'btn',
                  type: 'button',
                  text: '跳过',
                  on: { click: () => act(it.id, 'skip') },
                }),
              ],
            }),
          ],
        }),
      ),
    );
    renderBadge();
  }

  function applyLocal(id, action) {
    if (action === 'done' || action === 'skip') {
      data.items = data.items.filter((it) => it.id !== id);
      if (data.current?.id === id) data.current = null;
    } else if (action === 'play') {
      for (const it of data.items) if (it.status === 'playing') it.status = 'queued';
      const target = data.items.find((it) => it.id === id);
      if (target) target.status = 'playing';
      data.current = target ?? null;
    }
    data.queued = data.items.filter((it) => it.status === 'queued').length;
    data.current = data.items.find((it) => it.status === 'playing') ?? null;
  }

  async function act(id, action) {
    if (busy) return;
    busy = true;
    try {
      await api.songAction(id, action);
      applyLocal(id, action);
      render();
    } catch (err) {
      toast(`队列没更新：${err.message}`, 'error');
    } finally {
      busy = false;
    }
  }

  function update(next) {
    if (!next || typeof next !== 'object') return;
    data = {
      current: next.current ?? null,
      queued: Number(next.queued) || 0,
      items: Array.isArray(next.items) ? next.items.map((it) => ({ ...it })) : [],
    };
    if (dlg.open) render();
    else renderBadge();
  }

  async function load() {
    if (busy) return;
    busy = true;
    const seq = ++loadSeq;
    try {
      const r = await api.songs();
      if (seq !== loadSeq) return;
      update(r);
      render();
    } catch (err) {
      toast(`点歌队列打不开：${err.message}`, 'error');
    } finally {
      busy = false;
      if (pendingReload) {
        pendingReload = false;
        load();
      }
    }
  }

  function open() {
    if (!dlg.open) dlg.showModal();
    render();
    load();
  }

  function refreshIfOpen() {
    if (dlg.open) load();
  }

  function reset() {
    // 队列是整机一份、不随房间变；切房时不能把徽标清零，否则
    // 队列还在、页面却说没有。直接重拉一次，以服务端为准。
    load();
  }

  renderBadge();
  return { open, refreshIfOpen, update, reset };
}
