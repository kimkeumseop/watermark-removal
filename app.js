// 영상 선택 영역 관리와 ffmpeg.wasm 워터마크 제거 처리를 담당하는 클라이언트 로직
const $ = (selector) => document.querySelector(selector);

const elements = {
  fileInput: $("#fileInput"),
  dropZone: $("#dropZone"),
  uploadPanel: $("#uploadPanel"),
  editPanel: $("#editPanel"),
  processingPanel: $("#processingPanel"),
  resultPanel: $("#resultPanel"),
  sourceVideo: $("#sourceVideo"),
  resultVideo: $("#resultVideo"),
  overlay: $("#selectionOverlay"),
  playPauseButton: $("#playPauseButton"),
  playPauseIcon: $("#playPauseIcon"),
  playPauseText: $("#playPauseText"),
  restartPreviewButton: $("#restartPreviewButton"),
  fileSummary: $("#fileSummary"),
  processButton: $("#processButton"),
  clearButton: $("#clearButton"),
  resetButton: $("#resetButton"),
  editAgainButton: $("#editAgainButton"),
  newVideoButton: $("#newVideoButton"),
  downloadLink: $("#downloadLink"),
  regionCount: $("#regionCount"),
  sizeWarning: $("#sizeWarning"),
  uploadError: $("#uploadError"),
  processError: $("#processError"),
  progressBar: $("#progressBar"),
  progressValue: $("#progressValue"),
  coreIndicator: $("#coreIndicator"),
  coreStatusText: $("#coreStatusText"),
  steps: [...document.querySelectorAll(".step")],
};

const state = {
  file: null,
  videoW: 0,
  videoH: 0,
  regions: [],
  sourceUrl: "",
  resultUrl: "",
};

const { FFmpeg } = FFmpegWASM;
const { toBlobURL, fetchFile } = FFmpegUtil;
const ffmpeg = new FFmpeg();

let ffmpegLoadPromise = null;
let ffmpegReady = false;
let dragging = null;
let processing = false;

ffmpeg.on("log", ({ message }) => {
  console.log(`[ffmpeg] ${message}`);
});

ffmpeg.on("progress", ({ progress }) => {
  if (!processing || !Number.isFinite(progress)) return;
  setProgress(Math.round(Math.min(1, Math.max(0, progress)) * 100));
});

function setCoreStatus(status, message) {
  elements.coreIndicator.classList.toggle("is-loading", status === "loading");
  elements.coreIndicator.classList.toggle("is-error", status === "error");
  elements.coreStatusText.textContent = message;
}

async function loadFfmpeg() {
  if (ffmpegReady) return;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  setCoreStatus("loading", "영상 처리 엔진을 준비하고 있어요");
  ffmpegLoadPromise = ffmpeg
    .load({
      coreURL: await toBlobURL("./vendor/ffmpeg-core.js", "text/javascript"),
      wasmURL: await toBlobURL("./vendor/ffmpeg-core.wasm", "application/wasm"),
    })
    .then(() => {
      ffmpegReady = true;
      setCoreStatus("ready", "영상 처리 엔진 준비 완료");
    })
    .catch((error) => {
      ffmpegLoadPromise = null;
      setCoreStatus("error", "영상 처리 엔진을 불러오지 못했어요");
      throw error;
    });

  return ffmpegLoadPromise;
}

function showNotice(element, message) {
  element.textContent = message;
  element.classList.toggle("hidden", !message);
}

function setStep(activeStep) {
  const order = ["upload", "select", "done"];
  const activeIndex = order.indexOf(activeStep);

  elements.steps.forEach((step) => {
    const stepIndex = order.indexOf(step.dataset.step);
    step.classList.toggle("is-active", stepIndex === activeIndex);
    step.classList.toggle("is-complete", stepIndex < activeIndex);
  });
}

function showPanel(panel) {
  [
    elements.uploadPanel,
    elements.editPanel,
    elements.processingPanel,
    elements.resultPanel,
  ].forEach((candidate) => {
    candidate.classList.toggle("hidden", candidate !== panel);
  });
}

function revokeUrl(key) {
  if (!state[key]) return;
  URL.revokeObjectURL(state[key]);
  state[key] = "";
}

function isVideoFile(file) {
  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name);
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function updateFileSummary() {
  if (!state.file) {
    elements.fileSummary.textContent = "";
    return;
  }

  const dimensions =
    state.videoW && state.videoH ? ` · ${state.videoW} × ${state.videoH}` : "";
  elements.fileSummary.textContent =
    `${state.file.name}${dimensions} · ${formatFileSize(state.file.size)}`;
  elements.fileSummary.title = elements.fileSummary.textContent;
}

function syncPreviewControls() {
  const hasVideo = Boolean(state.file && state.videoW && state.videoH);
  elements.playPauseButton.disabled = !hasVideo || processing;
  elements.restartPreviewButton.disabled = !hasVideo || processing;
  const isPlaying = hasVideo && !elements.sourceVideo.paused && !elements.sourceVideo.ended;
  elements.playPauseIcon.textContent = isPlaying ? "❚❚" : "▶";
  elements.playPauseText.textContent = isPlaying ? "일시정지" : "미리보기 재생";
}

