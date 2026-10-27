// 万能搜索（个人使用，不做商用）
// 数据源均为公开接口，浏览器可直接跨域访问，无需密钥：
//   电影/剧集：Wikipedia（搜索 + 页面图片）
//   图片：Openverse（CC 授权图片库）
//   音乐：iTunes Search（专辑封面）
//   我的曲库：本地 tracks.json，封面取自 Internet Archive
// 封面加载失败的地址会记入 localStorage，刷新后不再显示该封面。
const APP_VERSION = '0.3.0';

const KINDS = [
  { key: 'all', name: '全部' },
  { key: 'movie', name: '电影' },
  { key: 'tv', name: '剧集' },
  { key: 'image', name: '图片' },
  { key: 'music', name: '音乐' },
  { key: 'library', name: '我的曲库' },
];
const SEARCH_KINDS = ['movie', 'tv', 'image', 'music'];
const KIND_NAME = Object.fromEntries(KINDS.map((k) => [k.key, k.name]));
const PER_SOURCE = 24;

const $ = (sel) => document.querySelector(sel);
const qInput = $('#q');
const catsEl = $('#cats');
const sectionsEl = $('#sections');
const hintEl = $('#hint');

const state = {
  q: '',
  cat: 'all',
  results: {},        // kind -> [{cover, title, sub, link}]
  status: {},         // kind -> 文本或 null
  library: null,      // 曲库条目（只读一次）
};

$('#appVer').textContent = 'v' + APP_VERSION;

// ---------- 失效封面记录（localStorage，可失败） ----------
const DEAD_KEY = 'deadCovers';
const MAX_DEAD = 3000;

function loadDead() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DEAD_KEY) || '[]'));
  } catch (_) {
    return new Set();
  }
}
const deadCovers = loadDead();

function markDead(url) {
  deadCovers.add(url);
  try {
    const arr = [...deadCovers].slice(-MAX_DEAD);
    localStorage.setItem(DEAD_KEY, JSON.stringify(arr));
  } catch (_) { /* 无存储权限时，本次会话内仍然隐藏 */ }
}

// ---------- 数据源 ----------
const isCJK = (s) => /[㐀-鿿]/.test(s);

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Wikipedia：电影 / 剧集
async function fetchWiki(q, kind) {
  const zh = isCJK(q);
  const lang = zh ? 'zh' : 'en';
  const suffix = kind === 'movie'
    ? (zh ? '电影' : 'film')
    : (zh ? '电视剧' : 'television series');
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrsearch: `${q} ${suffix}`, gsrlimit: String(PER_SOURCE),
    prop: 'pageimages|info', piprop: 'thumbnail', pithumbsize: '400', pilicense: 'any',
    inprop: 'url',
  });
  const data = await getJSON(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  const pages = Object.values(data.query?.pages || {});
  return pages
    .filter((p) => p.thumbnail?.source)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({
      cover: p.thumbnail.source,
      title: p.title,
      sub: lang === 'zh' ? '维基百科' : 'Wikipedia',
      link: p.fullurl,
    }));
}

// Wikimedia Commons：图片（多为公版或 CC 授权）
async function fetchImages(q) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrnamespace: '6', gsrsearch: q, gsrlimit: String(PER_SOURCE),
    prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '400',
  });
  const data = await getJSON(`https://commons.wikimedia.org/w/api.php?${params}`);
  return Object.values(data.query?.pages || {})
    .map((p) => ({ p, info: p.imageinfo?.[0] }))
    .filter(({ info }) => info?.thumburl && /^image\//.test(info.mime || ''))
    .sort((a, b) => (a.p.index ?? 0) - (b.p.index ?? 0))
    .map(({ p, info }) => ({
      cover: info.thumburl,
      title: p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
      sub: 'Wikimedia Commons',
      link: info.descriptionurl,
    }));
}

// iTunes：音乐（专辑封面）
async function fetchMusic(q) {
  const params = new URLSearchParams({ term: q, media: 'music', entity: 'song', limit: String(PER_SOURCE) });
  const data = await getJSON(`https://itunes.apple.com/search?${params}`);
  return (data.results || [])
    .filter((r) => r.artworkUrl100)
    .map((r) => ({
      cover: r.artworkUrl100.replace('100x100bb', '400x400bb'),
      title: r.trackName,
      sub: r.artistName,
      link: r.trackViewUrl || r.collectionViewUrl,
    }));
}

// 我的曲库：本地清单，封面来自 Internet Archive 条目图片
async function loadLibrary() {
  if (state.library) return state.library;
  const data = await getJSON('tracks.json');
  state.library = (data.tracks || []).map((t) => {
    const ident = (t.source || '').split('/details/')[1] || '';
    return {
      cover: ident ? `https://archive.org/services/img/${ident}` : '',
      title: t.title,
      sub: [t.artist, t.category === 'vocal' ? '歌曲' : '乐器'].filter(Boolean).join(' · '),
      link: t.source,
      _search: [t.title, t.artist, t.composer, t.instrument, t.country].filter(Boolean).join(' ').toLowerCase(),
    };
  }).filter((x) => x.cover && x.link);
  return state.library;
}

