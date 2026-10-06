# 개발자용 안내 — 팀 일정 공유 (Daily Timetable)

팀 전원의 **하루 일정을 세로 시간표 하나**(가로축 = 팀원, 세로축 = 06:00~24:00, 30분 단위)에서
함께 보고 편집하는 도구입니다. 로그인이 없고, 접속한 모두가 같은 데이터를 봅니다.
사용자용 설명은 [README.md](./README.md), 설치 절차는 [SETUP.md](./SETUP.md)에 있습니다.

## 스택 · 구조

| 층 | 내용 |
|---|---|
| 프런트 | **바닐라 JS 단일 파일** `index.html` (빌드 없음, 프레임워크 없음) |
| API | Vercel 서버리스 함수 1개 `api/schedule.js` (Node, 리전 `icn1` — `vercel.json`) |
| DB | Supabase(PostgreSQL) — 서버 함수가 REST(`/rest/v1`)로 접근. **service_role 키는 서버 환경변수에만** |
| 배포 | main 푸시 → Vercel 자동 배포. 환경변수는 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` 두 개가 전부 |
| PWA | `manifest.json` + `sw.js` (HTML은 network-first, 정적 자원 캐시). 화면을 크게 바꾸면 `sw.js`의 `CACHE` 버전을 올릴 것 |
| 라이브러리 | SheetJS 하나, `vendor/xlsx.min.js`로 동봉(엑셀 기능을 쓸 때만 지연 로드). CDN 의존 없음 |

## 데이터 모델 (테이블 2개)

```sql
schedule_members ( id text PK, name text, color text, sort int )
schedule_entries ( id text PK, date text 'YYYY-MM-DD', member_id text,
                   start_min int, end_min int,   -- 자정 기준 분 (09:00 = 540)
                   title text, memo text, created_at timestamptz )
```

- 시간은 전부 **자정 기준 분(int)**, 30분 스냅. 화면 범위는 `DAY_START`(06:00) ~ `DAY_END`(24:00), 칸은 `STEP`(30).
- **공통 일정**: 별도 테이블 없이 같은 (제목·시간·메모)의 행을 사람 수만큼 넣고, 화면이
  `groupKey()`로 묶어 가로 막대로 그린다. ⚠️ `groupKey`의 구분자는 `\x01` 제어문자다.
- **매주 반복 일정**: 테이블을 늘리지 않고 **1900년 첫 주를 요일 슬롯**으로 쓴다 —
  월=`1900-01-01` … 일=`1900-01-07` (1900-01-01이 월요일). 그 날짜들의 행이 곧 반복 규칙이다.
  하루를 열 때 `recurDateFor(date)`로 그 요일의 1900 날짜를 함께 조회해 `expandRecur()`로 펼친다.
  - `member_id = '*'` 는 「전체」 — 화면·캡처에서 노란 배경 띠(`renderRecurBands`)로 그린다
  - 특정 팀원 대상은 그 사람 열의 금색 블록으로 그린다
  - 반복 일정에서 펼친 항목은 `recur`(원본 규칙 id)를 달고 있어 드래그 대신 반복 일정 창을 연다

## API — `/api/schedule` 하나

| 메서드 | 형태 | 동작 |
|---|---|---|
| GET | `?date=YYYY-MM-DD` | 그 날짜의 `{ members, entries }`. 구성원이 0명이면 기본 9명 시드 |
| GET | `?health=1` | 환경변수 설정 여부 진단 |
| POST | `{type:'entry', entry}` | 일정 upsert (`Prefer: resolution=merge-duplicates`) |
| POST | `{type:'entries', entries:[…]}` | 여러 건 upsert (엑셀 업로드) |
| POST | `{type:'member', id, name}` · `{type:'member-add', member}` | 이름 변경 · 팀원 추가 |
| DELETE | `?id=` · `?member=` · `?date=` | 일정 삭제 · 팀원(과 그 일정) 삭제 · 그 날짜 비우기 |

서버는 `normalizeEntry()`로 형식만 검증한다. **인증·권한이 없다** — 주소를 아는 사람은 누구나
읽고 쓸 수 있다는 전제(팀 내부용)이므로, 외부에 주소를 공개하는 용도라면 인증을 붙여야 한다.

## 프런트 주요 동작 (전부 `index.html`)

- **흐름**: `loadDay()` → `state{date, members, entries, recur}` → `render()` / `renderBoard()`(CSS grid).
  오늘 보이는 일정 전부는 `dayEntries()` = 날짜 일정 + 펼친 반복 일정 — 화면·비는시간·캡처가 모두 이것을 본다.
- **겹침**: `layoutOverlaps()`가 겹치는 일정끼리만 클러스터로 묶어 폭을 나눈다. 공통 일정은 `groupBands()` → `renderBands()`.
- **드래그**: pointer 이벤트로 이동·양끝 리사이즈(30분 스냅). 터치는 320ms 길게 누른 뒤에만 시작
  (그 전 움직임은 스크롤로 취급), 드래그 중에는 `touchmove`를 막아 화면이 따라 움직이지 않게 한다.
- **회의 시간 찾기**: `computeFree()` — 고른 참석자의 일정을 30분 칸 boolean 배열에 칠해 빈 구간을 낸다.
- **📷 이미지 복사**: `makeDayImage()`가 화면 캡처 대신 **캔버스에 새로 그린다**(2배 해상도, 하루 전체 06~24시).
  모바일은 Web Share, PC는 Clipboard API, 둘 다 안 되면 파일 저장.
- **엑셀**: SheetJS로 기간 다운로드(`작성방법` 시트 포함)·업로드 파싱. 시간은 `09:00`·`오전 9시`·엑셀 시간 서식을 받는다.
  파일명은 ASCII(`team-schedule_날짜.xlsx`) — 한글 파일명을 `download`로 바꿔 버리는 브라우저가 있다.
- **오프라인·미설정**: 서버 실패 시 최근 14일 캐시를 보기 전용으로 보여 주고, 서버가 아예 설정되지 않았으면
  localStorage 로컬 모드로 돌다가 서버가 연결되면 로컬 데이터 이관을 제안한다.

## 손대는 법

1. 클론 후 `index.html`을 브라우저로 바로 열면 **로컬 모드**로 동작한다 — 서버 없이 화면 개발 가능.
2. 실서버 연동 확인은 Vercel 배포본(또는 `vercel dev`)에서. 테이블 생성 SQL은 `api/schedule.js` 상단 주석에 있다.
3. 단일 파일이라 수정 뒤 `<script>` 문법 검사를 권장 — 예: 스크립트 블록을 뽑아 `new Function(code)`로 파싱.

함께 고려할 규약: 시간 상수(`DAY_START`·`DAY_END`·`STEP`), 반복 일정의 1900 날짜 규칙과 `'*'`,
`groupKey`의 `\x01` 구분자는 서로 물려 있어 하나를 바꾸면 나머지를 함께 확인해야 한다.
