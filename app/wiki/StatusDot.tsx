'use client';

import type { StalenessState } from '@/lib/wiki/status-types';

type Mode = 'wiki' | 'picture';

// Colours chosen against each mode's sidebar background (Wiki: light surface,
// Field Guide: night-sky). Shape also differs per state, so colour is never the only cue.
const COLORS: Record<Mode, Record<StalenessState, string>> = {
  wiki: {
    current: '#1a7f37',
    'files-changed': '#b35900',
    'older-template': '#8250df',
    'missing-or-failed': '#cf222e',
  },
  picture: {
    current: '#7dff9a',
    'files-changed': '#ffb347',
    'older-template': '#5ef2ff',
    'missing-or-failed': '#ff9e7a',
  },
};

const STATE_LABEL: Record<StalenessState, string> = {
  current: 'current',
  'files-changed': 'files changed',
  'older-template': 'older template',
  'missing-or-failed': 'missing or failed',
};

interface StatusDotProps {
  state: StalenessState;
  mode: Mode;
  reason: string;
}

export function StatusDot({ state, mode, reason }: StatusDotProps) {
  const color = COLORS[mode][state];
  const label = `${mode === 'wiki' ? 'Wiki page' : 'Field Guide page'}: ${STATE_LABEL[state]} - ${reason}`;

  let shape: React.ReactNode;
  switch (state) {
    case 'current': // filled circle
      shape = <circle cx="5" cy="5" r="4" fill={color} />;
      break;
    case 'files-changed': // filled diamond
      shape = <polygon points="5,0.5 9.5,5 5,9.5 0.5,5" fill={color} />;
      break;
    case 'older-template': // filled triangle
      shape = <polygon points="5,0.8 9.5,9 0.5,9" fill={color} />;
      break;
    default: // hollow circle with a slash
      shape = (
        <>
          <circle cx="5" cy="5" r="3.7" fill="none" stroke={color} strokeWidth="1.4" />
          <line x1="2.4" y1="7.6" x2="7.6" y2="2.4" stroke={color} strokeWidth="1.4" />
        </>
      );
  }

  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      role="img"
      aria-label={label}
      style={{ flexShrink: 0, display: 'inline-block' }}
    >
      <title>{label}</title>
      {shape}
    </svg>
  );
}
