// 万能搜索（个人使用，不做商用）
// 数据源（均为公开接口，浏览器可直接访问，无需密钥）：
//   电影：Internet Archive 公版剧情片合集（可在页内播放）
//   剧集：Wikipedia（仅信息，无播放）
//   图片：Wikimedia Commons（仅图片，点击打开原页）
//   音乐：iTunes 搜索（30 秒试听，可在页内播放）
//   我的曲库：本地 tracks.json（可在页内播放）
// 封面加载失败的地址会记入 localStorage，刷新后不再显示。
const APP_VERSION = '0.8.9';

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

// ---------- 记住上次搜索（localStorage，可失败） ----------
const LAST_KEY = 'lastSearch';
function saveLast(q) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ q, cat: state.cat })); } catch (_) { /* 忽略 */ }
}
function loadLast() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (_) { return null; }
}

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

// 中文片名 -> 英文片名：先在中文维基搜索，再取各条目的英文页面标题
async function zhToEnTitles(q) {
  const search = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', list: 'search',
    srsearch: `${q} 电影`, srlimit: '3',
  });
  const s = await getJSON(`https://zh.wikipedia.org/w/api.php?${search}`);
  const titles = (s.query?.search || []).map((h) => h.title);
  if (!titles.length) return [];
  const links = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', prop: 'langlinks',
    lllang: 'en', titles: titles.join('|'),
  });
  const p = await getJSON(`https://zh.wikipedia.org/w/api.php?${links}`);
  const en = Object.values(p.query?.pages || {})
    .flatMap((pg) => (pg.langlinks || []).map((l) => l['*']));
  return [...new Set(en)];
}

// 电影：Archive 公版剧情片合集，播放时再去取可播放的文件
async function fetchMovies(q) {
  let names = [q];
  if (isCJK(q)) {
    names = await zhToEnTitles(q);      // 中文片名先转英文，Archive 元数据是英文的
    if (!names.length) return [];
  }
  // 每个片名单独查询再合并（多个片名用 OR 合并时，Archive 会返回空结果）
  const terms = names.map(cleanTerm).filter(Boolean);
  if (!terms.length) return [];
  const docsLists = await Promise.all(terms.map(async (term) => {
    const params = new URLSearchParams();
    params.set('q', `collection:feature_films AND mediatype:movies AND title:(${term})`);
    ['identifier', 'title', 'date'].forEach((f) => params.append('fl[]', f));
    params.set('rows', String(PER_SOURCE));
    params.set('output', 'json');
    const data = await getJSON(`https://archive.org/advancedsearch.php?${params}`);
    return data.response?.docs || [];
  }));
  const seen = new Set();
  const docs = docsLists.flat().filter((d) => (seen.has(d.identifier) ? false : seen.add(d.identifier)));
  return docs.slice(0, PER_SOURCE).map((d) => ({
    en: d.title || d.identifier,
    cover: `https://archive.org/services/img/${d.identifier}`,
    title: d.title || d.identifier,
    sub: d.date ? String(d.date).slice(0, 4) + ' · 公版电影' : '公版电影',
    link: `https://archive.org/details/${d.identifier}`,
    play: { type: 'video', ident: d.identifier },
  }));
}

// TMDB 密钥只保存在本机浏览器中（localStorage），不写入代码
const TMDB_KEY = 'tmdbKey';
function getTmdbKey() {
  try { return localStorage.getItem(TMDB_KEY) || ''; } catch (_) { return ''; }
}
function setTmdbKey(v) {
  try {
    if (v) localStorage.setItem(TMDB_KEY, v); else localStorage.removeItem(TMDB_KEY);
  } catch (_) { /* 无存储权限时本次会话内无效 */ }
}

// 剧集：有 TMDB 密钥时用 TMDB（海报 + 简介，链接到 TMDB 页面），否则用 Wikipedia
async function fetchTV(q) {
  const key = getTmdbKey();
  if (!key) return fetchWiki(q, 'tv');
  const zh = isCJK(q);
  const params = new URLSearchParams({
    api_key: key, query: q, include_adult: 'false',
    language: zh ? 'zh-CN' : 'en-US',
  });
  const data = await getJSON(`https://api.themoviedb.org/3/search/tv?${params}`);
  return (data.results || [])
    .filter((r) => r.poster_path)
    .slice(0, PER_SOURCE)
    .map((r) => tmdbItem('tv', r, r.name, r.original_name, r.first_air_date));
}

