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

  function improveCamelSymbol(svg) {
    const camel = svg.querySelector('symbol#camel');
    if (!camel) return;

    camel.setAttribute('viewBox', '-90 -95 180 150');
    camel.innerHTML = `
      <g fill="#03050a" stroke="#03050a" stroke-linecap="round" stroke-linejoin="round">
        <ellipse cx="0" cy="1" rx="48" ry="18"/>
        <path d="M-25 -8 C-18 -31 -7 -38 2 -18 C12 -39 25 -31 31 -8 Z"/>
        <path d="M31 -6 C43 -18 49 -34 51 -50 C53 -64 61 -74 72 -74" fill="none" stroke-width="11"/>
        <ellipse cx="80" cy="-73" rx="12" ry="7" transform="rotate(-8 80 -73)"/>
        <path d="M87 -74 L96 -70 L87 -67 Z"/>
        <path d="M73 -80 L76 -88 L80 -80 Z"/>
        <circle cx="83" cy="-75" r="1.3" fill="#172033" stroke="none"/>
        <path d="M-46 -2 Q-63 -15 -72 -6 Q-76 -2 -71 2" fill="none" stroke-width="4"/>

        <path d="M-31 14 L-34 32 L-44 50" fill="none" stroke-width="7"/>
        <path d="M-12 16 L-9 34 L-14 51" fill="none" stroke-width="7"/>
        <path d="M22 16 L18 34 L25 51" fill="none" stroke-width="7"/>
        <path d="M39 12 L43 31 L51 48" fill="none" stroke-width="7"/>
        <path d="M-48 50 L-39 50 M-18 51 L-9 51 M21 51 L30 51 M47 48 L56 48" fill="none" stroke-width="4"/>

        <path d="M-30 -10 Q0 -21 31 -10" fill="none" stroke-width="3" opacity="0.8"/>
        <circle cx="1" cy="-45" r="9"/>
        <path d="M-10 -36 Q1 -30 12 -36 L20 -7 L-18 -7 Z"/>
        <path d="M-2 -55 L7 -46 L-10 -46 Z"/>
        <path d="M13 -31 L31 -16" fill="none" stroke-width="4"/>
      </g>`;
  }

  function adjustScene() {
    const svg = document.querySelector('.landing-scene svg');
    if (!svg || svg.dataset.sceneFixed === 'true') return;
    svg.dataset.sceneFixed = 'true';

    improveCamelSymbol(svg);

    // The original 4:3 artwork is displayed with SVG "slice" behavior. On
    // modern wide screens that crops the top and bottom. Move the important
    // subjects inward so the full guiding star and caravan stay visible.
    const star = svg.querySelector('.bethlehem-star');
    wrap(star, 'translate(0 72)');

    const firstCamel = svg.querySelector('use[href="#camel"]');
    const caravan = firstCamel?.parentElement;
    if (caravan) wrap(caravan, 'translate(-42 -82)');

    // Keep the composition centered on narrow portrait screens where the
    // horizontal crop is much stronger than on desktop.
    const applyResponsiveFraming = () => {
      const portrait = window.innerHeight > window.innerWidth * 1.2;
      svg.setAttribute('preserveAspectRatio', portrait ? 'xMidYMid slice' : 'xMidYMid slice');

      const scene = document.querySelector('.landing-scene');
      if (scene) {
        scene.style.background = 'radial-gradient(circle at 66% 26%, #0b1b45 0%, #050b21 42%, #02040f 100%)';
      }
    };

    applyResponsiveFraming();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', adjustScene, { once: true });
  } else {
    adjustScene();
  }
})();
