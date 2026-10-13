/**
 * The local Whisper models: catalog, where each one is on disk, and how a
 * downloaded file is verified (pure apart from the injected fs probes).
 *
 * Resolution order for a model: the copy bundled with the app
 * (`<resources>/models`, filled at release time by tools/fetch-whisper-model.cjs),
 * then the user's cache (`<userData>/features/transcribe/models`), else it is
 * missing and is downloaded — automatically for the default model on first
 * use, on request for the larger one. Both roots use the Hugging Face layout
 * `<root>/<org>/<repo>/<file>`, which is what transformers.js reads with
 * `env.localModelPath`.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import catalog from './models.json';
import type { LocalModelId, ModelState } from '../../../shared/features/transcribe';

export interface ModelFile {
  path: string;
  size: number;
  /** LFS files: sha256 of the content. */
  sha256?: string;
  /** Small files: git blob id, sha1("blob <size>\0" + content). */
  gitOid?: string;
}

export interface ModelSpec {
  id: LocalModelId;
  repo: string;
  revision: string;
  dtype: 'q8';
  files: ModelFile[];
}

export const MODELS: Record<LocalModelId, ModelSpec> = {
  base: { id: 'base', ...(catalog.models.base as Omit<ModelSpec, 'id'>) },
  large: { id: 'large', ...(catalog.models.large as Omit<ModelSpec, 'id'>) }
};

export function modelSize(spec: ModelSpec): number {
  return spec.files.reduce((n, f) => n + f.size, 0);
}

/** Directory of a model under a models root. */
export function modelDir(root: string, spec: ModelSpec): string {
  return join(root, ...spec.repo.split('/'));
}

export function fileUrl(spec: ModelSpec, file: ModelFile): string {
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file.path}`;
}

export interface FsProbe {
  /** Size of a regular file, or -1 when absent. */
  sizeOf(path: string): number;
}

/** Every file present with its catalog size. (Content is verified when it is
 *  written; a size check at each status read is what stays cheap.) */
export function isComplete(root: string, spec: ModelSpec, fs: FsProbe): boolean {
  const dir = modelDir(root, spec);
  return spec.files.every((f) => fs.sizeOf(join(dir, ...f.path.split('/'))) === f.size);
}

export interface ResolvedModel {
  state: Extract<ModelState, 'bundled' | 'cached' | 'missing'>;
  /** The models root to point transformers.js at (null when missing). */
  root: string | null;
}

export function resolveModel(spec: ModelSpec, roots: { bundled: string | null; cache: string }, fs: FsProbe): ResolvedModel {
  if (roots.bundled && isComplete(roots.bundled, spec, fs)) return { state: 'bundled', root: roots.bundled };
  if (isComplete(roots.cache, spec, fs)) return { state: 'cached', root: roots.cache };
  return { state: 'missing', root: null };
}

/** A hasher for one catalog file: feed the bytes, then `matches()`. */
export function fileVerifier(file: ModelFile): { update(chunk: Uint8Array): void; matches(): boolean } {
  if (file.sha256) {
    const h = createHash('sha256');
    return { update: (c) => { h.update(c); }, matches: () => h.digest('hex') === file.sha256 };
  }
  if (file.gitOid) {
    const h = createHash('sha1');
    h.update(`blob ${file.size}\0`);
    return { update: (c) => { h.update(c); }, matches: () => h.digest('hex') === file.gitOid };
  }
  return { update: () => {}, matches: () => true };
}
