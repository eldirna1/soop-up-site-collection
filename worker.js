// SOOP 순위 사이트 — 클라우드플레어 워커
//
//  /list?id=..&no=..  →  댓글을 모아 순위 자료로 돌려줍니다
//  /img?u=..          →  프로필 사진을 대신 받아옵니다
//  그 외 모든 주소     →  저장소에 올린 html 파일을 그대로 보여줍니다
//
// 여러 쪽으로 나뉜 댓글을 이 안에서 전부 모아 정리된 목록 하나로 돌려줍니다.
// 그래서 보는 쪽은 갱신 한 번에 요청 한 번만 씁니다.
// 결과는 4초 동안 재사용하므로 여러 명이 동시에 봐도 부담이 적습니다.

const TMPL = 'https://api-channel.sooplive.com/v1.1/channel/{id}/post/{no}/comment' +
             '?page={page}&orderBy=reg_date&cCommentNo=0';

const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.sooplive.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
};

const CACHE_MS = 8000;   // 결과 재사용 시간
const cache = new Map();
const imgCache = new Map();                 // 프로필 사진 보관
const IMG_CACHE_MS = 6 * 60 * 60 * 1000;    // 6시간

/* ---------- 응답에서 댓글 뽑아내기 ---------- */

const NICK = ['user_nick','userNick','nickname','nick','writer_nick','userName'];
const UP   = ['like_cnt','likeCnt','likeCount','up_cnt','upCnt','recommend_cnt','vote_cnt'];
const UID  = ['user_id','userId','userid','writer_id'];
const DATE = ['reg_date','regDate','regDatetime','created_at','write_date'];
const IMG  = ['profile_image','profileImage','profileImageUrl','profile_img'];
const TEXT = ['comment','content','contents','text','memo','body','message'];

function pickKey(o, cands, wantNumber) {
  for (const k of cands) {
    if (!(k in o)) continue;
    const v = o[k];
    if (wantNumber) {
      if (typeof v === 'number') return k;
      if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return k;
    } else if (typeof v === 'string' && v.trim() !== '') return k;
  }
  return null;
}
function pickImgKey(o) {
  for (const k of IMG) {
    const v = o[k];
    if (typeof v === 'string' && v && (/\.(jpe?g|png|gif|webp)/i.test(v) || v.includes('//'))) return k;
  }
  return null;
}
function collectArrays(node, depth, out) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === 'object') out.push(node);
    for (let i = 0; i < Math.min(node.length, 3); i++) collectArrays(node[i], depth + 1, out);
  } else if (typeof node === 'object') {
    for (const k of Object.keys(node)) collectArrays(node[k], depth + 1, out);
  }
  return out;
}
function analyze(json) {
  let best = null;
  for (const arr of collectArrays(json, 0, [])) {
    const sample = arr.find(x => x && typeof x === 'object');
    if (!sample) continue;
    const nk = pickKey(sample, NICK, false);
    const uk = pickKey(sample, UP, true);
    if (!nk || !uk) continue;
    if (!best || arr.length > best.arr.length) {
      best = {
        arr, nk, uk,
        idk: pickKey(sample, UID, false),
        dk:  pickKey(sample, DATE, false),
        imk: pickImgKey(sample),
        tk:  pickKey(sample, TEXT, false),
      };
    }
  }
  return best;
}
function avatar(uid, raw) {
  if (raw) {
    let u = String(raw).trim();
    if (u.startsWith('//')) u = 'https:' + u;
    if (/^https?:/i.test(u)) return u;
  }
  if (!uid) return '';
  return 'https://profile.img.sooplive.com/LOGO/' +
         uid.slice(0, 2).toLowerCase() + '/' + uid + '/' + uid + '.jpg';
}
function flatten(f) {
  const out = [];
  let seen = 0;
  function walk(row, parentText) {
    if (!row || typeof row !== 'object') return;
    if (++seen > 50000) return;
    const nick = String(row[f.nk] ?? '').trim();
    if (!nick) return;
    const uid = f.idk ? String(row[f.idk] ?? '') : '';
    const txt = f.tk ? String(row[f.tk] ?? '') : '';
    out.push({
      nick,
      up: Number(row[f.uk]) || 0,
      uid,
      date: f.dk ? String(row[f.dk] || '') : '',
      img: avatar(uid, f.imk ? row[f.imk] : ''),
      txt,
      ptxt: parentText || '',
      key: uid || ('n:' + nick),
    });
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && (f.nk in v[0])) {
        for (const child of v) walk(child, txt || parentText);
      }
    }
  }
  for (const row of f.arr) walk(row, '');
  return out;
}


/* ---------- 한 게시글 전부 모으기 ---------- */

async function collectPost(id, no) {
  const pageUrl = (page) =>
    TMPL.replace('{id}', encodeURIComponent(id))
        .replace('{no}', encodeURIComponent(no))
        .replace('{page}', String(page));

  async function grab(page) {
    const res = await fetch(pageUrl(page), { headers: HEADERS });
    if (!res.ok) throw new Error('SOOP이 ' + res.status + ' 로 응답했습니다 (' + page + '쪽)');
    const json = await res.json();
    const f = analyze(json);
    return f ? flatten(f) : [];
  }

  const rows = [];
  const WAVE = 6;                 // 한 번에 여러 쪽을 동시에 가져옵니다
  let page = 1, done = false, seen = new Set();

  while (!done && page <= 60) {
    const nums = [];
    for (let i = 0; i < WAVE && page + i <= 60; i++) nums.push(page + i);

    const batches = await Promise.all(nums.map(async (n) => {
      try { return await grab(n); } catch (e) { if (n === 1) throw e; return []; }
    }));

    for (const batch of batches) {
      if (!batch.length) { done = true; continue; }
      const sig = batch.length + '|' + batch[0].nick + batch[0].up;
      if (seen.has(sig)) { done = true; continue; }   // 같은 쪽이 반복되면 끝
      seen.add(sig);
      rows.push(...batch);
      if (batch.length < 5) done = true;
    }
    page += WAVE;
  }

  if (!rows.length) throw new Error('응답에서 댓글 목록을 못 찾았습니다');

  const map = new Map();
  for (const r of rows) {
    const prev = map.get(r.key);
    if (!prev || r.up > prev.up) map.set(r.key, r);
  }
  return [...map.values()].sort((a, b) => b.up - a.up);
}

