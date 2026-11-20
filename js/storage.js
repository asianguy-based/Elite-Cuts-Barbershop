// Bookings + loyalty persistence (localStorage) and the on-device loyalty vault.

export const STORAGE_KEY_BOOKINGS = 'ELITE_CUTS_H5_BOOKINGS_V1';
export const STORAGE_KEY_LOYALTY = 'ELITE_CUTS_H5_LOYALTY_V1';

export let bookings = JSON.parse(localStorage.getItem(STORAGE_KEY_BOOKINGS)) || [];
export const loyaltyDB = JSON.parse(localStorage.getItem(STORAGE_KEY_LOYALTY)) || {};

// `bookings` is reassigned in a few places; other modules read it as a live binding and
// replace it through setBookings().
export function setBookings(list) {
  bookings = list;
}

export function saveBookings() {
  localStorage.setItem(STORAGE_KEY_BOOKINGS, JSON.stringify(bookings));
}

export function saveLoyaltyDB() {
  localStorage.setItem(STORAGE_KEY_LOYALTY, JSON.stringify(loyaltyDB));
}

export function normalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

// Local obfuscated cache (not encryption) — XOR + base64 keyed on phone + 30-min window
export const LoyaltyVault = {
  encryptData(rawData, phonePin) {
    const timeWindowHash = Math.floor(Date.now() / (1000 * 60 * 30)); // Rotates every 30 mins
    const saltedPin = phonePin + '-' + timeWindowHash;
    const jsonStr = JSON.stringify(rawData);
    let encrypted = '';
    for (let i = 0; i < jsonStr.length; i++) {
      const charCode = jsonStr.charCodeAt(i) ^ saltedPin.charCodeAt(i % saltedPin.length);
      encrypted += String.fromCharCode(charCode);
    }
    return btoa(encrypted);
  },

  decryptData(encryptedBase64, phonePin) {
    try {
      const timeWindowHash = Math.floor(Date.now() / (1000 * 60 * 30));
      // Check current and previous 30-min window to prevent abrupt token drops
      for (let offset = 0; offset >= -1; offset--) {
        const saltedPin = phonePin + '-' + (timeWindowHash + offset);
        const jsonStr = atob(encryptedBase64);
        let decrypted = '';
        for (let i = 0; i < jsonStr.length; i++) {
          const charCode = jsonStr.charCodeAt(i) ^ saltedPin.charCodeAt(i % saltedPin.length);
          decrypted += String.fromCharCode(charCode);
        }
        const parsed = JSON.parse(decrypted);
        if (parsed) return parsed;
      }
    } catch (e) {
      return null;
    }
    return null;
  },

  saveToDevice(phone, record) {
    const pin = normalizePhone(phone);
    const token = this.encryptData(record, pin);
    localStorage.setItem(`EC_VAULT_${pin}`, token);
  },

  loadFromDevice(phone) {
    const pin = normalizePhone(phone);
    const token = localStorage.getItem(`EC_VAULT_${pin}`);
    if (!token) return { points: 0, stamps: 0, history: [] };
    return this.decryptData(token, pin) || { points: 0, stamps: 0, history: [] };
  }
};
