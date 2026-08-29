(() => {
  const NS = 'http://www.w3.org/2000/svg';

  function wrap(node, transform) {
    if (!node || node.parentElement?.dataset?.sceneFixWrapper === 'true') return;
    const wrapper = document.createElementNS(NS, 'g');
    wrapper.dataset.sceneFixWrapper = 'true';
    wrapper.setAttribute('transform', transform);
    node.parentNode.insertBefore(wrapper, node);
    wrapper.appendChild(node);
  }

  function adjustScene() {
    const svg = document.querySelector('.landing-scene svg');
    if (!svg || svg.dataset.sceneFixed === 'true') return;
    svg.dataset.sceneFixed = 'true';

    const star = svg.querySelector('.bethlehem-star');
    if (star) star.style.animationDuration = '18s';
    wrap(star, 'translate(0 72)');

    const firstCamel = svg.querySelector('use[href="#camel"]');
    const caravan = firstCamel?.parentElement;
    if (caravan) caravan.remove();

    const scene = document.querySelector('.landing-scene');
    if (scene) {
      scene.style.background = 'radial-gradient(circle at 66% 26%, #0b1b45 0%, #050b21 42%, #02040f 100%)';
    }
  }

  function adjustLandingActions() {
    const actions = document.querySelector('.landing-actions');
    const submit = document.getElementById('submitNativity');
    const tour = actions?.querySelector('a[href="/tour.html"]');
    if (!actions || !tour) return;

    tour.textContent = '“Scroll” to the Stable';
    if (submit) actions.insertBefore(submit, tour);
  }

  async function applySubmissionSetting() {
    try {
      const response = await fetch('/api/settings', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) return;
      const settings = await response.json();
      if (settings.submissionsOpen === false) {
        document.getElementById('submitNativity')?.remove();
        document.getElementById('submitDialog')?.remove();
      }
    } catch {
      // Backend creation remains authoritative if this display check fails.
    }
  }

  function init() {
    adjustScene();
    adjustLandingActions();
    applySubmissionSetting();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
