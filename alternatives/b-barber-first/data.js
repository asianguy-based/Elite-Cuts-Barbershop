// Data + store for Direction B.
// One store, two backends:
//   - API_URL empty  -> demo mode, everything lives in this browser's localStorage
//   - API_URL set    -> talks to the Cloudflare Worker in /worker (same endpoints + payloads)

export const API_URL = ''; // e.g. 'https://elite-cuts-api.example.workers.dev'

export const SHOP = {
  name: 'Elite Cuts',
  tagline: 'Barbering & grooming',
  phone: '+15552345678',
  address: '742 Evergreen Ave, Suite 100',
  depositAmount: 15,
  paymentLinkUrl: '', // Stripe payment link; client_reference_id=<refCode> is appended
  timeSlots: ['09:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '01:30 PM', '02:30 PM', '03:30 PM', '04:30 PM', '05:30 PM', '06:30 PM']
};

export const SERVICES = [
  { id: 'srv-1', name: 'The Executive Cut & Style', short: 'Cut & Style', price: 45, duration: 45, desc: 'Scissor or skin fade, hot lather neck shave and wash.' },
  { id: 'srv-2', name: 'Cut + Beard Sculpt & Hot Towel', short: 'Cut + Beard', price: 65, duration: 60, desc: 'Full haircut with straight-razor beard line-up.' },
  { id: 'srv-3', name: 'Traditional Straight Razor Shave', short: 'Razor Shave', price: 40, duration: 30, desc: 'Three hot towels, rich lather, double-pass razor finish.' },
  { id: 'srv-4', name: 'Beard Trim & Razor Line-Up', short: 'Beard Line-Up', price: 30, duration: 25, desc: 'Shape, taper, balm and crisp razor detailing.' }
];

export const BARBERS = [
  {
    id: 'brb-1', name: 'Marcus Vance', first: 'Marcus', handle: '@marcus.cuts', initials: 'MV',
    role: 'Master Barber', years: 12, rating: '5.0', reviews: 214,
    specialties: ['Skin fades', 'Beard sculpting', 'Razor shaves'],
    bio: 'Twelve years behind the chair. Sharp fades, clean beard work, no rush.'
  },
  {
    id: 'brb-2', name: 'Mateo Cruz', first: 'Mateo', handle: '@mateo.cruz', initials: 'MC',
    role: 'Senior Barber', years: 8, rating: '4.9', reviews: 167,
    specialties: ['Razor tapers', 'Crop cuts', 'Textured tops'],
    bio: 'Tapers and crops with texture that grows out right.'
  }
];

// "Looks" = the feed. `art` drives the SVG placeholder tile (no external images).
export const LOOKS = [
  { id: 'lk-skin-fade', name: 'Skin Fade', barberId: 'brb-1', serviceIds: ['srv-1'], tone: 'light', art: { fade: 0.75, top: 0.35, texture: 'crop' } },
  { id: 'lk-low-taper', name: 'Low Taper', barberId: 'brb-2', serviceIds: ['srv-1'], tone: 'dark', art: { fade: 0.25, top: 0.6, texture: 'curl' } },
  { id: 'lk-crop', name: 'Textured Crop', barberId: 'brb-2', serviceIds: ['srv-1'], tone: 'accent', art: { fade: 0.55, top: 0.45, texture: 'crop', fringe: true } },
  { id: 'lk-beard', name: 'Beard Sculpt', barberId: 'brb-1', serviceIds: ['srv-2'], tone: 'dark', art: { fade: 0.5, top: 0.3, texture: 'buzz', beard: true } },
  { id: 'lk-mid-drop', name: 'Mid Drop Fade', barberId: 'brb-1', serviceIds: ['srv-1'], tone: 'light', art: { fade: 0.5, top: 0.55, texture: 'slick' } },
  { id: 'lk-side-part', name: 'Side Part', barberId: 'brb-2', serviceIds: ['srv-1'], tone: 'light', art: { fade: 0.3, top: 0.6, texture: 'slick', part: true } },
  { id: 'lk-line-up', name: 'Razor Line-Up', barberId: 'brb-1', serviceIds: ['srv-4'], tone: 'accent', art: { fade: 0.4, top: 0.2, texture: 'buzz', beard: true } },
  { id: 'lk-buzz', name: 'Buzz + Taper', barberId: 'brb-2', serviceIds: ['srv-1'], tone: 'dark', art: { fade: 0.35, top: 0.12, texture: 'buzz' } },
  { id: 'lk-shave', name: 'Hot Towel Shave', barberId: 'brb-1', serviceIds: ['srv-3'], tone: 'light', art: { fade: 0.2, top: 0.4, texture: 'slick' } }
];

export const barberById = (id) => BARBERS.find((b) => b.id === id) || BARBERS[0];
export const serviceById = (id) => SERVICES.find((s) => s.id === id);
export const lookById = (id) => LOOKS.find((l) => l.id === id);
export const isLive = () => !!API_URL.trim();

// ---------- date / time helpers (local time, not UTC) ----------
export const pad = (n) => String(n).padStart(2, '0');
export const toDateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = () => toDateKey(new Date());
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return toDateKey(new Date(y, m - 1, d + n));
}
export function slotMinutes(slot) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(slot.trim());
  if (!m) return 0;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}
