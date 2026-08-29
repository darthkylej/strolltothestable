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

    // Keep the guiding star comfortably inside the visible safe area and
    // slow its existing pulse animation to one quarter of its original speed.
    const star = svg.querySelector('.bethlehem-star');
    if (star) star.style.animationDuration = '18s';
    wrap(star, 'translate(0 72)');

    // Remove the Wise Men and camel caravan entirely. The landing artwork is
    // intentionally limited to the night sky, stars, guiding star, horizon,
    // and desert landscape.
    const firstCamel = svg.querySelector('use[href="#camel"]');
    const caravan = firstCamel?.parentElement;
    if (caravan) caravan.remove();

    const scene = document.querySelector('.landing-scene');
    if (scene) {
      scene.style.background = 'radial-gradient(circle at 66% 26%, #0b1b45 0%, #050b21 42%, #02040f 100%)';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', adjustScene, { once: true });
  } else {
    adjustScene();
  }
})();
