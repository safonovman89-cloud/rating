(() => {
  const storageKey = 'i16-theme';
  const themes = new Map([
    ['system', 'Системная'],
    ['light', 'Светлая'],
    ['dark', 'Тёмная'],
    ['aurora', 'Северное сияние'],
  ]);
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  let picker;
  try {
    const saved = localStorage.getItem(storageKey);
    if (themes.has(saved)) preference = saved;
  } catch {
    // A private browsing policy may block storage.
  }

  function applyTheme() {
    const systemTheme = system.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = preference === 'system' ? systemTheme : preference;
    if (picker) picker.value = preference;
  }

  applyTheme();
  system.addEventListener('change', applyTheme);
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = themes.has(event.newValue) ? event.newValue : 'system';
    applyTheme();
  });

  document.addEventListener('DOMContentLoaded', () => {
    picker = document.querySelector('#theme');
    picker.replaceChildren(...Array.from(themes, ([value, label]) => new Option(label, value)));
    applyTheme();
    picker.closest('label').hidden = false;
    picker.addEventListener('change', () => {
      preference = picker.value;
      applyTheme();
      try {
        localStorage.setItem(storageKey, preference);
      } catch {
        // The theme still applies to the current page.
      }
    });
  });
})();
