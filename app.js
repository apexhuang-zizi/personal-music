// 万能搜索（个人使用，不做商用）
// 数据源（均为公开接口，浏览器可直接访问，无需密钥）：
//   电影：Internet Archive 公版剧情片合集（可在页内播放）
//   剧集：Wikipedia（仅信息，无播放）
//   图片：Wikimedia Commons（仅图片，点击打开原页）
//   音乐：iTunes 搜索（30 秒试听，可在页内播放）
//   我的曲库：本地 tracks.json（可在页内播放）
// 封面加载失败的地址会记入 localStorage，刷新后不再显示。
const APP_VERSION = '0.4.0';

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
const playerEl = $('#player');
const playerTitle = $('#playerTitle');
const playerAudio = $('#playerAudio');
const playerVideo = $('#playerVideo');
const playerNote = $('#playerNote');

const state = {
  q: '',
  cat: 'all',
  results: {},        // kind -> [{cover, title, sub, link, play}]
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

// ---------- 通用 ----------
const isCJK = (s) => /[\u3400-\u9fff]/.test(s);

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Archive 搜索语法中有特殊字符，先去掉
const cleanTerm = (s) => s.replace(/[():"\\[\]{}^~*?!+\-/]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- 数据源 ----------

// 电影：Archive 公版剧情片合集，播放时再去取可播放的文件
async function fetchMovies(q) {
  const term = cleanTerm(q);
  if (!term) return [];
  const params = new URLSearchParams();
  params.set('q', `collection:feature_films AND mediatype:movies AND title:(${term})`);
  ['identifier', 'title', 'date'].forEach((f) => params.append('fl[]', f));
  params.set('rows', String(PER_SOURCE));
  params.set('output', 'json');
  const data = await getJSON(`https://archive.org/advancedsearch.php?${params}`);
  return (data.response?.docs || []).map((d) => ({
    cover: `https://archive.org/services/img/${d.identifier}`,
    title: d.title || d.identifier,
    sub: d.date ? String(d.date).slice(0, 4) + ' · 公版电影' : '公版电影',
    link: `https://archive.org/details/${d.identifier}`,
    play: { type: 'video', ident: d.identifier },
  }));
}

// 剧集：Wikipedia（仅信息）
async function fetchWiki(q, kind) {
  const zh = isCJK(q);
  const lang = zh ? 'zh' : 'en';
  const suffix = zh ? '电视剧' : 'television series';
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrsearch: `${q} ${suffix}`, gsrlimit: String(PER_SOURCE),
    prop: 'pageimages|info', piprop: 'thumbnail', pithumbsize: '400', pilicense: 'any',
    inprop: 'url',
  });
  const data = await getJSON(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  return Object.values(data.query?.pages || {})
    .filter((p) => p.thumbnail?.source)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({
      cover: p.thumbnail.source,
      title: p.title,
      sub: lang === 'zh' ? '维基百科' : 'Wikipedia',
      link: p.fullurl,
    }));
}

// 图片：Wikimedia Commons
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

// 音乐：iTunes（专辑封面 + 30 秒试听）
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
      play: r.previewUrl ? { type: 'audio', url: r.previewUrl, note: '30 秒试听（iTunes）' } : null,
    }));
}

// 我的曲库：本地清单，封面来自 Internet Archive
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
      play: t.url ? { type: 'audio', url: t.url, note: t.lossless ? '无损 FLAC' : '有损' } : null,
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
    movie: () => fetchMovies(q),
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

// 播放按钮的数据放在 data-* 中，点击时再读取
function playAttrs(x, idx) {
  if (!x.play) return '';
  return `data-play-kind="${x.play.type}" data-play-idx="${idx}"`;
}

const playStore = new Map();   // 当前页面可播放条目：key -> 条目

function renderSections() {
  playStore.clear();
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
    const cards = items.map((x, i) => {
      const key = `${kind}-${i}`;
      playStore.set(key, x);
      const playBtn = x.play
        ? `<button class="play" data-key="${esc(key)}" aria-label="播放">▶</button>` : '';
      return `
      <a class="card" href="${esc(x.link)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
        <div class="cover"><img src="${esc(x.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover="${esc(x.cover)}">${playBtn}</div>
        <div class="t">${esc(x.title)}</div>
        <div class="s">${esc(x.sub)}</div>
      </a>`;
    }).join('');
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

// ---------- 播放 ----------
function closePlayer() {
  playerAudio.pause();
  playerVideo.pause();
  playerAudio.removeAttribute('src');
  playerVideo.removeAttribute('src');
  playerAudio.hidden = true;
  playerVideo.hidden = true;
  playerEl.hidden = true;
}

// Archive 条目：挑一个能在浏览器中播放的文件（mp4 优先，取较小的以便快速开始）
async function resolveArchiveVideo(ident) {
  const meta = await getJSON(`https://archive.org/metadata/${ident}`);
  const files = (meta.files || []).filter((f) => /\.(mp4|ogv|webm)$/i.test(f.name));
  const bySize = (a, b) => (+a.size || 0) - (+b.size || 0);
  // 只选本浏览器能解码的格式：H.264 的 MP4 > WebM > Ogg Theora
  const probe = document.createElement('video');
  const canH264 = probe.canPlayType('video/mp4; codecs="avc1.42E01E"') !== '';
  const canWebm = probe.canPlayType('video/webm; codecs="vp8"') !== '';
  const canOgv = probe.canPlayType('video/ogg; codecs="theora"') !== '';
  const h264 = canH264 ? files.filter((f) => /\.mp4$/i.test(f.name) && /h\.?264|avc/i.test(f.format || '')).sort(bySize) : [];
  const webm = canWebm ? files.filter((f) => /\.webm$/i.test(f.name)).sort(bySize) : [];
  const ogv = canOgv ? files.filter((f) => /\.ogv$/i.test(f.name)).sort(bySize) : [];
  const pick = [...h264, ...webm, ...ogv][0];
  if (!pick) throw new Error('该条目的视频格式本浏览器无法播放，换一个条目试试');
  const path = pick.name.split('/').map(encodeURIComponent).join('/');
  return `https://archive.org/download/${ident}/${path}`;
}

async function playItem(x) {
  playerEl.hidden = false;
  playerTitle.textContent = x.title;
  playerNote.textContent = '正在准备…';
  playerAudio.hidden = true;
  playerVideo.hidden = true;
  try {
    if (x.play.type === 'video') {
      const url = await resolveArchiveVideo(x.play.ident);
      playerVideo.src = url;
      playerVideo.hidden = false;
      playerNote.textContent = '来自 Internet Archive 的公版电影';
      playerVideo.play().catch(() => {});
    } else {
      playerAudio.src = x.play.url;
      playerAudio.hidden = false;
      playerNote.textContent = x.play.note || '';
      playerAudio.play().catch(() => {});
    }
  } catch (err) {
    playerNote.textContent = '无法播放：' + (err.message || '网络错误');
  }
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
  const playBtn = e.target.closest('.play');
  if (playBtn) {
    e.preventDefault();          // 不打开链接，只播放
    e.stopPropagation();
    const x = playStore.get(playBtn.dataset.key);
    if (x?.play) playItem(x);
    return;
  }
  const more = e.target.closest('.more');
  if (more) {
    const strip = more.closest('.section').querySelector('.strip');
    strip.classList.toggle('open');
    layoutAll();
  }
});

$('#playerClose').addEventListener('click', closePlayer);

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
