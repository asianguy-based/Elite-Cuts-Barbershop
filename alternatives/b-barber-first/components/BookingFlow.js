// Booking: service -> day & time -> contact + confirm -> done (ref code + .ics).
// The barber is already chosen (from the look or profile), which is the point of this direction.
import { useEffect, useState } from '../vendor/hooks.module.js';
import { html, Icon, money, useFocusOnMount, Avatar } from './ui.js';
import {
  SHOP, SERVICES, barberById, serviceById, store, todayKey, addDays, formatDay, isPastSlot,
  normalizePhone, bookingIcs, download
} from '../data.js';
import { dayLabel } from './BarberSheet.js';

const STEPS = ['Service', 'Time', 'Details'];

function StepHeader({ step, title, onBack }) {
  const ref = useFocusOnMount();
  return html`
    <div class="step-head">
      <button type="button" class="icon-btn" onClick=${onBack} aria-label=${step === 0 ? 'Cancel booking' : 'Back'}>${Icon.back}</button>
      <ol class="progress" aria-label="Booking progress">
        ${STEPS.map((s, i) => html`<li class=${i <= step ? 'on' : ''} aria-current=${i === step ? 'step' : undefined}><span class="sr-only">Step ${i + 1}: </span>${s}</li>`)}
      </ol>
    </div>
    <h1 class="display display--md" tabindex="-1" ref=${ref}>${title}</h1>`;
}

function Summary({ barber, services, date, time }) {
  const total = services.reduce((a, s) => a + s.price, 0);
  const mins = services.reduce((a, s) => a + s.duration, 0);
  return html`
    <aside class="summary" aria-label="Your booking so far">
      <${Avatar} barber=${barber} size="sm" />
      <div>
        <p class="summary__who">${barber.name}</p>
        <p class="muted small">${services.length ? services.map((s) => s.short).join(' + ') : 'No service yet'}${date ? ` / ${dayLabel(date)}` : ''}${time ? ` ${time}` : ''}</p>
      </div>
      <p class="summary__total">${money(total)}<span class="muted small"> ${mins} min</span></p>
    </aside>`;
}

function ServiceStep({ state, set, next, back, look }) {
  const toggle = (id) => set({ serviceIds: state.serviceIds.includes(id) ? state.serviceIds.filter((x) => x !== id) : [...state.serviceIds, id] });
  return html`
    <${StepHeader} step=${0} title="What are we doing?" onBack=${back} />
    ${look && html`<p class="muted">Suggested for <strong class="fg">${look.name}</strong>. Add or swap anything.</p>`}
    <ul class="services">
      ${SERVICES.map((s) => {
        const on = state.serviceIds.includes(s.id);
        const suggested = look && look.serviceIds.includes(s.id);
        return html`<li>
          <button type="button" class=${'service' + (on ? ' is-on' : '')} aria-pressed=${on ? 'true' : 'false'} onClick=${() => toggle(s.id)}>
            <span class="service__check" aria-hidden="true">${on ? Icon.check : ''}</span>
            <span class="service__main">
              <span class="service__name">${s.name}${suggested ? html` <span class="badge">Suggested</span>` : ''}</span>
              <span class="muted small">${s.desc}</span>
            </span>
            <span class="service__price">${money(s.price)}<span class="muted small">${s.duration} min</span></span>
          </button></li>`;
      })}
    </ul>
    <div class="sticky-cta">
      <button type="button" class="btn btn--primary btn--block" disabled=${!state.serviceIds.length} onClick=${next}>Choose a time</button>
    </div>`;
}