// 电影（TMDB 部分）：只提供信息和"在哪看"，没有播放
async function fetchTMDBMovies(q) {
  const key = getTmdbKey();
  if (!key) return [];
  const params = new URLSearchParams({
    api_key: key, query: q, include_adult: 'false',
    language: isCJK(q) ? 'zh-CN' : 'en-US',
  });
  const data = await getJSON(`https://api.themoviedb.org/3/search/movie?${params}`);
  return (data.results || [])
    .filter((r) => r.poster_path)
    .slice(0, PER_SOURCE)
    .map((r) => tmdbItem('movie', r, r.title, r.original_title, r.release_date));
}

// TMDB 结果统一格式：标题用当前语言，副标题显示英文片名（若不同）、年份
function tmdbItem(kind, r, title, original, date) {
  const en = original && original !== title ? original : '';
  return {
    cover: `https://image.tmdb.org/t/p/w342${r.poster_path}`,
    title: title || original,
    sub: [en, date?.slice(0, 4), 'TMDB'].filter(Boolean).join(' · '),
    link: `https://www.themoviedb.org/${kind}/${r.id}`,
    tmdb: { kind, id: r.id },
    en: original || title || '',
  };
}

// 类型（分类）搜索：输入"西部片"等类型名，列出该类型的主要电影和剧集
const GENRES = [
  { names: ['西部片', '西部', 'western'], movie: 37, tv: 37 },
  { names: ['科幻片', '科幻', 'sci-fi', 'scifi', 'science fiction'], movie: 878, tv: 10765 },
  { names: ['动作片', '动作', 'action'], movie: 28, tv: 10759 },
  { names: ['喜剧片', '喜剧', 'comedy'], movie: 35, tv: 35 },
  { names: ['恐怖片', '恐怖', 'horror'], movie: 27, tv: null },
  { names: ['爱情片', '爱情', 'romance'], movie: 10749, tv: null },
  { names: ['剧情片', '剧情', 'drama'], movie: 18, tv: 18 },
  { names: ['动画片', '动画', 'animation'], movie: 16, tv: 16 },
  { names: ['悬疑片', '悬疑', '惊悚', 'thriller', 'mystery'], movie: 53, tv: 9648 },
  { names: ['战争片', '战争', 'war'], movie: 10752, tv: 10768 },
  { names: ['犯罪片', '犯罪', 'crime'], movie: 80, tv: 80 },
  { names: ['纪录片', '纪录', 'documentary'], movie: 99, tv: 99 },
];

function findGenre(q) {
  const s = q.trim().toLowerCase();
  return GENRES.find((g) => g.names.includes(s)) || null;
}

async function fetchGenre(kind, genre) {
  const id = genre[kind];
  const key = getTmdbKey();
  if (!id) return [];
  if (!key) throw new Error('请先在页面底部设置 TMDB 密钥');
  const params = new URLSearchParams({
    api_key: key, with_genres: String(id), sort_by: 'popularity.desc',
    'vote_count.gte': '100', include_adult: 'false',
    language: 'zh-CN',
  });
  const data = await getJSON(`https://api.themoviedb.org/3/discover/${kind}?${params}`);
  return (data.results || [])
    .filter((r) => r.poster_path)
    .slice(0, PER_SOURCE)
    .map((r) => kind === 'movie'
      ? tmdbItem('movie', r, r.title, r.original_title, r.release_date)
      : tmdbItem('tv', r, r.name, r.original_name, r.first_air_date));
}

// ---------- "在哪看"：TMDB 提供的各地区正版平台 ----------
const TMDB_REGION = 'tmdbRegion';
function getRegion() {
  try { return localStorage.getItem(TMDB_REGION) || 'HK'; } catch (_) { return 'HK'; }
}
function setRegion(v) {
  try { localStorage.setItem(TMDB_REGION, v); } catch (_) { /* 忽略 */ }
}

async function fetchProviders(kind, id) {
  const key = getTmdbKey();
  if (!key) throw new Error('请先在页面底部设置 TMDB 密钥');
  const data = await getJSON(`https://api.themoviedb.org/3/${kind}/${id}/watch/providers?api_key=${encodeURIComponent(key)}`);
  const region = getRegion();
  return { region, info: data.results?.[region] || null };
}

