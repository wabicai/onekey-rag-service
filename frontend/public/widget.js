(function () {
  var NS = "OneKeyRAGWidget";

  if (window[NS] && window[NS].__initialized) return;

  function pickCurrentScript() {
    if (document.currentScript) return document.currentScript;
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      var s = scripts[i];
      if (s && s.src && s.src.indexOf("/widget/") !== -1 && s.src.indexOf("widget.js") !== -1) {
        return s;
      }
    }
    return null;
  }

  var script = pickCurrentScript();
  if (!script || !script.src) return;

  var scriptUrl = new URL(script.src, document.baseURI);
  var defaultWidgetBaseUrl = new URL(".", scriptUrl).href; // .../widget/
  var globalConfig = window.OneKeyRAGWidgetConfig || {};
  var dataset = script.dataset || {};

  var widgetBaseUrl = dataset.widgetBaseUrl || globalConfig.widgetBaseUrl || defaultWidgetBaseUrl;
  var widgetOrigin = new URL(widgetBaseUrl).origin;
  var apiBase = dataset.apiBase || globalConfig.apiBase || ""; // 为空表示 iframe 内走同域相对路径

  var model = dataset.model || globalConfig.model || "onekey-docs";
  var title = dataset.title || globalConfig.title || "Ask AI";
  var buttonLabel = dataset.buttonLabel || globalConfig.buttonLabel || "Ask AI";
  var contactUrl = dataset.contactUrl || globalConfig.contactUrl || "";

  var zIndex = parseInt(dataset.zIndex || globalConfig.zIndex || "2147483647", 10);
  // 兼容旧配置：data-width 之前用于侧边栏宽度，这里作为 modalWidth 的默认值
  var width = dataset.width || globalConfig.width || "";

  var containerId = "onekey-rag-widget-container";
  if (document.getElementById(containerId)) return;

  var style = document.createElement("style");
  var modalWidth = dataset.modalWidth || globalConfig.modalWidth || width || "860px";
  var modalHeight = dataset.modalHeight || globalConfig.modalHeight || "72vh";
  var modalMaxHeight = dataset.modalMaxHeight || globalConfig.modalMaxHeight || "820px";

  style.textContent =
    "#onekey-rag-widget-button{position:fixed;right:20px;bottom:20px;z-index:" +
    zIndex +
    ";display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:linear-gradient(135deg,#ef4444,#f97316);color:#fff;box-shadow:0 14px 40px rgba(0,0,0,.28);cursor:pointer;font:800 13px/1 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;}" +
    "#onekey-rag-widget-button:hover{box-shadow:0 18px 46px rgba(0,0,0,.34)}" +
    "#onekey-rag-widget-overlay{position:fixed;inset:0;z-index:" +
    zIndex +
    ";background:rgba(0,0,0,.55);opacity:0;pointer-events:none;transition:opacity .18s ease;}" +
    "#onekey-rag-widget-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.98);z-index:" +
    (zIndex + 1) +
    ";width:" +
    modalWidth +
    ";max-width:calc(100vw - 32px);height:" +
    modalHeight +
    ";max-height:" +
    modalMaxHeight +
    ";background:rgba(17,24,39,.96);border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 26px 80px rgba(0,0,0,.52);opacity:0;pointer-events:none;transition:opacity .18s ease, transform .18s ease;overflow:hidden;}" +
    "#onekey-rag-widget-overlay[data-open='true']{opacity:1;pointer-events:auto}" +
    "#onekey-rag-widget-modal[data-open='true']{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}" +
    "#onekey-rag-widget-iframe{border:0;width:100%;height:100%;background:transparent;}" +
    "@media (max-width: 640px){#onekey-rag-widget-modal{width:calc(100vw - 16px);height:calc(100vh - 16px);max-height:calc(100vh - 16px);border-radius:14px}}";
  document.head.appendChild(style);

  var container = document.createElement("div");
  container.id = containerId;

  var button = document.createElement("button");
  button.id = "onekey-rag-widget-button";
  button.type = "button";
  button.setAttribute("aria-label", buttonLabel || "打开文档助手");
  button.title = buttonLabel || "Ask AI";
  button.textContent = "AI";

  var overlay = document.createElement("div");
  overlay.id = "onekey-rag-widget-overlay";
  overlay.setAttribute("data-open", "false");

  var modal = document.createElement("div");
  modal.id = "onekey-rag-widget-modal";
  modal.setAttribute("data-open", "false");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  var iframe = document.createElement("iframe");
  iframe.id = "onekey-rag-widget-iframe";
  iframe.title = title;
  iframe.loading = "lazy";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";

  modal.appendChild(iframe);
  container.appendChild(button);
  container.appendChild(overlay);
  container.appendChild(modal);
  document.body.appendChild(container);

  var opened = false;
  var iframeLoaded = false;

  function buildIframeSrc() {
    var url = new URL(widgetBaseUrl);
    url.searchParams.set("model", model);
    url.searchParams.set("title", title);
    url.searchParams.set("parent_origin", window.location.origin);
    if (apiBase) url.searchParams.set("api_base", apiBase);
    if (contactUrl) url.searchParams.set("contact_url", contactUrl);
    return url.toString();
  }

  function sendContext() {
    if (!iframeLoaded || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      {
        type: "onekey_rag_widget:context",
        page_url: window.location.href,
        page_title: document.title,
      },
      widgetOrigin
    );
  }

  function open() {
    if (opened) return;
    opened = true;
    overlay.setAttribute("data-open", "true");
    modal.setAttribute("data-open", "true");
    if (!iframeLoaded) {
      iframe.src = buildIframeSrc();
      iframe.addEventListener(
        "load",
        function () {
          iframeLoaded = true;
          sendContext();
        },
        { once: true }
      );
    } else {
      sendContext();
    }
  }

  function close() {
    if (!opened) return;
    opened = false;
    overlay.setAttribute("data-open", "false");
    modal.setAttribute("data-open", "false");
    try {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: "onekey_rag_widget:host_closed" }, widgetOrigin);
      }
    } catch (e) {
      // ignore
    }
  }

  button.addEventListener("click", function () {
    open();
  });
  overlay.addEventListener("click", function () {
    close();
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== widgetOrigin) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "onekey_rag_widget:close") close();
    if (data.type === "onekey_rag_widget:open") open();
    if (data.type === "onekey_rag_widget:request_context") sendContext();
  });

  // 监听路由变化（适配 SPA 文档站）
  try {
    var _pushState = history.pushState;
    history.pushState = function () {
      var ret = _pushState.apply(this, arguments);
      sendContext();
      return ret;
    };
    var _replaceState = history.replaceState;
    history.replaceState = function () {
      var ret2 = _replaceState.apply(this, arguments);
      sendContext();
      return ret2;
    };
    window.addEventListener("popstate", function () {
      sendContext();
    });
  } catch (e) {
    // ignore
  }

  window[NS] = {
    __initialized: true,
    open: open,
    close: close,
    version: "0.1.0",
  };
})();