function TimeStep({ state, set, next, back, barber, error }) {
  const days = Array.from({ length: 10 }, (_, i) => addDays(todayKey(), i));
  const [booked, setBooked] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    setBooked(null); setErr('');
    store.bookedSlots(state.date, barber.id)
      .then((b) => alive && setBooked(b))
      .catch(() => { if (alive) { setBooked([]); setErr('Could not check live availability. Times shown may already be taken.'); } });
    return () => { alive = false; };
  }, [state.date, barber.id]);
  const slots = SHOP.timeSlots.filter((s) => !isPastSlot(state.date, s));
  return html`
    <${StepHeader} step=${1} title=${`When works?`} onBack=${back} />
    <fieldset class="field-group">
      <legend class="h3">Day</legend>
      <div class="days" role="group">
        ${days.map((d) => html`
          <button type="button" class="day" aria-pressed=${state.date === d ? 'true' : 'false'} onClick=${() => set({ date: d, time: '' })}
            aria-label=${formatDay(d, { weekday: 'long', month: 'long', day: 'numeric' })}>
            <span class="day__dow">${d === todayKey() ? 'Today' : formatDay(d, { weekday: 'short' })}</span>
            <span class="day__num">${formatDay(d, { day: 'numeric' })}</span>
          </button>`)}
      </div>
    </fieldset>
    <fieldset class="field-group">
      <legend class="h3">Time with ${barber.first}</legend>
      ${(error || err) && html`<p class="notice" role="alert">${error || err}</p>`}
      ${booked === null ? html`<p class="muted" role="status">Loading times...</p>`
        : slots.length === 0 ? html`<p class="muted">No times left today. Pick another day.</p>`
        : html`<div class="times" role="group">
          ${slots.map((s) => {
            const taken = booked.includes(s);
            return html`<button type="button" class="time" disabled=${taken} aria-pressed=${state.time === s ? 'true' : 'false'}
              onClick=${() => set({ time: s })}>${s}${taken ? html`<span class="sr-only"> (booked)</span>` : ''}</button>`;
          })}
        </div>`}
    </fieldset>
    <div class="sticky-cta">
      <button type="button" class="btn btn--primary btn--block" disabled=${!state.time} onClick=${next}>Continue</button>
    </div>`;
}

function DetailsStep({ state, set, back, submit, busy, error, barber, services }) {
  const total = services.reduce((a, s) => a + s.price, 0);
  const onSubmit = (e) => { e.preventDefault(); submit(); };
  return html`
    <${StepHeader} step=${2} title="Lock it in" onBack=${back} />
    <form class="form" onSubmit=${onSubmit} novalidate>
      <div class="field">
        <label for="f-name">Name</label>
        <input id="f-name" name="name" autocomplete="name" required value=${state.clientName} onInput=${(e) => set({ clientName: e.target.value })} />
      </div>
      <div class="field">
        <label for="f-phone">Mobile number</label>
        <input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required aria-describedby="f-phone-hint"
          value=${state.clientPhone} onInput=${(e) => set({ clientPhone: e.target.value })} />
        <p id="f-phone-hint" class="muted small">Your number is also your rewards card.</p>
      </div>
      <div class="field">
        <label for="f-notes">Notes for ${barber.first} <span class="muted">(optional)</span></label>
        <textarea id="f-notes" rows="2" value=${state.notes} onInput=${(e) => set({ notes: e.target.value })}></textarea>
      </div>
      <fieldset class="field-group">
        <legend class="h3">Payment</legend>
        <label class="radio">
          <input type="radio" name="pay" value="chair" checked=${state.paymentMode === 'chair'} onChange=${() => set({ paymentMode: 'chair' })} />
          <span><strong>Pay at the chair</strong><span class="muted small"> ${money(total)} after your cut. +100 pts</span></span>
        </label>
        <label class="radio">
          <input type="radio" name="pay" value="deposit" checked=${state.paymentMode === 'deposit'} onChange=${() => set({ paymentMode: 'deposit' })} />
          <span><strong>${money(SHOP.depositAmount)} deposit now</strong><span class="muted small"> Holds the chair. +150 pts once paid</span></span>
        </label>
      </fieldset>
      <dl class="review">
        <div><dt>Barber</dt><dd>${barber.name}</dd></div>
        <div><dt>When</dt><dd>${formatDay(state.date, { weekday: 'long', month: 'short', day: 'numeric' })}, ${state.time}</dd></div>
        <div><dt>Service</dt><dd>${services.map((s) => s.name).join(' + ')}</dd></div>
        <div><dt>Total</dt><dd>${money(total)}</dd></div>
      </dl>
      ${error && html`<p class="notice" role="alert">${error}</p>`}
      <div class="sticky-cta">
        <button type="submit" class="btn btn--primary btn--block" disabled=${busy}>${busy ? 'Booking...' : 'Confirm booking'}</button>
      </div>
    </form>`;
}

