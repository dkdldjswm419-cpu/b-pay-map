# b-pay-map

도로명, 동이름, 지명이나 **"을지로 근처 한식집 찾기"** 같은 문장을 입력하면, 그 구획의 경계(폴리곤)와 안에 있는 식당을 지도에 표시합니다.
누구나 로그인 없이 식당을 클릭해 **비플페이 가능 / 불가능**을 누를 수 있고, 표시는 모든 사용자의 지도에 실시간으로 반영됩니다.

| 표시 | 의미 |
| --- | --- |
| 형광 테두리 (깜빡임) | 비플페이 가능 |
| 회색 | 비플페이 불가능 |
| 파랑 | 아직 확인 안 됨 |

같은 식당에 여러 사람이 누르면 **가장 최근 응답**을 따릅니다.

## 구성

| 역할 | 사용 기술 | 키 |
| --- | --- | --- |
| 지도 화면 | 오픈스트리트맵 + Leaflet | 필요 없음 |
| 구획 경계, 식당 목록 | 오픈스트리트맵 (Nominatim, Overpass) | 필요 없음 |
| 검색어 해석, 업종 분류 | Gemini | `GEMINI_API_KEY` |
| 데이터 저장, 실시간 공유 | Supabase | 프로젝트 URL과 키 |
| 웹사이트 배포 | Vercel | GitHub 연결 |

### 구획 범위
- **동 이름** (예: `명동`, `성수동`): 그 동의 행정 경계
- **도로명** (예: `을지로`): 그 도로가 지나는 동 전체 (을지로 → 광희동, 명동, 소공동, 신당동, 을지로동)
- **그 외 지명** (예: `서울시청`): 그 지점이 속한 동

처음 검색하는 구획은 오픈스트리트맵에서 수집하고 Gemini로 업종을 분류하느라 30초~1분 걸립니다.
한 번 수집한 구획은 Supabase에 저장되어 다음부터는 바로 나옵니다.

## 설정

### 1. Supabase
1. https://supabase.com 에서 새 프로젝트를 만듭니다.
2. **SQL Editor**에 [supabase/schema.sql](supabase/schema.sql) 내용을 전부 붙여넣고 **Run**을 누릅니다.
3. **Project Settings → API**에서 아래 세 값을 복사합니다.
   - Project URL → `SUPABASE_URL`
   - `anon` `public` 키 → `SUPABASE_ANON_KEY`
   - `service_role` 키 → `SUPABASE_SERVICE_ROLE_KEY` (서버 전용. 절대 공개하지 마세요)

### 2. Gemini
https://aistudio.google.com 에서 **Get API key**를 눌러 키를 만들고 `GEMINI_API_KEY`에 넣습니다.

### 3. 로컬에서 실행
`.env`에 위 값들을 채우고:

```bash
npm run dev
```

http://localhost:3000 을 엽니다. 키가 없어도 지도 검색은 동작합니다.
- Gemini 키가 없으면 간단한 규칙으로 검색어를 해석하고 업종을 분류합니다.
- Supabase 설정이 없으면 표시를 저장할 수 없습니다.

### 4. Vercel 배포
1. https://vercel.com 에서 **Add New → Project**를 누르고 GitHub의 `b-pay-map` 저장소를 가져옵니다.
2. Framework Preset은 **Other**로 두고, **Environment Variables**에 `.env`의 값들을 같은 이름으로 넣습니다 (`PORT` 제외).
3. **Deploy**를 누릅니다.

## 참고
- 오픈스트리트맵 데이터는 사용자들이 만든 공개 데이터라서 일부 식당이 빠져 있을 수 있습니다.
- 공용 Overpass 서버가 붐비면 자동으로 다른 서버로 재시도합니다.
- 지도 데이터 © OpenStreetMap contributors (ODbL)
