/**
 * VTK Multi-Device Demo 2 Server (Render 배포용)
 * PG502 표준화 검토 시연 — 데모 1의 기기 역할 교체판
 *
 * 구성:
 *  - PC      : VNK (0~9 숫자표시) + QR. π를 받아 VNK를 렌더링(참조용).
 *  - 휴대폰  : VIK (무표시 좌표입력). 사용자가 좌표를 탭하여 제출.
 *  - 서버    : 휴대폰이 보낸 좌표열 C를 π로 역매핑하여 인증 판정.
 *
 * 보안 포인트(데모 1과 대칭):
 *  - 사용자의 입력 좌표는 휴대폰에서만 수집·전송됨 → PC는 클릭 위치를 알지 못함.
 *  - 비밀번호 평문은 통신에 흐르지 않고, 서버는 커밋먼트(해시)만 비교.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.set('trust proxy', true);   // Render 프록시 뒤에서 실제 클라이언트 IP 획득

// ===== QR 피싱(AiTM) 완화: 1회용 nonce + 짧은 TTL =====
const QR_TTL_MS = 1 * 60 * 1000;   // QR 1회용 유효시간(1분)

function clientIpOf(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}
function parseUA(ua) {
  ua = ua || '';
  let os = '알 수 없음';
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = '알 수 없음';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/SamsungBrowser/.test(ua)) br = 'Samsung Internet';
  else if (/OPR\/|Opera/.test(ua)) br = 'Opera';
  else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Firefox\//.test(ua)) br = 'Firefox';
  else if (/Safari\//.test(ua)) br = 'Safari';
  return os + ' · ' + br;
}
// 한국 시·도 (ISO 3166-2:KR 지역코드 → 한국어 명칭). ip-api는 한국어(lang=ko) 미지원이므로 코드로 매핑.
const KR_REGION = {
  '11': '서울특별시', '26': '부산광역시', '27': '대구광역시', '28': '인천광역시',
  '29': '광주광역시', '30': '대전광역시', '31': '울산광역시', '50': '세종특별자치시',
  '41': '경기도', '42': '강원특별자치도', '43': '충청북도', '44': '충청남도',
  '45': '전북특별자치도', '46': '전라남도', '47': '경상북도', '48': '경상남도', '49': '제주특별자치도'
};
// 접속 위치를 { ko, en } 두 언어로 반환 (시·군·구/우편번호까지 최대한 상세하게)
function geoLookup(ip) {
  return new Promise((resolve) => {
    if (!ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/.test(ip)) {
      return resolve({ ko: '로컬/사설망', en: 'Local/Private' });
    }
    const unknown = { ko: '알 수 없음', en: 'Unknown' };
    try {
      const r = http.get('http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=status,country,countryCode,region,regionName,city,district,zip', { timeout: 2500 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.status !== 'success') return resolve(unknown);
            // 시·군·구/동/우편번호까지 최대한 상세하게 (ip-api는 시·군·구를 영문으로만 제공)
            const dedupe = (arr) => arr.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
            const enBase = dedupe([j.district, j.city, j.regionName, j.country]).join(', ') || 'Unknown';
            const en = enBase + (j.zip ? ' (' + j.zip + ')' : '');
            let ko;
            if (j.countryCode === 'KR') {
              const sido = KR_REGION[j.region] || j.regionName || '';
              const detail = dedupe([j.city, j.district]).filter(v => v !== j.regionName);   // 시·군·구/동(영문)
              ko = ('대한민국' + (sido ? ' ' + sido : '') + (detail.length ? ' ' + detail.join(' ') : '')).trim() + (j.zip ? ' (' + j.zip + ')' : '');
            } else {
              ko = en;   // 한국 외 지역은 영문으로 표시
            }
            resolve({ ko: ko || '알 수 없음', en });
          } catch (_) { resolve(unknown); }
        });
      });
      r.on('error', () => resolve(unknown));
      r.on('timeout', () => { r.destroy(); resolve(unknown); });
    } catch (_) { resolve(unknown); }
  });
}

const sessions = new Map();
const users = new Map();

function generateSessionId() { return crypto.randomBytes(8).toString('hex'); }
function generatePi() {
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function generateSalt() { return crypto.randomBytes(16).toString('hex'); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

// 허브(런처) 화면 / 휴대폰 스캔 화면 (기존 '/'·'/m.html' 흐름은 그대로)
app.get('/hub', (req, res) => res.sendFile(path.join(__dirname, 'public', 'hub.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scan.html')));

// 사용자 등록 (시연용)
app.post('/register', (req, res) => {
  const { userId, password, sid } = req.body;
  if (!userId || !/^\d{4,8}$/.test(password)) {
    return res.status(400).json({ error: '잘못된 입력' });
  }
  const salt = generateSalt();
  const commitment = sha256(password + salt);
  users.set(userId, { salt, commitment, password });
  console.log(`[Register] ${userId} commitment=${commitment.substring(0, 12)}...`);
  // 휴대폰에서 등록한 경우: 세션의 사용자와 연결하고 PC에 알림
  if (sid && sessions.has(sid)) {
    const session = sessions.get(sid);
    session.userId = userId;
    io.to(`pc-${sid}`).emit('user-registered', { userId });
  }
  res.json({ ok: true });
});

// PC가 인증 세션 시작 — PC는 VNK(숫자)를 그려야 하므로 π를 수신
app.post('/auth/start', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '사용자 ID 필요' });
  }
  // 등록 전에도 세션(π·QR)을 만들 수 있게 함 (화면 로드 시 QR 자동 표시용)
  const sid = generateSessionId();
  const pi = generatePi();
  const nonce = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const accessInfo = { location: { ko: '조회 중…', en: 'Checking…' }, device: parseUA(req.headers['user-agent']), requestTimeMs: now };
  const geoPromise = geoLookup(clientIpOf(req)).then(loc => { accessInfo.location = loc; return loc; });
  sessions.set(sid, {
    sid, pi, userId,
    mobileConnected: false,
    status: 'waiting_for_mobile',
    createdAt: now,
    nonce, qrExpiresAt: now + QR_TTL_MS, qrUsed: false,
    accessInfo, geoPromise
  });
  const user = users.get(userId);
  console.log(`[AuthStart] session=${sid} userId=${userId}`);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  // PC(VNK)에 π와 (등록된 경우) 비밀번호(강조 표시용) 전달. Channel ①: Server → PC
  res.json({
    sid,
    n: 4,
    pi,
    password: user ? user.password : null, // 시연용: 강조 표시(토글)용
    qrTtlMs: QR_TTL_MS,
    mobileUrl: `${baseUrl}/m.html?s=${sid}&n=${nonce}`
  });
});

// 세션이 아직 서버에 존재하는지 확인 (PC 재연결 시 QR 재발급 판단용)
app.get('/api/session-exists/:sid', (req, res) => {
  res.json({ exists: sessions.has(req.params.sid) });
});

// 휴대폰(VIK) 페어링
// 무표시 입력 패드가 기본이나, 발표자 보조용 "위치 강조"를 휴대폰에서 계산할 수 있도록
// π와 비밀번호(위치 산출용)를 함께 전달한다.
//   ※ 강조는 순수 표시용이며, 실제 인증 전송은 좌표 C만 사용(기존과 동일).
app.get('/api/pair/:sid', async (req, res) => {
  const { sid } = req.params;
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ error: '세션 만료 또는 없음' });
  // 1회용 QR 검증: nonce 일치 + 미사용 (시간 만료는 입력 단계 타이머로 이전 — QR 대기 중엔 만료 안 함)
  if (session.nonce && req.query.n !== session.nonce) return res.status(403).json({ error: 'QR이 유효하지 않습니다' });
  if (session.qrUsed) return res.status(409).json({ error: '이미 사용된 QR입니다' });
  // 1회용 소비는 '확인'(confirm-login) 시점으로 이동 — 페이지 중복 로드(프리페치·인앱브라우저·새로고침)에도 페어링 견고
  session.mobileConnected = true;
  session.status = 'waiting_for_mobile_input';

  // 접속 위치(IP 지오) 조회가 끝날 때까지 잠깐 대기 (최대 2.5초)
  try { await Promise.race([session.geoPromise, new Promise(r => setTimeout(r, 2500))]); } catch (_) {}

  console.log(`[Pair] session=${sid} 휴대폰(VIK) 스캔(확인 대기)`);

  const user = users.get(session.userId);
  // Channel ②: Server → Mobile (격자 형상 + 강조용 π·비밀번호 + 접속정보). mobile-paired는 '확인' 후 발생
  res.json({
    sid,
    n: 4,
    pi: session.pi,                 // 강조 위치 계산용
    password: user ? user.password : null, // 시연용: 위치 강조(토글)용
    accessInfo: session.accessInfo,         // { location, device, requestTimeMs }
    qrTtlMs: QR_TTL_MS                       // '확인' 후 입력 단계에서 시작할 만료 TTL
  });
});

// 휴대폰(VIK)이 좌표 시퀀스 C 제출
app.post('/auth/submit', (req, res) => {
  const { sid, cSequence } = req.body;
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ error: '세션 만료 또는 없음' });

  console.log(`[Submit] session=${sid} C=[${cSequence.join(',')}]`);

  // 인증 성공 후에는 π가 폐기된 상태 → 새 VNK를 받아야 재인증 가능
  if (!session.pi) {
    return res.json({ ok: false, reasonCode: 'stale', reason: '이전 인증이 끝난 VNK입니다 — [VNK 재배치]를 눌러 주세요' });
  }

  const numericIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10];
  const cellLayout = new Array(12).fill(null);
  for (let digit = 0; digit < 10; digit++) {
    cellLayout[numericIndices[session.pi[digit]]] = digit;
  }
  const computedDigits = cSequence.map(cellIdx => cellLayout[cellIdx]);
  if (computedDigits.includes(null) || computedDigits.includes(undefined)) {
    return res.json({ ok: false, reasonCode: 'badCoord', reason: '잘못된 좌표' });
  }
  const enteredPassword = computedDigits.join('');
  const user = users.get(session.userId);
  if (!user) {
    return res.json({ ok: false, reasonCode: 'unregistered', reason: '미등록 — 먼저 등록 및 인증을 진행하세요' });
  }
  const computedCommitment = sha256(enteredPassword + user.salt);
  const success = computedCommitment === user.commitment;

  console.log(`[Submit] D'=${enteredPassword} success=${success}`);

  // 결과를 PC·휴대폰 양쪽에 통보
  io.to(`pc-${sid}`).emit('auth-result', { success });
  io.to(`mobile-${sid}`).emit('auth-result', { success });

  // 성공 시: 사용한 π는 즉시 폐기하고 새 π로 자동 재배치 → 재인증 가능 상태 유지
  if (success) {
    session.pi = generatePi();
    console.log(`[Submit] 인증 성공 → 새 π 자동 재배치`);
    io.to(`pc-${sid}`).emit('pi-updated', { pi: session.pi, auto: true });
    io.to(`mobile-${sid}`).emit('pi-updated', { pi: session.pi, auto: true });
  }
  session.status = success ? 'success' : 'failure';

  res.json({ ok: success, computedPassword: enteredPassword, message: success ? '인증 성공' : '인증 실패' });
});

io.on('connection', (socket) => {
  socket.on('join-pc', ({ sid }) => { socket.join(`pc-${sid}`); if (sid) socket.data.pcSid = sid; if (sid && sessions.has(sid)) sessions.get(sid).createdAt = Date.now(); console.log(`[Socket] PC joined ${sid}`); });
  socket.on('join-mobile', ({ sid }) => { socket.join(`mobile-${sid}`); console.log(`[Socket] Mobile joined ${sid}`); });
  // 허브(디스플레이) ↔ 스캔(휴대폰) 페어링
  //  1) 휴대폰이 허브 QR 스캔 → hub-scanned → 디스플레이를 데모(/?h=)로 전환
  //  2) 디스플레이(데모)가 세션 생성 후 hub-session-ready(mobileUrl) 전송 → 휴대폰을 바로 인증 화면으로 이동(hub-go)
  socket.on('join-hub', ({ hubId }) => { if (hubId) socket.join(`hub-${hubId}`); });
  socket.on('hub-scanned', ({ hubId }) => { if (hubId) { io.to(`hub-${hubId}`).emit('hub-paired'); console.log(`[Hub] 휴대폰 스캔 → 디스플레이(${hubId}) 데모 전환`); } });
  socket.on('hub-session-ready', ({ hubId, mobileUrl }) => { if (hubId && mobileUrl) { io.to(`hub-${hubId}`).emit('hub-go', { mobileUrl }); console.log(`[Hub] 디스플레이 세션 준비 → 휴대폰(${hubId}) 인증 화면 이동`); } });
  // 홈(집) 버튼: 눌린 기기가 요청 → 같은 세션의 PC는 허브 화면으로, 휴대폰은 카메라(재스캔)로 전환
  // 홈(집) 버튼: 데모 재시작 — PC가 새 세션을 만들어 '휴대폰 연결됨' 표시 후, 기존 휴대폰을 새 세션 승인(로그인 요청)화면으로 보냄
  // 홈(집) 버튼: 첫 화면으로 — PC는 허브 런처(/hub), 휴대폰은 '카메라로 스캔' 안내 화면으로
  socket.on('home-hub', ({ sid }) => { if (sid) { io.to(`pc-${sid}`).emit('pc-to-hub'); io.to(`mobile-${sid}`).emit('mobile-to-scan'); console.log(`[Home] 홈 → PC(${sid}) 허브 첫화면 + 휴대폰 스캔 안내`); } });
  // 휴대폰 '확인'(로그인 승인) → PC를 입력 화면으로 전환 (확인 후에만 전환)
  socket.on('confirm-login', ({ sid }) => { if (sid) { const s = sessions.get(sid); if (s) s.qrUsed = true; io.to(`pc-${sid}`).emit('mobile-paired'); } });
  // 휴대폰 '취소' → PC에 새 QR 재발급 신호
  socket.on('cancel-login', ({ sid }) => { if (sid) io.to(`pc-${sid}`).emit('renew-session'); });
  // 휴대폰 '새 세션(QR 재발급)' 요청 → 해당 세션의 PC에 재발급 신호
  socket.on('request-new-session', ({ sid }) => {
    if (sid) {
      io.to(`pc-${sid}`).emit('renew-session');
      console.log(`[Socket] 휴대폰 새 세션 요청 → PC(${sid})에 renew-session`);
    }
  });
  // PC 세션 keepalive → 열려 있는 세션이 만료되지 않도록 createdAt 갱신
  socket.on('session-keepalive', ({ sid }) => {
    if (sid && sessions.has(sid)) sessions.get(sid).createdAt = Date.now();
  });
  // 휴대폰(VIK) 첫 입력 → 해당 세션의 PC에 전달 (PC 자동 복귀 타이머 해제용)
  socket.on('mobile-input', ({ sid }) => {
    if (sid) io.to(`pc-${sid}`).emit('mobile-input');
  });
  // PC 자동 복귀(1분 무입력) → 기존 세션의 휴대폰에 '세션 종료, 재스캔' 안내 전달
  socket.on('session-expired', ({ sid }) => {
    if (sid) io.to(`mobile-${sid}`).emit('session-expired');
  });
  // KO/EN 언어 전환 → 같은 세션의 PC·휴대폰 양쪽에 전달 (어느 쪽에서 눌러도 동시 전환)
  socket.on('set-lang', ({ sid, lang }) => {
    if (sid && (lang === 'ko' || lang === 'en')) {
      io.to(`pc-${sid}`).emit('set-lang', { lang });
      io.to(`mobile-${sid}`).emit('set-lang', { lang });
    }
  });
  // PC 연결 종료(새로고침·창 닫기·네트워크 종료) → 2초 후에도 PC가 그 세션으로 복귀하지 않으면
  // 해당 세션의 휴대폰을 '세션 종료 → 카메라(재스캔)' 모드로 전환 (일시적 끊김에는 반응하지 않음)
  socket.on('disconnect', () => {
    const psid = socket.data && socket.data.pcSid;
    if (!psid) return;
    setTimeout(() => {
      const room = io.sockets.adapter.rooms.get(`pc-${psid}`);
      if (!room || room.size === 0) {
        io.to(`mobile-${psid}`).emit('session-expired');
        console.log(`[Socket] PC 연결 종료 → 휴대폰(${psid}) 재스캔(카메라) 전환`);
      }
    }, 2000);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions.entries()) {
    if (now - session.createdAt > 12 * 60 * 60 * 1000) {
      sessions.delete(sid);
      console.log(`[Cleanup] 세션 만료: ${sid}`);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║  VTK Multi-Device Demo 2 Server           ║`);
  console.log(`║  PC=VNK(숫자) / 휴대폰=VIK(무표시) ║`);
  console.log(`╚═══════════════════════════════════════════╝`);
  console.log(`Port: ${PORT}`);
});
