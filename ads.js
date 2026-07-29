// 광고 단위를 렌더링한다.
// 로더 스크립트와 게시자 ID는 각 HTML의 <head>에 그대로 두어
// 애드센스 크롤러가 HTML 원본에서 찾을 수 있게 한다.
(function () {
  "use strict";

  var CLIENT_PATTERN = /^ca-pub-\d{16}$/;
  var SLOT_PATTERN = /^\d{6,}$/;

  var meta = document.querySelector('meta[name="google-adsense-account"]');
  var client = meta ? String(meta.content || "").trim() : "";
  var containers = Array.prototype.slice.call(document.querySelectorAll(".ad-slot"));

  containers.forEach(function (container) {
    var slotId = String(container.dataset.adSlot || "").trim();

    // 게시자 ID나 광고 단위 ID가 없으면 빈 자리를 남기지 않고 제거한다.
    if (!CLIENT_PATTERN.test(client) || !SLOT_PATTERN.test(slotId)) {
      container.remove();
      return;
    }

    var unit = document.createElement("ins");
    unit.className = "adsbygoogle";
    unit.style.display = "block";
    unit.dataset.adClient = client;
    unit.dataset.adSlot = slotId;
    unit.dataset.adFormat = container.dataset.adFormat || "auto";
    unit.dataset.fullWidthResponsive = "true";
    container.appendChild(unit);

    // 로더가 아직 준비되지 않아도 큐에 쌓였다가 실행된다.
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  });
})();
