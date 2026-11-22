/* The words the admin page has changed (its "Titles and text"), put into this page.
   The page is written with its own words, so it reads right straight away and if the settings can't
   be fetched; those that were changed are swapped in once the settings arrive. Each one goes in as
   plain text, never as HTML. The settings are fetched once and shared: window.MISOGI_SITE. */
(() => {
  const local = location.protocol === "file:";
  const got = window.MISOGI_SETTINGS ? Promise.resolve(window.MISOGI_SETTINGS)
    : local ? Promise.resolve(null)
    : fetch("/api/settings", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  window.MISOGI_SITE = got;
  const put = (v) => {
    const t = (v && v.text) || {};
    document.querySelectorAll("[data-text]").forEach((el) => {
      const w = t[el.dataset.text];
      if (typeof w === "string" && w.trim()) el.textContent = w;
    });
  };
  got.then((v) => { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => put(v)); else put(v); });
})();
