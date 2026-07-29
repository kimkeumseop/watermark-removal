// 애드센스 로더와 광고 단위를 초기화한다.
// 게시자 ID는 각 HTML의 <meta name="google-adsense-account"> 한 곳에서만 관리한다.
(function () {
  "use strict";

  var CLIENT_PATTERN = /^ca-pub-\d{16}$/;
  var SLOT_PATTERN = /^\d{6,}$/;
  var LOADER_SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";

  var meta = document.querySelector('meta[name="google-adsense-account"]');
  var client = meta ? String(meta.content || "").trim() : "";
  var containers = Array.prototype.slice.call(document.querySelectorAll(".ad-slot"));

  // 게시자 ID를 아직 넣지 않았으면 빈 광고 자리를 남기지 않고 그대로 종료한다.
  if (!CLIENT_PATTERN.test(client)) {
    removeAll(containers);
    return;
  }

  var loader = document.createElement("script");
  loader.async = true;
  loader.crossOrigin = "anonymous";
  loader.src = LOADER_SRC + "?client=" + encodeURIComponent(client);
  document.head.appendChild(loader);

  containers.forEach(function (container) {
    var slotId = String(container.dataset.adSlot || "").trim();

    // 광고 단위 ID가 비어 있으면 자리만 차지하므로 제거한다.
    if (!SLOT_PATTERN.test(slotId)) {
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

  function removeAll(nodes) {
    nodes.forEach(function (node) {
      node.remove();
    });
  }
})();