export function formatDay(key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}
export function isPastSlot(dateKey, slot) {
  if (dateKey !== todayKey()) return dateKey < todayKey();
  const now = new Date();
  return slotMinutes(slot) <= now.getHours() * 60 + now.getMinutes();
}
export const normalizePhone = (p) => String(p || '').replace(/\D/g, '');

// ---------- localStorage helpers (wrapped: storage can be blocked) ----------
const K_BOOKINGS = 'ELITE_CUTS_B_BOOKINGS_V1';
const K_LOYALTY = 'ELITE_CUTS_B_LOYALTY_V1';
const K_TOKEN = 'ELITE_CUTS_B_MANAGER_TOKEN';
function readLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

// ---------- Worker API ----------
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  let token = null;
  try { token = sessionStorage.getItem(K_TOKEN); } catch { /* ignore */ }
  if (token) headers['X-Manager-Token'] = token;
  const res = await fetch(API_URL.trim().replace(/\/+$/, '') + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---------- demo backend (mirrors worker/src/index.js behaviour) ----------
function demoAward(booking, points) {
  const db = readLS(K_LOYALTY, {});
  const key = normalizePhone(booking.clientPhone);
  const rec = db[key] || { points: 0, stamps: 0, history: [] };
  rec.name = booking.clientName;
  rec.phone = booking.clientPhone;
  rec.points = (rec.points || 0) + points;
  rec.stamps = ((rec.stamps || 0) + 1) % 11;
  rec.lastVisit = booking.date;
  rec.history = [{
    date: booking.date, time: booking.time, services: booking.services,
    barberName: booking.barberName, refCode: booking.refCode, status: booking.status
  }, ...(rec.history || [])].slice(0, 50);
  db[key] = rec;
  writeLS(K_LOYALTY, db);
}

const demo = {
  async slots(date, barberId) {
    const booked = readLS(K_BOOKINGS, [])
      .filter((b) => b.date === date && b.barberId === barberId && b.status !== 'Cancelled')
      .map((b) => b.time);
    return [...new Set(booked)];
  },
  async createBooking(body) {
    const all = readLS(K_BOOKINGS, []);
    if (all.some((b) => b.date === body.date && b.barberId === body.barberId && b.time === body.time && b.status !== 'Cancelled')) {
      return { ok: false, status: 409, error: 'That time is already booked' };
    }
    const isDeposit = body.paymentMode === 'deposit';
    const booking = {
      ...body,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      refCode: 'EC-' + String(Math.floor(1000 + Math.random() * 9000)),
      depositAmount: isDeposit ? body.depositAmount : 0,
      status: isDeposit ? 'Deposit Unpaid' : 'Confirmed',
      paid: false,
      createdAt: new Date().toISOString()
    };
    writeLS(K_BOOKINGS, [booking, ...all]);
    if (!isDeposit) demoAward(booking, 100);
    return { ok: true, booking };
  },
  async loyalty(phone) {
    const rec = readLS(K_LOYALTY, {})[normalizePhone(phone)] || { points: 0, stamps: 0, history: [] };
    return { points: rec.points || 0, stamps: rec.stamps || 0, history: (rec.history || []).slice(0, 10) };
  },
  async login(pin) { return pin === '1234' ? { ok: true } : { ok: false, error: 'Wrong PIN (demo PIN is 1234)' }; },
  async managerBookings(from, to) {
    return { ok: true, bookings: readLS(K_BOOKINGS, []).filter((b) => b.date >= from && b.date <= to) };
  },
  async patch(id, status) {
    const all = readLS(K_BOOKINGS, []);
    const b = all.find((x) => x.id === id);
    if (!b) return { ok: false, error: 'Booking not found' };
    if (status === 'Paid' && b.paymentMode === 'deposit' && !b.paid) {
      b.paid = true; b.paidAt = new Date().toISOString();
      demoAward({ ...b, status }, 150);
    }
    b.status = status;
    b.updatedAt = new Date().toISOString();
    writeLS(K_BOOKINGS, all);
    return { ok: true, booking: b };
  },
  async loyaltyCsv() {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = Object.values(readLS(K_LOYALTY, {}))
      .map((r) => [cell(r.name), cell(r.phone), r.points || 0, r.stamps || 0, cell(r.lastVisit)].join(','));
    return ['name,phone,points,stamps,lastVisit', ...rows].join('\n') + '\n';
  },
  seedToday() {
    const t = todayKey();
    const sample = [
      ['brb-1', '10:00 AM', 'Jordan Reyes', '5551230001', ['The Executive Cut & Style'], 'chair'],
      ['brb-1', '12:00 PM', 'Dev Patel', '5551230002', ['Cut + Beard Sculpt & Hot Towel'], 'deposit'],
      ['brb-1', '03:30 PM', 'Chris Okafor', '5551230003', ['Beard Trim & Razor Line-Up'], 'chair'],
      ['brb-2', '09:00 AM', 'Sam Lee', '5551230004', ['The Executive Cut & Style'], 'chair'],
      ['brb-2', '02:30 PM', 'Andre Moss', '5551230005', ['Traditional Straight Razor Shave'], 'chair']
    ];
    const all = readLS(K_BOOKINGS, []);
    for (const [barberId, time, clientName, clientPhone, services, paymentMode] of sample) {
      if (all.some((b) => b.date === t && b.barberId === barberId && b.time === time)) continue;
      const svc = SERVICES.filter((s) => services.includes(s.name));
      all.push({
        id: `seed-${barberId}-${slotMinutes(time)}-${t}`, refCode: 'EC-' + (1000 + slotMinutes(time)),
        services, totalCost: svc.reduce((a, s) => a + s.price, 0), totalMin: svc.reduce((a, s) => a + s.duration, 0),
        barberId, barberName: barberById(barberId).name, date: t, time, clientName, clientPhone, notes: '',
        paymentMode, depositAmount: paymentMode === 'deposit' ? SHOP.depositAmount : 0,
        status: paymentMode === 'deposit' ? 'Deposit Unpaid' : 'Confirmed', paid: false, createdAt: new Date().toISOString()
      });
    }
    writeLS(K_BOOKINGS, all);
  }
};

// ---------- public store ----------
export const store = {
  live: isLive,

  /** Times already taken for a barber on a date. */
  async bookedSlots(date, barberId) {
    if (!isLive()) return demo.slots(date, barberId);
    const r = await api(`/api/slots?date=${encodeURIComponent(date)}&barberId=${encodeURIComponent(barberId)}`);
    if (!r.ok) throw new Error(r.data.error || `HTTP ${r.status}`);
    return r.data.booked || [];
  },

  /** First `count` open slots for a barber, scanning up to 14 days ahead. */
  async nextOpenings(barberId, count = 3) {
    const out = [];
    let day = todayKey();
    for (let i = 0; i < 14 && out.length < count; i++, day = addDays(day, 1)) {
      const booked = await this.bookedSlots(day, barberId).catch(() => []);
      for (const slot of SHOP.timeSlots) {
        if (out.length >= count) break;
        if (!booked.includes(slot) && !isPastSlot(day, slot)) out.push({ date: day, time: slot });
      }
    }
    return out;
  },

  /** payload has the exact shape the Worker's POST /api/bookings expects. */
  async createBooking(payload) {
    if (!isLive()) return demo.createBooking(payload);
    const r = await api('/api/bookings', { method: 'POST', body: payload });
    if (r.ok && r.data.booking) return { ok: true, booking: r.data.booking };
    return { ok: false, status: r.status, error: r.data.error || `Server error ${r.status}` };
  },

  async loyalty(phone) {
    if (!isLive()) return demo.loyalty(phone);
    const r = await api(`/api/loyalty?phone=${encodeURIComponent(normalizePhone(phone))}`);
    if (!r.ok) throw new Error(r.data.error || `HTTP ${r.status}`);
    return r.data;
  },

  async managerLogin(pin) {
    if (!isLive()) return demo.login(pin);
    const r = await api('/api/manager/login', { method: 'POST', body: { pin } });
    if (!r.ok || !r.data.token) return { ok: false, error: r.data.error || 'Invalid PIN' };
    try { sessionStorage.setItem(K_TOKEN, r.data.token); } catch { /* ignore */ }
    return { ok: true };
  },

  async managerBookings(from, to = from) {
    if (!isLive()) return demo.managerBookings(from, to);
    const r = await api(`/api/manager/bookings?from=${from}&to=${to}`);
    if (!r.ok) return { ok: false, status: r.status, error: r.data.error || `HTTP ${r.status}` };
    return { ok: true, bookings: r.data.bookings || [] };
  },

  async setStatus(id, status) {
    if (!isLive()) return demo.patch(id, status);
    const r = await api(`/api/manager/bookings/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    return r.ok ? { ok: true, booking: r.data.booking } : { ok: false, error: r.data.error || `HTTP ${r.status}` };
  },

  async loyaltyCsv() {
    if (!isLive()) return demo.loyaltyCsv();
    const res = await api('/api/manager/loyalty.csv', { raw: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },

  seedDemoDay() { if (!isLive()) demo.seedToday(); }
};

// ---------- files the customer / manager can download ----------
export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function bookingIcs(b) {
  const [y, mo, d] = b.date.split('-').map(Number);
  const start = new Date(y, mo - 1, d, 0, slotMinutes(b.time));
  const end = new Date(start.getTime() + (b.totalMin || 45) * 60000);
  const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  const esc = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Elite Cuts//Booking//EN', 'BEGIN:VEVENT',
    `UID:${b.refCode}-${b.id}@elitecuts`, `DTSTAMP:${stamp}`,
    `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(`${SHOP.name} with ${b.barberName}`)}`,
    `DESCRIPTION:${esc(`${b.services.join(' + ')} | Ref ${b.refCode} | $${b.totalCost}`)}`,
    `LOCATION:${esc(SHOP.address)}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
}

export function bookingsCsv(rows) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['refCode', 'date', 'time', 'barber', 'client', 'phone', 'services', 'total', 'payment', 'status'];
  const lines = rows.map((b) => [b.refCode, b.date, b.time, b.barberName, b.clientName, b.clientPhone,
    (b.services || []).join(' + '), b.totalCost, b.paymentMode, b.status].map(cell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}
