// iOS-style interaction for the glass controls, on the browser's built-in
// Web Animations API — no animation library. Motion One and anime.js ship
// 118-140 KB browser bundles without a bundler, which would nearly double this
// app; both are thin wrappers over exactly the API used here.
//
// Two effects, matching how glass behaves on iOS:
//   1. the specular rim highlight turns to face the pointer
//   2. the surface compresses under a press and springs back on release

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// easeOutQuint: a fast start that decelerates hard into rest, the way a real
// surface returns. No overshoot — across a 0.96→1 scale change a bounce is
// imperceptible anyway, and the physicality comes from the press and the
// timing, not from rubber-banding past the target.
const SETTLE = 'cubic-bezier(.22, 1, .36, 1)';

/**
 * Points the highlight gradient at the pointer. The vendor stylesheet already
 * reads --gradient-angle in .liquid-glass::after and transitions it, so this
 * only has to keep the number current.
 */
function aimHighlight(node, event) {
  const r = node.getBoundingClientRect();
  const dx = event.clientX - (r.left + r.width / 2);
  const dy = event.clientY - (r.top + r.height / 2);
  // CSS gradient angles run clockwise from "up", the opposite of screen y.
  const deg = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
  node.style.setProperty('--gradient-angle', `${deg}deg`);
}

/**
 * Adds the dispersion rim — the coloured fringe real glass throws at its edges
 * when light bends through it, and the thing that makes iOS 26's glass read as
 * glass rather than as a frosted rectangle. Idle it is invisible; it blooms
 * under a press. Only glassed controls get one; a flat list row shouldn't.
 */
function ensureRim(node) {
  if (!node.querySelector(':scope > .liquid-glass')) return;
  if (node.querySelector(':scope > .rim')) return;
  const rim = document.createElement('span');
  rim.className = 'rim';
  rim.setAttribute('aria-hidden', 'true');
  node.append(rim);
}

function press(node, depth) {
  node.__pressed = true;
  node.classList.add('is-pressed');
  node.__settle?.cancel();
  node.__settle = null;
  node.__press?.cancel();
  node.__press = node.animate(
    [{ transform: `scale(${depth})` }],
    { duration: 130, easing: 'cubic-bezier(.3,0,.2,1)', fill: 'forwards' }
  );
}

function release(node, depth) {
  if (!node.__pressed) return;
  node.__pressed = false;
  node.classList.remove('is-pressed');

  const settle = node.animate(
    [{ transform: `scale(${depth})` }, { transform: 'scale(1)' }],
    { duration: reduced.matches ? 120 : 420, easing: reduced.matches ? 'ease-out' : SETTLE, fill: 'forwards' }
  );
  node.__settle = settle;

  // The press also fills forwards. Started before this settle is cleaned up, it
  // would take over again the moment the settle is cancelled and leave the
  // control stuck compressed — visible after a few fast taps. Retire it now;
  // the settle's own first keyframe holds the compressed pose meanwhile.
  node.__press?.cancel();
  node.__press = null;

  // Hand the element back to CSS once it has settled, so nothing accumulates.
  settle.finished
    .then(() => {
      if (node.__settle !== settle) return; // a newer press already took over
      settle.cancel();
      node.__settle = null;
    })
    .catch(() => {});
}

/**
 * @param {Element} node
 * @param {number} depth how far the surface compresses (1 = not at all)
 */
export function interactive(node, depth = 0.96) {
  if (!node || node.dataset.motion) return;
  node.dataset.motion = '1';
  ensureRim(node);

  node.addEventListener('pointermove', (e) => aimHighlight(node, e));
  node.addEventListener('pointerdown', (e) => {
    aimHighlight(node, e);
    press(node, depth);
  });

  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) {
    node.addEventListener(event, () => release(node, depth));
  }

  // Keyboard activation gets the same feedback as a tap.
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') press(node, depth);
  });
  node.addEventListener('keyup', () => release(node, depth));

  // A pointer leaving the window never fires pointerup on the element.
  node.addEventListener('blur', () => release(node, depth));
}

export function interactiveAll(nodes, depth) {
  for (const node of nodes) interactive(node, depth);
}
