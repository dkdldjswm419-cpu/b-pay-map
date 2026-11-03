// 오픈스트리트맵 (키 없음)
// - Nominatim: 지명 검색, 경계 폴리곤
// - Overpass: 도로가 지나는 동 찾기, 구획 안의 식당 목록

const UA = 'b-pay-map/1.0 (https://github.com/dkdldjswm419-cpu/b-pay-map)';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const AREA_OFFSET = 3600000000; // Overpass area id = relation id + 3600000000
const FOOD_AMENITY = 'restaurant|fast_food|cafe|food_court|bar|pub|ice_cream|biergarten';
const MAX_RESTAURANTS = 6000;

export class UserError extends Error {}

// 같은 이름이 여러 지역에 있을 때: choices 에 "대구광역시 중구 동성로" 같은 검색어 후보를 담는다
export class AmbiguousError extends UserError {
  constructor(areaName, choices) {
    super(`"${areaName}"이(가) 여러 지역에 있습니다. 지역을 골라주세요.`);
    this.choices = choices;
  }
}

// "동성로, 동성로3가, 성내1동, 중구, 대구광역시, 41937, 대한민국" → "대구광역시 중구"
function regionLabel(displayName) {
  const parts = displayName.split(',').map((s) => s.trim()).filter((s) => s !== '대한민국' && !/^\d+$/.test(s));
  return parts.length > 2 ? `${parts.at(-1)} ${parts.at(-2)}` : parts.at(-1);
}

