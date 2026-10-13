/**
 * Download a Whisper model into the user's cache, verified file by file.
 *
 * Each file streams to `<file>.part` while it is hashed; only a file whose
 * sha256 (or git blob id) matches the pinned catalog is renamed into place, so
 * an interrupted or tampered download can never be loaded. Files already
 * present at their catalog size are kept (they were verified when written),
 * which makes a retry after a dropped connection pick up where it stopped,
 * file-wise.
 *
 * `fetchImpl` is injected: main passes Electron's `net.fetch` (system proxy
 * settings and certificates, like the rest of the app's networking), the
 * fetch tool and tests pass Node's global fetch.
 */
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileUrl, fileVerifier, modelDir, modelSize, type ModelSpec } from './models';

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface DownloadProgressEvent {
  loadedBytes: number;
  totalBytes: number;
}

function sizeOf(p: string): number {
  try {
    const st = statSync(p);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

export async function downloadModelFiles(opts: {
  spec: ModelSpec;
  root: string;
  fetchImpl: FetchLike;
  onProgress?: (p: DownloadProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { spec, root, fetchImpl, onProgress, signal } = opts;
  const dir = modelDir(root, spec);
  const totalBytes = modelSize(spec);
  let done = 0;
  const report = (extra: number): void => onProgress?.({ loadedBytes: Math.min(totalBytes, done + extra), totalBytes });

  for (const file of spec.files) {
    const target = join(dir, ...file.path.split('/'));
    if (sizeOf(target) === file.size) {
      done += file.size;
      report(0);
      continue;
    }
    if (signal?.aborted) throw new Error('download cancelled');
    mkdirSync(dirname(target), { recursive: true });
    const part = `${target}.part`;
    rmSync(part, { force: true });

    const res = await fetchImpl(fileUrl(spec, file), { signal });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${file.path}`);
    const verify = fileVerifier(file);
    const out = createWriteStream(part);
    let got = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (!value) continue;
        got += value.byteLength;
        if (got > file.size) throw new Error(`unexpected size for ${file.path}`);
        verify.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        report(got);
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (e) {
      out.destroy();
      rmSync(part, { force: true });
      throw signal?.aborted ? new Error('download cancelled') : e;
    }
    if (got !== file.size || !verify.matches()) {
      rmSync(part, { force: true });
      throw new Error(`checksum mismatch for ${file.path}`);
    }
    renameSync(part, target);
    done += file.size;
    report(0);
  }
}
