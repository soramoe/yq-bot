/**
 * 插件面板：schema 驱动，前端不认识任何具体插件。
 *
 * 这一条是 README 里"新增一个插件，前端代码改动 = 0 行"的兑现方式：
 * 表单完全由 `/api/plugins` 返回的 `fields` 生成，字段的 label、类型、
 * 取值范围、提示语全部来自 manifest。想加一个插件，只要写好 manifest 的
 * `config` 段，这里自动就有对应的控件。
 *
 * 三条硬约定：
 *
 * 1. **只提交用户改过的那个字段**。保存的是增量 patch，不是整份配置 ——
 *    否则用户打开一次面板就把当时所有默认值固化了，往后插件升级改了默认文案，
 *    他永远看不到，而且不会有任何提示。
 *
 * 2. **回填服务端返回的值，不回显自己传的值**。manifest 有 min/max，
 *    用户填 100000 而实际生效 600，回显自己的输入等于显示一个假值。
 *
 * 3. **保存失败要把界面退回去**。界面显示"已保存"而实际没保存，
 *    比保存失败本身更糟 —— 用户会以为设置生效了，直播时才发现没生效。
 */

import { api } from '../core/api.js';
import { el, replaceChildren } from '../core/dom.js';
import { saveBlob } from '../core/download.js';
import { GREETING_PACKS, findPack, matchPack } from '../core/greetings.js';

/** 字段没写 group 时归到这一组 */
const DEFAULT_GROUP = '设置';

/**
 * 固定 tab 的 id。
 *
 * 用双下划线开头，保证不会和插件 id（manifest 里的小写标识符）撞名。
 * 「维护」不属于任何插件，但它需要一个能放的地方 —— 塞进某个插件的
 * 面板里会让那个插件的配置看起来莫名其妙。
 */
const MAINTENANCE = '__maintenance';

/**
 * @param {object} opts
 * @param {HTMLDialogElement} opts.dlg
 * @param {HTMLElement} opts.tabs
 * @param {HTMLElement} opts.body
 * @param {HTMLElement} opts.closeBtn
 * @param {(text:string, level?:string)=>void} opts.toast
 * @param {'plugins'|'maintenance'} [opts.mode] 同一套代码挂两种面板：
 *   plugins 走插件 tab；maintenance 只有一个维护页（顶部菜单单独打开）
 */