function selectVideo(file) {
  showNotice(elements.uploadError, "");

  if (!isVideoFile(file)) {
    showNotice(elements.uploadError, "영상 파일을 선택해 주세요.");
    return;
  }

  revokeUrl("sourceUrl");
  revokeUrl("resultUrl");
  state.file = file;
  state.videoW = 0;
  state.videoH = 0;
  state.regions = [];
  state.sourceUrl = URL.createObjectURL(file);
  elements.sourceVideo.src = state.sourceUrl;
  elements.resultVideo.removeAttribute("src");
  elements.resultVideo.load();

  if (file.size > 200 * 1024 * 1024) {
    showNotice(
      elements.sizeWarning,
      "200MB가 넘는 영상입니다. 브라우저 처리 특성상 오래 걸리거나 메모리 부족으로 멈출 수 있어요.",
    );
  } else {
    showNotice(elements.sizeWarning, "");
  }

  showNotice(elements.processError, "");
  updateFileSummary();
  syncPreviewControls();
  renderRects();
  setStep("select");
  showPanel(elements.editPanel);
  elements.editPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function getPoint(event) {
  const box = elements.overlay.getBoundingClientRect();
  return {
    box,
    x: Math.min(box.width, Math.max(0, event.clientX - box.left)),
    y: Math.min(box.height, Math.max(0, event.clientY - box.top)),
  };
}

function drawDraft(point) {
  const x = Math.min(dragging.startX, point.x);
  const y = Math.min(dragging.startY, point.y);
  const width = Math.abs(point.x - dragging.startX);
  const height = Math.abs(point.y - dragging.startY);

  Object.assign(dragging.element.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
}

elements.overlay.addEventListener("pointerdown", (event) => {
  if (processing || event.button !== 0 || !state.videoW || !state.videoH) return;

  const point = getPoint(event);
  const element = document.createElement("div");
  element.className = "selection-rect";
  elements.overlay.appendChild(element);

  dragging = {
    pointerId: event.pointerId,
    startX: point.x,
    startY: point.y,
    element,
  };

  elements.overlay.setPointerCapture(event.pointerId);
  event.preventDefault();
});

elements.overlay.addEventListener("pointermove", (event) => {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  drawDraft(getPoint(event));
});

function finishDrag(event, saveRegion) {
  if (!dragging || dragging.pointerId !== event.pointerId) return;

  const point = getPoint(event);
  const box = point.box;
  const x = Math.min(dragging.startX, point.x);
  const y = Math.min(dragging.startY, point.y);
  const width = Math.abs(point.x - dragging.startX);
  const height = Math.abs(point.y - dragging.startY);

  dragging.element.remove();
  dragging = null;

  if (!saveRegion || width < 6 || height < 6 || !box.width || !box.height) {
    renderRects();
    return;
  }

  state.regions.push({
    x: Math.round(x * (state.videoW / box.width)),
    y: Math.round(y * (state.videoH / box.height)),
    w: Math.round(width * (state.videoW / box.width)),
    h: Math.round(height * (state.videoH / box.height)),
  });
  renderRects();
}

elements.overlay.addEventListener("pointerup", (event) => finishDrag(event, true));
elements.overlay.addEventListener("pointercancel", (event) => finishDrag(event, false));

function renderRects() {
  elements.overlay.querySelectorAll(".selection-rect").forEach((rect) => rect.remove());

  const box = elements.overlay.getBoundingClientRect();
  const scaleX = state.videoW && box.width ? box.width / state.videoW : 0;
  const scaleY = state.videoH && box.height ? box.height / state.videoH : 0;

  state.regions.forEach((region, index) => {
    const rect = document.createElement("div");
    rect.className = "selection-rect";
    Object.assign(rect.style, {
      left: `${region.x * scaleX}px`,
      top: `${region.y * scaleY}px`,
      width: `${region.w * scaleX}px`,
      height: `${region.h * scaleY}px`,
    });

    const removeButton = document.createElement("button");
    removeButton.className = "selection-delete";
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.setAttribute("aria-label", `${index + 1}번째 선택 영역 삭제`);
    removeButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      state.regions.splice(index, 1);
      renderRects();
    });

    rect.appendChild(removeButton);
    elements.overlay.appendChild(rect);
  });

  elements.regionCount.textContent = `선택 영역 ${state.regions.length}개`;
  elements.processButton.disabled = state.regions.length === 0 || processing;
  elements.clearButton.disabled = state.regions.length === 0 || processing;
}

function clampRegion(region) {
  const x = Math.max(1, Math.min(Math.round(region.x), state.videoW - 2));
  const y = Math.max(1, Math.min(Math.round(region.y), state.videoH - 2));
  const maxWidth = Math.max(1, state.videoW - 1 - x);
  const maxHeight = Math.max(1, state.videoH - 1 - y);

  return {
    x,
    y,
    w: Math.max(1, Math.min(Math.round(region.w), maxWidth)),
    h: Math.max(1, Math.min(Math.round(region.h), maxHeight)),
  };
}

