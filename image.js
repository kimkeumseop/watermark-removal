// 이미지 폴더 선택 영역 관리와 워터마크 일괄 제거(canvas 보간 + 내장 ZIP) 클라이언트 로직
// 모든 처리는 브라우저 안에서만 이루어지며, 이미지는 네트워크로 전송되지 않습니다.
const $ = (selector) => document.querySelector(selector);

const elements = {
  folderInput: $("#folderInput"),
  filesInput: $("#filesInput"),
  dropZone: $("#dropZone"),
  uploadPanel: $("#uploadPanel"),
  editPanel: $("#editPanel"),
  processingPanel: $("#processingPanel"),
  resultPanel: $("#resultPanel"),
  sourceImage: $("#sourceImage"),
  overlay: $("#selectionOverlay"),
  fileSummary: $("#fileSummary"),
  editDescription: $("#editDescription"),
  previewPair: $("#previewPair"),
  beforeCanvas: $("#beforeCanvas"),
  afterCanvas: $("#afterCanvas"),
  processButton: $("#processButton"),
  processButtonLabel: $("#processButtonLabel"),
  processingNote: $("#processingNote"),
  resultImageWrap: $("#resultImageWrap"),
  resultImage: $("#resultImage"),
  downloadLabel: $("#downloadLabel"),
  previewButton: $("#previewButton"),
  clearButton: $("#clearButton"),
  resetButton: $("#resetButton"),
  editAgainButton: $("#editAgainButton"),
  newFolderButton: $("#newFolderButton"),
  downloadLink: $("#downloadLink"),
  regionCount: $("#regionCount"),
  uploadError: $("#uploadError"),
  processError: $("#processError"),
  progressBar: $("#progressBar"),
  progressValue: $("#progressValue"),
  resultSummary: $("#resultSummary"),
  steps: [...document.querySelectorAll(".step")],
};

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

const state = {
  files: [],           // File[]
  regions: [],         // {rx, ry, rw, rh} 0~1 비율
  repW: 0,
  repH: 0,
  sourceUrl: "",
  resultUrl: "",
};

let dragging = null;
let processing = false;

/* ---------------- 공통 UI ---------------- */
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

function setProgress(value) {
  const percent = Math.min(100, Math.max(0, value));
  elements.progressBar.style.width = `${percent}%`;
  elements.progressValue.textContent = `${percent}%`;
}

/* ---------------- 이미지 불러오기 (한 장 또는 폴더) ---------------- */
function isSingle() {
  return state.files.length === 1;
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 한 장인지 여러 장인지에 따라 안내 문구와 버튼 이름을 맞춘다. */
function syncModeLabels() {
  const single = isSingle();
  const count = state.files.length;

  elements.editDescription.textContent = single
    ? "워터마크 위를 드래그하세요. 여러 영역을 선택할 수 있습니다."
    : `여기서 지정한 위치가 이미지 ${count}장 전체에 같은 비율로 적용됩니다.`;

  elements.processButtonLabel.textContent = single ? "워터마크 제거" : "모두 제거 → ZIP";
  elements.processingNote.textContent = single
    ? "해상도에 따라 잠시 걸릴 수 있습니다. 창을 닫지 마세요."
    : `이미지 ${count}장을 처리합니다. 창을 닫지 마세요.`;
  elements.downloadLabel.textContent = single ? "이미지 다시 받기" : "ZIP 다시 받기";
}

function selectImages(fileList) {
  showNotice(elements.uploadError, "");
  const files = [...fileList].filter((f) => IMAGE_RE.test(f.name));

  if (files.length === 0) {
    showNotice(elements.uploadError, "이미지 파일(JPG · PNG · WEBP)을 찾지 못했어요.");
    return;
  }

  revokeUrl("sourceUrl");
  revokeUrl("resultUrl");
  state.files = files;
  state.regions = [];
  state.repW = 0;
  state.repH = 0;
  state.sourceUrl = URL.createObjectURL(files[0]);
  elements.sourceImage.src = state.sourceUrl;
  elements.sourceImage.alt = files.length === 1 ? "선택한 이미지 미리보기" : "대표 이미지 미리보기";
  elements.fileSummary.textContent =
    files.length === 1
      ? `${files[0].name} · ${formatFileSize(files[0].size)}`
      : `이미지 ${files.length}장 · 대표: ${files[0].name}`;

  showNotice(elements.processError, "");
  elements.previewPair.classList.add("hidden");
  elements.resultImageWrap.classList.add("hidden");
  syncModeLabels();
  renderRects();
  setStep("select");
  showPanel(elements.editPanel);
  elements.editPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

elements.sourceImage.addEventListener("load", () => {
  state.repW = elements.sourceImage.naturalWidth;
  state.repH = elements.sourceImage.naturalHeight;
  renderRects();
});

/* ---------------- 드래그로 영역 지정 (비율 저장) ---------------- */
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
  if (processing || event.button !== 0 || !state.repW || !state.repH) return;
  const point = getPoint(event);
  const element = document.createElement("div");
  element.className = "selection-rect";
  elements.overlay.appendChild(element);
  dragging = { pointerId: event.pointerId, startX: point.x, startY: point.y, element };
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
    rx: x / box.width,
    ry: y / box.height,
    rw: width / box.width,
    rh: height / box.height,
  });
  elements.previewPair.classList.add("hidden");
  renderRects();
}

