// 팀 일정 공유 — 서비스 워커
// 화면(앱 껍데기)은 캐시해 두어 오프라인에서도 열리게 하고,
// 일정 데이터(/api/)는 항상 서버에서 새로 받아온다.

var CACHE = 'team-schedule-v2';
var SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {}); // 일부 파일이 없어도 설치는 계속
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                     // 저장/삭제는 그대로 통과
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;      // 일정 데이터는 항상 서버에서

  // 화면(HTML): 새 버전 우선, 실패하면 캐시 — 배포 후 항상 최신 화면이 뜨게
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('/index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('/index.html').then(function (r) { return r || caches.match('/'); });
      })
    );
    return;
  }

  // 그 외 정적 파일: 캐시 우선 + 뒤에서 갱신
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
