# 개발자용 안내 — 팀 일정 공유 (Daily Timetable)

팀 전원의 **하루 일정을 세로 시간표 하나**(가로축 = 팀원, 세로축 = 06:00~24:00, 30분 단위)에서
함께 보고 편집하는 도구입니다. 개인 계정은 없고, (선택) **기수 로그인** — 지역·기수를 고르고
4자리 비밀번호로 들어가며 기수마다 데이터가 분리됩니다. 기수 표가 없으면 로그인 없이 하나의 일정표로 동작합니다.
사용자용 설명은 [README.md](./README.md), 설치 절차는 [SETUP.md](./SETUP.md)에 있습니다.

## 스택 · 구조

| 층 | 내용 |
|---|---|
| 프런트 | **바닐라 JS 단일 파일** `index.html` (빌드 없음, 프레임워크 없음) |
| API | Vercel 서버리스 함수 1개 `api/schedule.js` (Node, 리전 `icn1` — `vercel.json`) |
| DB | Supabase(PostgreSQL) — 서버 함수가 REST(`/rest/v1`)로 접근. **service_role 키는 서버 환경변수에만** |
| 배포 | main 푸시 → Vercel 자동 배포. 필수 환경변수 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` / 선택 `ADMIN_PIN`, `SESSION_SECRET`, `COHORT_REGIONS` |
| PWA | `manifest.json` + `sw.js` (HTML은 network-first, 정적 자원 캐시). 화면을 크게 바꾸면 `sw.js`의 `CACHE` 버전을 올릴 것 |
| 라이브러리 | SheetJS 하나, `vendor/xlsx.min.js`로 동봉(엑셀 기능을 쓸 때만 지연 로드). CDN 의존 없음 |

## 데이터 모델 (테이블 2개 + 기수 표)

```sql
schedule_members ( id text PK, name text, color text, sort int )
schedule_entries ( id text PK, date text 'YYYY-MM-DD', member_id text,
                   start_min int, end_min int,   -- 자정 기준 분 (09:00 = 540)
                   title text, memo text, created_at timestamptz )
-- 기수 로그인(선택): 아래 표가 있으면 「기수 모드」
schedule_cohorts ( id text PK 'musil-166', region text, num int, pin_hash text 'salt:scrypt',
                   fail_count int, locked_until timestamptz, unique(region, num) )
-- 기수 모드에서는 두 표에 cohort_id text 열이 붙고, 모든 조회·수정·삭제가 이 열로 한정된다
```

- **기수 모드 판별**: 서버가 `schedule_cohorts`를 조회해 보고(인스턴스마다 60초 캐시) 있으면 기수 모드.
- **출입증**: 로그인 성공 시 HMAC 서명 토큰(`{c: 기수id, v: 비밀번호 지문, e: 만료}`, 30일)을 주고,
  프런트는 `localStorage['mlk-sched-auth']`에 두고 모든 요청에 `X-Cohort-Token` 헤더로 보낸다(`apiFetch`).
  비밀번호를 바꾸면 지문(v)이 달라져 예전 토큰은 401 `{error:'auth', reason:'pin-changed'}` → 입장 화면.
- **잠금**: 비밀번호를 확인하기 전에 `reserveAttempt()`가 `fail_count`를 조건부 PATCH(`fail_count=eq.현재값`)로 올려
  시도 한 번을 예약한다 — 동시 요청으로 횟수를 건너뛸 수 없다. 5의 배수째에 `locked_until`(60초), 맞히면 0.
  관리자 재설정은 숨은 줄 `__admin`(기수 목록에서 제외)으로 사이트 전체 횟수를 세고 5회에 15분 잠근다.
- **기수 격리**: 일정 저장 전 같은 id가 다른 기수에 있으면 409 `id-taken`(남의 일정 덮어쓰기 방지).
  기수 표 확인이 404가 아닌 오류면 종전 모드로 넘어가지 않고 오류를 낸다.

- 시간은 전부 **자정 기준 분(int)**, 30분 스냅. 화면 범위는 `DAY_START`(06:00) ~ `DAY_END`(24:00), 칸은 `STEP`(30).
- **공통 일정**: 별도 테이블 없이 같은 (제목·시간·메모)의 행을 사람 수만큼 넣고, 화면이
  `groupKey()`로 묶어 가로 막대로 그린다. ⚠️ `groupKey`의 구분자는 `\x01` 제어문자다.
- **매주 반복 일정**: 테이블을 늘리지 않고 **1900년 첫 주를 요일 슬롯**으로 쓴다 —
  월=`1900-01-01` … 일=`1900-01-07` (1900-01-01이 월요일). 그 날짜들의 행이 곧 반복 규칙이다.
  하루를 열 때 `recurDateFor(date)`로 그 요일의 1900 날짜를 함께 조회해 `expandRecur()`로 펼친다.
  - `member_id = '*'` 는 「전체」 — 화면·캡처에서 노란 배경 띠(`renderRecurBands`)로 그린다
  - 특정 팀원 대상은 그 사람 열의 금색 블록으로 그린다
  - 반복 일정에서 펼친 항목은 `recur`(원본 규칙 id)를 달고 있어 드래그 대신 `openRecurEdit()`로 일정 창(반복 수정 상태)을 연다
  - 반복은 별도 창 없이 일정 창의 「매주 반복」 체크(`#fRepeat`, 요일 `#fDows`)로 만든다. 저장은 요일 × 대상마다 한 행,
    대상을 모두 고르면 `'*'` 한 행. 한 「규칙」 = 같은 제목·시간이면서 반복 요일 집합이 같은 대상들(`editingRecur`)

