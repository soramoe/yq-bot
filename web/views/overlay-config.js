/**
 * OBS 挂件的设置面板。
 *
 * 挂件本身是 `/overlay.html` 这个只读页面，不是插件：它不认领弹幕事件、
 * 不参与发言仲裁，所以不该出现在「插件」列表里。用户真正需要的是一个
 * **能生成地址、能复制、能看说明** 的地方，这个对话框只做这件事。
 */

import { el, replaceChildren } from '../core/dom.js';

const STORE_KEY = 'yuyue.overlay.config';
const THEMES = [
  ['default', '深色（默认）'],
  ['light', '浅色'],
  ['warm', '暖色'],
  ['mono', '黑白'],
];
const SCENES = [
  ['full', '完整（全部卡片）'],
  ['compact', '精简（标题 + 数字）'],
  ['minimal', '极简（只留标题）'],
];
const HIDES = [
  ['paid', '付费用户'],
  ['gifts', '最近礼物'],
  ['goal', '礼物目标'],
  ['stats', '本场数字'],
];

export function buildOverlayUrl(base, { theme = 'default', scene = 'full', hide = [] } = {}) {
  const url = new URL('/overlay.html', base || 'http://127.0.0.1:8900');
  if (theme !== 'default') url.searchParams.set('theme', theme);
  if (scene !== 'full') url.searchParams.set('scene', scene);
  const picked = [...new Set(hide)].filter((x) => HIDES.some(([id]) => id === x)).sort();
  if (picked.length) url.searchParams.set('hide', picked.join(','));
  return url.toString();
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      theme: THEMES.some(([id]) => id === data.theme) ? data.theme : 'default',
      scene: SCENES.some(([id]) => id === data.scene) ? data.scene : 'full',
      hide: Array.isArray(data.hide) ? data.hide.filter((x) => HIDES.some(([id]) => id === x)) : [],
    };
  } catch {
    return null;
  }
}

function save(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式下 localStorage 可能不可用；不记也无所谓
  }
}

export function createOverlayConfig({ dlg, toast = () => {}, origin = null }) {
  const saved = loadSaved();
  const state = saved ?? { theme: 'default', scene: 'full', hide: [] };
  const base = origin || window.location.origin;

  const urlInput = el('input', {
    class: 'ovcfg-url',
    attrs: { type: 'text', readonly: 'readonly', spellcheck: 'false' },
  });

  function currentUrl() {
    return buildOverlayUrl(base, state);
  }

  async function copyUrl() {
    const text = currentUrl();
    try {
      await navigator.clipboard.writeText(text);
      toast('挂件地址已复制', 'info');
    } catch {
      urlInput.value = text;
      urlInput.select?.();
      try {
        document.execCommand('copy');
        toast('挂件地址已复制', 'info');
      } catch {
        toast('浏览器没给剪贴板权限，手动复制上面的地址', 'warn');
      }
    }
  }

  function render() {
    const themeSelect = el('select', {
      attrs: { 'aria-label': '挂件主题' },
      on: {
        change: (e) => {
          state.theme = e.target.value;
          save(state);
          render();
        },
      },
    }, {
      children: THEMES.map(([value, label]) =>
        el('option', { text: label, attrs: { value, selected: value === state.theme ? 'selected' : null } })),
    });

    const sceneSelect = el('select', {
      attrs: { 'aria-label': '挂件场景' },
      on: {
        change: (e) => {
          state.scene = e.target.value;
          save(state);
          render();
        },
      },
    }, {
      children: SCENES.map(([value, label]) =>
        el('option', { text: label, attrs: { value, selected: value === state.scene ? 'selected' : null } })),
    });

    const hideBoxes = HIDES.map(([id, label]) =>
      el('label', { class: 'ovcfg-check' }, {
        children: [
          el('input', {
            attrs: { type: 'checkbox', checked: state.hide.includes(id) ? 'checked' : null },
            on: {
              change: (e) => {
                state.hide = e.target.checked
                  ? [...new Set([...state.hide, id])]
                  : state.hide.filter((x) => x !== id);
                save(state);
                render();
              },
            },
          }),
          el('span', { text: label }),
        ],
      }));

    urlInput.value = currentUrl();

    replaceChildren(dlg, [
      el('div', { class: 'ovcfg-wrap' }, {
        children: [
          el('header', { class: 'ovcfg-head' }, {
            children: [
              el('h4', { text: 'OBS 挂件' }),
              el('button', {
                class: 'btn', text: '关闭', attrs: { type: 'button' },
                on: { click: () => dlg.close() },
              }),
            ],
          }),
          el('p', {
            class: 'ovcfg-intro',
            text: '挂件是给 OBS「浏览器源」用的只读页面：显示本场数字、付费用户和最近礼物，不会发言，也不影响机器人。',
          }),
          el('div', { class: 'ovcfg-field' }, {
            children: [
              el('div', { class: 'ovcfg-label', text: '挂件地址' }),
              el('div', { class: 'ovcfg-row' }, {
                children: [
                  urlInput,
                  el('button', {
                    class: 'btn small', text: '复制', attrs: { type: 'button' },
                    on: { click: () => void copyUrl() },
                  }),
                  el('a', {
                    class: 'btn small', text: '打开预览', attrs: { href: currentUrl(), target: '_blank', rel: 'noopener' },
                  }),
                ],
              }),
              el('div', {
                class: 'ovcfg-hint',
                text: '地址可以随时改主题/场景；改完复制新地址，替换 OBS 里的旧地址即可。',
              }),
            ],
          }),
          el('div', { class: 'ovcfg-grid' }, {
            children: [
              el('div', { class: 'ovcfg-field' }, {
                children: [el('div', { class: 'ovcfg-label', text: '主题' }), themeSelect],
              }),
              el('div', { class: 'ovcfg-field' }, {
                children: [el('div', { class: 'ovcfg-label', text: '场景' }), sceneSelect],
              }),
            ],
          }),
          el('div', { class: 'ovcfg-field' }, {
            children: [
              el('div', { class: 'ovcfg-label', text: '隐藏不想露出的卡片' }),
              el('div', { class: 'ovcfg-checks' }, { children: hideBoxes }),
            ],
          }),
          el('div', { class: 'ovcfg-field' }, {
            children: [
              el('div', { class: 'ovcfg-label', text: '在 OBS 里怎么加' }),
              el('ol', { class: 'ovcfg-steps' }, {
                children: [
                  el('li', { text: 'OBS 左下「来源」→ 加号 →「浏览器」。' }),
                  el('li', { text: '把上面的地址粘贴到「URL」。' }),
                  el('li', { text: '宽 1280、高 720（或按你的画布比例缩放）。' }),
                  el('li', { text: '背景默认透明，不用勾选额外选项；不要加自定义 CSS。' }),
                  el('li', { text: '想换主题或隐藏卡片，回这个面板改，复制新地址替换。' }),
                ],
              }),
            ],
          }),
          el('div', {
            class: 'ovcfg-hint',
            text: '挂件只读公开的直播数据；断线会自动重连，OBS 那边不用反复刷新。',
          }),
        ],
      }),
    ]);
  }

  return {
    open() {
      render();
      if (!dlg.open) dlg.showModal();
    },
  };
}
