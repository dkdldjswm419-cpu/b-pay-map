// 비플페이 지도 프론트엔드 (오픈스트리트맵 + Supabase 실시간)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const LIST_LIMIT = 300;
const STYLE = {
  unknown: { radius: 6, color: '#ffffff', weight: 1.5, fillColor: '#3b82f6', fillOpacity: 0.9 },
  no: { radius: 6, color: '#6b7280', weight: 1.5, fillColor: '#9ca3af', fillOpacity: 0.9 },
  yes: { radius: 10, color: '#39ff14', weight: 5, fillColor: '#16a34a', fillOpacity: 1 },
};
const LABEL = { yes: '비플페이 가능', no: '비플페이 불가능', unknown: '아직 확인되지 않음' };

const $ = (sel) => document.querySelector(sel);

let sb = null;
let area = null;
let cuisines = [];
let activeCuisine = null;
let yesOnly = false;
const statuses = new Map(); // restaurant_id -> 'yes' | 'no'
const markers = new Map(); // restaurant_id -> L.circleMarker
const byId = new Map(); // restaurant_id -> restaurant

// ---------- 지도 ----------
const map = L.map('map').setView([37.5665, 126.978], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const polygonLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);

// ---------- 공통 ----------
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showMessage(text, ms = 3000) {
  const el = $('#message');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(showMessage.timer);
  if (ms) showMessage.timer = setTimeout(() => (el.hidden = true), ms);
}

// 같은 이름이 여러 지역에 있을 때 고를 수 있는 버튼을 보여준다
function showChoices(text, choices) {
  const el = $('#message');
  clearTimeout(showMessage.timer);
  el.innerHTML = '';
  el.append(text);
  const box = document.createElement('div');
  box.className = 'choices';
  for (const c of choices) {
    const b = document.createElement('button');
    b.textContent = c;
    b.onclick = () => {
      $('#query').value = c;
      search(c);
    };
    box.appendChild(b);
  }
  el.appendChild(box);
  el.hidden = false;
}

const statusOf = (id) => statuses.get(id) || 'unknown';

function visible(r) {
  if (activeCuisine && r.cuisine !== activeCuisine) return false;
  if (yesOnly && statusOf(r.id) !== 'yes') return false;
  return true;
}

// ---------- 마커 ----------
function applyStyle(id) {
  const m = markers.get(id);
  if (!m) return;
  const st = statusOf(id);
  m.setStyle(STYLE[st]);
  m.setRadius(STYLE[st].radius);
  m.getElement()?.classList.toggle('neon', st === 'yes');
  if (st === 'yes') m.bringToFront();
}

function renderMarkers() {
  markerLayer.clearLayers();
  markers.clear();
  for (const r of area.restaurants) {
    if (!visible(r)) continue;
    const m = L.circleMarker([r.lat, r.lng], STYLE[statusOf(r.id)])
      .bindTooltip(r.name, { direction: 'top', offset: [0, -6] })
      .on('click', () => openPopup(r));
    m.addTo(markerLayer);
    markers.set(r.id, m);
    applyStyle(r.id);
  }
}

function popupContent(r) {
  const st = statusOf(r.id);
  const el = document.createElement('div');
  el.className = 'info';
  el.innerHTML = `
    <h3>${escapeHtml(r.name)}</h3>
    <p>${escapeHtml(r.cuisine)}</p>
    ${r.address ? `<p>${escapeHtml(r.address)}</p>` : ''}
    <div class="current">현재 상태: <b>${LABEL[st]}</b></div>
    <div class="buttons">
      <button class="btn-yes ${st === 'yes' ? 'active' : ''}">비플페이 가능</button>
      <button class="btn-no ${st === 'no' ? 'active' : ''}">불가능</button>
    </div>`;
  el.querySelector('.btn-yes').onclick = () => vote(r, 'yes');
  el.querySelector('.btn-no').onclick = () => vote(r, 'no');
  return el;
}

function openPopup(r) {
  L.popup({ offset: [0, -4] }).setLatLng([r.lat, r.lng]).setContent(popupContent(r)).openOn(map);
}

// 열려 있는 팝업이 이 식당 것이면 내용을 새로 그린다
function refreshPopup(r) {
  const popup = map._popup;
  if (popup?.isOpen() && popup.getLatLng().equals([r.lat, r.lng])) popup.setContent(popupContent(r));
}

// ---------- 비플페이 표시 ----------
async function vote(r, status) {
  if (!sb) return showMessage('Supabase가 연결되지 않아 저장할 수 없습니다. README.md를 참고하세요.', 5000);
  const { error } = await sb.from('bpay_status').upsert({ restaurant_id: r.id, status, name: r.name });
  if (error) return showMessage(`저장 실패: ${error.message}`, 5000);
  onStatusChange(r.id, status);
  showMessage(`${r.name}: ${LABEL[status]}으로 표시했습니다.`);
}

function onStatusChange(id, status) {
  if (statuses.get(id) === status) return;
  statuses.set(id, status);
  const r = byId.get(id);
  if (!r) return;
  if (yesOnly) renderMarkers();
  else applyStyle(id);
  refreshPopup(r);
  renderList();
  renderFilters();
}

