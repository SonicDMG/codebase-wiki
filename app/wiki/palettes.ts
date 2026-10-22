export const PALETTES = {
  wiki: {
    bg:          '#ffffff',
    surface:     '#f7f8fa',
    border:      '#e2e4e8',
    text:        '#1a1a1f',
    textMuted:   '#57606a',
    textFaint:   '#8b949e',
    amber:       '#F5A623',
    amberLight:  '#fff7e6',
    amberBorder: '#fcd389',
    amberGlow:   '#F5A62326',
    accentText:  '#92600a',
    onAccent:    '#1a1a1f',
    codeBg:      '#1E1E22',
    codeBorder:  '#2A2A2F',
    codeText:    '#e2e4e8',
    fontBody:    '-apple-system, "Segoe UI", system-ui, sans-serif',
    fontHeading: 'Georgia, "Times New Roman", serif',
    titleSize:   '17px',
    questionSize: '26px',
    questionLine: '1.3',
    fontLabel:   'inherit',
    panelBorder: '1px',
  },
  picture: {
    bg:          '#0b1020',
    surface:     '#141c33',
    border:      '#26325a',
    text:        '#f3f5ff',
    textMuted:   '#a8b3d6',
    textFaint:   '#7d88ad',
    amber:       '#ffb347',
    amberLight:  '#1f2a48',
    amberBorder: '#3a4a7a',
    amberGlow:   '#ffb34733',
    accentText:  '#ffe066',
    onAccent:    '#0b1020',
    codeBg:      '#0a0f1d',
    codeBorder:  '#26325a',
    codeText:    '#f3f5ff',
    fontBody:    '"Nunito", "Segoe UI", system-ui, sans-serif',
    fontHeading: '"Press Start 2P", "Courier New", monospace',
    titleSize:   '13px',
    questionSize: '17px',
    questionLine: '1.7',
    fontLabel:   '"Press Start 2P", "Courier New", monospace',
    panelBorder: '3px',
  },
} as const;

export type PaletteKey = keyof typeof PALETTES.wiki;

export function paletteVars(mode: 'wiki' | 'picture'): string {
  return Object.entries(PALETTES[mode])
    .map(([k, v]) => `--w-${k}: ${v};`)
    .join(' ');
}

export function paletteCss(): string {
  return `
.wiki-root { ${paletteVars('wiki')} }
.wiki-root[data-mode="picture"] { ${paletteVars('picture')} }
/* Field Guide scrollbars: square night-sky thumbs, like the lesson panels. */
.wiki-root[data-mode="picture"], .wiki-root[data-mode="picture"] * { scrollbar-width: thin; scrollbar-color: #3a4a7a #0b1020; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar { width: 14px; height: 14px; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar-track { background: #0b1020; border-left: 3px solid #26325a; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar-thumb { background: #3a4a7a; border: 3px solid #0b1020; border-radius: 0; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar-thumb:hover { background: #5ef2ff; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar-corner { background: #0b1020; }
.wiki-root ::placeholder { color: var(--w-textFaint); }
`;
}
