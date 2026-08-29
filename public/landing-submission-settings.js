(() => {
  async function applySubmissionSetting() {
    try {
      const response = await fetch('/api/settings', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const settings = await response.json();
      if (settings.submissionsOpen === false) {
        const button = document.getElementById('submitNativity');
        if (button) button.remove();
        const dialog = document.getElementById('submitDialog');
        if (dialog) dialog.remove();
      }
    } catch {
      // If the availability check fails, backend submission creation still
      // enforces the current setting.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applySubmissionSetting, { once: true });
  } else {
    applySubmissionSetting();
  }
})();
