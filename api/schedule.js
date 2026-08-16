// 팀 일정 공유(하루 타임테이블) 저장/조회 API — Supabase 연동
//
// 필요한 Vercel 환경변수 (기존 심리검사센터와 동일한 Supabase 프로젝트를 함께 사용):
//   SUPABASE_URL          예: https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  Supabase 프로젝트의 service_role 키 (절대 클라이언트에 노출 금지)
//
// Supabase SQL Editor에서 한 번 실행할 테이블 생성 SQL:
//   create table schedule_members (
//     id text primary key,
//     name text not null,
//     color text,
//     sort int
//   );
//   create table schedule_entries (
//     id text primary key,
//     date text not null,          -- 'YYYY-MM-DD'
//     member_id text not null,
//     start_min int not null,      -- 자정 기준 분 (예: 9:00 = 540)
//     end_min int not null,
//     title text not null,
//     memo text,
//     created_at timestamptz default now()
//   );
//   create index schedule_entries_date_idx on schedule_entries (date);
//   alter table schedule_members enable row level security;
//   alter table schedule_entries enable row level security;
//   -- 접근은 service_role 키(이 API 서버)로만 하므로 별도 정책은 만들지 않는다.

const SUPABASE_URL = (process.env.SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/, '')
  .replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// 9명 기본 구성원 — 최초 조회 시 자동 생성되고, 화면에서 이름을 바꿔 쓴다.
const DEFAULT_MEMBER_COLORS = [
  '#3E6288', '#A9884F', '#5E8D66', '#B56576', '#6D597A',
  '#C97B4A', '#40878A', '#7D6FA0', '#8B6D5C'
];

function sbHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