/* ---------- 부문 나누기 (가벼운 형식용) ---------- */

function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }
function parseGroups(v) {
  const out = [];
  String(v || '').split('|').forEach((part) => {
    const p = part.split('~');
    const name = (p[0] || '').trim();
    if (!name) return;
    out.push({ name, keys: (p[1] || p[0]).split(',').map((x) => x.trim()).filter(Boolean) });
  });
  return out;
}
function hitAt(t, g, head) {
  t = norm(t);
  if (!t) return false;
  for (const k0 of g.keys) {
    const k = norm(k0);
    if (!k) continue;
    if (head ? t.indexOf(k) === 0 : t.indexOf(k) >= 0) return true;
  }
  return false;
}
function classify(r, G) {
  if (!G.length) return -1;
  for (let i = 0; i < G.length; i++) if (hitAt(r.ptxt, G[i], true)) return i;
  for (let i = 0; i < G.length; i++) if (hitAt(r.txt, G[i], true)) return i;
  for (let i = 0; i < G.length; i++) if (hitAt(r.ptxt, G[i], false)) return i;
  for (let i = 0; i < G.length; i++) if (hitAt(r.txt, G[i], false)) return i;
  return -1;
}
// 사진 주소는 아이디에서 만들 수 있으니, 예상과 같으면 빼고 보냅니다
function guessed(uid) {
  if (!uid) return '';
  return 'https://profile.img.sooplive.com/LOGO/' +
         uid.slice(0, 2).toLowerCase() + '/' + uid + '/' + uid + '.jpg';
}

/* ---------- 서버 ---------- */

function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'public, max-age=8, s-maxage=8' },
  });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);

    // 프로필 사진 통로 — 이미지 복사 기능에 필요합니다 (특정 스트리머에게만 쓰임)
  if (url.pathname === '/img') {
    const t0 = url.searchParams.get('u') || '';
    let ti;
    try { ti = new URL(t0); } catch { return new Response('주소 형식 오류', { status: 400, headers: CORS }); }
    if (!/(^|\.)sooplive\.com$/.test(ti.hostname))
      return new Response('허용되지 않은 주소', { status: 403, headers: CORS });

    const key = ti.toString();
    const hit = imgCache.get(key);
    if (hit && Date.now() - hit.at < IMG_CACHE_MS) {
      return new Response(hit.buf, { status: 200,
        headers: { ...CORS, 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400' } });
    }
    try {
      const r = await fetch(key, {
        headers: { 'Referer': 'https://www.sooplive.com/', 'User-Agent': HEADERS['User-Agent'] },
        redirect: 'follow',
      });
      if (!r.ok) return new Response('사진 없음', { status: r.status, headers: CORS });
      const buf = await r.arrayBuffer();
      const type = r.headers.get('Content-Type') || 'image/jpeg';
      imgCache.set(key, { at: Date.now(), buf, type });
      if (imgCache.size > 600) for (const k of [...imgCache.keys()].slice(0, 200)) imgCache.delete(k);
      return new Response(buf, { status: 200,
        headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
    } catch (e) {
      return new Response('사진 가져오기 실패', { status: 502, headers: CORS });
    }
  }

  // /list 가 아니면 저장소에 올린 파일을 보여줍니다
  if (url.pathname !== '/list') {
    if (env && env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('파일이 연결되어 있지 않습니다.', { status: 404, headers: CORS });
  }

  const id = (url.searchParams.get('id') || '').toLowerCase();
    const no = url.searchParams.get('no') || '';
    if (!/^[a-z0-9_-]{2,30}$/.test(id) || !/^\d{1,20}$/.test(no)) {
      return reply({ error: 'id 와 no 를 확인해주세요.' }, 400);
    }

    const cacheKey = id + '/' + no +
      (url.searchParams.get('slim') === '1' ? '|s' : '') +
      (url.searchParams.get('g') ? '|g' : '');
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return reply({ ...hit.body, cached: true });

    const slim = url.searchParams.get('slim') === '1';
    const G = parseGroups(url.searchParams.get('g') || '');

    try {
      const items = await collectPost(id, no);
      let body;
      if (slim) {
        // 한 사람당 배열 하나로 — 이름표를 빼서 크기를 크게 줄입니다
        // [닉네임, 아이디, UP, 등록일, 부문번호, 댓글일부, 사진주소(예상과 다를 때만)]
        const d = items.map((r) => {
          const row = [
            r.nick, r.uid, r.up, r.date,
            classify(r, G),
            String(r.txt || '').replace(/\s+/g, ' ').slice(0, 45),
          ];
          if (r.img && r.img !== guessed(r.uid)) row.push(r.img);
          return row;
        });
        body = { id, no, updated: new Date().toISOString(), count: d.length, slim: 1, d };
      } else {
        body = { id, no, updated: new Date().toISOString(), count: items.length, items };
      }
      cache.set(cacheKey, { at: Date.now(), body });
      if (cache.size > 200) cache.clear();
      return reply(body);
    } catch (e) {
      return reply({ error: e instanceof Error ? e.message : String(e) }, 502);
    }

  },
};
