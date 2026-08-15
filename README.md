# 팀 일정 공유 — 하루 타임테이블

9명이 함께 쓰는 하루 일정 공유 사이트입니다.
06:00~22:00을 30분 단위로 나눈 표에 각자 일정을 등록해 서로 보고,
"회의 시간 찾기"로 모두가 비는 시간에 전원의 회의를 한 번에 잡습니다.

## 처음 공개하기 (약 10분)

### 1단계. 사이트 배포 (Vercel, 무료)

1. [vercel.com](https://vercel.com) 가입 (GitHub 계정으로 로그인)
2. **Add New → Project** → 이 저장소(`team-schedule`) Import
3. 설정 변경 없이 **Deploy** 클릭
4. 배포가 끝나면 `https://team-schedule-xxxx.vercel.app` 같은 주소가 생깁니다

여기까지만 해도 화면은 열리지만, 일정이 **각자 브라우저에만** 저장됩니다.
팀원끼리 서로의 일정을 보려면 2단계가 필요합니다.

### 2단계. 서버 저장 연결 (Supabase, 무료)

1. [supabase.com](https://supabase.com) 가입 → **New Project** (무료 요금제)
2. 프로젝트가 준비되면 좌측 **SQL Editor**에서 아래 SQL을 한 번 실행:

```sql
create table schedule_members (
  id text primary key,
  name text not null,
  color text,
  sort int
);
create table schedule_entries (
  id text primary key,
  date text not null,
  member_id text not null,
  start_min int not null,
  end_min int not null,
  title text not null,
  memo text,
  created_at timestamptz default now()
);
create index schedule_entries_date_idx on schedule_entries (date);
alter table schedule_members enable row level security;
alter table schedule_entries enable row level security;
```

3. **Project Settings → API**에서 두 값을 복사:
   - `Project URL` (예: `https://xxxx.supabase.co`)
   - `service_role` 키 (⚠️ secret — 외부 공개 금지)
4. Vercel 프로젝트 → **Settings → Environment Variables**에 추가:

| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | 위에서 복사한 Project URL |
| `SUPABASE_SERVICE_KEY` | 위에서 복사한 service_role 키 |

5. **Deployments → 최신 배포 → Redeploy**를 눌러 반영

### 확인

사이트에 접속했을 때 상단에 "팀 공유 중"이라고 나오면 성공입니다.
"오프라인 모드" 배너가 보이면 환경변수를 다시 확인하세요.

## 사용 방법

- **일정 등록**: 본인 열의 빈 칸 클릭 → 제목·시간 입력 → 저장. 여러 명을 함께 선택하면 각자의 칸에 같은 일정이 들어갑니다.
- **일정 수정/삭제**: 일정 블록을 클릭. 블록을 **드래그하면 시간대가 이동**하고, 블록의 **위/아래 가장자리를 끌면** 시작/끝 시간이 30분 단위로 조절됩니다.
- **이름 바꾸기**: 표 맨 위의 이름 클릭. 처음에는 "팀원 1~9"로 되어 있습니다.
- **팀원 추가/제거**: 표 오른쪽 끝의 `＋`를 누르면 추가, 이름을 누른 창의 "팀원 제거"로 제거됩니다 (그 사람의 일정도 함께 삭제).
- **전체 일정 추가**: 상단 "📌 전체 일정 추가" 버튼 — 회의뿐 아니라 교육·행사·휴무처럼 모두에게 해당하는 일정을 한 번에 등록합니다.
- **회의 시간 찾기**: 상단 버튼 → 참석자·시간대·최소 시간을 고르면 모두가 비는 시간이 초록색으로 표시되고, 클릭하면 전원의 일정으로 회의가 잡힙니다. (점심 12~13시는 기본 제외)
- **날짜 이동**: 상단 ◀ ▶ 버튼 또는 날짜를 눌러 달력에서 선택.
- 화면은 30초마다, 그리고 탭에 다시 돌아올 때 자동으로 새로고침됩니다.

## 구조

- `index.html` — 타임테이블 화면 (프레임워크 없는 단일 파일)
- `api/schedule.js` — 일정 저장/조회 서버 함수 (Vercel Serverless + Supabase)
- 데이터베이스 키(service_role)는 서버 함수에만 존재하며 방문자에게 노출되지 않습니다.