// 후보들이 서로 다른 지역에 흩어져 있으면 (지역을 지정하지 않은 경우) 사용자에게 고르게 한다
function assertSingleRegion(areaName, candidates, region) {
  if (region) return;
  const labels = [...new Set(candidates.map((r) => regionLabel(r.display_name)))];
  if (labels.length > 1) throw new AmbiguousError(areaName, labels.map((l) => `${l} ${areaName}`));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatim(path) {
  const res = await fetch(`${NOMINATIM}${path}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko' } });
  if (!res.ok) throw new Error(`Nominatim 오류 (${res.status})`);
  return res.json();
}

// 공용 Overpass 서버는 자주 붐비므로 재시도한다.
// 기본 서버는 붐비면 바로 응답(504)하므로 자주 다시 시도하고, 보조 서버는 사이사이에 시도하되
// 응답이 없던 보조 서버는 이후 건너뛴다.
const deadServers = new Set();
const OVERPASS_BUDGET_MS = 200000;

function pickServer(attempt) {
  if (attempt % 2 === 0) return OVERPASS[0];
  const alive = OVERPASS.slice(1).filter((u) => !deadServers.has(u));
  return alive.length ? alive[Math.floor(attempt / 2) % alive.length] : OVERPASS[0];
}

async function overpass(query) {
  const deadline = Date.now() + OVERPASS_BUDGET_MS;
  let lastError;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const url = pickServer(attempt);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(Math.min(90000, deadline - Date.now())),
      });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) return JSON.parse(text).elements;
      lastError = new Error(`Overpass 서버가 붐빕니다 (${res.status})`);
    } catch (e) {
      lastError = e;
      if (url !== OVERPASS[0]) deadServers.add(url);
    }
    await sleep(Math.min(3000 * 2 ** Math.floor(attempt / 2), 20000));
  }
  throw new Error(`지도 데이터 서버 응답이 없습니다. 잠시 후 다시 시도해주세요. (${lastError?.message})`);
}

const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const searchPlaces = (q) =>
  nominatim(`/search?q=${encodeURIComponent(q)}&format=jsonv2&countrycodes=kr&accept-language=ko&limit=8`);

const isRoad = (r) => r.category === 'highway' && r.osm_type === 'way';
const isBoundary = (r) => r.category === 'boundary' && r.osm_type === 'relation';

// Overpass 에서 구획(동 영역 집합 .d)을 고르는 구문을 만든다.
// 도로: 그 도로가 지나는 동 전체 / 동: 그 동(또는 "성수동" → 성수1가1동 등 행정동 전체) / 지명: 그 지점이 속한 동
async function areaSelector(areaName, type, region) {
  let results = await searchPlaces(region ? `${region} ${areaName}` : areaName);
  if (!results.length && region) results = await searchPlaces(areaName);

  const road = results.find(isRoad);
  // 상위 지역(예: 중구) 경계가 잡히지 않도록 이름이 정확히 같은 경계만 쓴다
  const boundary = results.find((r) => isBoundary(r) && r.name === areaName);

  if (type === 'road' && road) {
    assertSingleRegion(areaName, results.filter((r) => isRoad(r) && r.name === road.name), region);
    return `way[highway][name=${quote(road.name)}](around:3000,${road.lat},${road.lon})->.r;
node(w.r)->.n;
.n is_in->.a;
area.a[boundary=administrative][admin_level=8]->.d;`;
  }
  if (boundary) {
    assertSingleRegion(areaName, results.filter((r) => isBoundary(r) && r.name === areaName), region);
    return `rel(${boundary.osm_id});map_to_area->.d;`;
  }
  if (type === 'dong') {
    // "성수동" 처럼 행정동으로 나뉜 법정동: 이름이 "성수…동" 인 행정동을 모두 모은다
    const base = regexEscape(areaName.replace(/동$/, ''));
    const regionBoundary = region && (await searchPlaces(region)).find(isBoundary);
    const scope = regionBoundary
      ? `area(id:${regionBoundary.osm_id + AREA_OFFSET})->.g;`
      : 'area["ISO3166-1"="KR"][admin_level=2]->.g;';
    return `${scope}
rel(area.g)[boundary=administrative][admin_level=8][name~"^${base}[0-9]*가?[0-9]*동$"];
map_to_area->.d;`;
  }
  const point = results.find((r) => !isRoad(r)) || results[0];
  if (!point) throw new UserError(`"${areaName}"을(를) 지도에서 찾지 못했습니다.`);
  return `is_in(${point.lat},${point.lon})->.a;
area.a[boundary=administrative][admin_level=8]->.d;`;
}

async function polygonsOf(relIds) {
  const ids = relIds.map((id) => `R${id}`).join(',');
  return nominatim(`/lookup?osm_ids=${ids}&format=geojson&polygon_geojson=1&polygon_threshold=0.00005&accept-language=ko`);
}

function address(tags) {
  if (tags['addr:full']) return tags['addr:full'];
  const parts = [tags['addr:city'], tags['addr:district'], tags['addr:street'], tags['addr:housenumber']];
  return parts.filter(Boolean).join(' ');
}

function toRestaurants(els) {
  const seen = new Set();
  const list = [];
  for (const e of els) {
    if (e.type === 'area') continue;
    const id = `${e.type[0]}${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    list.push({
      id,
      name: e.tags['name:ko'] || e.tags.name,
      amenity: e.tags.amenity,
      osmCuisine: e.tags.cuisine || '',
      address: address(e.tags),
      lat,
      lng,
    });
  }
  return list;
}

// 구획 이름 → { name, dongs, polygon, restaurants }
// type: 'road' | 'dong' | 'place', region: "서울특별시 성동구" 처럼 동명이인을 가르는 상위 지역 (없으면 null)
export async function collectArea(areaName, type, region) {
  const selector = await areaSelector(areaName, type, region);

  // 구획 찾기와 식당 수집을 Overpass 한 번에 처리 (영역 → 식당 순서로 출력됨)
  const els = await overpass(`[out:json][timeout:150];
${selector}
.d out tags;
nwr(area.d)[amenity~"^(${FOOD_AMENITY})$"][name];
out center tags;`);

  const relIds = els.filter((e) => e.type === 'area' && e.id > AREA_OFFSET).map((e) => e.id - AREA_OFFSET);
  if (!relIds.length) throw new UserError(`"${areaName}"의 구획 경계를 찾지 못했습니다.`);

  const restaurants = toRestaurants(els);
  const polygon = await polygonsOf(relIds);
  if (restaurants.length > MAX_RESTAURANTS) {
    throw new UserError(`"${areaName}" 범위가 너무 넓습니다 (식당 ${restaurants.length}곳). 동 이름으로 좁혀서 검색해주세요.`);
  }
  const dongs = polygon.features.map((f) => f.properties.name).filter(Boolean);
  return { name: areaName, dongs, polygon, restaurants };
}
