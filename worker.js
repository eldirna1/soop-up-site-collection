// 중계기 + 홈페이지 파일 서빙을 한 워커에서 같이 합니다.
//
//  /relay?u=<주소>  →  그 주소의 내용을 대신 받아다 돌려줍니다.
//  그 외 모든 주소  →  저장소에 올린 html 파일을 그대로 보여줍니다.

const OK_HOSTS = [
  'api-channel.sooplive.com',
  'openapi.sooplive.com',
  'bjapi.sooplive.com',
  'chapi.sooplive.com',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/relay') {
      if (request.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: CORS });

      const target = url.searchParams.get('u');
      if (!target)
        return new Response('u 값이 없습니다.', { status: 400, headers: CORS });

      let t;
      try { t = new URL(target); }
      catch { return new Response('주소 형식이 잘못됐습니다.', { status: 400, headers: CORS }); }

      // 아무 주소나 대신 받아주면 남이 악용할 수 있으니 SOOP만 허용
      if (!OK_HOSTS.includes(t.hostname))
        return new Response('허용되지 않은 주소입니다: ' + t.hostname, { status: 403, headers: CORS });

      try {
        const r = await fetch(t.toString(), {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.sooplive.com/',
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
          },
          cf: { cacheTtl: 5, cacheEverything: true },
        });
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: {
            ...CORS,
            'Content-Type': r.headers.get('Content-Type') || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      } catch (e) {
        return new Response('중계 실패: ' + (e && e.message), { status: 502, headers: CORS });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
