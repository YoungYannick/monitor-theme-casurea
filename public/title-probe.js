;(function () {
  var KEY = "casurea:site_name"
  var mark = function (source) { if (!window.__titleProbeSource) window.__titleProbeSource = source }
  var cached = null
  try {
    cached = localStorage.getItem(KEY)
  } catch {
  }
  if (cached) {
    document.title = cached
    mark("cache")
    return
  }
  if (!window.fetch) return
  fetch("/api/me?theme-title=1", { credentials: "same-origin" })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (!d || !d.site_name || window.__titleOwned) return
      document.title = d.site_name
      mark("fetch")
      try {
        localStorage.setItem(KEY, d.site_name)
      } catch {}
    })
    .catch(function () {})
})()
