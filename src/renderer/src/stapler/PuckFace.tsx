/**
 * The Stapler himself: a yellow stapler with a face, drawn here on a 14×14
 * pixel grid (4 px a cell at 56 px, so every edge lands on a whole pixel). Our
 * own art — lemon body, ink outline, a cream shine — in the office's pixel
 * language rather than a borrowed avatar.
 *
 * Moods: idle (blinks now and then), listening (eyes wide, the mouth opens
 * with the microphone level), busy (looks up, waiting on the transcriber),
 * happy (^ ^, after a send), error (flat mouth). The outline and eyes use
 * --cth-on-accent, which is dark in both themes, because the creature is an
 * accent fill and must read the same on a dark desktop.
 */
export type PuckMood = 'idle' | 'listening' | 'busy' | 'happy' | 'error';

export function PuckFace({ mood = 'idle', level = 0 }: { mood?: PuckMood; level?: number }) {
  const ink = 'var(--cth-on-accent)';
  const body = 'var(--cth-lemon)';
  const shade = 'var(--cth-peach)';
  const shine = 'var(--cth-cream-50)';
  // Mouth: closed line, or open by the mic level in quarter-cell steps.
  const open = mood === 'listening' ? Math.min(1, Math.max(0, level)) : 0;
  const mouthH = mood === 'listening' ? 0.5 + Math.round(open * 3) * 0.25 : 0.5;
  const eyeY = mood === 'busy' ? 3.5 : 4;
  return (
    <svg viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {/* Hard shadow: the same silhouette, offset 0.75 cell (3 px). */}
      <g fill="rgba(26, 19, 32, 0.18)" transform="translate(0.75 0.75)">
        <rect x="1" y="2" width="12" height="6" />
        <rect x="1" y="6" width="3" height="4" />
        <rect x="0" y="9" width="14" height="4" />
      </g>
      {/* Outline */}
      <g fill={ink}>
        <rect x="1" y="2" width="12" height="6" />
        <rect x="1" y="6" width="3" height="4" />
        <rect x="0" y="9" width="14" height="4" />
      </g>
      {/* Arm, hinge, base */}
      <rect x="2" y="3" width="10" height="4" fill={body} />
      <rect x="2" y="7" width="1" height="3" fill={body} />
      <rect x="1" y="10" width="12" height="1" fill={body} />
      <rect x="1" y="11" width="12" height="1" fill={shade} />
      {/* The staple slot at the nose */}
      <rect x="11" y="7" width="1" height="0.5" fill={ink} />
      {/* Shine */}
      <rect x="3" y="3" width="4" height="0.5" fill={shine} />
      {/* Eyes */}
      {mood === 'happy' ? (
        <g fill={ink}>
          <rect x="6.5" y="4.5" width="0.5" height="0.5" />
          <rect x="7" y="4" width="0.5" height="0.5" />
          <rect x="7.5" y="4.5" width="0.5" height="0.5" />
          <rect x="9.5" y="4.5" width="0.5" height="0.5" />
          <rect x="10" y="4" width="0.5" height="0.5" />
          <rect x="10.5" y="4.5" width="0.5" height="0.5" />
        </g>
      ) : (
        <g className={mood === 'idle' ? 'cth-stapler-eye' : undefined}>
          <rect x="7" y={eyeY} width="1" height={mood === 'listening' ? 1.5 : 1} fill={ink} />
          <rect x="10" y={eyeY} width="1" height={mood === 'listening' ? 1.5 : 1} fill={ink} />
          <rect x="7" y={eyeY} width="0.5" height="0.5" fill={shine} />
          <rect x="10" y={eyeY} width="0.5" height="0.5" fill={shine} />
        </g>
      )}
      {/* Cheek */}
      <rect x="11.5" y="5.5" width="0.5" height="0.5" fill="var(--cth-coral)" />
      {/* Mouth */}
      {mood === 'error' ? (
        <rect x="8" y="6" width="2" height="0.5" fill={ink} />
      ) : (
        <rect x="8.25" y={6.5 - mouthH + 0.25} width="1.5" height={mouthH} fill={ink} />
      )}
    </svg>
  );
}
