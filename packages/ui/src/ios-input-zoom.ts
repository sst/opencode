export const IOS_INPUT_ZOOM_SCRIPT = `(function () {
  if (!/iPhone|iPod/.test(navigator.userAgent)) return;
  var root = document.documentElement;
  if (root.hasAttribute("data-ios-input-zoom")) return;
  root.setAttribute("data-ios-input-zoom", "");
  var OWN = "data-ios-input-zoom-meta";
  var own = null;
  function sources() {
    var list = document.querySelectorAll('meta[name="viewport"]');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].hasAttribute(OWN)) out.push(list[i]);
    }
    return out;
  }
  function derive(content) {
    var parts = content.split(",");
    var kept = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (part && part.split("=")[0].trim() !== "maximum-scale") kept.push(part);
    }
    kept.push("maximum-scale=1");
    return kept.join(", ");
  }
  function apply() {
    var metas = sources();
    for (var i = 0; i < metas.length; i++) {
      if (metas[i].getAttribute("data-ios-input-zoom") === "keep") {
        if (own && own.parentNode) {
          own.parentNode.removeChild(own);
          metas[i].setAttribute("content", metas[i].getAttribute("content") || "");
        }
        return;
      }
    }
    var last = metas.length ? metas[metas.length - 1] : null;
    var content = derive(last ? last.getAttribute("content") || "" : "");
    if (!own) {
      own = document.createElement("meta");
      own.setAttribute("name", "viewport");
      own.setAttribute(OWN, "");
    }
    if (document.head.lastElementChild !== own) document.head.appendChild(own);
    own.setAttribute("content", content);
  }
  apply();
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      if (records[i].target !== own) {
        apply();
        return;
      }
    }
  }).observe(document.head, {
    attributeFilter: ["content", "data-ios-input-zoom"],
    attributes: true,
    childList: true,
    subtree: true,
  });
})();`
