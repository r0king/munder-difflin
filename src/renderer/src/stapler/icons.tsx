/**
 * The Stapler's stroke icons — the same 16-unit box, weight and caps as the
 * Workspace's WsIcon (workspace/ui.tsx), for the actions only the Stapler has.
 */

export type StaplerIconName =
  | 'screenshot' | 'message' | 'meeting' | 'dictate' | 'invisible' | 'visible' | 'computer'
  | 'settings' | 'to' | 'close' | 'folder' | 'file' | 'image' | 'video' | 'pdf' | 'stop'
  | 'record' | 'trash' | 'external' | 'check' | 'send' | 'back' | 'plus' | 'reset' | 'library';

const PATHS: Record<StaplerIconName, string> = {
  screenshot: 'M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M6 8h4M8 6v4',
  message: 'M8 2.5a2 2 0 0 0-2 2v3a2 2 0 1 0 4 0v-3a2 2 0 0 0-2-2zM4 7.5a4 4 0 0 0 8 0M8 11.5v2',
  meeting: 'M2.5 3.5h7v5h-4l-2 2v-2h-1zM11.5 6.5h2v5h-1v2l-2-2h-3v-1.5',
  dictate: 'M2.5 4.5h11v7h-11zM5 6.5v3M8 8h3.5',
  invisible: 'M2 8s2.2-4 6-4s6 4 6 4s-2.2 4-6 4s-6-4-6-4zM8 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3zM3 13L13 3',
  visible: 'M2 8s2.2-4 6-4s6 4 6 4s-2.2 4-6 4s-6-4-6-4zM8 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z',
  computer: 'M2.5 3h11v7.5h-11zM6 13.5h4M8 10.5v3',
  settings: 'M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  to: 'M6 6.5a2 2 0 1 0 0-4a2 2 0 0 0 0 4zM2.5 13c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5M10.5 8h3.5M12.5 6l1.5 2l-1.5 2',
  close: 'M4 4l8 8M12 4l-8 8',
  folder: 'M2 4.5h4l1.5 1.5h6.5v6.5h-12z',
  file: 'M4 2.5h5l3 3v8h-8zM9 2.5v3h3',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3l3 3l2-2l3 3M10.5 6h.01',
  video: 'M2.5 4.5h8v7h-8zM10.5 7l3-2v6l-3-2',
  pdf: 'M4 2.5h5l3 3v8h-8zM9 2.5v3h3M6 9h4M6 11h3',
  stop: 'M4.5 4.5h7v7h-7z',
  record: 'M8 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
  trash: 'M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9',
  external: 'M9.5 2.5h4v4M13.5 2.5l-6 6M11.5 9.5v4h-9v-9h4',
  check: 'M3 8.5l3 3l7-7',
  send: 'M2.5 8h10M8.5 4l4 4l-4 4',
  back: 'M10 4l-4 4l4 4',
  plus: 'M8 3v10M3 8h10',
  reset: 'M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5M8 6.5v3M6.5 8h3',
  library: 'M3 2.5h3v11h-3zM7 2.5h3v11h-3zM11 3l2.5.5l-1.8 10l-2.5-.5'
};

/** Filled marks (stop, record) read better solid at 16px. */
const FILLED = new Set<StaplerIconName>(['stop', 'record']);

export function StaplerIcon({ name, size = 16 }: { name: StaplerIconName; size?: 16 | 20 | 24 }) {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ imageRendering: 'auto', flexShrink: 0 }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