elements.overlay.addEventListener("pointerup", (event) => finishDrag(event, true));
elements.overlay.addEventListener("pointercancel", (event) => finishDrag(event, false));

function renderRects() {
  elements.overlay.querySelectorAll(".selection-rect").forEach((rect) => rect.remove());
  const box = elements.overlay.getBoundingClientRect();

  state.regions.forEach((region, index) => {
    const rect = document.createElement("div");
    rect.className = "selection-rect";
    Object.assign(rect.style, {
      left: `${region.rx * box.width}px`,
      top: `${region.ry * box.height}px`,
      width: `${region.rw * box.width}px`,
      height: `${region.rh * box.height}px`,
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
      elements.previewPair.classList.add("hidden");
      renderRects();
    });

    rect.appendChild(removeButton);
    elements.overlay.appendChild(rect);
  });

  elements.regionCount.textContent = `선택 영역 ${state.regions.length}개`;
  const hasRegion = state.regions.length > 0;
  elements.processButton.disabled = !hasRegion || processing;
  elements.previewButton.disabled = !hasRegion || processing;
  elements.clearButton.disabled = !hasRegion || processing;
}
window.addEventListener("resize", renderRects);

/* ---------------- 비율 → 픽셀 + 프레임 안쪽 클램프 ---------------- */
function regionsToPixels(width, height) {
  const out = [];
  for (const region of state.regions) {
    let x = Math.max(1, Math.min(Math.round(region.rx * width), width - 2));
    let y = Math.max(1, Math.min(Math.round(region.ry * height), height - 2));
    const maxWidth = Math.max(1, width - 1 - x);
    const maxHeight = Math.max(1, height - 1 - y);
    const w = Math.max(1, Math.min(Math.round(region.rw * width), maxWidth));
    const h = Math.max(1, Math.min(Math.round(region.rh * height), maxHeight));
    out.push({ x, y, w, h });
  }
  return out;
}

