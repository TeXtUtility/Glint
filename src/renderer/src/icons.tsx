const PATHS = {
  logo: 'M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
  stop: 'M7 7h10v10H7z',
  pause: 'M8 6v12M16 6v12',
  play: 'M8 5l11 7-11 7z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  screen: 'M3 4h18v12H3zM8 20h8M12 16v4',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  send: 'M5 12h14M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 5.3a3 3 0 0 1 0 5.4M21 20a6 6 0 0 0-3.5-5.4',
  tag: 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01',
  wave: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  clip: 'M20 11l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17a2 2 0 0 1-3-3l7.5-7.5',
  file: 'M6 3h9l4 4v14H6zM14 3v5h5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  checkCircle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l2.7 2.7L16 9.8',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  translate: 'M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6',
  person: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  chat: 'M4 5h16v11H10l-4 4v-4H4z',
  history: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v4h4M12 7v5l3 2',
  tune: 'M4 6h9M17 6h3M13 4v4M4 12h3M11 12h9M7 10v4M4 18h9M17 18h3M13 16v4',
  chevron: 'M7 10l5 5 5-5',
  back: 'M15 6l-6 6 6 6',
  alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5M12 16h.01',
  hourglass: 'M6 3h12M6 21h12M7 3q0 6 5 9t5 9M17 3q0 6-5 9t-5 9',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  check: 'M5 12.5l4.5 4.5L19 7',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  merge: 'M7 3v5a6 6 0 0 0 6 6h4M14 11l3 3-3 3M7 14v7',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z',
}

export function Icon({ name, size = 16, filled: fill }: { name: keyof typeof PATHS; size?: number; filled?: boolean }) {
  const solid = name === 'logo' || name === 'stop' || name === 'play'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={solid || fill ? 'currentColor' : 'none'} stroke={solid ? 'none' : 'currentColor'}
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  )
}