function getInputFilename(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const safeExtension = /^[a-z0-9]{2,5}$/.test(extension || "") ? extension : "mp4";
  return `input.${safeExtension}`;
}

async function deleteVirtualFile(filename) {
  try {
    await ffmpeg.deleteFile(filename);
  } catch {
    // 이전 처리의 가상 파일이 없는 경우는 정리할 내용이 없으므로 무시한다.
  }
}

function setProgress(value) {
  const percent = Math.min(100, Math.max(0, value));
  elements.progressBar.style.width = `${percent}%`;
  elements.progressValue.textContent = `${percent}%`;
}

async function processVideo() {
  if (processing || !state.file || state.regions.length === 0) return;

  processing = true;
  elements.sourceVideo.pause();
  syncPreviewControls();
  showNotice(elements.processError, "");
  setProgress(0);
  showPanel(elements.processingPanel);
  elements.processingPanel.scrollIntoView({ behavior: "smooth", block: "center" });

  const inputFilename = getInputFilename(state.file);
  const outputFilename = "output.mp4";

  try {
    await loadFfmpeg();
    const regions = state.regions.map(clampRegion);
    const filter = regions
      .map(({ x, y, w, h }) => `delogo=x=${x}:y=${y}:w=${w}:h=${h}`)
      .join(",");

    await deleteVirtualFile(inputFilename);
    await deleteVirtualFile(outputFilename);
    await ffmpeg.writeFile(inputFilename, await fetchFile(state.file));
    await ffmpeg.exec([
      "-i",
      inputFilename,
      "-vf",
      filter,
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      outputFilename,
    ]);

    const data = await ffmpeg.readFile(outputFilename);
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      throw new Error("empty-output");
    }

    revokeUrl("resultUrl");
    state.resultUrl = URL.createObjectURL(
      new Blob([data.buffer], { type: "video/mp4" }),
    );
    elements.resultVideo.src = state.resultUrl;
    elements.downloadLink.href = state.resultUrl;
    setProgress(100);
    setStep("done");
    showPanel(elements.resultPanel);
    elements.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    showPanel(elements.editPanel);
    showNotice(
      elements.processError,
      "이 영상은 처리에 실패했어요. 코덱이나 파일 용량 문제일 수 있습니다. 다른 영상으로 다시 시도해 주세요.",
    );
  } finally {
    await deleteVirtualFile(inputFilename);
    await deleteVirtualFile(outputFilename);
    processing = false;
    syncPreviewControls();
    renderRects();
  }
}

function resetWorkspace() {
  if (processing) return;

  revokeUrl("sourceUrl");
  revokeUrl("resultUrl");
  state.file = null;
  state.videoW = 0;
  state.videoH = 0;
  state.regions = [];
  elements.fileInput.value = "";
  elements.sourceVideo.pause();
  elements.sourceVideo.removeAttribute("src");
  elements.sourceVideo.load();
  elements.resultVideo.removeAttribute("src");
  elements.resultVideo.load();
  showNotice(elements.sizeWarning, "");
  showNotice(elements.uploadError, "");
  showNotice(elements.processError, "");
  updateFileSummary();
  syncPreviewControls();
  setStep("upload");
  showPanel(elements.uploadPanel);
  renderRects();
  elements.uploadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-over");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, () => {
    elements.dropZone.classList.remove("is-over");
  });
});

elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  const [file] = event.dataTransfer.files;
  if (file) selectVideo(file);
});

elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  if (file) selectVideo(file);
});

elements.sourceVideo.addEventListener("loadedmetadata", () => {
  state.videoW = elements.sourceVideo.videoWidth;
  state.videoH = elements.sourceVideo.videoHeight;
  updateFileSummary();
  syncPreviewControls();
  renderRects();
});

["play", "pause", "ended"].forEach((eventName) => {
  elements.sourceVideo.addEventListener(eventName, syncPreviewControls);
});

elements.playPauseButton.addEventListener("click", () => {
  if (elements.sourceVideo.paused || elements.sourceVideo.ended) {
    elements.sourceVideo.play().catch((error) => {
      console.error(error);
      showNotice(elements.processError, "미리보기를 재생하지 못했어요. 다시 시도해 주세요.");
    });
  } else {
    elements.sourceVideo.pause();
  }
});

elements.restartPreviewButton.addEventListener("click", () => {
  elements.sourceVideo.currentTime = 0;
  syncPreviewControls();
});

elements.clearButton.addEventListener("click", () => {
  state.regions = [];
  renderRects();
});

elements.processButton.addEventListener("click", processVideo);
elements.resetButton.addEventListener("click", resetWorkspace);
elements.newVideoButton.addEventListener("click", resetWorkspace);
elements.editAgainButton.addEventListener("click", () => {
  elements.resultVideo.pause();
  setStep("select");
  showPanel(elements.editPanel);
  renderRects();
  elements.editPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});

window.addEventListener("resize", renderRects);
window.addEventListener("beforeunload", () => {
  revokeUrl("sourceUrl");
  revokeUrl("resultUrl");
});

loadFfmpeg().catch((error) => {
  console.error(error);
});
