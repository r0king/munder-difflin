/**
 * Main-side host for the transcription worker (transcribe-worker.ts).
 *
 * One worker, created on first use and terminated after IDLE_MS without work,
 * which is what returns the model's few hundred MB to the OS. Jobs carry a
 * timeout scaled to the audio's length; a job that overruns terminates the
 * worker (the only way to stop a running ONNX session) and the next job
 * starts a fresh one.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism, cpus } from 'node:os';
import workerPath from './transcribe-worker?modulePath';
import type { WorkerInit, WorkerRequest, WorkerResponse } from './protocol';

const IDLE_MS = 10 * 60 * 1000;

type Pending = {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Leave cores for the agents and the UI: half the machine, at most 4. */
function inferenceThreads(): number {
  const n = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  return Math.max(1, Math.min(4, Math.floor(n / 2)));
}

/** Distributive Omit, so each request variant keeps its own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export class LocalEngine {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onBusy: (busy: boolean) => void;

  constructor(onBusy: (busy: boolean) => void = () => {}) {
    this.onBusy = onBusy;
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  run(req: WithoutId<WorkerRequest>, timeoutMs: number): Promise<WorkerResponse> {
    const id = this.nextId++;
    const w = this.ensure();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Terminating fails every job queued behind this one too; they would
        // otherwise wait on a session that is wedged.
        this.fail(new Error('transcription timed out'));
      }, Math.max(30_000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      if (this.pending.size === 1) this.onBusy(true);
      w.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.fail(new Error('transcription stopped'));
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const init: WorkerInit = { threads: inferenceThreads() };
    const w = new Worker(workerPath, { workerData: init });
    w.on('message', (msg: WorkerResponse) => this.settle(msg));
    w.on('error', (e) => {
      console.error('[transcribe] worker error:', e);
      this.fail(e instanceof Error ? e : new Error(String(e)));
    });
    w.on('exit', (code) => {
      if (this.worker !== w) return;
      this.worker = null;
      if (this.pending.size) this.fail(new Error(`transcription worker exited (${code})`));
    });
    // An idle worker must not keep the app alive at quit.
    w.unref();
    this.worker = w;
    return w;
  }

  private settle(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error));
    else p.resolve(msg);
    if (!this.pending.size) {
      this.onBusy(false);
      this.idleTimer = setTimeout(() => this.stopWorker(), IDLE_MS);
    }
  }

  private fail(err: Error): void {
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const p of jobs) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    if (jobs.length) this.onBusy(false);
    this.stopWorker();
  }

  private stopWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate().catch(() => {});
  }
}
