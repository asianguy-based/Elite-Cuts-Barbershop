// App shell: which tab is showing, which sheet is open, and whether we're mid-booking.
import { render } from './vendor/preact.module.js';
import { useEffect, useState } from './vendor/hooks.module.js';
import { html } from './components/ui.js';
import { TopBar, TabBar, TABS } from './components/Nav.js';
import { Feed } from './components/Feed.js';
import { Barbers } from './components/Barbers.js';
import { Rewards } from './components/Rewards.js';
import { BarberSheet } from './components/BarberSheet.js';
import { BookingFlow } from './components/BookingFlow.js';
import { Admin } from './components/Admin.js';
import { SHOP } from './data.js';

const isAdmin = new URLSearchParams(location.search).get('portal') === 'admin';
const tabFromHash = () => (TABS.some((t) => '#' + t.id === location.hash) ? location.hash.slice(1) : 'looks');

function App() {
  const [tab, setTab] = useState(tabFromHash);
  const [sheet, setSheet] = useState(null); // { barberId, look }
  const [booking, setBooking] = useState(null); // { barberId, look, opening }

  useEffect(() => {
    const onHash = () => {
      if (location.hash && !TABS.some((t) => '#' + t.id === location.hash)) return; // e.g. #main from the skip link
      setTab(tabFromHash()); setBooking(null); setSheet(null);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const go = (id) => {
    setBooking(null); setSheet(null); setTab(id);
    if (location.hash !== '#' + id) history.pushState(null, '', '#' + id);
    scrollTo(0, 0);
    requestAnimationFrame(() => { const h = document.querySelector('main h1'); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); } });
  };
  const openLook = (look) => setSheet({ barberId: look.barberId, look });
  const openBarber = (barberId) => setSheet({ barberId, look: null });
  const startBooking = (barberId, look, opening) => { setSheet(null); setBooking({ barberId, look, opening }); scrollTo(0, 0); };

  if (isAdmin) {
    return html`<${TopBar} admin /><main id="main" class="main main--admin"><${Admin} /></main>`;
  }

  let view;
  if (booking) view = html`<${BookingFlow} init=${booking} onExit=${() => setBooking(null)} onRewards=${() => go('rewards')} />`;
  else if (tab === 'barbers') view = html`<${Barbers} onProfile=${openBarber} onBook=${startBooking} />`;
  else if (tab === 'rewards') view = html`<${Rewards} />`;
  else view = html`<${Feed} onOpenLook=${openLook} />`;

  return html`
    <a class="skip" href="#main" onClick=${(e) => { e.preventDefault(); document.getElementById('main').focus(); }}>Skip to content</a>
    <${TopBar} tab=${tab} onTab=${go} />
    <main id="main" tabindex="-1" class=${'main' + (booking ? ' main--booking' : '')}>${view}</main>
    <footer class="footer"><p>${SHOP.address}</p><p><a class="link" href=${'tel:' + SHOP.phone}>Call the shop</a></p></footer>
    ${!booking && html`<${TabBar} tab=${tab} onTab=${go} />`}
    ${sheet && html`<${BarberSheet} key=${sheet.barberId + (sheet.look ? sheet.look.id : '')} barberId=${sheet.barberId} look=${sheet.look}
      onClose=${() => setSheet(null)} onBook=${startBooking} onOpenLook=${openLook} />`}`;
}

render(html`<${App} />`, document.getElementById('app'));
