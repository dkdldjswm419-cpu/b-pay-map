// GET /api/search?q=을지로 근처 한식집 찾기
// 1) Gemini 로 검색어를 구획 + 업종으로 해석
// 2) 이미 수집한 구획이면 Supabase 캐시, 아니면 오픈스트리트맵에서 수집 → Gemini 로 업종 분류 → 캐시에 저장
// 업종 필터링은 화면에서 하므로 구획의 식당 전체를 돌려준다.

import { parseQuery, classify, CUISINES } from '../lib/gemini.js';
import { collectArea, UserError, AmbiguousError } from '../lib/osm.js';
import { areaKey, getArea, saveArea } from '../lib/db.js';

export async function GET(request) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!q) return Response.json({ error: '검색어를 입력해주세요.' }, { status: 400 });

  try {
    const parsed = await parseQuery(q);
    const key = areaKey(`${parsed.region || ''}${parsed.area}`);

    let area = await getArea(key);
    let cached = Boolean(area);
    if (!area) {
      const collected = await collectArea(parsed.area, parsed.areaType, parsed.region);
      const restaurants = (await classify(collected.restaurants)).map(({ osmCuisine, ...r }) => r);
      area = { key, name: collected.name, dongs: collected.dongs, polygon: collected.polygon, restaurants };
      await saveArea(area);
    }

    return Response.json({ query: q, parsed, cached, cuisines: CUISINES, area });
  } catch (e) {
    if (e instanceof AmbiguousError) return Response.json({ error: e.message, choices: e.choices }, { status: 409 });
    if (e instanceof UserError) return Response.json({ error: e.message }, { status: 404 });
    console.error(e);
    return Response.json({ error: `처리 중 오류가 발생했습니다: ${e.message}` }, { status: 500 });
  }
}