// ---------- 搜索流程 ----------
async function runSearch(q) {
  state.q = q;
  state.results = {};
  state.status = {};
  SEARCH_KINDS.forEach((k) => { state.status[k] = '搜索中…'; });
  render();

  const jobs = {
    movie: () => fetchWiki(q, 'movie'),
    tv: () => fetchWiki(q, 'tv'),
    image: () => fetchImages(q),
    music: () => fetchMusic(q),
  };
  const entries = Object.entries(jobs);
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn()));
  settled.forEach((r, i) => {
    const kind = entries[i][0];
    if (state.q !== q) return;           // 已被新的搜索取代
    if (r.status === 'fulfilled') {
      state.results[kind] = r.value;
      state.status[kind] = r.value.length ? null : '没有找到结果';
    } else {
      state.results[kind] = [];
      state.status[kind] = '暂时不可用：' + (r.reason?.message || '网络错误');
    }
  });
  render();
}

// ---------- 渲染 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function visibleKinds() {
  if (state.cat !== 'all') return [state.cat];
  return [...SEARCH_KINDS, 'library'];
}

function itemsFor(kind) {
  let items;
  if (kind === 'library') {
    const all = state.library || [];
    const q = state.q.trim().toLowerCase();
    items = q ? all.filter((x) => x._search.includes(q)) : all;
  } else {
    items = state.results[kind] || [];
  }
  return items.filter((x) => !deadCovers.has(x.cover));   // 刷新后不再显示已失效封面
}

function renderCats() {
  catsEl.innerHTML = KINDS.map((k) =>
    `<button class="cat${k.key === state.cat ? ' active' : ''}" data-cat="${k.key}">${esc(k.name)}</button>`
  ).join('');
}

function renderSections() {
  const kinds = visibleKinds();
  const parts = [];
  for (const kind of kinds) {
    const isLib = kind === 'library';
    const items = itemsFor(kind);
    const status = isLib ? (state.library ? null : '读取曲库…') : state.status[kind];
    let body = '';
    if (status) body += `<p class="status${status.startsWith('暂时不可用') ? ' err' : ''}">${esc(status)}</p>`;
    if (!status && items.length === 0) {
      const msg = isLib && state.q ? '曲库中没有匹配的条目'
        : state.q ? '暂无可显示的封面'
        : '输入关键词后显示结果';
      body += `<p class="status">${msg}</p>`;
    }
    const cards = items.map((x) => `
      <a class="card" href="${esc(x.link)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
        <div class="cover"><img src="${esc(x.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover="${esc(x.cover)}"></div>
        <div class="t">${esc(x.title)}</div>
        <div class="s">${esc(x.sub)}</div>
      </a>`).join('');
    parts.push(`
      <section class="section" data-kind="${kind}">
        <div class="sec-head">
          <div class="sec-title">${esc(KIND_NAME[kind])}<span>${items.length ? items.length + ' 项' : ''}</span></div>
          <button class="more" hidden aria-label="展开或收起">▾</button>
        </div>
        ${body}
        <div class="strip">${cards}</div>
      </section>`);
  }
  sectionsEl.innerHTML = parts.join('');
  layoutAll();
}

function render() {
  renderCats();
  renderSections();
  hintEl.textContent = state.q ? `“${state.q}” 的结果` : '输入关键词开始搜索；"我的曲库"随时可看。';
}

// 两行高度：测量第一张卡片，超过两行才显示展开箭头
function layoutAll() {
  document.querySelectorAll('.section').forEach((sec) => {
    const strip = sec.querySelector('.strip');
    const btn = sec.querySelector('.more');
    const first = strip.querySelector('.card');
    if (!first) { btn.hidden = true; strip.style.maxHeight = ''; return; }
    const cs = getComputedStyle(strip);
    const gap = parseFloat(cs.rowGap) || 0;
    const rowH = first.offsetHeight;
    const twoRows = Math.round(rowH * 2 + gap);
    if (!strip.classList.contains('open')) strip.style.maxHeight = twoRows + 'px';
    const overflow = strip.scrollHeight > twoRows + 2 || strip.classList.contains('open');
    btn.hidden = !overflow;
    btn.classList.toggle('open', strip.classList.contains('open'));
  });
}

// ---------- 事件 ----------
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (!q) return;
  if (state.cat === 'library') state.cat = 'all';
  runSearch(q);
});

catsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.cat');
  if (!btn) return;
  state.cat = btn.dataset.cat;
  render();
});

sectionsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.more');
  if (!btn) return;
  const strip = btn.closest('.section').querySelector('.strip');
  strip.classList.toggle('open');
  layoutAll();
});

// 封面加载失败：记录并移除，刷新后不再显示
sectionsEl.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.cover) return;
  markDead(img.dataset.cover);
  img.closest('.card')?.remove();
  layoutAll();
}, true);

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layoutAll, 150);
});

// ---------- 启动 ----------
(async () => {
  renderCats();
  try {
    await loadLibrary();
  } catch (err) {
    state.library = [];
  }
  render();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 非 HTTPS 时不注册 */ });
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded) { reloaded = true; location.reload(); }
    });
  });
}
