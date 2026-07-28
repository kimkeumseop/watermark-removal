# 워터마크 제거 웹사이트 — 빌드 지침서 (CLI용)

> 이 문서는 코딩 에이전트(CLI)에게 그대로 시키기 위한 실행 지침서입니다.
> **아래 "검증된 사실" 섹션의 함정들을 반드시 지키세요. 이미 실제 브라우저에서 테스트로 확인한 내용입니다.**

---

## 0. 목표 한 줄 요약

영상을 올리고 → 화면에서 **드래그로 워터마크 영역을 선택**하면 → **브라우저 안에서(ffmpeg.wasm)** 그 부분을
`delogo` 필터로 제거해 다운로드하는 **정적 웹사이트**. 서버 없음, 무료 호스팅, 영상은 사용자 브라우저 밖으로 나가지 않음. 일반 공개 서비스용.

- **처리 방식**: 100% 클라이언트 사이드 (ffmpeg.wasm, 단일 스레드 코어)
- **호스팅**: 정적 사이트 (Netlify / Vercel / GitHub Pages 중 아무거나, 무료 티어)
- **백엔드 없음**, 빌드 툴체인 없음 (순수 HTML/CSS/JS + vendor 폴더)

기존 로컬 버전(`D:\mannai\watermark-remover`, Flask+네이티브 ffmpeg)의 **UI/UX를 그대로** 웹으로 옮기는 작업입니다. 그 폴더의 `templates/index.html`에 있는 드래그 선택 로직을 참고하되, 처리부만 서버 호출 → ffmpeg.wasm 호출로 바꿉니다.

---

## 1. ⚠️ 검증된 사실 (반드시 지킬 것 — 이미 실측함)

이 프로젝트의 핵심 리스크는 전부 실제 브라우저에서 테스트해 확인했습니다. 재발견하려고 시간 낭비하지 마세요.

1. **`delogo` 필터는 ffmpeg.wasm 단일스레드 코어(`@ffmpeg/core@0.12.6`)에 존재하고 정상 작동한다.**
   `-vf delogo=...` + `libx264` 재인코딩까지 브라우저에서 성공 확인함.

2. **CDN(unpkg/esm.sh)에서 `@ffmpeg/ffmpeg`를 직접 import 하면 실패한다.**
   → `SecurityError: Failed to construct 'Worker' ... cannot be accessed from origin`.
   ffmpeg.wasm은 내부적으로 **Web Worker**를 쓰는데, 교차 출처(cross-origin) Worker는 브라우저가 막는다.
   **해결책 = 모든 ffmpeg 파일을 사이트에 직접 포함(vendoring)하여 같은 출처에서 로드한다.**
   → 이 함정 때문에 vendor 파일을 이미 받아서 `./vendor/`에 넣어두었다. **다시 받지 말고 그대로 써라.**

3. **`vendor/` 폴더에 이미 준비된 파일 (그대로 사용):**
   - `vendor/ffmpeg.js` — `@ffmpeg/ffmpeg@0.12.10` UMD. 전역 `FFmpegWASM.FFmpeg` 노출.
   - `vendor/814.ffmpeg.js` — Worker 청크. **반드시 `ffmpeg.js`와 같은 폴더에 있어야 한다** (ffmpeg.js가 자기 옆의 `814.ffmpeg.js`를 Worker로 자동 로드함). 이름/위치 바꾸지 말 것.
   - `vendor/util.js` — `@ffmpeg/util@0.12.1` UMD. 전역 `FFmpegUtil.{toBlobURL, fetchFile}` 노출.
   - `vendor/ffmpeg-core.js` — 코어 로더 (약 115KB).
   - `vendor/ffmpeg-core.wasm` — **약 31MB**. 이게 첫 로드 용량의 대부분. (호스팅 시 Git LFS 또는 그냥 정적 파일로 올림)