module.exports = async (req, res) => {
  const configured = !!(SUPABASE_URL && SERVICE_KEY);
  if (req.method === 'GET' && (req.query || {}).health === '1') {
    return res.status(200).json({ ok: true, configured, hasUrl: !!SUPABASE_URL, hasKey: !!SERVICE_KEY });
  }
  if (!configured) {
    return res.status(503).json({ error: 'not-configured', hasUrl: !!SUPABASE_URL, hasKey: !!SERVICE_KEY });
  }
  const membersTable = `${SUPABASE_URL}/rest/v1/schedule_members`;
  const entriesTable = `${SUPABASE_URL}/rest/v1/schedule_entries`;

  try {
    // 하루치 조회 — 구성원 목록 + 해당 날짜의 모든 일정
    if (req.method === 'GET') {
      const date = String((req.query || {}).date || '');
      if (!DATE_RE.test(date)) return res.status(400).json({ error: 'bad-date' });

      let resp = await fetch(`${membersTable}?select=*&order=sort.asc&limit=30`, { headers: sbHeaders() });
      if (!resp.ok) throw new Error(`members ${resp.status}: ${await resp.text()}`);
      let members = await resp.json();

      // 최초 접속: 구성원이 없으면 9명 기본 생성
      if (!members.length) {
        const seed = DEFAULT_MEMBER_COLORS.map((color, i) => ({
          id: `m${i + 1}`, name: `팀원 ${i + 1}`, color, sort: i + 1
        }));
        const ins = await fetch(membersTable, {
          method: 'POST',
          headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(seed)
        });
        if (!ins.ok) throw new Error(`seed ${ins.status}: ${await ins.text()}`);
        members = await ins.json();
        members.sort((a, b) => (a.sort || 0) - (b.sort || 0));
      }

      resp = await fetch(
        `${entriesTable}?select=*&date=eq.${encodeURIComponent(date)}&order=start_min.asc&limit=1000`,
        { headers: sbHeaders() }
      );
      if (!resp.ok) throw new Error(`entries ${resp.status}: ${await resp.text()}`);
      const entries = await resp.json();
      return res.status(200).json({ ok: true, members, entries });
    }

    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

      // 구성원 이름 변경
      if (b.type === 'member') {
        const id = String(b.id || '').slice(0, 40);
        const name = String(b.name || '').trim().slice(0, 20);
        if (!id || !name) return res.status(400).json({ error: 'bad-member' });
        const resp = await fetch(`${membersTable}?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ name })
        });
        if (!resp.ok) throw new Error(`member ${resp.status}: ${await resp.text()}`);
        return res.status(200).json({ ok: true });
      }

      // 구성원 추가
      if (b.type === 'member-add') {
        const m = b.member || {};
        const row = {
          id: String(m.id || '').slice(0, 40),
          name: String(m.name || '').trim().slice(0, 20),
          color: /^#[0-9A-Fa-f]{6}$/.test(String(m.color || '')) ? m.color : DEFAULT_MEMBER_COLORS[0],
          sort: Number.isFinite(Number(m.sort)) ? Number(m.sort) : 999
        };
        if (!row.id || !row.name) return res.status(400).json({ error: 'bad-member' });
        const cnt = await fetch(`${membersTable}?select=id&limit=31`, { headers: sbHeaders() });
        if (!cnt.ok) throw new Error(`count ${cnt.status}: ${await cnt.text()}`);
        if ((await cnt.json()).length >= 30) return res.status(400).json({ error: 'too-many-members' });
        const resp = await fetch(membersTable, {
          method: 'POST',
          headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(row)
        });
        if (!resp.ok) throw new Error(`member-add ${resp.status}: ${await resp.text()}`);
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
          rows.push(row);
        }
        const resp = await fetch(entriesTable, {
          method: 'POST',
          headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(rows)
        });
        if (!resp.ok) throw new Error(`entries ${resp.status}: ${await resp.text()}`);
        return res.status(200).json({ ok: true, count: rows.length });
      }

      // 일정 저장(생성/수정) — 같은 id면 갱신(upsert)
      if (b.type === 'entry') {
        const row = normalizeEntry(b.entry || {});
        if (!row) return res.status(400).json({ error: 'bad-entry' });
        const resp = await fetch(entriesTable, {
          method: 'POST',
          headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(row)
        });
        if (!resp.ok) throw new Error(`entry ${resp.status}: ${await resp.text()}`);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'bad-type' });
    }

    // 삭제 — ?member=구성원(본인 일정 포함), ?id=일정 하나
    if (req.method === 'DELETE') {
      const memberId = String((req.query || {}).member || '');
      if (memberId) {
        let resp = await fetch(`${entriesTable}?member_id=eq.${encodeURIComponent(memberId)}`, {
          method: 'DELETE', headers: sbHeaders()
        });
        if (!resp.ok) throw new Error(`member-entries ${resp.status}: ${await resp.text()}`);
        resp = await fetch(`${membersTable}?id=eq.${encodeURIComponent(memberId)}`, {
          method: 'DELETE', headers: sbHeaders()
        });
        if (!resp.ok) throw new Error(`member-del ${resp.status}: ${await resp.text()}`);
        return res.status(200).json({ ok: true });
      }
      const delDate = String((req.query || {}).date || '');
      if (delDate) {
        if (!DATE_RE.test(delDate)) return res.status(400).json({ error: 'bad-date' });
        const resp = await fetch(`${entriesTable}?date=eq.${encodeURIComponent(delDate)}`, {
          method: 'DELETE', headers: sbHeaders()
        });
        if (!resp.ok) throw new Error(`day-del ${resp.status}: ${await resp.text()}`);
        return res.status(200).json({ ok: true });
      }
      const id = String((req.query || {}).id || '');
      if (!id) return res.status(400).json({ error: 'no-id' });
      const resp = await fetch(`${entriesTable}?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: sbHeaders()
      });
      if (!resp.ok) throw new Error(`delete ${resp.status}: ${await resp.text()}`);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e && e.message || e).slice(0, 300) });
  }
};
