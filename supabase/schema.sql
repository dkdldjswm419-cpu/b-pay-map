-- 비플페이 지도 Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 Run 하세요.

-- 수집한 구획 캐시: 경계 폴리곤과 그 안의 식당 목록 (서버만 기록)
create table if not exists public.areas (
  key         text primary key,          -- 정규화한 구획 이름 (예: 을지로)
  name        text not null,             -- 화면 표시용 이름
  dongs       text[] not null,           -- 구획을 이루는 동 이름들
  polygon     jsonb not null,            -- GeoJSON FeatureCollection
  restaurants jsonb not null,            -- [{id, name, cuisine, amenity, address, lat, lng}]
  created_at  timestamptz not null default now()
);

-- 비플페이 가능/불가능 표시 (로그인 없이 누구나, 가장 최근 응답 우선)
create table if not exists public.bpay_status (
  restaurant_id text primary key,        -- 오픈스트리트맵 ID (예: n123456)
  status        text not null check (status in ('yes', 'no')),
  name          text,
  updated_at    timestamptz not null default now()
);

-- 누가 언제 보냈든 서버 시각으로 기록해 "최근 응답 우선"이 확실하게 동작하도록 한다
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bpay_status_touch on public.bpay_status;
create trigger bpay_status_touch
  before insert or update on public.bpay_status
  for each row execute function public.touch_updated_at();

-- 권한: areas 는 읽기만, bpay_status 는 읽기/추가/수정 (삭제 불가)
alter table public.areas enable row level security;
alter table public.bpay_status enable row level security;

drop policy if exists "areas read" on public.areas;
create policy "areas read" on public.areas for select using (true);

drop policy if exists "status read" on public.bpay_status;
create policy "status read" on public.bpay_status for select using (true);

drop policy if exists "status insert" on public.bpay_status;
create policy "status insert" on public.bpay_status for insert with check (true);

drop policy if exists "status update" on public.bpay_status;
create policy "status update" on public.bpay_status for update using (true) with check (true);

-- 실시간: 다른 사용자의 표시가 모든 지도에 즉시 반영되도록
do $$
begin
  alter publication supabase_realtime add table public.bpay_status;
exception when duplicate_object then null;
end $$;
