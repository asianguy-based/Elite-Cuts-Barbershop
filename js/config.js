// Shop configuration: defaults + the tenant overrides saved in localStorage.

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
  services: [
    { id: 'srv-1', name: 'The Executive Cut & Style', price: 45, duration: 45, category: 'Hair', desc: 'Precision scissor or skin fade, hot lather neck shave & invigorating wash.' },
    { id: 'srv-2', name: 'Cut + Beard Sculpt & Hot Towel', price: 65, duration: 60, category: 'Combo', desc: 'Full bespoke haircut paired with straight-razor beard line-up and essential oils.' },
    { id: 'srv-3', name: 'Traditional Straight Razor Shave', price: 40, duration: 30, category: 'Shave', desc: 'Three hot towels, rich sandalwood lather, double-pass straight razor finish.' },
    { id: 'srv-4', name: 'Beard Trim & Razor Line-Up', price: 30, duration: 25, category: 'Beard', desc: 'Shape, taper, conditioning balm, and crisp cheek/neck razor detailing.' }
  ],
  barbers: [
    { id: 'brb-1', firstName: 'Marcus', lastName: 'Vance', name: 'Marcus Vance', folder: 'marcus_vance', photoFilename: 'marcus_vance_001.jpg', role: 'Master Barber • 12 Yrs', specialty: 'Skin Fades & Beard Sculpting', rating: '5.0', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=240&q=80' },
    { id: 'brb-2', firstName: 'Mateo', lastName: 'Cruz', name: 'Mateo Cruz', folder: 'mateo_cruz', photoFilename: 'mateo_cruz_001.jpg', role: 'Senior Barber • 8 Yrs', specialty: 'Razor Tapers & Crop Cuts', rating: '4.9', avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=240&q=80' }
  ],
  lookbook: [
    { title: 'Mid Drop Skin Fade + Textured Crop', tag: 'Fade', img: 'https://images.unsplash.com/photo-1622286342621-4bd786c2447c?auto=format&fit=crop&w=600&q=80' },
    { title: 'Executive Side Part + Tapered Beard', tag: 'Classic', img: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=600&q=80' }
  ],
  timeSlots: ['09:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '01:30 PM', '02:30 PM', '03:30 PM', '04:30 PM', '05:30 PM', '06:30 PM']
};

export const shopConfig = Object.assign({}, DEFAULT_CONFIG, JSON.parse(localStorage.getItem(STORAGE_KEY_CONFIG) || '{}'));

export function saveConfig() {
  localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(shopConfig));
}