## API — `/api/schedule` 하나

| 메서드 | 형태 | 동작 |
|---|---|---|
| GET | `?date=YYYY-MM-DD` | 그 날짜의 `{ members, entries }`. 구성원이 0명이면 기본 9명 시드 |
| GET | `?health=1` | 환경변수 설정 여부 진단 |
| POST | `{type:'entry', entry}` | 일정 upsert (`Prefer: resolution=merge-duplicates`) |
| POST | `{type:'entries', entries:[…]}` | 여러 건 upsert (엑셀 업로드) |
| POST | `{type:'member', id, name}` · `{type:'member-add', member}` | 이름 변경 · 팀원 추가 |
| DELETE | `?id=` · `?member=` · `?date=` | 일정 삭제 · 팀원(과 그 일정) 삭제 · 그 날짜 비우기 |
| GET | `?cohorts=1` | `{mode:'legacy'}` 또는 `{mode:'cohort', regions, adminEnabled, cohorts:[{id,name,hasPin}]}` |
| POST | `cohort-create` · `login` · `cohort-setpin` · `admin-reset` | 출입증 없이 가능 — 성공하면 `{token, cohort}` |
| POST | `cohort-pin {pin,newPin}` · `cohort-delete {pin}` | 출입증 + 지금 비밀번호 필요 |

서버는 `normalizeEntry()`로 형식만 검증한다. 종전 모드에는 인증이 없고(주소를 아는 사람은 누구나 읽고 씀),
기수 모드에서는 기수 비밀번호(4자리, 기수 공용)가 유일한 관문이다 — 팀 내부용 수준의 보호다.

## 프런트 주요 동작 (전부 `index.html`)

- **흐름**: `loadDay()` → `state{date, members, entries, recur}` → `render()` / `renderBoard()`(CSS grid).
  오늘 보이는 일정 전부는 `dayEntries()` = 날짜 일정 + 펼친 반복 일정 — 화면·비는시간·캡처가 모두 이것을 본다.
- **겹침**: `layoutOverlaps()`가 겹치는 일정끼리만 클러스터로 묶어 폭을 나눈다. 공통 일정은 `groupBands()` → `renderBands()`.
- **드래그**: pointer 이벤트로 이동·양끝 리사이즈(30분 스냅). 터치는 320ms 길게 누른 뒤에만 시작
  (그 전 움직임은 스크롤로 취급), 드래그 중에는 `touchmove`를 막아 화면이 따라 움직이지 않게 한다.
- **회의 시간 찾기**: `computeFree()` — 고른 참석자의 일정을 30분 칸 boolean 배열에 칠해 빈 구간을 낸다.
- **이미지 복사**: `makeDayImage()`가 화면 캡처 대신 **캔버스에 새로 그린다**(2배 해상도, 하루 전체 06~24시).
  모바일은 Web Share, PC는 Clipboard API, 둘 다 안 되면 파일 저장.
- **엑셀**: SheetJS로 기간 다운로드(`작성방법` 시트 포함)·업로드 파싱. 시간은 `09:00`·`오전 9시`·엑셀 시간 서식을 받는다.
  파일명은 ASCII(`team-schedule_날짜.xlsx`) — 한글 파일명을 `download`로 바꿔 버리는 브라우저가 있다.
- **오프라인·미설정**: 서버 실패 시 최근 14일 캐시를 보기 전용으로 보여 주고, 서버가 아예 설정되지 않았으면
  localStorage 로컬 모드로 돌다가 서버가 연결되면 로컬 데이터 이관을 제안한다.

## 화면 디자인 규칙 (2026-11 개편)

- 색 토큰은 `:root` — 잉크 남색 `--navy-2 #1C3347`(주 버튼·글자), 황동 `--brass #9C7A3C`(오늘·기수·요일 포인트만),
  바탕 `--page #F3F5F6`. 포인트 색은 아껴 쓴다.
- 글꼴: 본문 Noto Sans KR, **날짜·기수 이름·창 제목만 Noto Serif KR**(`--serif`).
- 아이콘은 이모지 대신 `ICONS` + `ico(name)`의 선 아이콘. 상단 버튼은 `.tool`(평소) / `.tool.primary`(전체 일정 추가 하나) / `.on`(켜짐).
  버튼 글자를 바꿀 때는 `setTool(id, icon, label)`을 쓴다. 휴대폰에서는 `.tools`가 4칸 타일 격자가 된다.

## 손대는 법

1. 클론 후 `index.html`을 브라우저로 바로 열면 **로컬 모드**로 동작한다 — 서버 없이 화면 개발 가능.
2. 실서버 연동 확인은 Vercel 배포본(또는 `vercel dev`)에서. 테이블 생성 SQL은 `api/schedule.js` 상단 주석에 있다.
3. 단일 파일이라 수정 뒤 `<script>` 문법 검사를 권장 — 예: 스크립트 블록을 뽑아 `new Function(code)`로 파싱.

함께 고려할 규약: 시간 상수(`DAY_START`·`DAY_END`·`STEP`), 반복 일정의 1900 날짜 규칙과 `'*'`,
`groupKey`의 `\x01` 구분자는 서로 물려 있어 하나를 바꾸면 나머지를 함께 확인해야 한다.
