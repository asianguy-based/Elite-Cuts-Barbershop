// Shop configuration: defaults + the tenant overrides saved in localStorage.
// With the Worker backend, the shared shop profile (SHARED_FIELDS) is published by the manager to
// GET /api/shop and every client loads it on start; localStorage then only caches it for a fast,
// offline-friendly first paint. apiBaseUrl stays per-device, since it is how the app finds the API.

export const STORAGE_KEY_CONFIG = 'ELITE_CUTS_H5_CONFIG_V1';

export const DEFAULT_CONFIG = {
  shopName: 'ELITE CUTS',
  tagline: 'Master Barbering & Grooming Lounge',
  phone: '+15552345678',
  address: '742 Evergreen Ave, Suite 100 • Free Validated Garage Parking',
  primaryColor: '#1a1a2e',
  accentColor: '#d4af37',
  webhookUrl: '',
  licenseKey: 'EC-ENTERPRISE-LICENSE-ACTIVE',
  depositAmount: 15,
  paymentLinkUrl: '',
  apiBaseUrl: 'https://elite-cuts-api.voxlibera.workers.dev',
  requireDeposit: false,
  // Online payment options (Stripe Checkout through the Worker). Each shows only when the API says it works.
  depositEnabled: true,
  prepayEnabled: true,
  walletEnabled: true,
  walletTopUps: [25, 50, 100],
  // Client reviews shown on the home screen. While reviewsAreSamples is true the app labels them
  // "Sample reviews", so a demo never passes made-up quotes off as real ones. A shop swaps in its
  // own reviews from the manager portal and turns the label off.
  reviewsAreSamples: true,
  reviews: [
    { name: 'Sample Client A.', stars: 5, text: 'Booked my fade from my phone in under a minute and walked straight into the chair.' },
    { name: 'Sample Client B.', stars: 5, text: 'Love the stamp card. My 10th cut was on the house.' },
    { name: 'Sample Client C.', stars: 5, text: 'Picked my barber, picked a time, done. No phone tag.' }
  ],
  services: [
    { id: 'srv-1', name: 'The Executive Cut & Style', price: 45, duration: 45, category: 'Hair', desc: 'Precision scissor or skin fade, hot lather neck shave & invigorating wash.' },
    { id: 'srv-2', name: 'Cut + Beard Sculpt & Hot Towel', price: 65, duration: 60, category: 'Combo', desc: 'Full bespoke haircut paired with straight-razor beard line-up and essential oils.' },
    { id: 'srv-3', name: 'Traditional Straight Razor Shave', price: 40, duration: 30, category: 'Shave', desc: 'Three hot towels, rich sandalwood lather, double-pass straight razor finish.' },
    { id: 'srv-4', name: 'Beard Trim & Razor Line-Up', price: 30, duration: 25, category: 'Beard', desc: 'Shape, taper, conditioning balm, and crisp cheek/neck razor detailing.' }
  ],
  barbers: [
    { id: 'brb-1', firstName: 'Marcus', lastName: 'Vance', name: 'Marcus Vance', folder: 'marcus_vance', photoFilename: 'marcus_vance_001.jpg', role: 'Master Barber • 12 Yrs', specialty: 'Skin Fades & Beard Sculpting', rating: '5.0', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=240&q=80' },
    { id: 'brb-2', firstName: 'Mateo', lastName: 'Cruz', name: 'Mateo Cruz', folder: 'mateo_cruz', photoFilename: 'mateo_cruz_001.jpg', role: 'Senior Barber • 8 Yrs', specialty: 'Razor Tapers & Crop Cuts', rating: '4.9', avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=240&q=80' },
    { id: 'brb-3', firstName: 'Darius', lastName: 'King', name: 'Darius King', folder: 'darius_king', photoFilename: 'darius_king_001.jpg', role: 'Barber • 6 Yrs', specialty: 'Waves, Lineups & Designs', rating: '4.9', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=240&q=80' },
    { id: 'brb-4', firstName: 'Leo', lastName: 'Alvarez', name: 'Leo Alvarez', folder: 'leo_alvarez', photoFilename: 'leo_alvarez_001.jpg', role: 'Barber • 4 Yrs', specialty: 'Kids Cuts & Classic Scissor Work', rating: '4.8', avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=240&q=80' }
  ],
  lookbook: [
    { title: 'Mid Drop Skin Fade + Textured Crop', tag: 'Fade', img: 'https://images.unsplash.com/photo-1622286342621-4bd786c2447c?auto=format&fit=crop&w=600&q=80' },
    { title: 'Executive Side Part + Tapered Beard', tag: 'Classic', img: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=600&q=80' },
    { title: 'Low Taper + Sharp Lineup', tag: 'Taper', img: 'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?auto=format&fit=crop&w=600&q=80' },
    { title: 'Classic Scissor Cut + Clean Neckline', tag: 'Classic', img: 'https://images.unsplash.com/photo-1621605815971-fbc98d665033?auto=format&fit=crop&w=600&q=80' }
  ],
  timeSlots: ['09:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '01:30 PM', '02:30 PM', '03:30 PM', '04:30 PM', '05:30 PM', '06:30 PM']
};

export const shopConfig = Object.assign({}, DEFAULT_CONFIG, JSON.parse(localStorage.getItem(STORAGE_KEY_CONFIG) || '{}'));

export function saveConfig() {
  localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(shopConfig));
}

// Fields the manager publishes to every client through PUT /api/manager/shop. Must match
// SETTINGS_FIELDS in worker/src/index.js (the server rejects any other key).
export const SHARED_FIELDS = [
  'shopName', 'tagline', 'phone', 'address', 'primaryColor', 'accentColor', 'depositAmount',
  'requireDeposit', 'paymentLinkUrl', 'depositEnabled', 'prepayEnabled', 'walletEnabled', 'walletTopUps',
  'reviewsAreSamples', 'reviews', 'services', 'barbers', 'lookbook', 'timeSlots'
];

/** The shared part of a config object, ready to publish. */
export function pickShared(cfg = shopConfig) {
  const out = {};
  SHARED_FIELDS.forEach(k => { if (cfg[k] !== undefined) out[k] = cfg[k]; });
  return out;
}

/** Copy published settings from the API into shopConfig (and the local cache). Returns true if anything changed. */
export function applySharedSettings(settings) {
  if (!settings || typeof settings !== 'object') return false;
  let changed = false;
  SHARED_FIELDS.forEach(k => {
    if (settings[k] === undefined) return;
    if (JSON.stringify(shopConfig[k]) !== JSON.stringify(settings[k])) changed = true;
    shopConfig[k] = settings[k];
  });
  if (changed) saveConfig();
  return changed;
}
