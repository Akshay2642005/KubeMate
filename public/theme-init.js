/* Restores the persisted theme before first paint so a dark-mode user never
   sees a flash of the light theme (and vice versa) on refresh. Keep in sync
   with the class contract used by ThemeProvider (.light/.dark on <html>). */
(function () {
  try {
    var stored = window.localStorage.getItem("theme")
    var theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system"
    var dark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
    var root = document.documentElement
    root.classList.remove("light", "dark")
    root.classList.add(dark ? "dark" : "light")
    root.style.colorScheme = dark ? "dark" : "light"
  } catch {}
})()