function Done({ booking, onFinish, onRewards }) {
  const ref = useFocusOnMount();
  const pending = booking.paymentMode === 'deposit';
  return html`
    <div class="done">
      <p class="kicker">Booked</p>
      <h1 class="display" tabindex="-1" ref=${ref}>You're in.</h1>
      <p class="ref" aria-label=${`Reference code ${booking.refCode}`}>${booking.refCode}</p>
      <p>${booking.services.join(' + ')} with <strong>${booking.barberName}</strong>${', '}${formatDay(booking.date, { weekday: 'long', month: 'short', day: 'numeric' })} at ${booking.time}.</p>
      <p class="muted">${pending ? `Pay the ${money(booking.depositAmount)} deposit to hold the chair. 150 points land once it's paid.` : '100 points added to your rewards card.'}</p>
      <div class="row row--wrap">
        <button type="button" class="btn btn--primary" onClick=${() => download(`${booking.refCode}.ics`, bookingIcs(booking), 'text/calendar;charset=utf-8')}>
          ${Icon.calendar}<span>Add to calendar</span>
        </button>
        <button type="button" class="btn btn--ghost" onClick=${onRewards}>See rewards</button>
        <button type="button" class="btn btn--ghost" onClick=${onFinish}>Back to looks</button>
      </div>
    </div>`;
}

export function BookingFlow({ init, onExit, onRewards }) {
  const barber = barberById(init.barberId);
  const [step, setStep] = useState(0);
  const [state, setState] = useState({
    serviceIds: init.look ? [...init.look.serviceIds] : ['srv-1'],
    date: init.opening ? init.opening.date : todayKey(),
    time: init.opening ? init.opening.time : '',
    clientName: '', clientPhone: '', notes: '', paymentMode: 'chair'
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [booking, setBooking] = useState(null);
  const set = (patch) => setState((s) => ({ ...s, ...patch }));
  const services = state.serviceIds.map(serviceById).filter(Boolean);

  // If they tapped a specific opening, skip straight past the time step once a service is chosen.
  const afterService = () => setStep(init.opening && state.time ? 2 : 1);

  async function submit() {
    setError('');
    if (!state.clientName.trim() || !normalizePhone(state.clientPhone)) {
      setError('Add your name and a mobile number so we can confirm.');
      return;
    }
    setBusy(true);
    const isDeposit = state.paymentMode === 'deposit';
    const payload = {
      services: services.map((s) => s.name),
      totalCost: services.reduce((a, s) => a + s.price, 0),
      totalMin: services.reduce((a, s) => a + s.duration, 0),
      barberId: barber.id, barberName: barber.name,
      date: state.date, time: state.time,
      clientName: state.clientName.trim(), clientPhone: state.clientPhone.trim(), notes: state.notes.trim(),
      paymentMode: state.paymentMode,
      depositAmount: isDeposit ? SHOP.depositAmount : 0
    };
    let res;
    try { res = await store.createBooking(payload); } catch { res = { ok: false, error: 'Could not reach the booking server. Check your connection.' }; }
    setBusy(false);
    if (res.status === 409) { setError('That time was just taken. Pick another.'); set({ time: '' }); setStep(1); return; }
    if (!res.ok) { setError(res.error || 'Booking failed.'); return; }
    try { localStorage.setItem('ELITE_CUTS_B_LAST_PHONE', payload.clientPhone); } catch { /* ignore */ }
    if (isDeposit && SHOP.paymentLinkUrl) {
      const sep = SHOP.paymentLinkUrl.includes('?') ? '&' : '?';
      window.open(`${SHOP.paymentLinkUrl}${sep}client_reference_id=${encodeURIComponent(res.booking.refCode)}`, '_blank', 'noopener');
    }
    setBooking(res.booking);
  }

  let body;
  if (booking) body = html`<${Done} booking=${booking} onFinish=${onExit} onRewards=${onRewards} />`;
  else if (step === 0) body = html`<${ServiceStep} state=${state} set=${set} look=${init.look} next=${afterService} back=${onExit} />`;
  else if (step === 1) body = html`<${TimeStep} state=${state} set=${set} barber=${barber} error=${error} next=${() => { setError(''); setStep(2); }} back=${() => setStep(0)} />`;
  else body = html`<${DetailsStep} state=${state} set=${set} barber=${barber} services=${services} busy=${busy} error=${error}
    submit=${submit} back=${() => setStep(1)} />`;

  return html`
    <section class="booking" aria-label=${`Booking with ${barber.name}`}>
      <div class="booking__main" key=${booking ? 'done' : step}>${body}</div>
      ${!booking && html`<div class="booking__side"><${Summary} barber=${barber} services=${services} date=${step > 0 || state.time ? state.date : ''} time=${state.time} /></div>`}
    </section>`;
}
