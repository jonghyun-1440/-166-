// 팀 일정 공유(하루 타임테이블) 저장/조회 API — Supabase 연동
//
// 필요한 Vercel 환경변수:
//   SUPABASE_URL          예: https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  Supabase 프로젝트의 service_role(secret) 키 (절대 클라이언트에 노출 금지)
// 선택 환경변수:
//   ADMIN_PIN             비상용 관리자 비밀번호 — 기수 비밀번호를 잊었을 때 재설정에 쓴다 (없으면 기능 꺼짐)
//   SESSION_SECRET        로그인 출입증 서명 키 — 없으면 SERVICE_KEY에서 만들어 쓴다
//   COHORT_REGIONS        기수 지역 목록(쉼표 구분) — 없으면 무실,일산,단계,우산,단구
//
// ── 테이블 (Supabase SQL Editor에서 한 번 실행) ──
//   create table schedule_members (
//     id text primary key, name text not null, color text, sort int,
//     cohort_id text not null default ''
//   );
//   create table schedule_entries (
//     id text primary key,
//     date text not null,          -- 'YYYY-MM-DD' (반복 일정 규칙은 1900-01-01(월)~07(일))
//     member_id text not null,     -- '*' = 전체(반복 일정)
//     start_min int not null,      -- 자정 기준 분 (예: 9:00 = 540)
//     end_min int not null,
//     title text not null,
//     memo text,
//     created_at timestamptz default now(),
//     cohort_id text not null default ''
//   );
//   create table schedule_cohorts (
//     id text primary key, region text not null, num int not null,
//     pin_hash text, fail_count int not null default 0, locked_until timestamptz,
//     created_at timestamptz default now(), unique (region, num)
//   );
//   create index schedule_entries_cohort_date_idx on schedule_entries (cohort_id, date);
//   alter table schedule_members enable row level security;
//   alter table schedule_entries enable row level security;
//   alter table schedule_cohorts enable row level security;
//   -- 접근은 service_role 키(이 API 서버)로만 하므로 별도 정책은 만들지 않는다.
//
// ── 기수 모드와 종전 모드 ──
//   schedule_cohorts 테이블이 있으면 「기수 모드」: 기수를 고르고 4자리 비밀번호로 들어가며,
//   모든 읽기·쓰기가 그 기수(cohort_id)의 데이터로만 한정된다.
//   테이블이 없으면 「종전 모드」: 로그인 없이 하나의 팀 일정표로 동작한다(기존 설치 그대로).

const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/, '')
  .replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PIN = String(process.env.ADMIN_PIN || '').trim();
const SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('team-schedule-session|' + (SERVICE_KEY || '')).digest('hex');

// 지역 이름 → 기수 id 앞부분. 목록에 없는 지역은 이름에서 만든다.
const REGION_CODES = { '무실': 'musil', '일산': 'ilsan', '단계': 'dangye', '우산': 'usan', '단구': 'dangu' };
const REGIONS = (process.env.COHORT_REGIONS || '무실,일산,단계,우산,단구')
  .split(',').map((s) => s.trim()).filter(Boolean);
function regionCode(r) {
  return REGION_CODES[r] || ('r' + crypto.createHash('sha1').update(r).digest('hex').slice(0, 8));
}

const TOKEN_DAYS = 30;          // 한 번 들어오면 그 기기에서 기억하는 기간
const MAX_FAILS = 5;            // 비밀번호를 이만큼 틀리면
const LOCK_SECONDS = 60;        // 이 시간 동안 잠근다
const ADMIN_LOCK_SECONDS = 900; // 관리자 비밀번호는 사이트 전체에서 5번 틀리면 15분 잠근다
const ADMIN_ROW = '__admin';    // 관리자 시도 횟수를 세는 숨은 줄 (기수 목록에는 안 보임)

// 9명 기본 구성원 — 기수를 처음 열 때 자동 생성되고, 화면에서 이름을 바꿔 쓴다.
const DEFAULT_MEMBER_COLORS = [
  '#3E6288', '#A9884F', '#5E8D66', '#B56576', '#6D597A',
  '#C97B4A', '#40878A', '#7D6FA0', '#8B6D5C'
];

function sbHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json'
  }, extra || {});
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PIN_RE = /^\d{4}$/;

// 들어온 일정 한 건을 저장 가능한 형태로 정리 — 형식이 어긋나면 null
function normalizeEntry(e) {
  const startMin = Number(e && e.start_min), endMin = Number(e && e.end_min);
  const row = {
    id: String((e && e.id) || '').slice(0, 60),
    date: String((e && e.date) || ''),
    member_id: String((e && e.member_id) || '').slice(0, 40),
    start_min: startMin,
    end_min: endMin,
    title: String((e && e.title) || '').trim().slice(0, 60),
    memo: String((e && e.memo) || '').slice(0, 500)
  };
  if (!row.id || !DATE_RE.test(row.date) || !row.member_id || !row.title ||
      !Number.isInteger(startMin) || !Number.isInteger(endMin) ||
      startMin < 0 || endMin > 1440 || endMin <= startMin) {
    return null;
  }
  return row;
}

// ── 비밀번호 · 출입증 ──
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function pinMatches(pin, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const [salt, hex] = stored.split(':');
  const a = crypto.scryptSync(String(pin), salt, 32), b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function b64u(s) { return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function sign(payload) { return crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 40); }
function pinVersion(h) { return crypto.createHash('sha1').update(String(h || '')).digest('hex').slice(0, 10); }
// 출입증에는 비밀번호 지문(v)을 담는다 — 비밀번호를 바꾸면 예전 출입증은 모두 무효가 된다
function makeToken(cohort) {
  const payload = b64u(JSON.stringify({ c: cohort.id, v: pinVersion(cohort.pin_hash), e: Date.now() + TOKEN_DAYS * 864e5 }));
  return payload + '.' + sign(payload);
}
function readToken(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 2) return null;
  const expect = Buffer.from(sign(parts[0])), got = Buffer.from(parts[1]);
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return p && p.c && p.e > Date.now() ? p : null;
  } catch (e) { return null; }
}
function cohortName(c) { return `${c.region} ${c.num}기`; }
function publicCohort(c) { return { id: c.id, region: c.region, num: c.num, name: cohortName(c), hasPin: !!c.pin_hash }; }
// 기수 표가 있는지 — 같은 서버 인스턴스에서는 1분 동안 기억한다 (SQL 실행 후 늦어도 1분 안에 기수 모드로 바뀜)
let modeCache = { on: null, at: 0 };
function lockLeft(c) { return c.locked_until ? Math.ceil((new Date(c.locked_until) - Date.now()) / 1000) : 0; }

