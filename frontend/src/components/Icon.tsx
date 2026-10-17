const PATHS = {
  atlas: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  rank: 'M4 19V9M10 19V5M16 19v-7M21 19H3',
  corridor: 'M3 12h18M3 8h18M3 16h18M7 6v2M12 6v2M17 6v2',
  ped: 'M12 5.5a1.5 1.5 0 1 0 0-.01M10 21l2-6 2 2v4M9 11l3-2 3 3 2 1M12 9v6',
  lidar: 'M12 20V9M8 9h8M12 9l-7-5M12 9l7-5M5 14a7 7 0 0 0 14 0',
  methods: 'M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h5',
  sheet: 'M4 4h16v16H4zM4 9h16M9 9v11M14 14h3',
  platform: 'M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01',
  ask: 'M4 5h16v11H9l-5 4zM8 10h8M8 13h5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  play: 'M8 5v14l11-7z',
  pause: 'M8 5v14M16 5v14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