4. **단일 스레드 코어를 쓰므로 `SharedArrayBuffer`가 필요 없다 → COOP/COEP 특수 헤더가 필요 없다.**
   덕분에 **아무 정적 호스트에나 그냥 올려도 된다.** (멀티스레드 코어는 헤더가 필요해서 일부러 안 씀. 4번 "선택 업그레이드" 참고)

5. **로드 코드 패턴 (이대로 쓰면 됨, 실측 통과):**
   ```html
   <script src="vendor/util.js"></script>
   <script src="vendor/ffmpeg.js"></script>
   <script>
   const { FFmpeg } = FFmpegWASM;
   const { toBlobURL, fetchFile } = FFmpegUtil;
   const ffmpeg = new FFmpeg();
   ffmpeg.on('log', ({ message }) => console.log(message));
   ffmpeg.on('progress', ({ progress }) => { /* progress: 0~1 */ });
   await ffmpeg.load({
     coreURL: await toBlobURL('vendor/ffmpeg-core.js', 'text/javascript'),
     wasmURL: await toBlobURL('vendor/ffmpeg-core.wasm', 'application/wasm'),
   });
   // classWorkerURL 은 지정하지 말 것 — 지정 안 하면 vendor/814.ffmpeg.js 를 같은 출처에서 자동 로드함
   ```

6. **처리 명령 패턴 (여러 영역 = delogo 체이닝):**
   ```js
   // regions: [{x,y,w,h}, ...]  ← 영상 "실제 픽셀" 좌표
   const vf = regions.map(r => `delogo=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}`).join(',');
   await ffmpeg.writeFile('input.mp4', await fetchFile(file));
   await ffmpeg.exec(['-i','input.mp4','-vf',vf,'-pix_fmt','yuv420p','-preset','veryfast','output.mp4']);
   const data = await ffmpeg.readFile('output.mp4'); // Uint8Array
   const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
   ```
   - 로그 끝에 `Aborted()`가 찍혀도 **정상**이다 (wasm 프로세스 종료 메시지). 판정은 `readFile` 결과 바이트 길이 > 0 로 한다.

7. **좌표 변환 (가장 흔한 버그 지점):** 사용자는 화면에 표시된 `<video>` 위를 드래그한다. 화면 좌표를 **영상 실제 픽셀 좌표**로 변환해야 delogo가 맞는 위치에 적용된다.
   ```js
   const box = overlay.getBoundingClientRect();
   const scaleX = video.videoWidth  / box.width;   // videoWidth = 실제 픽셀 폭
   const scaleY = video.videoHeight / box.height;
   const region = { x: Math.round(dx*scaleX), y: Math.round(dy*scaleY),
                    w: Math.round(dw*scaleX), h: Math.round(dh*scaleY) };
   ```

8. **delogo 좌표 제약**: 영역은 프레임 안쪽에 있어야 한다. 저장 전에 클램프:
   `x=max(1,x)`, `y=max(1,y)`, `x+w ≤ videoWidth-1`, `y+h ≤ videoHeight-1`, `w≥1, h≥1`.

---

## 2. 만들 파일 구조

```
watermark-web/
├─ index.html          ← 만들 것 (메인 UI)
├─ app.js              ← 만들 것 (드래그 선택 + ffmpeg.wasm 처리)
├─ styles.css          ← 만들 것 (또는 index.html에 인라인)
├─ vendor/             ← 이미 있음. 건드리지 말 것.
│   ├─ ffmpeg.js
│   ├─ 814.ffmpeg.js
│   ├─ util.js
│   ├─ ffmpeg-core.js
│   └─ ffmpeg-core.wasm  (~31MB)
├─ netlify.toml        ← 만들 것 (배포용, 아래 5번)
├─ _headers            ← 만들 것 (아래 5번)
└─ README.md           ← 만들 것 (사용/배포 설명)
```

---

## 3. UI 사양 (기존 로컬 버전과 동일한 UX)

참고 원본: `D:\mannai\watermark-remover\templates\index.html` (드래그 선택 로직 재사용).