/* delogo 원리: 사각형 내부를 좌/우/상/하 테두리 픽셀의 역거리 가중평균으로 채움 */
function inpaintRegion(ctx, x, y, w, h) {
  const image = ctx.getImageData(x - 1, y - 1, w + 2, h + 2);
  const d = image.data;
  const W = w + 2;
  const px = (ix, iy) => (iy * W + ix) * 4;
  for (let iy = 1; iy <= h; iy++) {
    for (let ix = 1; ix <= w; ix++) {
      const dl = ix;
      const dr = w + 1 - ix;
      const dt = iy;
      const db = h + 1 - iy;
      const L = px(0, iy);
      const R = px(w + 1, iy);
      const T = px(ix, 0);
      const B = px(ix, h + 1);
      const O = px(ix, iy);
      const wl = 1 / dl;
      const wr = 1 / dr;
      const wt = 1 / dt;
      const wb = 1 / db;
      const ws = wl + wr + wt + wb;
      for (let c = 0; c < 3; c++) {
        d[O + c] = (d[L + c] * wl + d[R + c] * wr + d[T + c] * wt + d[B + c] * wb) / ws;
      }
      d[O + 3] = 255;
    }
  }
  ctx.putImageData(image, x - 1, y - 1);
}

async function renderToCanvas(file, canvas, withInpaint) {
  const bitmap = await createImageBitmap(file);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  if (withInpaint) {
    for (const region of regionsToPixels(canvas.width, canvas.height)) {
      inpaintRegion(ctx, region.x, region.y, region.w, region.h);
    }
  }
  return ctx;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function outputType(file) {
  const type = file.type && /^image\//.test(file.type) ? file.type : "";
  if (type === "image/jpeg" || type === "image/png" || type === "image/webp") return type;
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/png";
}

/* ---------------- 미리보기 (전/후) ---------------- */
elements.previewButton.addEventListener("click", async () => {
  if (state.regions.length === 0) return;
  showNotice(elements.processError, "");
  try {
    await renderToCanvas(state.files[0], elements.beforeCanvas, false);
    await renderToCanvas(state.files[0], elements.afterCanvas, true);
    elements.previewPair.classList.remove("hidden");
    elements.previewPair.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    console.error(error);
    showNotice(elements.processError, "미리보기를 만들지 못했어요. 다른 이미지로 시도해 보세요.");
  }
});

/* ---------------- 처리 (한 장 또는 일괄) ---------------- */
function triggerDownload(url, filename) {
  const auto = document.createElement("a");
  auto.href = url;
  auto.download = filename;
  document.body.appendChild(auto);
  auto.click();
  auto.remove();
}

/** 원본 이름에 접미사를 붙여 원본을 덮어쓸 위험을 줄인다. */
function cleanedName(name) {
  const base = name.replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return `${base}-clean`;
  return `${base.slice(0, dot)}-clean${base.slice(dot)}`;
}

async function processAll() {
  if (processing || state.files.length === 0 || state.regions.length === 0) return;

  processing = true;
  showNotice(elements.processError, "");
  setProgress(0);
  elements.resultImageWrap.classList.add("hidden");
  showPanel(elements.processingPanel);
  elements.processingPanel.scrollIntoView({ behavior: "smooth", block: "center" });

  const canvas = document.createElement("canvas");

  try {
    if (isSingle()) {
      // 한 장은 ZIP으로 묶지 않고 이미지 파일 그대로 저장한다.
      const file = state.files[0];
      setProgress(20);
      await renderToCanvas(file, canvas, true);
      setProgress(70);
      const blob = await canvasToBlob(canvas, outputType(file), 0.95);
      if (!blob || blob.size === 0) throw new Error("no-output");

      revokeUrl("resultUrl");
      state.resultUrl = URL.createObjectURL(blob);
      const filename = cleanedName(file.name);
      elements.downloadLink.href = state.resultUrl;
      elements.downloadLink.download = filename;
      elements.resultImage.src = state.resultUrl;
      elements.resultImageWrap.classList.remove("hidden");
      elements.resultSummary.textContent = `${filename} 으로 저장했습니다. 결과를 확인해 보세요.`;
      setProgress(100);
      triggerDownload(state.resultUrl, filename);
    } else {
      const zip = new ZipStore();
      let done = 0;
      for (let i = 0; i < state.files.length; i++) {
        const file = state.files[i];
        setProgress(Math.round((i / state.files.length) * 100));
        try {
          await renderToCanvas(file, canvas, true);
          const blob = await canvasToBlob(canvas, outputType(file), 0.95);
          const buffer = new Uint8Array(await blob.arrayBuffer());
          await zip.add(file.webkitRelativePath || file.name, buffer);
          done++;
        } catch (error) {
          console.warn("건너뜀:", file.name, error);
        }
        await new Promise((resolve) => setTimeout(resolve, 0)); // UI 양보
      }

      if (done === 0) throw new Error("no-output");

      setProgress(100);
      revokeUrl("resultUrl");
      state.resultUrl = URL.createObjectURL(zip.generate());
      elements.downloadLink.href = state.resultUrl;
      elements.downloadLink.download = "cleanframe-images.zip";
      elements.resultSummary.textContent =
        `${done}장을 처리해 ZIP으로 저장했습니다${done < state.files.length ? ` (${state.files.length - done}장은 건너뜀)` : ""}.`;
      triggerDownload(state.resultUrl, "cleanframe-images.zip");
    }

    setStep("done");
    showPanel(elements.resultPanel);
    elements.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    showPanel(elements.editPanel);
    showNotice(
      elements.processError,
      "이미지를 처리하지 못했어요. 형식이나 용량 문제일 수 있습니다. 다른 이미지로 다시 시도해 주세요.",
    );
  } finally {
    processing = false;
    renderRects();
  }
}

/* ---------------- 리셋 ---------------- */
function resetWorkspace() {
  if (processing) return;
  revokeUrl("sourceUrl");
  revokeUrl("resultUrl");
  state.files = [];
  state.regions = [];
  state.repW = 0;
  state.repH = 0;
  elements.folderInput.value = "";
  elements.filesInput.value = "";
  elements.sourceImage.removeAttribute("src");
  elements.resultImage.removeAttribute("src");
  elements.fileSummary.textContent = "";
  elements.previewPair.classList.add("hidden");
  elements.resultImageWrap.classList.add("hidden");
  showNotice(elements.uploadError, "");
  showNotice(elements.processError, "");
  setStep("upload");
  showPanel(elements.uploadPanel);
  renderRects();
  elements.uploadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------- 이벤트 연결 ---------------- */
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
  if (event.dataTransfer && event.dataTransfer.files.length) {
    selectImages(event.dataTransfer.files);
  }
});
elements.folderInput.addEventListener("change", () => {
  if (elements.folderInput.files.length) selectImages(elements.folderInput.files);
});
elements.filesInput.addEventListener("change", () => {
  if (elements.filesInput.files.length) selectImages(elements.filesInput.files);
});

elements.processButton.addEventListener("click", processAll);
elements.clearButton.addEventListener("click", () => {
  state.regions = [];
  elements.previewPair.classList.add("hidden");
  renderRects();
});
elements.resetButton.addEventListener("click", resetWorkspace);
elements.newFolderButton.addEventListener("click", resetWorkspace);
elements.editAgainButton.addEventListener("click", () => {
  setStep("select");
  showPanel(elements.editPanel);
  elements.editPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});

renderRects();

/* ================================================================
 *  내장 ZIP 생성기 (저장 전용 / store, 압축 없음)
 *  이미지(jpg/png/webp)는 이미 압축돼 있어 store로 충분합니다.
 * ================================================================ */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class ZipStore {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
  }
  async add(name, data) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const size = data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 파일명
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    this.parts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, this.offset, true);
    central.set(nameBytes, 46);
    this.central.push(central);

    this.offset += local.length + size;
  }
  generate() {
    const centralSize = this.central.reduce((a, c) => a + c.length, 0);
    const centralOffset = this.offset;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.central.length, true);
    ev.setUint16(10, this.central.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    return new Blob([...this.parts, ...this.central, end], { type: "application/zip" });
  }
}
