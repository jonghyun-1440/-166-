# 팀 일정 공유 — 설치 안내 (공유받으신 분용)

지인에게 이 프로그램을 소개받으셨나요? 이 문서만 따라 하면 **약 10분** 안에
여러분 팀만의 일정 공유 사이트가 생깁니다. 서버는 전부 **무료**이고,
일정 데이터는 여러분 서버에만 저장되어 다른 팀과 섞이지 않습니다.

**준비물** — 무료 계정 3개 (이미 있다면 그대로 사용):

| 계정 | 역할 |
|---|---|
| [GitHub](https://github.com) | 프로그램 코드 보관 |
| [Supabase](https://supabase.com) | 일정 데이터 저장 (데이터 서버) |
| [Vercel](https://vercel.com) | 사이트 실행 (실행 서버) — GitHub 계정으로 로그인 권장 |

---

## 1단계. Supabase — 데이터 서버 만들기 (5분)

1. [supabase.com](https://supabase.com) 가입 → 조직(Organization) 만들기 화면이 나오면 이름은 아무거나, 요금제 **Free** 그대로
2. **New Project** 클릭
   - Project name: `team-schedule` (아무거나)
   - Database Password: 자동 생성값 사용, **어딘가에 메모**
   - Region: **Northeast Asia (Seoul)** 선택
3. 프로젝트가 준비되면(1~2분) 왼쪽 메뉴 **SQL Editor** → 아래 내용 전체를 붙여넣고 **Run**
   → `Success. No rows returned` 가 나오면 성공

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

4. 두 가지 값을 복사해 둡니다:
   - **Project URL**: 왼쪽 아래 ⚙️ Project Settings → **General**(또는 Data API)에서 `https://xxxx.supabase.co` 형태 주소
   - **Secret key**: ⚙️ Project Settings → **API Keys** → 아래쪽 **Secret keys**의 default 키 (눈 아이콘으로 표시 후 복사, `sb_secret_...`로 시작)
   - ⚠️ Secret key는 비밀번호와 같습니다. 채팅방 등에 붙여넣지 마세요.
   - 화면에 Secret keys가 없고 **Legacy anon, service_role API keys** 탭이 있다면 그 탭의 `service_role` 키를 쓰면 됩니다.

## 2단계. Vercel — 사이트 배포 (3분)

1. 저장소 첫 화면(README)의 **"Deploy with Vercel"** 버튼 클릭
2. GitHub 계정으로 로그인 → 저장소 이름 그대로 **Create** (프로그램이 본인 GitHub 계정으로 복사됩니다)
3. 환경변수 입력 칸이 나오면 1단계에서 복사한 값을 붙여넣기:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_KEY` = Secret key
4. **Deploy** 클릭 → 1~2분 뒤 완료 화면에서 사이트 주소가 나옵니다

접속해서 오른쪽 위에 **"팀 공유 중"** 이라고 표시되면 완성입니다.
"오프라인 모드"라고 나오면 화면의 노란 배너가 원인을 알려줍니다 (대부분 환경변수 이름 오타 → 수정 후 Vercel에서 Redeploy).

## 3단계. 팀 설정 (2분)

- 표 맨 위의 "팀원 1~9" 이름을 클릭해 실제 이름으로 변경 (오른쪽 끝 ＋로 인원 추가, 이름 창의 "팀원 제거"로 삭제)
- 사이트 주소를 팀원들에게 공유
- 각자 폰 **홈 화면에 앱으로 설치**하면 편합니다:
  - 아이폰: **Safari**로 접속 → 공유 버튼 → "홈 화면에 추가"
  - 안드로이드: Chrome → ⋮ → "앱 설치"

---

## 주소(도메인) 설정

- 기본 주소(`xxx.vercel.app`)를 그대로 써도 아무 문제 없습니다.
- **주소 이름만 바꾸기**: Vercel 프로젝트 → **Settings → Domains** → 기존 `xxx.vercel.app` 옆 Edit → 원하는 이름으로 (예: `ourteam-schedule.vercel.app`)
- **보유한 도메인 연결하기** (예: `schedule.우리회사.com`): 같은 Domains 화면에 도메인 입력 → Vercel이 알려주는 DNS 값(A 레코드 또는 CNAME)을 도메인 구입처(가비아·후이즈 등) 관리 페이지에 등록 → 몇 분 뒤 자동으로 연결 + HTTPS 적용

## 주요 기능 요약

| 기능 | 방법 |
|---|---|
| 일정 등록 | 본인 열의 빈 칸 클릭 |
| 일정 수정/삭제 | 일정 블록 클릭 |
| 시간 옮기기 | 블록 드래그 (폰은 **길게 누른 뒤** 드래그) / 위·아래 가장자리 끌면 시간 조절 |
| 전체 공통 일정 | 상단 "📌 전체 일정 추가" — 전원 칸에 하나의 막대로 표시 |
| 회의 시간 찾기 | 상단 버튼 → 모두 비는 시간이 초록색으로 → 클릭하면 전원 회의 등록 |
| 일정표 공유 | 상단 "📷 복사" → 이미지로 복사/공유 (카톡·텔레그램 붙여넣기) |
| 엑셀 | 상단 "📊 엑셀" → 내려받기 / 같은 양식으로 일괄 등록 |
| 날짜 이동 | ◀ ▶ 버튼 또는 날짜 클릭 |

## 클로드(Claude)와 함께 쓰기

배포 버튼을 누르는 순간 프로그램 코드 전체가 **본인 GitHub 저장소**로 복사됩니다.
즉, 이 프로그램은 이제 여러분 것이라 마음대로 고칠 수 있습니다 — 클로드에게 부탁하면 됩니다.

1. [claude.ai](https://claude.ai) 또는 Claude Code에서 GitHub 연동을 켜고 본인의 `team-schedule` 저장소를 선택
2. 원하는 것을 말로 요청 — 예시:
   - "일정표 시간 범위를 06~22시에서 07~23시로 바꿔줘"
   - "점심시간 표시를 11:30~12:30으로 바꿔줘"
   - "사이트 제목을 ○○팀 일정표로 바꿔줘"
   - "토요일·일요일 날짜는 빨간색으로 표시해줘"
   - "'오프라인 모드'라고 떠서 공유가 안 돼. 화면 캡처 줄게" (문제 해결도 가능)
3. 클로드가 main 브랜치에 수정 내용을 올리면 Vercel이 **1~2분 안에 자동으로 사이트에 반영**합니다

## 자주 묻는 문제

| 증상 | 해결 |
|---|---|
| "오프라인 모드 (이 브라우저에만 저장)" | 노란 배너의 안내 확인 — 환경변수 이름(`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) 오타가 대부분. 고친 뒤 Vercel → Deployments → Redeploy |
| 배너에 "테이블 생성 SQL을 아직 실행하지 않은 것 같습니다" | 1단계 3번의 SQL을 Supabase SQL Editor에서 실행 |
| 팀원이 올린 일정이 안 보임 | 30초 기다리거나 새로고침. 계속 안 되면 둘 다 "팀 공유 중" 상태인지 확인 |
| 아이폰에서 앱 설치가 안 보임 | 크롬이 아닌 **Safari**로 접속해야 "홈 화면에 추가"가 나옵니다 |