**화면 흐름**
1. **업로드 영역**: 큰 드래그&드롭 존 + "클릭해서 선택". `accept="video/*"`. 선택 시 `URL.createObjectURL(file)`로 `<video>`에 미리보기.
2. **편집 화면**:
   - `<video controls>` + 그 위에 절대배치된 `.overlay` (커서 crosshair).
   - 마우스/포인터 드래그로 **사각형 여러 개** 그림. 각 사각형에 삭제(✕) 버튼.
   - `pointerdown/move/up` 사용 (마우스·터치 겸용). 6px 미만 드래그는 무시.
   - 창 리사이즈/영상 메타로드 시 사각형 다시 그림(`renderRects`).
   - 버튼: **[워터마크 제거]**, [영역 모두 지우기], [다른 영상].
   - 선택 영역 개수 표시. 영역 0개면 제거 버튼 비활성.
3. **처리 중**: 스피너 + **진행률**(`ffmpeg.on('progress')`의 0~1을 %로) + "브라우저에서 처리 중, 창을 닫지 마세요" 안내.
4. **완료**: 결과 `<video>` 미리보기 + **[결과 다운로드]** 링크(`download` 속성, blob URL).

**디자인 시스템** (글로벌 규칙 준수):
- 스페이싱 4px 배수, 카드 패딩 p-6~8, 버튼 py-4 px-6.
- radius: 인풋 `rounded-xl`, 버튼 `rounded-2xl`/`rounded-full`, 카드 `rounded-[2rem]`.
- 깊이는 그림자 위주 + 저채도 브랜드 glow. border는 1px 보조.
- 헤딩/라벨 `font-black`, 카드제목 `font-bold`, 본문 `font-medium`.
- 버튼 hover `scale-1.02` + 그림자 한 단계, active `scale-0.98`.
- 진입 애니메이션 opacity/translateY, 0.45~0.55s easeOut.
- 브랜드 컬러는 인디고 계열(예 `#6366f1`) 기본, 밝은 배경. 다크/라이트 둘 다 신경 쓸 필요는 없고 하나로 통일해도 됨(단, 영상이 잘 보이게 편집화면 스테이지는 어둡게 권장).
- Tailwind CDN 써도 되고(정적 사이트라 무방), 순수 CSS로 해도 됨. **단 ffmpeg vendor는 절대 CDN 금지(1번 함정).**

---

## 4. 처리 로직 사양 (app.js 핵심)

- 상태: `{ file, videoW, videoH, regions: [] }`.
- ffmpeg 인스턴스는 **최초 1회만 `load()`** (로드에 수 초 + 31MB). 페이지 진입 시 백그라운드 프리로드하고, 로딩 진행 표시하면 UX 좋음.
- [워터마크 제거] 클릭 시:
  1. `regions`(화면좌표)를 실제 픽셀좌표로 변환 + 클램프(1번-7,8).
  2. `vf` 문자열 delogo 체이닝 생성.
  3. `writeFile('input.<ext>')` → `exec(['-i', ...,'-vf',vf,'-pix_fmt','yuv420p','-preset','veryfast','output.mp4'])`.
  4. `readFile('output.mp4')` → blob → 다운로드 링크 + 미리보기.
  5. 다음 처리를 위해 `deleteFile`로 input/output 정리(선택).
- **오디오**: delogo는 영상만 바꾸므로 오디오는 자동으로 재먹싱된다. 문제 생기면 `-c:a copy` 추가.
- **입력 확장자**: mp4/mov/webm 등. 출력은 mp4(H.264)로 통일.
- **에러 처리**: readFile 결과가 비었거나 예외면 사용자에게 "이 영상은 처리에 실패했어요(코덱/용량 문제일 수 있음)" 안내.
- **용량 경고**: 파일 선택 시 대략 200MB 초과면 "브라우저 처리라 큰 영상은 느리거나 멈출 수 있어요" 경고 표시. (wasm 메모리 한계)

---

## 5. 배포 설정

단일스레드라 특수 헤더 없이도 동작하지만, 큰 wasm 캐싱과 mime을 위해 아래 권장.

