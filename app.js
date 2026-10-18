// 个人音乐台 - 试用版
// 升级时：同时修改 APP_VERSION 与 sw.js 里的 CACHE_VERSION，再重新部署即可。
const APP_VERSION = '0.2.0';

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const statusEl = $('#status');
const searchEl = $('#search');
const subEl = $('#filterSub');
const losslessEl = $('#filterLossless');
const audio = $('#audio');
const discEl = $('#disc');
const needleEl = $('#needle');
const badgeEl = $('#nowBadge');

let library = [];          // 清单中的曲目
let localTracks = [];      // 本地导入的曲目（仅内存）
let category = 'instrumental';
let currentId = null;

$('#appVer').textContent = 'v' + APP_VERSION;

// ---------- 数据加载 ----------
async function loadLibrary() {
  try {
    const res = await fetch('tracks.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    library = data.tracks || [];
    statusEl.textContent = `清单更新于 ${data.updated}，共 ${library.length} 首`;
  } catch (err) {
    statusEl.textContent = '清单加载失败（离线且无缓存？）：' + err.message;
  }
  render();
}

// ---------- 无损判断 ----------
const LOSSLESS_EXT = ['flac', 'wav', 'ape', 'alac', 'aiff', 'aif'];
const LOSSY_EXT = ['mp3', 'aac', 'ogg', 'opus', 'wma'];

function losslessByName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (LOSSLESS_EXT.includes(ext)) return 'lossless';
  if (LOSSY_EXT.includes(ext)) return 'lossy';
  return 'unknown';
}

function qualityOf(t) {
  if (t.lossless === true) return 'lossless';
  if (t.lossless === false) return 'lossy';
  return 'unknown';
}

const QUALITY_LABEL = { lossless: '无损', lossy: '有损', unknown: '未知' };

// ---------- 色相：由曲目 id 决定，让每首歌有自己的背景色调 ----------
function hueOf(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function setHue(id) {
  document.documentElement.style.setProperty('--hue', hueOf(id || 'home'));
}

// ---------- 筛选 ----------
function currentPool() {
  if (category === 'local') return localTracks;
  return library.filter((t) => t.category === category);
}

function refreshSubOptions() {
  const pool = currentPool();
  const key = category === 'instrumental' ? 'instrument' : 'country';
  const values = [...new Set(pool.map((t) => t[key]).filter(Boolean))].sort();
  const label = category === 'instrumental' ? '全部乐器' : '全部国家/地区';
  const prev = subEl.value;
  subEl.innerHTML = `<option value="">${label}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (values.includes(prev)) subEl.value = prev;
  subEl.hidden = category === 'local';
}

function filtered() {
  const q = searchEl.value.trim().toLowerCase();
  const sub = subEl.value;
  const lq = losslessEl.value;
  const key = category === 'instrumental' ? 'instrument' : 'country';
  return currentPool().filter((t) => {
    if (sub && category !== 'local' && t[key] !== sub) return false;
    if (lq && qualityOf(t) !== lq) return false;
    if (q) {
      const hay = [t.title, t.artist, t.composer, t.genre, t.instrument, t.country, t.name]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------- 渲染 ----------
function render() {
  refreshSubOptions();
  const items = filtered();
  if (category === 'local' && localTracks.length === 0) {
    listEl.innerHTML = '';
    statusEl.textContent = '还没有导入本地文件，点击下方"导入本地文件"。';
    return;
  }
  statusEl.textContent = `显示 ${items.length} 首`;
  listEl.innerHTML = items.map((t) => {
    const q = qualityOf(t);
    const sub = category === 'local'
      ? escapeHtml(t.name)
      : escapeHtml([t.artist, t.instrument || t.country, t.era].filter(Boolean).join(' · '));
    const playing = t.id === currentId ? ' playing' : '';
    return `<li class="item${playing}" data-id="${escapeHtml(t.id)}">
      <div class="main">
        <div class="t">${escapeHtml(t.title || t.name)}</div>
        <div class="s">${sub}</div>
      </div>
      <span class="badge ${q}">${QUALITY_LABEL[q]}${t.format ? ' · ' + escapeHtml(t.format) : ''}</span>
    </li>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 播放 ----------
function allTracks() {
  return [...library, ...localTracks];
}

function play(id) {
  const t = allTracks().find((x) => x.id === id);
  if (!t) return;
  currentId = id;
  setHue(id);
  audio.src = t.url || t.objectUrl;
  audio.play().catch(() => { /* 需要用户再点一次播放 */ });

  $('#nowTitle').textContent = t.title || t.name;
  const q = qualityOf(t);
  $('#nowMeta').textContent = [t.artist, t.composer && `作曲 ${t.composer}`, t.era].filter(Boolean).join(' · ') || ' ';
  badgeEl.hidden = false;
  badgeEl.className = `badge now-badge ${q}`;
  badgeEl.textContent = `${QUALITY_LABEL[q]}${t.format ? ' · ' + t.format : ''}`;

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title || t.name,
      artist: t.artist || '',
    });
  }
  render();
}

listEl.addEventListener('click', (e) => {
  const li = e.target.closest('.item');
  if (li) play(li.dataset.id);
});

// 唱片与唱针跟随播放状态
function setSpinning(on) {
  discEl.classList.toggle('playing', on);
  needleEl.classList.toggle('on', on);
}
audio.addEventListener('play', () => setSpinning(true));
audio.addEventListener('pause', () => setSpinning(false));
audio.addEventListener('ended', () => setSpinning(false));
audio.addEventListener('error', () => {
  setSpinning(false);
  $('#nowMeta').textContent = '播放失败：链接可能失效或当前网络无法访问。';
});

// ---------- 分类与筛选事件 ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    category = btn.dataset.cat;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    subEl.value = '';
    render();
  });
});
searchEl.addEventListener('input', render);
subEl.addEventListener('change', render);
losslessEl.addEventListener('change', render);

// ---------- 本地导入 ----------
$('#localFiles').addEventListener('change', (e) => {
  const files = [...e.target.files];
  files.forEach((f, i) => {
    const q = losslessByName(f.name);
    localTracks.push({
      id: 'local-' + Date.now() + '-' + i,
      name: f.name,
      title: f.name.replace(/\.[^.]+$/, ''),
      objectUrl: URL.createObjectURL(f),
      lossless: q === 'lossless' ? true : q === 'lossy' ? false : null,
      format: (f.name.split('.').pop() || '').toUpperCase(),
    });
  });
  e.target.value = '';
  if (files.length) {
    category = 'local';
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.cat === 'local'));
    render();
  }
});

// ---------- 服务端缓存（离线 + 升级） ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw && sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            statusEl.textContent = '发现新版本，正在更新…';
          }
        });
      });
    }).catch(() => { /* 非 HTTPS 或本地 file:// 时不注册 */ });
    // 新 SW 接管后刷新一次，让新页面生效
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded) { reloaded = true; location.reload(); }
    });
  });
}

loadLibrary();
