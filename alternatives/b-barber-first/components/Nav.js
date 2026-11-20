// Top bar (brand + desktop tabs) and the mobile bottom tab bar. Same tab list drives both.
import { html, Icon } from './ui.js';

export const TABS = [
  { id: 'looks', label: 'Looks', icon: Icon.grid },
  { id: 'barbers', label: 'Barbers', icon: Icon.people },
  { id: 'rewards', label: 'Rewards', icon: Icon.stamp }
];

export function TopBar({ tab, onTab, admin = false }) {
  return html`
    <header class="topbar">
      <a class="brand" href="./" onClick=${(e) => { if (!admin) { e.preventDefault(); onTab('looks'); } }}>
        <span class="brand__mark" aria-hidden="true">EC</span><span class="brand__name">Elite Cuts</span>
      </a>
      ${!admin && html`<nav class="topnav" aria-label="Main">
        ${TABS.map((t) => html`<a href=${'#' + t.id} class="topnav__link" aria-current=${tab === t.id ? 'page' : undefined}
          onClick=${(e) => { e.preventDefault(); onTab(t.id); }}>${t.label}</a>`)}
      </nav>`}
      ${!admin && html`<a class="btn btn--sm btn--ghost topbar__call" href="tel:+15552345678">Call shop</a>`}
    </header>`;
}

export function TabBar({ tab, onTab }) {
  return html`
    <nav class="tabbar" aria-label="Main">
      ${TABS.map((t) => html`<a href=${'#' + t.id} class="tabbar__item" aria-current=${tab === t.id ? 'page' : undefined}
        onClick=${(e) => { e.preventDefault(); onTab(t.id); }}>${t.icon}<span>${t.label}</span></a>`)}
    </nav>`;
}