**`_headers`** (Netlify/Cloudflare Pages):
```
/vendor/*
  Cache-Control: public, max-age=31536000, immutable
```

**`netlify.toml`**:
```toml
[build]
  publish = "."
[[headers]]
  for = "/vendor/ffmpeg-core.wasm"
  [headers.values]
    Content-Type = "application/wasm"
    Cache-Control = "public, max-age=31536000, immutable"
```

**배포 방법 3가지 (README에 적어줄 것):**
- **Netlify Drop**: app.netlify.com/drop 에 폴더 통째로 드래그. 제일 쉬움.
- **Vercel**: `vercel` CLI 또는 깃 연동. (Vercel은 `vercel.json`의 headers로 wasm mime 지정)
- **GitHub Pages**: 레포에 올리고 Pages 활성화. **단 31MB wasm** 때문에 일반 add로 올려도 되지만, 레포가 커진다. 문제 시 Git LFS.

**주의**: 로컬에서 열 때 `file://`로 열면 안 된다(Worker/CORS). 반드시 로컬 서버로 확인:
`python -m http.server 8000` 후 `http://localhost:8000`.

---

## 6. (선택) 속도 업그레이드 — 멀티스레드 코어

기본은 단일스레드(안전·간단). 처리가 너무 느리면 멀티스레드 코어(`@ffmpeg/core-mt`)로 교체 가능하나:
- `SharedArrayBuffer` 필요 → 사이트 전체에 **COOP/COEP 헤더 필수**:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```
- 이 헤더가 걸리면 외부 리소스 로딩에 제약이 생기므로, **모든 자원을 same-origin(vendor)로 유지**해야 함(이 프로젝트는 이미 그럼).
- **1차 버전은 단일스레드로 완성하고**, 필요할 때만 이 업그레이드를 별도로 진행할 것.

---

## 7. 완료 기준 (Acceptance)

로컬 `python -m http.server`로 띄운 뒤 브라우저에서:
1. 페이지 진입 시 ffmpeg 코어 로딩 표시가 뜨고 완료된다.
2. 영상 업로드 → `<video>`에 미리보기 나온다.
3. 워터마크 위를 드래그하면 사각형이 그려지고, 여러 개/삭제가 된다.
4. [워터마크 제거] 누르면 진행률이 오르고, 완료 후 결과 영상이 나온다.
5. 결과에서 선택 영역의 워터마크가 주변 픽셀로 메워져 사라졌다(또는 옅어졌다).
6. [결과 다운로드]로 mp4가 저장된다.
7. 콘솔에 `SecurityError`(Worker) 같은 게 없다.
8. 창을 좁혔다 넓혀도 사각형 위치가 영상과 어긋나지 않는다(좌표 스케일 재계산).

**테스트용 영상 만들기** (워터마크 흉내):
```bash
ffmpeg -f lavfi -i "testsrc=size=640x360:rate=15:duration=3" \
  -vf "drawbox=x=440:y=300:w=160:h=40:color=white@0.9:t=fill" \
  -pix_fmt yuv420p sample.mp4
```

---

## 8. 한계 (README에 정직하게 명시)

- delogo는 선택 영역을 **주변 픽셀로 보간**하는 방식. **고정 위치의 불투명 사각 로고**에 가장 잘 맞는다.
- 반투명/복잡한 배경 위 워터마크는 자국이 남을 수 있다.
- **움직이는 워터마크**는 한 영역으로 부족(AI 인페인팅 영역, 이 도구 범위 밖).
- 브라우저 처리라 **대용량·고해상도 영상은 느리거나 메모리 한계**로 실패할 수 있다.

---

## 9. 참고: 기존 로컬 버전

- `D:\mannai\watermark-remover\` — Flask + 네이티브 ffmpeg 버전. **드래그 선택 UI 코드(`templates/index.html`)를 그대로 참고**해서 프론트를 만들고, 서버 `fetch('/process')` 부분만 ffmpeg.wasm 호출로 교체하면 된다. 좌표 변환·클램프 로직도 거기 있음.
```