async function loadStatuses(ids) {
  if (!sb) return;
  const chunks = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
  const results = await Promise.all(
    chunks.map((c) => sb.from('bpay_status').select('restaurant_id,status').in('restaurant_id', c)),
  );
  for (const { data, error } of results) {
    if (error) throw error;
    for (const row of data) statuses.set(row.restaurant_id, row.status);
  }
}

// 다른 사용자가 누른 표시를 실시간으로 반영 (가장 최근 응답 우선)
function subscribeRealtime() {
  sb.channel('bpay_status')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bpay_status' }, ({ new: row }) => {
      if (row?.restaurant_id) onStatusChange(row.restaurant_id, row.status);
    })
    .subscribe();
}

// ---------- 목록과 필터 ----------
function renderList() {
  const order = { yes: 0, unknown: 1, no: 2 };
  const shown = area.restaurants.filter(visible).sort((a, b) => order[statusOf(a.id)] - order[statusOf(b.id)]);
  const list = $('#place-list');
  list.innerHTML = '';
  for (const r of shown.slice(0, LIST_LIMIT)) {
    const li = document.createElement('li');
    li.innerHTML = `<i class="dot ${statusOf(r.id)}"></i>${escapeHtml(r.name)}<small>${escapeHtml(r.cuisine)}${r.address ? ` · ${escapeHtml(r.address)}` : ''}</small>`;
    li.onclick = () => {
      map.setView([r.lat, r.lng], Math.max(map.getZoom(), 17));
      openPopup(r);
    };
    list.appendChild(li);
  }
  if (shown.length > LIST_LIMIT) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `외 ${shown.length - LIST_LIMIT}곳은 지도에서 확인하세요`;
    list.appendChild(li);
  }

  const yes = area.restaurants.filter((r) => statusOf(r.id) === 'yes').length;
  $('#summary').textContent = `${area.name} (${area.dongs.join('·')}) · 식당 ${area.restaurants.length}곳 · 비플페이 가능 ${yes}곳`;
}

function renderFilters() {
  const nav = $('#filters');
  const counts = {};
  for (const r of area.restaurants) counts[r.cuisine] = (counts[r.cuisine] || 0) + 1;
  const yes = area.restaurants.filter((r) => statusOf(r.id) === 'yes').length;

  nav.innerHTML = '';
  const add = (label, active, onClick, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = `${cls} ${active ? 'active' : ''}`;
    b.onclick = onClick;
    nav.appendChild(b);
  };
  add(`비플페이 가능만 (${yes})`, yesOnly, () => setFilter(activeCuisine, !yesOnly), 'yes-only');
  nav.appendChild(Object.assign(document.createElement('span'), { className: 'sep' }));
  add(`전체 (${area.restaurants.length})`, !activeCuisine, () => setFilter(null, yesOnly));
  for (const c of cuisines) if (counts[c]) add(`${c} (${counts[c]})`, activeCuisine === c, () => setFilter(c, yesOnly));
  nav.hidden = false;
}

function setFilter(cuisine, onlyYes) {
  activeCuisine = cuisine;
  yesOnly = onlyYes;
  map.closePopup();
  renderMarkers();
  renderList();
  renderFilters();
}

// ---------- 검색 ----------
async function search(q) {
  const btn = $('#search-form button');
  btn.disabled = true;
  showMessage('검색 중... 처음 검색하는 구획은 수집에 30초~1분 정도 걸립니다.', 0);
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.choices) return showChoices(data.error, data.choices);
    if (!res.ok) throw new Error(data.error);

    area = data.area;
    cuisines = data.cuisines;
    activeCuisine = data.parsed.cuisine;
    yesOnly = false;
    byId.clear();
    for (const r of area.restaurants) byId.set(r.id, r);

    await loadStatuses(area.restaurants.map((r) => r.id));

    polygonLayer.clearLayers();
    const poly = L.geoJSON(area.polygon, {
      style: { color: '#03c75a', weight: 2, fillColor: '#03c75a', fillOpacity: 0.06 },
      interactive: false,
    }).addTo(polygonLayer);
    map.fitBounds(poly.getBounds(), { padding: [20, 20] });

    renderMarkers();
    renderList();
    renderFilters();
    const what = activeCuisine ? `${activeCuisine} ` : '';
    const n = area.restaurants.filter(visible).length;
    showMessage(`${area.name}: ${what}식당 ${n}곳을 표시했습니다.`);
  } catch (e) {
    showMessage(`검색 실패: ${e.message}`, 6000);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 시작 ----------
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#query').value.trim();
  if (q) search(q);
});

try {
  const { supabaseUrl, supabaseAnonKey } = await fetch('/api/config').then((r) => r.json());
  if (supabaseUrl && supabaseAnonKey) {
    sb = createClient(supabaseUrl, supabaseAnonKey);
    subscribeRealtime();
  } else {
    console.warn('Supabase 설정이 없어 비플페이 표시를 저장할 수 없습니다 (지도 검색은 가능).');
  }
} catch (e) {
  console.warn(`설정을 불러오지 못했습니다: ${e.message}`);
}
if (!area) showMessage('위 검색창에 도로명·동이름·지명을 입력하고 검색하세요. (예: 명동, 을지로 근처 한식집 찾기)', 0);