// 剧集：Wikipedia（无 TMDB 密钥时的备用来源，仅信息）
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

  const genre = findGenre(q);
  if (genre) {
    // 类型搜索：只显示该类型的电影和剧集（TMDB）
    const kinds = ['movie', 'tv'];
    const settledG = await Promise.allSettled(kinds.map((k) => fetchGenre(k, genre)));
    if (state.q !== q) return;
    settledG.forEach((r, i) => {
      const k = kinds[i];
      state.results[k] = r.status === 'fulfilled' ? r.value : [];
      state.status[k] = r.status === 'rejected'
        ? '暂时不可用：' + (r.reason?.message || '网络错误')
        : (r.value.length ? null : '没有找到结果（该类型在此来源无数据）');
    });
    state.results.image = [];
    state.status.image = '类型搜索只显示电影和剧集';
    state.results.music = [];
    state.status.music = '类型搜索只显示电影和剧集';
    hintEl.textContent = `类型：${genre.names[0]}（TMDB 热门作品）`;
    render();
    return;
  }

  const jobs = {
    movie: async () => {
      // 公版可播放的电影 + TMDB 的电影信息（后者只有"在哪看"）
      const [playable, info] = await Promise.allSettled([fetchMovies(q), fetchTMDBMovies(q)]);
      const a = playable.status === 'fulfilled' ? playable.value : [];
      const b = info.status === 'fulfilled' ? info.value : [];
      if (playable.status === 'rejected' && info.status === 'rejected') throw playable.reason;
      return [...a, ...b];
    },
    tv: () => fetchTV(q),
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
      const watchBtn = x.tmdb
        ? `<button class="watch" data-key="${esc(key)}" aria-label="在哪看">在哪看</button>` : '';
      const copyBtn = x.en
        ? `<button class="copy" type="button" data-copy="${esc(x.en)}" aria-label="复制英文名" title="复制英文名">⧉</button>` : '';
      return `
      <a class="card" href="${esc(x.link)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
        <div class="cover"><img src="${esc(x.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover="${esc(x.cover)}">${playBtn}${watchBtn}${copyBtn}</div>
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
  if (state.q) {
    // 只是跳转到 YouTube 自己的搜索页，不嵌入、不自动播放
    const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(state.q)}`;
    hintEl.innerHTML = `“${esc(state.q)}” 的结果 · <a href="${esc(yt)}" target="_blank" rel="noopener noreferrer">在 YouTube 搜索</a>（结果可能包含非官方上传，请优先选择官方频道）`;
  } else {
    hintEl.textContent = '输入关键词开始搜索；"我的曲库"随时可看。';
  }
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
  saveLast(q);
  runSearch(q);
});

catsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.cat');
  if (!btn) return;
  state.cat = btn.dataset.cat;
  if (state.q) saveLast(state.q);
  render();
});

// 复制英文片名（不打开链接）
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
}

sectionsEl.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.copy');
  if (copyBtn) {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(copyBtn.dataset.copy);
    const old = copyBtn.textContent;
    copyBtn.textContent = ok ? '✓' : '✕';
    setTimeout(() => { copyBtn.textContent = old; }, 1200);
    return;
  }
  const watchBtn = e.target.closest('.watch');
  if (watchBtn) {
    e.preventDefault();
    e.stopPropagation();
    const x = playStore.get(watchBtn.dataset.key);
    if (x?.tmdb) showWatch(x);
    return;
  }
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

// ---------- 直连：通过 Wikidata 找到 Tubi 与 YouTube 的编号 ----------
// Tubi 网址格式未在本机核实（Tubi 在欧洲不可用），因此标注为"待测试"
async function fetchDirect(kind, tmdbId) {
  const tmdbProp = kind === 'movie' ? 'P4947' : 'P4983';
  const tubiProp = kind === 'movie' ? 'P7760' : 'P7761';
  const sparql = `SELECT ?tubi ?yt WHERE { ?item wdt:${tmdbProp} "${tmdbId}" . OPTIONAL { ?item wdt:${tubiProp} ?tubi } OPTIONAL { ?item wdt:P1651 ?yt } } LIMIT 20`;
  const data = await getJSON(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`);
  const rows = data.results?.bindings || [];
  const tubi = [...new Set(rows.map((r) => r.tubi?.value).filter(Boolean))];
  const yt = [...new Set(rows.map((r) => r.yt?.value).filter(Boolean))];
  return {
    tubi: tubi[0] ? `https://tubitv.com/${kind === 'movie' ? 'movies' : 'series'}/${tubi[0]}` : '',
    yt: yt.slice(0, 5).map((id) => `https://www.youtube.com/watch?v=${id}`),
  };
}

// "在哪看"面板
const LABELS ={ flatrate: '订阅', free: '免费', ads: '含广告免费', rent: '租借', buy: '购买' };
const LOGO = (p) => p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : '';

