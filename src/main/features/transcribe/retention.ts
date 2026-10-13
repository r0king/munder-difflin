/**
 * Recording retention (pure).
 *
 * "Recordings are deleted 24 hours after they are transcribed." A recording
 * that is never transcribed (cancelled flow, crash) is deleted after 7 days.
 * A session that is still recording is never touched, whatever its age.
 */
export const TRANSCRIBED_TTL_MS = 24 * 60 * 60 * 1000;
export const UNTRANSCRIBED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionRecord {
  id: string;
  createdAt: number;
  transcribedAt?: number;
}

export function selectExpired(
  sessions: readonly SessionRecord[],
  now: number,
  isOpen: (id: string) => boolean = () => false
): string[] {
  const out: string[] = [];
  for (const s of sessions) {
    if (isOpen(s.id)) continue;
    const t = typeof s.transcribedAt === 'number' && Number.isFinite(s.transcribedAt) ? s.transcribedAt : null;
    if (t !== null ? now - t >= TRANSCRIBED_TTL_MS : now - s.createdAt >= UNTRANSCRIBED_TTL_MS) out.push(s.id);
  }
  return out;
}