module.exports = async (req, res) => {
  const configured = !!(SUPABASE_URL && SERVICE_KEY);
  const q = req.query || {};
  if (req.method === 'GET' && q.health === '1') {
    return res.status(200).json({ ok: true, configured, hasUrl: !!SUPABASE_URL, hasKey: !!SERVICE_KEY });
  }
  if (!configured) {
    return res.status(503).json({ error: 'not-configured', hasUrl: !!SUPABASE_URL, hasKey: !!SERVICE_KEY });
  }
  const membersTable = `${SUPABASE_URL}/rest/v1/schedule_members`;
  const entriesTable = `${SUPABASE_URL}/rest/v1/schedule_entries`;
  const cohortsTable = `${SUPABASE_URL}/rest/v1/schedule_cohorts`;
  const enc = encodeURIComponent;

  async function sb(url, opts, what) {
    const r = await fetch(url, Object.assign({ headers: sbHeaders() }, opts || {}));
    if (!r.ok) throw new Error(`${what || 'db'} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  async function getCohort(id) {
    const rows = await sb(`${cohortsTable}?id=eq.${enc(id)}&select=*`, null, 'cohort');
    return (rows && rows[0]) || null;
  }
  // 비밀번호를 확인하기 「전에」 시도 한 번을 예약한다. fail_count를 조건부(지금 값일 때만)로 올리므로
  // 동시에 수천 번 보내도 한 번에 하나씩만 통과하고, MAX_FAILS번째에 잠긴다. 맞히면 0으로 되돌린다.
  async function reserveAttempt(id, lockSeconds) {
    for (let i = 0; i < 6; i++) {
      const c = await getCohort(id);
      if (!c) return { gone: true };
      const wait = lockLeft(c);
      if (wait > 0) return { wait };
      const cur = c.fail_count || 0, next = cur + 1;
      const locking = next % MAX_FAILS === 0;
      const body = locking
        ? { fail_count: next, locked_until: new Date(Date.now() + lockSeconds * 1000).toISOString() }
        : { fail_count: next };
      const rows = await sb(`${cohortsTable}?id=eq.${enc(id)}&fail_count=eq.${cur}`, {
        method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(body)
      }, 'attempt');
      if (rows && rows.length) return { c, locking, left: MAX_FAILS - (next % MAX_FAILS) };
    }
    return { wait: 3 }; // 동시에 너무 많이 들어옴 — 잠시 뒤 다시
  }
  async function clearAttempts(id) {
    await sb(`${cohortsTable}?id=eq.${enc(id)}`, {
      method: 'PATCH', body: JSON.stringify({ fail_count: 0, locked_until: null })
    }, 'reset');
  }
  // 비밀번호 확인 — 실패면 { status, body } 반환, 맞으면 null
  async function checkPin(c, pin) {
    const a = await reserveAttempt(c.id, LOCK_SECONDS);
    if (a.gone) return { status: 404, body: { error: 'no-cohort' } };
    if (a.wait) return { status: 429, body: { error: 'locked', wait: a.wait } };
    if (pinMatches(pin, a.c.pin_hash)) { await clearAttempts(c.id); return null; }
    return a.locking
      ? { status: 429, body: { error: 'locked', wait: LOCK_SECONDS } }
      : { status: 401, body: { error: 'wrong-pin', left: a.left } };
  }
  function sameSecret(a, b) {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  }
  async function seedMembers(cohortId) {
    const seed = DEFAULT_MEMBER_COLORS.map((color, i) => ({
      id: `${cohortId}-m${i + 1}`, name: `팀원 ${i + 1}`, color, sort: i + 1, cohort_id: cohortId
    }));
    const rows = await sb(membersTable, {
      method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify(seed)
    }, 'seed');
    return (rows || []).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  }

  try {
    // ── 어느 모드인가: 기수 테이블이 있으면 기수 모드 ──
    let cohortMode = modeCache.at > Date.now() - 60000 ? modeCache.on : null;
    if (cohortMode === null) {
      const probe = await fetch(`${cohortsTable}?select=id&limit=1`, { headers: sbHeaders() });
      if (!probe.ok && probe.status !== 404) throw new Error(`cohort-probe ${probe.status}`);
      cohortMode = probe.ok;
      modeCache = { on: cohortMode, at: Date.now() };
    }

    // ── 로그인 화면용: 기수 목록 (이름만 공개) ──
    if (req.method === 'GET' && q.cohorts === '1') {
      if (!cohortMode) return res.status(200).json({ ok: true, mode: 'legacy' });
      const rows = await sb(`${cohortsTable}?select=id,region,num,pin_hash&order=num.asc&limit=500`, null, 'cohorts');
      return res.status(200).json({
        ok: true, mode: 'cohort', regions: REGIONS, adminEnabled: !!ADMIN_PIN,
        cohorts: rows.filter((r) => r.id !== ADMIN_ROW).map(publicCohort)
      });
    }

    const b = req.method === 'POST'
      ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}))
      : {};

    // ── 기수 만들기 · 들어가기 · 첫 비밀번호 정하기 · 관리자 재설정 (출입증 없이) ──
    const OPEN_TYPES = ['cohort-create', 'login', 'cohort-setpin', 'admin-reset'];
    if (cohortMode && req.method === 'POST' && OPEN_TYPES.indexOf(b.type) >= 0) {
      if (b.type === 'cohort-create') {
        const region = String(b.region || '');
        const num = String(b.num || '');
        if (REGIONS.indexOf(region) < 0) return res.status(400).json({ error: 'bad-region' });
        if (!/^\d{1,4}$/.test(num) || Number(num) < 1) return res.status(400).json({ error: 'bad-num' });
        if (!PIN_RE.test(String(b.pin || ''))) return res.status(400).json({ error: 'bad-pin' });
        const row = { id: `${regionCode(region)}-${Number(num)}`, region, num: Number(num), pin_hash: hashPin(String(b.pin)) };
        const r = await fetch(cohortsTable, {
          method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(row)
        });
        if (r.status === 409) return res.status(409).json({ error: 'exists' });
        if (!r.ok) throw new Error(`cohort-create ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const c = (await r.json())[0];
        return res.status(200).json({ ok: true, token: makeToken(c), cohort: publicCohort(c) });
      }

      const c = String(b.cohort || '') === ADMIN_ROW ? null : await getCohort(String(b.cohort || ''));
      if (!c) return res.status(404).json({ error: 'no-cohort' });

      // 비밀번호가 아직 없는 기수(옮겨 온 기수) — 처음 들어온 사람이 정한다
      if (b.type === 'cohort-setpin') {
        if (c.pin_hash) return res.status(409).json({ error: 'has-pin' });
        if (!PIN_RE.test(String(b.pin || ''))) return res.status(400).json({ error: 'bad-pin' });
        const rows = await sb(`${cohortsTable}?id=eq.${enc(c.id)}&pin_hash=is.null`, {
          method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }),
          body: JSON.stringify({ pin_hash: hashPin(String(b.pin)) })
        }, 'setpin');
        if (!rows || !rows.length) return res.status(409).json({ error: 'has-pin' }); // 그 사이 누가 먼저 정했다
        return res.status(200).json({ ok: true, token: makeToken(rows[0]), cohort: publicCohort(rows[0]) });
      }

      if (b.type === 'login') {
        if (!c.pin_hash) return res.status(409).json({ error: 'no-pin' });
        const fail = await checkPin(c, String(b.pin || ''));
        if (fail) return res.status(fail.status).json(fail.body);
        return res.status(200).json({ ok: true, token: makeToken(c), cohort: publicCohort(c) });
      }

      if (b.type === 'admin-reset') {
        if (!ADMIN_PIN) return res.status(404).json({ error: 'no-admin' });
        // 관리자 시도는 기수마다가 아니라 사이트 전체로 센다 — 기수를 새로 만들어 횟수를 초기화할 수 없게
        await fetch(cohortsTable, {
          method: 'POST', headers: sbHeaders({ Prefer: 'resolution=ignore-duplicates' }),
          body: JSON.stringify({ id: ADMIN_ROW, region: ADMIN_ROW, num: 0 })
        });
        const a = await reserveAttempt(ADMIN_ROW, ADMIN_LOCK_SECONDS);
        if (a.wait) return res.status(429).json({ error: 'locked', wait: a.wait });
        if (a.gone) throw new Error('admin-row');
        if (!sameSecret(b.adminPin || '', ADMIN_PIN)) {
          return a.locking
            ? res.status(429).json({ error: 'locked', wait: ADMIN_LOCK_SECONDS })
            : res.status(401).json({ error: 'wrong-admin' });
        }
        await clearAttempts(ADMIN_ROW);
        if (!PIN_RE.test(String(b.newPin || ''))) return res.status(400).json({ error: 'bad-pin' });
        const rows = await sb(`${cohortsTable}?id=eq.${enc(c.id)}`, {
          method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }),
          body: JSON.stringify({ pin_hash: hashPin(String(b.newPin)), fail_count: 0, locked_until: null })
        }, 'admin-reset');
        return res.status(200).json({ ok: true, token: makeToken(rows[0]), cohort: publicCohort(rows[0]) });
      }
    }

    // ── 여기부터는 일정 데이터 — 기수 모드에서는 출입증이 있어야 한다 ──
    let cohortId = null, cohort = null;
    if (cohortMode) {
      const tok = readToken(req.headers && req.headers['x-cohort-token']);
      if (!tok) return res.status(401).json({ error: 'auth' });
      cohort = await getCohort(tok.c);
      if (!cohort) return res.status(401).json({ error: 'auth', reason: 'gone' });
      if (tok.v !== pinVersion(cohort.pin_hash)) return res.status(401).json({ error: 'auth', reason: 'pin-changed' });
      cohortId = cohort.id;
    }
    // 기수 모드면 모든 조회·수정·삭제에 이 조건이 붙는다
    const scope = cohortMode ? `&cohort_id=eq.${enc(cohortId)}` : '';
    // 저장하려는 일정 id가 다른 기수의 것인지 — upsert가 남의 일정을 덮어써 가져오지 못하게
    async function idsTakenElsewhere(ids) {
      if (!cohortMode || !ids.length) return false;
      const rows = await sb(`${entriesTable}?select=id,cohort_id&id=in.(${ids.map((x) => enc('"' + x + '"')).join(',')})`, null, 'id-check');
      return (rows || []).some((r) => r.cohort_id !== cohortId);
    }
    const stamp = (row) => (cohortMode ? Object.assign(row, { cohort_id: cohortId }) : row);

    // 하루치 조회 — 구성원 목록 + 해당 날짜의 모든 일정
    if (req.method === 'GET') {
      const date = String(q.date || '');
      if (!DATE_RE.test(date)) return res.status(400).json({ error: 'bad-date' });

      let members = await sb(`${membersTable}?select=*&order=sort.asc&limit=30${scope}`, null, 'members');
      if (!members.length) {                  // 처음 연 기수(또는 처음 설치): 9명 기본 생성
        if (cohortMode) members = await seedMembers(cohortId);
        else {
          const seed = DEFAULT_MEMBER_COLORS.map((color, i) => ({ id: `m${i + 1}`, name: `팀원 ${i + 1}`, color, sort: i + 1 }));
          members = await sb(membersTable, {
            method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
            body: JSON.stringify(seed)
          }, 'seed');
          members.sort((a, b2) => (a.sort || 0) - (b2.sort || 0));
        }
      }
      const entries = await sb(
        `${entriesTable}?select=*&date=eq.${enc(date)}&order=start_min.asc&limit=1000${scope}`, null, 'entries');
      return res.status(200).json({ ok: true, members, entries, cohort: cohort ? publicCohort(cohort) : null });
    }

    if (req.method === 'POST') {
      // 기수 비밀번호 바꾸기 / 기수 삭제 — 지금 비밀번호를 한 번 더 확인한다
      if (cohortMode && (b.type === 'cohort-pin' || b.type === 'cohort-delete')) {
        const fail = await checkPin(cohort, String(b.pin || ''));
        if (fail) return res.status(fail.status).json(fail.body);
        if (b.type === 'cohort-pin') {
          if (!PIN_RE.test(String(b.newPin || ''))) return res.status(400).json({ error: 'bad-pin' });
          const rows = await sb(`${cohortsTable}?id=eq.${enc(cohortId)}`, {
            method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }),
            body: JSON.stringify({ pin_hash: hashPin(String(b.newPin)) })
          }, 'cohort-pin');
          return res.status(200).json({ ok: true, token: makeToken(rows[0]) });
        }
        await sb(`${entriesTable}?cohort_id=eq.${enc(cohortId)}`, { method: 'DELETE' }, 'del-entries');
        await sb(`${membersTable}?cohort_id=eq.${enc(cohortId)}`, { method: 'DELETE' }, 'del-members');
        await sb(`${cohortsTable}?id=eq.${enc(cohortId)}`, { method: 'DELETE' }, 'del-cohort');
        return res.status(200).json({ ok: true });
      }

      // 구성원 이름 변경
      if (b.type === 'member') {
        const id = String(b.id || '').slice(0, 40);
        const name = String(b.name || '').trim().slice(0, 20);
        if (!id || !name) return res.status(400).json({ error: 'bad-member' });
        await sb(`${membersTable}?id=eq.${enc(id)}${scope}`, { method: 'PATCH', body: JSON.stringify({ name }) }, 'member');
        return res.status(200).json({ ok: true });
      }

      // 구성원 추가 · 통째로 저장(이름·색·순서) — 같은 id면 덮어쓴다
      if (b.type === 'member-add') {
        const m = b.member || {};
        const row = stamp({
          id: String(m.id || '').slice(0, 40),
          name: String(m.name || '').trim().slice(0, 20),
          color: /^#[0-9A-Fa-f]{6}$/.test(String(m.color || '')) ? m.color : DEFAULT_MEMBER_COLORS[0],
          sort: Number.isFinite(Number(m.sort)) ? Number(m.sort) : 999
        });
        if (!row.id || !row.name) return res.status(400).json({ error: 'bad-member' });
        const existing = await sb(`${membersTable}?select=id&limit=31${scope}`, null, 'count');
        const isUpdate = existing.some((x) => x.id === row.id);
        if (!isUpdate && existing.length >= 30) return res.status(400).json({ error: 'too-many-members' });
        if (cohortMode && !isUpdate) {        // 다른 기수의 팀원을 덮어쓰지 않게
          const other = await sb(`${membersTable}?select=id&id=eq.${enc(row.id)}`, null, 'member-check');
          if (other.length) return res.status(409).json({ error: 'id-taken' });
        }
        await sb(membersTable, {
          method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify(row)
        }, 'member-add');
        return res.status(200).json({ ok: true });
      }

      // 엑셀 업로드 등 여러 건 한 번에 저장
      if (b.type === 'entries') {
        const list = Array.isArray(b.entries) ? b.entries : [];
        if (!list.length) return res.status(400).json({ error: 'no-entries' });
        if (list.length > 500) return res.status(400).json({ error: 'too-many' });
        const rows = [];
        for (const e of list) {
          const row = normalizeEntry(e);
          if (!row) return res.status(400).json({ error: 'bad-entry' });
          rows.push(stamp(row));
        }
        if (await idsTakenElsewhere(rows.map((r) => r.id))) return res.status(409).json({ error: 'id-taken' });
        await sb(entriesTable, {
          method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify(rows)
        }, 'entries');
        return res.status(200).json({ ok: true, count: rows.length });
      }

      // 일정 저장(생성/수정) — 같은 id면 갱신(upsert)
      if (b.type === 'entry') {
        const row = normalizeEntry(b.entry || {});
        if (!row) return res.status(400).json({ error: 'bad-entry' });
        if (await idsTakenElsewhere([row.id])) return res.status(409).json({ error: 'id-taken' });
        await sb(entriesTable, {
          method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify(stamp(row))
        }, 'entry');
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'bad-type' });
    }

    // 삭제 — ?member=구성원(본인 일정 포함), ?date=그날 전부, ?id=일정 하나
    if (req.method === 'DELETE') {
      const memberId = String(q.member || '');
      if (memberId) {
        await sb(`${entriesTable}?member_id=eq.${enc(memberId)}${scope}`, { method: 'DELETE' }, 'member-entries');
        await sb(`${membersTable}?id=eq.${enc(memberId)}${scope}`, { method: 'DELETE' }, 'member-del');
        return res.status(200).json({ ok: true });
      }
      const delDate = String(q.date || '');
      if (delDate) {
        if (!DATE_RE.test(delDate)) return res.status(400).json({ error: 'bad-date' });
        await sb(`${entriesTable}?date=eq.${enc(delDate)}${scope}`, { method: 'DELETE' }, 'day-del');
        return res.status(200).json({ ok: true });
      }
      const id = String(q.id || '');
      if (!id) return res.status(400).json({ error: 'no-id' });
      await sb(`${entriesTable}?id=eq.${enc(id)}${scope}`, { method: 'DELETE' }, 'delete');
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e && e.message || e).slice(0, 300) });
  }
};