async function showWatch(x) {
  const watchEl = $('#watch');
  const body = $('#watchBody');
  $('#watchTitle').textContent = x.title;
  body.innerHTML = '<p class="status">正在查询…</p>';
  watchEl.hidden = false;
  try {
    const [{ region, info }, direct] = await Promise.all([
      fetchProviders(x.tmdb.kind, x.tmdb.id),
      fetchDirect(x.tmdb.kind, x.tmdb.id).catch(() => ({ tubi: '', yt: [] })),
    ]);
    // 直连区域（Tubi 待测试；YouTube 为视频页，可能是预告片）
    const directHtml = (direct.tubi || direct.yt.length) ? `
      <div class="w-group">
        <div class="w-label">直连观看</div>
        <div class="w-list">
          ${direct.tubi ? `<a class="w-item" href="${esc(direct.tubi)}" target="_blank" rel="noopener noreferrer">Tubi（待测试）</a>` : ''}
          ${direct.yt.map((u, i) => `<a class="w-item" href="${esc(u)}" target="_blank" rel="noopener noreferrer">YouTube 视频 ${i + 1}</a>`).join('')}
        </div>
        <p class="w-foot">YouTube 链接可能是预告片或片段；请先确认是否为正版内容。</p>
      </div>` : '';
    // 数据里没有的片子，也可以在 Tubi 上按片名搜索（网址格式待测试）
    const tubiSearch = `<div class="w-group"><div class="w-label">搜索</div><div class="w-list">
      <a class="w-item" href="https://tubitv.com/search/${encodeURIComponent(x.title)}" target="_blank" rel="noopener noreferrer">在 Tubi 搜索（待测试）</a>
    </div></div>`;
    if (!info) {
      body.innerHTML = `${directHtml}<p class="status">该地区（${esc(region)}）暂无平台数据，可在下方设置中换一个地区。</p>${tubiSearch}`;
      return;
    }
    // 平台名称统一链接到 JustWatch 页面（TMDB 不提供每个平台的直达链接）
    const href = info.link ? esc(info.link) : '';
    const item = (p) => {
      const inner = `${LOGO(p) ? `<img src="${LOGO(p)}" alt="" referrerpolicy="no-referrer">` : ''}${esc(p.provider_name)}`;
      return href
        ? `<a class="w-item" href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<span class="w-item">${inner}</span>`;
    };
    const groups = Object.keys(LABELS).filter((k) => info[k]?.length).map((k) => `
      <div class="w-group">
        <div class="w-label">${LABELS[k]}</div>
        <div class="w-list">${info[k].map(item).join('')}</div>
      </div>`).join('');
    body.innerHTML = `${directHtml}${groups || '<p class="status">该地区暂无可观看的平台</p>'}${tubiSearch}
      <p class="w-foot">点击平台名称，将打开 TMDB 的观看页面，从那里进入平台观看。地区：${esc(region)} · 数据来自 TMDB（JustWatch）</p>`;
  } catch (err) {
    body.innerHTML = `<p class="status err">${esc(err.message || '查询失败')}</p>`;
  }
}

$('#watchClose').addEventListener('click', () => { $('#watch').hidden = true; });

// 地区设置
const regionSel = $('#tmdbRegion');
regionSel.value = getRegion();
regionSel.addEventListener('change', () => {
  setRegion(regionSel.value);
  hintEl.textContent = `"在哪看"地区已设为 ${regionSel.value}`;
});

// TMDB 密钥设置（仅保存在本机）
const tmdbInput = $('#tmdbKey');
tmdbInput.value = getTmdbKey();
$('#tmdbSave').addEventListener('click', () => {
  const v = tmdbInput.value.trim();
  setTmdbKey(v);
  hintEl.textContent = v ? 'TMDB 密钥已保存（仅在本机浏览器中）' : 'TMDB 密钥已清除';
  if (state.q) runSearch(state.q);
});
$('#tmdbClear').addEventListener('click', () => {
  tmdbInput.value = '';
  setTmdbKey('');
  hintEl.textContent = 'TMDB 密钥已清除';
  if (state.q) runSearch(state.q);
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
  const last = loadLast();
  if (last && typeof last.q === 'string' && last.q) {
    qInput.value = last.q;
    state.cat = last.cat && last.cat !== 'library' ? last.cat : 'all';
  }
  renderCats();
  try {
    await loadLibrary();
  } catch (err) {
    state.library = [];
  }
  if (last && last.q) runSearch(last.q);
  else render();
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
