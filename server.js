/**
 * VTK Multi-Device Demo Server (Render 배포용 v2)
 * PG502 표준화 검토 시연
 *
 * 핵심 설계:
 *  - QR 코드에는 짧은 세션 ID(16자)만 포함 → 아이폰 카메라 안정 인식
 *  - π·비밀번호 등 모든 데이터는 서버에 저장, 모바일이 세션 ID로 서버에서 직접 수신
 *  - Socket.IO로 PC·모바일 실시간 동기화
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== 메모리 저장소 =====
const sessions = new Map(); // 활성 인증 세션
const users = new Map();    // 등록된 사용자

// ===== 헬퍼 함수 =====
function generateSessionId() {
  return crypto.randomBytes(8).toString('hex'); // 16자
}

function generatePi() {
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ===== REST API =====

// 헬스 체크 (Render 슬립 모드 감지용)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 사용자 등록 (시연용) — 데모1 4단계: 등록을 휴대폰에서 수행
app.post('/register', (req, res) => {
  const { userId, password, sid } = req.body;
  if (!userId || !/^\d{4,8}$/.test(password)) {
    return res.status(400).json({ error: '잘못된 입력' });
  }
  const salt = generateSalt();
  const commitment = sha256(password + salt);
  // 시연 단순화를 위해 평문도 보관 (휴대폰 VNK에서 비밀번호 위치 강조용)
  users.set(userId, { salt, commitment, password });
  console.log(`[Register] ${userId} commitment=${commitment.substring(0, 12)}...`);
  // 휴대폰에서 등록한 경우: 세션과 사용자 연결 후 PC에 통보 → PC 키패드 활성화
  if (sid && sessions.has(sid)) {
    const session = sessions.get(sid);
    session.userId = userId;
    session.status = 'waiting_for_pc_input';
    io.to(`pc-${sid}`).emit('user-registered', { userId });
  }
  res.json({ ok: true });
});

// PC가 인증 세션 시작 — 등록 전에도 세션(π·QR)을 만들 수 있음 (등록은 휴대폰에서)
app.post('/auth/start', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '사용자 ID 필요' });
  }
  const sid = generateSessionId();
  const pi = generatePi();
  sessions.set(sid, {
    sid, pi, userId,
    mobileConnected: false,
    status: 'waiting_for_registration',
    createdAt: Date.now()
  });
  console.log(`[AuthStart] session=${sid} userId=${userId} (등록 대기)`);
  // PC에는 세션 ID와 모바일 페어링 URL만 반환 (π는 PC로 보내지 않음)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    sid,
    n: 4,
    mobileUrl: `${baseUrl}/m.html?s=${sid}`
  });
});

// 모바일이 세션 페어링하여 π 수신
app.get('/api/pair/:sid', (req, res) => {
  const { sid } = req.params;
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ error: '세션 만료 또는 없음' });
  const user = users.get(session.userId);   // 아직 등록 전이면 null 가능

  session.mobileConnected = true;

  // PC에 모바일 페어링 완료 통보 (실제 등록은 이후 휴대폰에서)
  io.to(`pc-${sid}`).emit('mobile-paired');
  console.log(`[Pair] session=${sid} 모바일 연결됨`);

  // 모바일에 π 전달 (Channel ①). 비밀번호는 등록 전이면 null
  res.json({
    sid,
    pi: session.pi,
    password: user ? user.password : null, // 시연용: 비밀번호 위치 강조
    registered: !!user,
    n: 4
  });
});

// PC가 좌표 시퀀스 C 제출
app.post('/auth/submit', (req, res) => {
  const { sid, cSequence } = req.body;
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ error: '세션 만료 또는 없음' });

  console.log(`[Submit] session=${sid} C=[${cSequence.join(',')}]`);

  // 이미 폐기된 VNK(π 없음)로 들어온 제출 방어 — [VNK 재배치]로 새 π 요청 유도
  if (!session.pi) {
    return res.json({ ok: false, reason: '이전 인증이 끝난 VNK입니다 — [VNK 재배치]를 눌러 새 배치를 받으세요' });
  }

  // 키패드 layout: [1,2,3,4,5,6,7,8,9,_,0,_]
  const numericIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10];

  // π를 통해 셔플된 cellLayout 재구성
  const cellLayout = new Array(12).fill(null);
  for (let digit = 0; digit < 10; digit++) {
    const cellIdx = numericIndices[session.pi[digit]];
    cellLayout[cellIdx] = digit;
  }

  // 사용자가 클릭한 셀들에 표시된 숫자 복원
  const computedDigits = cSequence.map(cellIdx => cellLayout[cellIdx]);
  if (computedDigits.includes(null) || computedDigits.includes(undefined)) {
    return res.json({ ok: false, reason: '잘못된 좌표' });
  }
  const enteredPassword = computedDigits.join('');

  // 커밋먼트 비교
  const user = users.get(session.userId);
  if (!user) {
    return res.json({ ok: false, reason: '미등록 — 휴대폰에서 비밀번호를 먼저 등록하세요' });
  }
  const computedCommitment = sha256(enteredPassword + user.salt);
  const success = computedCommitment === user.commitment;

  console.log(`[Submit] D'=${enteredPassword} success=${success}`);

  // 모바일에 결과 통보
  io.to(`mobile-${sid}`).emit('auth-result', { success });

  if (success) {
    // 인증 성공 → 사용한 π 폐기하고 즉시 새 π로 자동 재배치 (데모2 방식)
    // π는 휴대폰(VNK)에만 실시간 전송, PC(VIK)에는 보내지 않음 → 데모1 원칙 유지
    session.pi = generatePi();
    console.log(`[Submit] 인증 성공 → 새 π 자동 재배치`);
    io.to(`mobile-${sid}`).emit('pi-updated', { pi: session.pi, auto: true });
  }
  // 실패 시엔 π를 유지 → 같은 배치로 재시도 가능
  session.status = success ? 'success' : 'failure';

  res.json({
    ok: success,
    computedPassword: enteredPassword,
    message: success ? '인증 성공' : '인증 실패'
  });
});

// 수동 재배치 (VNK 재배치 버튼) — 같은 세션 유지, 새 π만 생성해 휴대폰에 전송
app.post('/auth/reshuffle', (req, res) => {
  const { sid } = req.body;
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ error: '세션 만료 또는 없음' });
  const user = users.get(session.userId);
  if (!user) return res.status(404).json({ error: '사용자 정보 없음' });

  session.pi = generatePi();
  session.status = 'waiting_for_pc_input';
  console.log(`[Reshuffle] session=${sid} 수동 재배치 — 새 π 생성`);

  // 새 π는 휴대폰(VNK)에만 전송 (auto 플래그 없음 → 수동 재배치 로그)
  io.to(`mobile-${sid}`).emit('pi-updated', { pi: session.pi });
  // PC에는 π를 보내지 않되, 입력 초기화를 위해 재배치 발생만 통보
  io.to(`pc-${sid}`).emit('reshuffled');

  res.json({ ok: true });
});

// ===== Socket.IO 실시간 동기화 =====
io.on('connection', (socket) => {
  socket.on('join-pc', ({ sid }) => {
    socket.join(`pc-${sid}`);
    console.log(`[Socket] PC joined ${sid}`);
  });
  socket.on('join-mobile', ({ sid }) => {
    socket.join(`mobile-${sid}`);
    console.log(`[Socket] Mobile joined ${sid}`);
  });
  // 휴대폰 '새 세션(QR 재발급)' 요청 → 해당 세션의 PC에 재발급 신호
  socket.on('request-new-session', ({ sid }) => {
    if (sid) {
      io.to(`pc-${sid}`).emit('renew-session');
      console.log(`[Socket] 휴대폰 새 세션 요청 → PC(${sid})에 renew-session`);
    }
  });
});

// 정리: 30분 이상 미사용 세션 자동 삭제
setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions.entries()) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      sessions.delete(sid);
      console.log(`[Cleanup] 세션 만료: ${sid}`);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║  VTK Multi-Device Demo Server             ║`);
  console.log(`║  PG502 표준화 검토 시연                   ║`);
  console.log(`╚═══════════════════════════════════════════╝`);
  console.log(`Port: ${PORT}`);
  console.log(`PC URL:     http://localhost:${PORT}/`);
  console.log(`Mobile URL: http://localhost:${PORT}/m.html?s=<session>`);
});
