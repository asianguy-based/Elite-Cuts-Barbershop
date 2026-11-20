// Placeholder "photo" for a haircut look, drawn in SVG so the app ships with no image files.
// Swap for real <img> portfolio shots later: LookTile only needs a square-ish picture.
import { useState } from '../vendor/hooks.module.js';
import { html } from './ui.js';

let seq = 0; // unique SVG ids per rendered tile (same look can show twice on screen)

const TONES = {
  light: { bg: '#E8E5DF', stripe: '#DAD6CE', skin: '#B9B3A9', hair: '#111111', guide: '#E0301E' },
  dark: { bg: '#1B1B1B', stripe: '#232323', skin: '#5E5A55', hair: '#050505', guide: '#FF5436' },
  accent: { bg: '#FF4A2B', stripe: '#F2401F', skin: '#2A2725', hair: '#0A0A0A', guide: '#FFFFFF' }
};

export function LookArt({ look }) {
  const t = TONES[look.tone] || TONES.light;
  const a = look.art;
  const [id] = useState(() => `${look.id}-${++seq}`);
  // Head: ellipse centred at (150,200), rx 70, ry 90 -> crown at y=110.
  const crown = 110;
  const topY = crown - 8 - a.top * 50; // hair volume above the crown
  const fadeY = 250 - a.fade * 120; // where the fade has fully blended to skin
  const texture = [];
  if (a.texture === 'crop') for (let i = 0; i < 14; i++) {
    const x = 92 + i * 9; texture.push(html`<path d=${`M${x} ${topY + 18 + (i % 3) * 4} l6 14`} stroke=${t.bg} stroke-width="2" opacity=".35"/>`);
  }
  if (a.texture === 'curl') for (let i = 0; i < 9; i++) for (let j = 0; j < 2; j++) {
    texture.push(html`<circle cx=${96 + i * 13 + j * 6} cy=${topY + 20 + j * 13} r="5" fill="none" stroke=${t.bg} stroke-width="2" opacity=".3"/>`);
  }
  if (a.texture === 'slick') for (let i = 0; i < 5; i++) {
    texture.push(html`<path d=${`M${88 + i * 4} ${topY + 34 + i * 7} C 130 ${topY + 4 + i * 6}, 190 ${topY + 6 + i * 6}, ${214 - i * 3} ${topY + 40 + i * 6}`} fill="none" stroke=${t.bg} stroke-width="2" opacity=".3"/>`);
  }
  if (a.texture === 'buzz') for (let i = 0; i < 10; i++) for (let j = 0; j < 3; j++) {
    texture.push(html`<circle cx=${100 + i * 11 + (j % 2) * 5} cy=${crown + 6 + j * 9} r="1.6" fill=${t.bg} opacity=".35"/>`);
  }
  return html`
    <svg class="look-art" viewBox="0 0 300 375" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <pattern id=${`st-${id}`} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <rect width="14" height="14" fill=${t.bg}/><rect width="5" height="14" fill=${t.stripe}/>
        </pattern>
        <linearGradient id=${`fd-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color=${t.hair}/>
          <stop offset=${Math.max(0.05, (fadeY - 60 - 50) / 200)} stop-color=${t.hair}/>
          <stop offset=${(fadeY - 60) / 200} stop-color=${t.hair} stop-opacity="0"/>
        </linearGradient>
        <clipPath id=${`hd-${id}`}><ellipse cx="150" cy="200" rx="70" ry="90"/></clipPath>
      </defs>
      <rect width="300" height="375" fill=${`url(#st-${id})`}/>
      <path d="M20 375 C 40 315, 100 300, 150 300 C 200 300, 260 315, 280 375 Z" fill=${t.skin} opacity=".9"/>
      <rect x="124" y="262" width="52" height="50" fill=${t.skin}/>
      <ellipse cx="80" cy="205" rx="10" ry="18" fill=${t.skin}/>
      <ellipse cx="220" cy="205" rx="10" ry="18" fill=${t.skin}/>
      <ellipse cx="150" cy="200" rx="70" ry="90" fill=${t.skin}/>
      <g clip-path=${`url(#hd-${id})`}>
        <rect x="70" y="60" width="160" height="200" fill=${`url(#fd-${id})`}/>
        ${a.beard && html`<path d="M78 200 C 84 262, 118 292, 150 292 C 182 292, 216 262, 222 200 L 214 200 C 206 236, 184 252, 150 252 C 116 252, 94 236, 86 200 Z" fill=${t.hair}/>`}
      </g>
      <path d=${`M80 ${crown + 40} C 76 ${topY + 10}, 110 ${topY}, 150 ${topY} C 190 ${topY}, 224 ${topY + 10}, 220 ${crown + 40} C 200 ${crown + 14}, 100 ${crown + 14}, 80 ${crown + 40} Z`} fill=${t.hair}/>
      ${a.fringe && html`<path d=${`M96 ${crown + 22} L 204 ${crown + 22} L 196 ${crown + 38} L 104 ${crown + 34} Z`} fill=${t.hair}/>`}
      ${a.part && html`<path d=${`M118 ${topY + 6} L 112 ${crown + 30}`} stroke=${t.bg} stroke-width="3"/>`}
      ${texture}
      <line x1="58" x2="242" y1=${fadeY} y2=${fadeY} stroke=${t.guide} stroke-width="2" stroke-dasharray="6 5"/>
    </svg>`;
}
