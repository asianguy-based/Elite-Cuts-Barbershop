// Shared building blocks: the html`` tag, a modal sheet, icons, small helpers.
import { h } from '../vendor/preact.module.js';
import { useEffect, useRef } from '../vendor/hooks.module.js';
import htm from '../vendor/htm.module.js';

export const html = htm.bind(h);

/** Native <dialog> as a bottom sheet (mobile) / side panel (desktop). Gives Esc + focus trap for free. */
export function Sheet({ label, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement;
    if (d && !d.open) d.showModal();
    return () => { if (opener && opener.focus) opener.focus(); };
  }, []);
  const onCancel = (e) => { e.preventDefault(); onClose(); };
  const onClick = (e) => { if (e.target === ref.current) onClose(); }; // click on backdrop
  return html`
    <dialog ref=${ref} class=${'sheet' + (wide ? ' sheet--wide' : '')} aria-label=${label} onCancel=${onCancel} onClick=${onClick}>
      <div class="sheet__inner">
        <button type="button" class="icon-btn sheet__close" onClick=${onClose} aria-label="Close">${Icon.close}</button>
        ${children}
      </div>
    </dialog>`;
}

const svg = (d, extra = '') => html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">${d}${extra}</svg>`;

export const Icon = {
  grid: svg(html`<path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"/>`),
  people: svg(html`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.7 3 2.4 3.5 5.2"/>`),
  stamp: svg(html`<rect x="3" y="5" width="18" height="14"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><path d="M12 9v6"/>`),
  close: svg(html`<path d="M5 5l14 14M19 5L5 19"/>`),
  back: svg(html`<path d="M15 4l-8 8 8 8"/>`),
  check: svg(html`<path d="M4 12l5 5L20 6"/>`),
  star: html`<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.2l7.1-.6z"/></svg>`,
  calendar: svg(html`<rect x="3" y="5" width="18" height="16"/><path d="M3 10h18M8 3v4M16 3v4"/>`)
};

export const money = (n) => `$${Number(n || 0).toFixed(0)}`;

/** Focus a heading after a view change so screen readers announce it. */
export function useFocusOnMount() {
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus({ preventScroll: false }); }, []);
  return ref;
}

/** Monogram avatar block — stands in for a real portrait photo. */
export function Avatar({ barber, size = 'md' }) {
  return html`<div class=${`avatar avatar--${size}`} aria-hidden="true"><span>${barber.initials}</span></div>`;
}
