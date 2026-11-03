// Gemini: 자연어 검색어 해석, 식당 업종 분류 (식당이 아닌 업종 걸러내기)
// GEMINI_API_KEY 가 없으면 간단한 규칙으로 대신 처리한다.

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const BATCH = 250;

export const CUISINES = ['한식', '중식', '일식', '양식', '분식', '치킨', '아시아', '패스트푸드', '카페·디저트', '주점', '기타'];
const NOT_FOOD = '음식점아님';

async function generate(prompt, schema) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0,
        // 단순 분류라 깊은 추론이 필요 없다. 끄면 응답이 약 4배 빨라진다 (Gemini 3 계열)
        ...(MODEL.startsWith('gemini-3') ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini 오류 (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

// ---------- 검색어 해석 ----------
// "을지로 근처 한식집 찾기" → { area: "을지로", areaType: "road", cuisine: "한식" }
export async function parseQuery(q) {
  if (!API_KEY) return parseQueryByRule(q);
  return generate(
    `사용자가 한국의 식당 지도에 입력한 검색어를 해석하세요.
- area: 검색할 구획 이름만 (도로명, 동 이름, 지명). "근처", "주변", "찾기" 같은 말은 빼세요.
- areaType: 도로명(…로, …길, …대로)이면 "road", 동 이름(…동)이면 "dong", 그 외 지명이면 "place"
- region: 그 구획이 속한 시/도와 시/군/구 (예: "서울특별시 성동구"). 같은 이름이 여러 지역에 있으면 가장 유명한 곳. 모르면 null
- cuisine: 찾는 업종이 있으면 목록 중 하나, 없으면 null. 목록: ${CUISINES.join(', ')}

검색어: ${q}`,
    {
      type: 'OBJECT',
      properties: {
        area: { type: 'STRING' },
        areaType: { type: 'STRING', enum: ['road', 'dong', 'place'] },
        region: { type: 'STRING', nullable: true },
        cuisine: { type: 'STRING', enum: CUISINES, nullable: true },
      },
      required: ['area', 'areaType', 'region', 'cuisine'],
    },
  );
}

const CUISINE_WORDS = {
  한식: /한식|백반|국밥|찌개|고기|갈비|삼겹/,
  중식: /중식|중국|짜장|짬뽕/,
  일식: /일식|초밥|스시|라멘|돈까스|돈카츠/,
  양식: /양식|파스타|스테이크|이탈리/,
  분식: /분식|김밥|떡볶이/,
  치킨: /치킨/,
  아시아: /베트남|태국|인도|쌀국수|아시아/,
  패스트푸드: /햄버거|버거|패스트푸드/,
  '카페·디저트': /카페|디저트|빵|베이커리/,
  주점: /술집|주점|호프|포차|이자카야|바$/,
};

const FILLER = /^(근처|주변|부근|인근|찾기|찾아줘|찾아|추천|맛집|식당|음식점)$/;
const REGION =
  /^(서울|부산|대구|인천|광주|대전|울산|세종|제주|경기|강원|충북|충남|전북|전남|경북|경남)$|(특별시|광역시|특별자치시|특별자치도|도|시|군|구)$/;

// "대구 중구 동성로 한식집" → region "대구 중구", area "동성로", cuisine "한식"
function parseQueryByRule(q) {
  const cuisine = Object.keys(CUISINE_WORDS).find((c) => CUISINE_WORDS[c].test(q)) || null;
  const tokens = q.trim().split(/\s+/).filter((t) => !FILLER.test(t));
  const areaTokens = tokens.filter((t) => !REGION.test(t) && !Object.values(CUISINE_WORDS).some((re) => re.test(t)));
  const regionTokens = tokens.filter((t) => REGION.test(t));
  const area = areaTokens[0] || tokens[0] || q.trim();
  const areaType = /(로|길)$/.test(area) ? 'road' : /동$/.test(area) ? 'dong' : 'place';
  return { area, areaType, region: regionTokens.join(' ') || null, cuisine };
}

// ---------- 업종 분류 ----------
// 각 식당에 cuisine 을 붙이고, 음식점이 아닌 곳은 걸러낸 목록을 돌려준다.
export async function classify(restaurants) {
  if (!API_KEY) return restaurants.map((r) => ({ ...r, cuisine: cuisineByTags(r) }));

  const batches = [];
  for (let i = 0; i < restaurants.length; i += BATCH) batches.push(restaurants.slice(i, i + BATCH));

  const labels = new Map();
  // 동시에 6묶음씩 요청
  for (let i = 0; i < batches.length; i += 6) {
    const results = await Promise.all(batches.slice(i, i + 6).map(classifyBatch));
    for (const r of results.flat()) labels.set(r.id, r.cuisine);
  }

  return restaurants
    .map((r) => ({ ...r, cuisine: labels.get(r.id) || cuisineByTags(r) }))
    .filter((r) => r.cuisine !== NOT_FOOD);
}

// 한 묶음이 실패해도 검색 전체가 실패하지 않도록, 실패한 묶음은 태그 규칙으로 분류되게 빈 결과를 돌려준다
async function classifyBatch(batch) {
  try {
    return await classifyBatchOnce(batch);
  } catch (e) {
    console.warn(`업종 분류 실패 (${batch.length}곳, 규칙으로 대체): ${e.message}`);
    return [];
  }
}

async function classifyBatchOnce(batch) {
  const lines = batch.map((r) => `${r.id}\t${r.name}\t${r.amenity}\t${r.osmCuisine}`).join('\n');
  const out = await generate(
    `아래는 오픈스트리트맵의 가게 목록입니다 (ID, 상호, 시설유형, 요리태그).
상호와 태그를 보고 각 가게의 업종을 다음 중 하나로 분류하세요: ${[...CUISINES, NOT_FOOD].join(', ')}
음식을 팔지 않는 곳(편의점, 학원, 숙박, 병원, 사무실 등)은 "${NOT_FOOD}"로 분류하세요.
모든 ID에 대해 하나씩 답하세요.

${lines}`,
    {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          cuisine: { type: 'STRING', enum: [...CUISINES, NOT_FOOD] },
        },
        required: ['id', 'cuisine'],
      },
    },
  );
  return out;
}

// 키가 없거나 Gemini 가 빠뜨린 가게는 오픈스트리트맵 태그로 분류
const TAG_CUISINE = {
  korean: '한식', chinese: '중식', japanese: '일식', sushi: '일식', ramen: '일식',
  italian: '양식', pizza: '양식', steak_house: '양식', american: '양식', french: '양식', western: '양식',
  chicken: '치킨', vietnamese: '아시아', thai: '아시아', indian: '아시아', asian: '아시아',
  burger: '패스트푸드', coffee_shop: '카페·디저트', dessert: '카페·디저트', bakery: '카페·디저트',
};

function cuisineByTags(r) {
  for (const tag of r.osmCuisine.split(';')) if (TAG_CUISINE[tag]) return TAG_CUISINE[tag];
  if (r.amenity === 'cafe' || r.amenity === 'ice_cream') return '카페·디저트';
  if (r.amenity === 'bar' || r.amenity === 'pub' || r.amenity === 'biergarten') return '주점';
  if (r.amenity === 'fast_food') return '패스트푸드';
  for (const [c, re] of Object.entries(CUISINE_WORDS)) if (re.test(r.name)) return c;
  return '기타';
}
