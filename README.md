# VTK 데모 1 — GitHub → Render 배포

구성: PC = 키패드 A(무표시 좌표입력) + QR / 휴대폰 = 키패드 B(숫자표시, 강조 토글)

폴더 구조 (저장소 루트에 그대로 위치해야 함):
```
package.json
server.js
public/
  index.html   (PC)
  m.html       (휴대폰)
.gitignore
```

## 1. 로컬에서 Git 초기화 & 커밋
```bash
cd vtk-demo1-fixed
git init
git add .
git commit -m "VTK Demo 1: PC=Keypad A, Phone=Keypad B"
git branch -M main
```

## 2. GitHub 새 저장소 생성 후 연결
GitHub에서 New repository → 이름 예: `vtk-demo1` (기존 데모와 다른 이름) → 빈 저장소로 생성.
```bash
git remote add origin https://github.com/<사용자명>/vtk-demo1.git
git push -u origin main
```

## 3. Render에서 새 Web Service 생성
1. dashboard.render.com → **New** → **Web Service**
2. **방금 만든 `vtk-demo1` 저장소** 연결 (기존 데모 저장소와 혼동 금지)
3. 설정:
   - Name: `vtk-demo1` (→ URL `https://vtk-demo1.onrender.com`)
   - Language: **Node**
   - Branch: `main`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. **Create Web Service** → 빌드·배포 자동 진행

포트는 `process.env.PORT`로 자동 처리됨(코드 반영 완료). 환경변수 불필요.

## 4. 배포 후
- 발급된 `https://vtk-demo1.onrender.com` 을 PC에서 열고, QR을 휴대폰으로 스캔하여 시연.
- 이후 `git push` 할 때마다 자동 재배포됨.

## 주의
- **무료 플랜 콜드스타트**: 약 15분 미사용 시 슬립 → 첫 접속에 ~30초 지연. 발표 직전 URL을 한 번 열어 깨워둘 것.
- **QR 외부 의존**: QR을 외부 서비스(api.qrserver.com)로 생성하므로 발표장 네트워크가 막히면 QR이 안 뜰 수 있음(대체 URL 표시 기능 있음). 자체 생성으로 바꾸려면 별도 요청.
- 기존 데모와 **저장소·서비스 이름·URL이 모두 분리**되어 서로 영향 없음.