export function createSettings({ dlg, tabs, body, closeBtn, toast, mode = 'plugins' }) {
  /** @type {Array<object>} 最近一次拿到的插件快照 */
  let plugins = [];
  /** 当前选中的插件 id；维护面板固定停在维护页 */
  let current = mode === 'maintenance' ? MAINTENANCE : null;
  let loading = false;

  // 插件的 tab 是横向滚动。触控板可以横扫，但 PC 的滚轮只有上下：
  // 滚轮落在 tab 条上时把它翻译成横向滚动。只有真的还能滚才拦默认行为，
  // 滚到头之后继续滚，页面该滚还是滚。维护面板没有 tab 条，跳过。
  function wheelToHorizontal(e) {
    if (!tabs || e.ctrlKey || e.defaultPrevented) return;
    const max = tabs.scrollWidth - tabs.clientWidth;
    if (!(max > 0)) return;
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!delta) return;
    const before = tabs.scrollLeft;
    const next = Math.min(max, Math.max(0, before + delta));
    if (next === before) return;
    e.preventDefault();
    tabs.scrollLeft = next;
  }
  if (tabs) tabs.addEventListener('wheel', wheelToHorizontal, { passive: false });

  async function open() {
    if (!dlg.open) dlg.showModal();
    await reload();
  }

  async function reload() {
    if (loading) return;
    loading = true;
    try {
      if (mode === 'maintenance') {
        renderBody();
        return;
      }
      const r = await api.plugins();
      plugins = r.plugins ?? [];
      if (!plugins.some((p) => p.id === current)) {
        current = plugins[0]?.id ?? null;
      }
      renderTabs();
      renderBody();
    } catch (err) {
      toast(err.message, 'error');
      replaceChildren(body, [el('p', { class: 'plg-empty', text: `拿不到插件列表：${err.message}` })]);
    } finally {
      loading = false;
    }
  }

  /* ────────────────────────── 顶部 tab ────────────────────────── */

  function renderTabs() {
    // 维护已经挪到顶部菜单，插件面板只列插件
    if (!tabs) return;
    const list = plugins.map((p) => ({ id: p.id, name: p.name ?? p.id }));
    replaceChildren(
      tabs,
      list.map((t) =>
        el('button', {
          class: `plg-tab${t.id === current ? ' is-on' : ''}`,
          attrs: { type: 'button', role: 'tab', 'aria-selected': String(t.id === current) },
          text: t.name,
          on: {
            click: () => {
              current = t.id;
              renderTabs();
              renderBody();
            },
          },
        }),
      ),
    );
  }

  /* ────────────────────────── 表单 ────────────────────────── */

  function currentPlugin() {
    return plugins.find((p) => p.id === current) ?? null;
  }

  function renderBody() {
    // 维护面板只有一个页面；插件面板才按当前 tab 走
    if (mode === 'maintenance' || current === MAINTENANCE) {
      void renderMaintenance();
      return;
    }

    const p = currentPlugin();
    if (!p) {
      replaceChildren(body, [el('p', { class: 'plg-empty', text: '还没有加载任何插件' })]);
      return;
    }

    const nodes = [];

    // 插件自身的开关（宿主级）。放在最上面，因为它决定下面所有配置是否有意义。
    nodes.push(
      el('div', { class: 'plg-title' }, {
        children: [
          el('div', { class: 'plg-title-main' }, {
            children: [
              el('span', { class: 'plg-name', text: p.name ?? p.id }),
              el('span', { class: 'plg-ver', text: p.version ?? '' }),
            ],
          }),
          el('label', { class: 'switch', attrs: { title: '关掉后这个插件完全不参与，配置保留' } }, {
            children: [
              el('input', {
                attrs: { type: 'checkbox', ...(p.enabled ? { checked: 'checked' } : {}) },
                on: {
                  change: (e) => togglePlugin(p, e.target.checked),
                },
              }),
              el('span', { text: '启用' }),
            ],
          }),
        ],
      }),
    );

    if (p.description) {
      nodes.push(el('p', { class: 'plg-desc', text: p.description }));
    }

    const fields = p.fields ?? [];
    if (fields.length === 0) {
      nodes.push(el('p', { class: 'plg-empty', text: '这个插件没有可改的配置' }));
    }

    // 按 group 分段，段内保持 manifest 里的顺序（作者排的顺序就是使用顺序）
    const groups = new Map();
    for (const f of fields) {
      const g = f.group || DEFAULT_GROUP;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }

    for (const [g, list] of groups) {
      nodes.push(el('div', { class: 'plg-group', text: g }));
      for (const f of list) nodes.push(fieldRow(p, f));
    }

    if (fields.length) {
      nodes.push(
        el('div', { class: 'plg-foot' }, {
          children: [
            el('span', { class: 'plg-foot-tip', text: '改动即时生效，不需要重启' }),
            el('button', {
              class: 'btn',
              attrs: { type: 'button' },
              text: '恢复默认',
              on: { click: () => resetPlugin(p) },
            }),
          ],
        }),
      );
    }

    replaceChildren(body, nodes);
  }

  /* ────────────────────────── 维护 ────────────────────────── */

  /**
   * 维护页：更新检查 + 诊断包。
   *
   * 刻意**不**把"设置更新源"做成自动保存：地址写错不该悄悄生效，
   * 而且这是要发网络请求的东西 —— 让人明确点一下"保存"再点"检查"，
   * 比"输一个字就存一次"清楚得多。
   */
  async function renderMaintenance() {
    replaceChildren(body, [el('p', { class: 'plg-empty', text: '正在读取状态…' })]);

    let st;
    try {
      st = await api.status();
    } catch (err) {
      replaceChildren(body, [el('p', { class: 'plg-empty', text: `读取状态失败：${err.message}` })]);
      return;
    }
    // 用户在等结果的时候可能已经切到别的插件了
    if (current !== MAINTENANCE) return;

    const version = st.version ?? '—';
    const savedUrl = String(st.config?.updateUrl ?? '');
    const snapshot = st.update ?? null;

    const nodes = [];

    /* ── 账号 ── */
    nodes.push(el('div', { class: 'plg-group', text: '账号' }));
    nodes.push(
      el('div', { class: 'plg-field' }, {
        children: [
          el('div', { class: 'plg-label' }, {
            children: [el('span', { class: 'plg-label-text', text: `当前账号 ${st.account?.uname || '未登录'}` })],
          }),
          el('div', { class: 'side-actions' }, {
            children: [
              el('button', {
                class: 'btn small',
                attrs: { type: 'button' },
                text: '切换账号',
                on: { click: () => window.open('/login', '_blank', 'noopener') },
              }),
            ],
          }),
          el('div', {
            class: 'plg-hint',
            text: '扫码成功后自动重连房间，不用重启服务；凭证只保存在本机 data/auth.json',
          }),
        ],
      }),
    );

    /* ── 使用说明 ── */
    nodes.push(el('div', { class: 'plg-group', text: '使用说明' }));
    nodes.push(
      el('div', { class: 'plg-field' }, {
        children: [
          el('div', {
            class: 'plg-hint',
            text: '安装、启停、换房间、换账号、更新和常见问题，都写在仓库的文档里。',
          }),
          el('div', { class: 'side-actions' }, {
            children: [
              el('button', {
                class: 'btn small',
                attrs: { type: 'button' },
                text: '打开 GitHub 使用说明',
                on: {
                  click: () =>
                    window.open('https://github.com/soramoe/yq-bot/blob/main/docs/guide.md', '_blank', 'noopener'),
                },
              }),
            ],
          }),
        ],
      }),
    );

    /* ── 更新 ── */
    nodes.push(el('div', { class: 'plg-group', text: '更新' }));
    nodes.push(
      el('div', { class: 'plg-field' }, {
        children: [
          el('div', { class: 'plg-label' }, {
            children: [el('span', { class: 'plg-label-text', text: `当前版本 ${version}` })],
          }),
          el('div', { class: 'plg-hint', text: '下载并校验后才会重启替换；不后台静默安装，直播中会再确认一次' }),
        ],
      }),
    );

    const urlInput = el('input', {
      class: 'plg-input',
      attrs: { type: 'text', value: savedUrl, placeholder: '更新源地址（留空 = 不检查）', spellcheck: 'false' },
    });
    const saveUrlBtn = el('button', { class: 'btn small', attrs: { type: 'button' }, text: '保存地址' });
    const checkBtn = el('button', { class: 'btn primary small', attrs: { type: 'button' }, text: '检查更新' });
    const dlBtn = el('button', { class: 'btn small', attrs: { type: 'button' }, text: '下载更新包' });
    const applyBtn = el('button', { class: 'btn primary small', attrs: { type: 'button' }, text: '重启并应用' });
    dlBtn.style.display = 'none';
    applyBtn.style.display = 'none';
    const updNote = el('div', { class: 'plg-hint', text: describeUpdate(snapshot) });

    let latestVersion = '';

    const offerUpdate = (r) => {
      const can = Boolean(r?.hasUpdate && r?.download);
      if (!can) {
        dlBtn.style.display = 'none';
        applyBtn.style.display = 'none';
        return;
      }
      latestVersion = String(r.latest ?? '');
      dlBtn.style.display = '';
      dlBtn.textContent = '下载更新包';
      applyBtn.style.display = 'none';
    };

    offerUpdate(snapshot);

    const savedMirror = String(st.config?.updateMirror ?? '');
    const mirrorInput = el('input', {
      class: 'plg-input',
      attrs: {
        type: 'text',
        value: savedMirror,
        placeholder: '镜像地址（可选，例如 https://mirror.example.com/yq）',
        spellcheck: 'false',
      },
    });
    const saveMirrorBtn = el('button', { class: 'btn small', attrs: { type: 'button' }, text: '保存镜像' });
    const mirrorNote = el('div', {
      class: 'plg-hint',
      text: savedMirror
        ? `当前镜像：${savedMirror}`
        : '留空 = 不用镜像；填了会先读镜像的 latest.json，失败再回落更新源',
    });

    nodes.push(
      el('div', { class: 'plg-field' }, {
        children: [
          el('div', { class: 'plg-label', children: [el('span', { class: 'plg-label-text', text: '更新镜像' })] }),
          mirrorInput,
          el('div', { class: 'side-actions', children: [saveMirrorBtn] }),
          mirrorNote,
          el('div', {
            class: 'plg-hint',
            text: '镜像目录约定：latest.json 放清单，更新包放同目录同名文件；镜像只做转发，不改变校验',
          }),
        ],
      }),
    );

    saveMirrorBtn.addEventListener('click', async () => {
      saveMirrorBtn.disabled = true;
      try {
        const r = await api.setUpdateMirror(String(mirrorInput.value ?? '').trim());
        mirrorInput.value = r.updateMirror ?? '';
        mirrorNote.textContent = r.updateMirror ? `当前镜像：${r.updateMirror}` : '已清空镜像，之后只走更新源';
        mirrorNote.className = 'plg-hint';
        toast('镜像地址已保存', 'info');
      } catch (err) {
        mirrorNote.textContent = err.message;
        mirrorNote.className = 'plg-hint is-error';
      } finally {
        saveMirrorBtn.disabled = false;
      }
    });

    nodes.push(
      el('div', { class: 'plg-field' }, {
        children: [
          el('div', { class: 'plg-label', children: [el('span', { class: 'plg-label-text', text: '更新源' })] }),
          urlInput,
          el('div', { class: 'side-actions', children: [saveUrlBtn, checkBtn, dlBtn, applyBtn] }),
          updNote,
          el('div', {
            class: 'plg-hint',
            text: '更新源要返回 JSON：{ "version": "0.3.0", "download": "https://…/yuyue3-0.3.0.tar.gz", "sha256": "…", "size": 12345 }',
          }),
        ],
      }),
    );

    saveUrlBtn.addEventListener('click', async () => {
      saveUrlBtn.disabled = true;
      try {
        const r = await api.setUpdateUrl(String(urlInput.value ?? '').trim());
        updNote.textContent = r.updateUrl ? `更新源已保存：${r.updateUrl}` : '已清空更新源，之后不再检查更新';
        updNote.className = 'plg-hint';
        toast('更新源已保存', 'info');
      } catch (err) {
        updNote.textContent = err.message;
        updNote.className = 'plg-hint is-error';
      } finally {
        saveUrlBtn.disabled = false;
      }
    });

    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      updNote.textContent = '正在检查…';
      updNote.className = 'plg-hint';
      try {
        const r = await api.checkUpdate({ force: true });
        updNote.textContent = describeUpdate(r);
        updNote.className = `plg-hint${r.hasUpdate ? ' is-new' : r.error ? ' is-error' : ''}`;
        offerUpdate(r);
      } catch (err) {
        updNote.textContent = err.message;
        updNote.className = 'plg-hint is-error';
      } finally {
        checkBtn.disabled = false;
      }
    });

    dlBtn.addEventListener('click', async () => {
      if (dlBtn.disabled) return;
      dlBtn.disabled = true;
      updNote.textContent = '正在下载更新包…';
      updNote.className = 'plg-hint';
      try {
        const r = await api.updateDownload();
        const mb = (Number(r.bytes) / 1024 / 1024).toFixed(1);
        updNote.textContent = `已下载 v${r.version}（${mb}MB），重启后生效`;
        updNote.className = 'plg-hint is-new';
        dlBtn.textContent = '重新下载';
        applyBtn.style.display = '';
        toast('更新包已下载', 'info');
      } catch (err) {
        updNote.textContent = `下载失败：${err.message}`;
        updNote.className = 'plg-hint is-error';
      } finally {
        dlBtn.disabled = false;
      }
    });

    applyBtn.addEventListener('click', async () => {
      if (applyBtn.disabled) return;
      const live = st.brief?.state === 'live';
      if (!window.confirm(`重启并更新到 v${latestVersion || '新版本'}？服务会停几秒，页面随后自动重连。`)) {
        return;
      }
      applyBtn.disabled = true;
      try {
        try {
          await api.updateApply({ force: false });
        } catch (err) {
          if (err?.code !== 'live_update') throw err;
          if (!window.confirm('当前正在直播。更新会中断推流和弹幕处理，确定现在更新？')) {
            applyBtn.disabled = false;
            return;
          }
          await api.updateApply({ force: true });
        }
        updNote.textContent = '正在重启并应用更新…';
        updNote.className = 'plg-hint is-new';
        toast(live ? '更新中，直播会被短暂中断' : '正在重启更新…', live ? 'warn' : 'info');
      } catch (err) {
        updNote.textContent = `更新失败：${err.message}`;
        updNote.className = 'plg-hint is-error';
        applyBtn.disabled = false;
      }
    });

    /* ── 诊断包 ── */
    nodes.push(el('div', { class: 'plg-group', text: '诊断包' }));

    const diagBtn = el('button', { class: 'btn small', attrs: { type: 'button' }, text: '生成诊断包' });
    const diagNote = el('div', {
      class: 'plg-hint',
      text: '打包版本、状态、脱敏配置与最近事件骨架。不含 Cookie、口令、昵称和弹幕内容，可以发给别人排障。',
    });
    nodes.push(
      el('div', { class: 'plg-field' }, {
        children: [
          el('div', { class: 'plg-label', children: [el('span', { class: 'plg-label-text', text: '一键导出' })] }),
          el('div', { class: 'side-actions', children: [diagBtn] }),
          diagNote,
        ],
      }),
    );

    diagBtn.addEventListener('click', async () => {
      diagBtn.disabled = true;
      diagNote.textContent = '正在打包…';
      diagNote.className = 'plg-hint';
      try {
        const { blob, filename, size } = await api.diagnostic();
        const saved = saveBlob(blob, filename);
        const kb = Math.max(1, Math.round(size / 1024));
        diagNote.textContent = saved
          ? `已生成 ${filename}（${kb} KB）`
          : `已生成 ${filename}（${kb} KB），但当前环境不能自动下载，请从浏览器下载记录里取`;
        diagNote.className = 'plg-hint';
      } catch (err) {
        diagNote.textContent = err.message;
        diagNote.className = 'plg-hint is-error';
      } finally {
        diagBtn.disabled = false;
      }
    });

    replaceChildren(body, nodes);
  }

  /** 把更新检查的结果翻译成人话。null 也要有话说 */
  function describeUpdate(r) {
    if (!r) return '还没检查过';
    if (!r.configured) return '还没配置更新源，填一个地址才能检查';
    if (r.error) return `检查失败：${r.error}`;
    if (r.hasUpdate) {
      return `有新版本 ${r.latest}（当前 ${r.current}）${r.notes ? `：${r.notes}` : ''}`;
    }
    return `已是最新（当前 ${r.current}）`;
  }

  /**
   * 一行字段。
   *
   * 布局是「标签在上、控件在下」的竖排，而不是左右两栏。
   * 左标签右控件的两栏在 320px 宽度下会把输入框压到无法输入，
   * 而手机上改配置正是最常见的使用场景。
   */
  function fieldRow(p, f) {
    const value = p.config?.[f.key];
    const isDefault = sameValue(value, f.default);

    const control = buildControl(f, value, (raw) => saveField(p, f, raw));

    return el('div', { class: 'plg-field', dataset: { key: f.key } }, {
      children: [
        el('div', { class: 'plg-label' }, {
          children: [
            el('span', { class: 'plg-label-text', text: f.label ?? f.key }),
            isDefault ? null : el('span', { class: 'plg-badge', text: '已改' }),
          ],
        }),
        control,
        f.hint ? el('div', { class: 'plg-hint', text: f.hint }) : null,
      ],
    });
  }

  /* ────────────────────────── 控件 ────────────────────────── */

  function buildControl(f, value, commit) {
    switch (f.type) {
      case 'switch': {
        const input = el('input', {
          attrs: { type: 'checkbox', ...(value ? { checked: 'checked' } : {}) },
          on: { change: (e) => commit(e.target.checked) },
        });
        return el('label', { class: 'switch' }, {
          children: [input, el('span', { text: value ? '开' : '关' })],
        });
      }

      case 'number': {
        const attrs = { type: 'number', value: String(value ?? 0) };
        if (Number.isFinite(f.min)) attrs.min = String(f.min);
        if (Number.isFinite(f.max)) attrs.max = String(f.max);
        attrs.step = String(Number.isFinite(f.step) ? f.step : 1);
        const input = el('input', {
          class: 'plg-input',
          attrs,
          on: {
            // change 而不是 input：input 每敲一个字符就存一次，
            // 数字会被存成"1"→"10"→"100" 三个中间值
            change: (e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) {
                e.target.value = String(value ?? 0);
                return;
              }
              commit(n);
            },
          },
        });
        return input;
      }

      case 'textarea': {
        const input = el('textarea', {
          class: 'plg-input plg-area',
          attrs: { rows: '3' },
          text: String(value ?? ''),
          on: { change: (e) => commit(e.target.value) },
        });
        return input;
      }

      case 'lines': {
        const arr = Array.isArray(value) ? value : [];
        const input = el('textarea', {
          class: 'plg-input plg-area',
          attrs: { rows: '4' },
          text: arr.join('\n'),
          on: {
            change: (e) => commit(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)),
          },
        });

        // manifest 写了 `presets` 才加这一层：预设列表来自共享的文案库，
        // 前端依然不认识任何具体插件。选一套 = 把该套文案写进输入框并立刻保存，
        // 走的是和普通编辑完全相同的 saveField 路径（回填服务端的值、失败退回）。
        if (f.presets !== 'greetings') return input;
        const current = matchPack(arr);
        const select = el('select', {
          class: 'plg-input plg-preset',
          attrs: { 'aria-label': '套用文案预设' },
          on: {
            change: (e) => {
              const pack = findPack(e.target.value);
              if (!pack) return; // 「自定义」项：不动输入框，也不提交
              input.value = pack.lines.join('\n');
              commit(pack.lines.slice());
            },
          },
        }, {
          children: [
            el('option', {
              // 已经在用某套预设时，这一项只是提示文字、不可选；
              // 否则选了它等于"什么都不做"，看起来却像操作成功了
              attrs: {
                value: '',
                ...(current ? { disabled: 'disabled' } : { selected: 'selected' }),
              },
              text: current ? '换一套预设…' : '自定义文案',
            }),
            ...GREETING_PACKS.map((p) =>
              el('option', {
                attrs: { value: p.id, ...(current?.id === p.id ? { selected: 'selected' } : {}) },
                text: p.name,
              }),
            ),
          ],
        });
        const note = el('div', {
          class: 'plg-hint',
          text: current
            ? `当前预设：${current.name}（${current.desc}）`
            : '当前是自定义文案，选一套可一键替换',
        });
        return el('div', { class: 'plg-preset-wrap', children: [select, note, input] });
      }

      case 'list': {
        // 与 lines 的区别：lines 是"文本行"，list 是"条目"，不做 trim 也不丢空行
        const arr = Array.isArray(value) ? value : [];
        const input = el('textarea', {
          class: 'plg-input plg-area',
          attrs: { rows: '4' },
          text: arr.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'),
          on: { change: (e) => commit(e.target.value.split('\n').filter((x) => x !== '')) },
        });
        return input;
      }

      case 'select': {
        const opts = Array.isArray(f.options) ? f.options : [];
        const select = el('select', {
          class: 'plg-input',
          on: { change: (e) => commit(e.target.value) },
        }, {
          children: opts.map((o) => {
            const v = typeof o === 'string' ? o : String(o?.value ?? '');
            const label = typeof o === 'string' ? o : String(o?.label ?? v);
            return el('option', {
              attrs: { value: v, ...(String(value ?? '') === v ? { selected: 'selected' } : {}) },
              text: label,
            });
          }),
        });
        return select;
      }

      case 'color': {
        const input = el('input', {
          class: 'plg-input plg-color',
          attrs: { type: 'color', value: String(value ?? '#4c8dff') },
          on: { change: (e) => commit(e.target.value) },
        });
        return input;
      }

      default: {
        const input = el('input', {
          class: 'plg-input',
          attrs: { type: 'text', value: String(value ?? '') },
          on: { change: (e) => commit(e.target.value) },
        });
        return input;
      }
    }
  }

  /* ────────────────────────── 保存 ────────────────────────── */

  async function saveField(p, f, raw) {
    const before = p.config?.[f.key];

    try {
      const r = await api.savePluginConfig(p.id, { [f.key]: raw });
      // 服务端可能收敛了值（min/max），以它为准
      p.config = r.config;

      const next = p.config[f.key];
      if (!sameValue(next, raw)) {
        toast(`${f.label ?? f.key} 只接受 ${JSON.stringify(next)}，已按规则修正`, 'warn');
      }
      // 只重绘这一行，避免整块重排把其他输入框的焦点弄丢
      redrawField(p, f);
    } catch (err) {
      // 退回旧值：界面显示的值必须等于实际生效的值
      if (p.config) p.config[f.key] = before;
      redrawField(p, f);
      toast(err.message, 'error');
    }
  }

  function redrawField(p, f) {
    const row = body.querySelector(`.plg-field[data-key="${cssEscape(f.key)}"]`);
    if (!row) return;
    const fresh = fieldRow(p, f);
    row.replaceWith(fresh);
  }

  async function resetPlugin(p) {
    try {
      const r = await api.resetPluginConfig(p.id);
      p.config = r.config;
      renderBody();
      toast(`已恢复 ${p.name ?? p.id} 的默认配置`, 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function togglePlugin(p, enabled) {
    try {
      await api.setPluginEnabled(p.id, enabled);
      p.enabled = enabled;
      renderBody();
      toast(`${p.name ?? p.id} 已${enabled ? '启用' : '停用'}`, enabled ? 'info' : 'warn');
    } catch (err) {
      renderBody();
      toast(err.message, 'error');
    }
  }

  /* ────────────────────────── 事件 ────────────────────────── */

  closeBtn.addEventListener('click', () => dlg.close());

  // 点遮罩关闭：<dialog> 的默认行为是点 backdrop 不关，这里补上，
  // 否则手机上很容易点进"关不掉"的状态
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });

  return {
    open,
    /** 别的标签页改了配置时用它同步，不整个重拉 */
    reload,
  };
}

/* ────────────────────────── 小工具 ────────────────────────── */

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    return x.length === y.length && x.every((v, i) => String(v) === String(y[i]));
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return String(a ?? '') === String(b ?? '');
}

/** 属性选择器里的 key 只可能是 manifest 里的 a-z 标识符，但仍要挡住引号 */
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}
