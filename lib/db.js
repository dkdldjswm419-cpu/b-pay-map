// Supabase (서버 전용, service role 키로 구획 캐시를 읽고 쓴다)

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const dbEnabled = Boolean(URL_ && KEY);

async function rest(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      // 예전 방식 service_role 키(JWT, eyJ…)만 Authorization 에도 넣는다. 새 방식 sb_secret_ 키는 apikey 만 쓴다.
      ...(KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}),
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`Supabase 오류 (${res.status}): ${(await res.text()).slice(0, 300)}`);
  // return=minimal 이면 201/204 에 본문이 비어 있다
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const areaKey = (name) => name.replace(/\s+/g, '').toLowerCase();

export async function getArea(key) {
  if (!dbEnabled) return null;
  const rows = await rest(`areas?key=eq.${encodeURIComponent(key)}&select=*`);
  return rows[0] || null;
}

export async function saveArea(row) {
  if (!dbEnabled) return;
  await rest('areas?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}
