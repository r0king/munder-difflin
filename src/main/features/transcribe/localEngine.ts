/**
 * Main-side host for the transcription worker (transcribe-worker.ts).
 *
 * One worker, created on first use and terminated after IDLE_MS without work,
 * which is what returns the model's few hundred MB to the OS. Jobs are queued
 * here and handed over one at a time, so each job's timeout (scaled to its
 * audio's length) runs only while the worker is actually on it. A job that
 * overruns terminates the worker — the only way to stop a running ONNX
 * session — and fails alone; the queue carries on in a fresh worker.
 *
 * Short jobs (a dictation, a recorded message) go ahead of long ones still
 * waiting, so dictating while an hour-long meeting is being transcribed does
 * not wait for the meeting. A job already running is never interrupted.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism, cpus } from 'node:os';
import workerPath from './transcribe-worker?modulePath';
import type { WorkerInit, WorkerRequest, WorkerResponse } from './protocol';

const IDLE_MS = 10 * 60 * 1000;
/** Audio shorter than this jumps the queue. */
const SHORT_AUDIO_MS = 2 * 60 * 1000;

/** Distributive Omit, so each request variant keeps its own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

interface Job {
  id: number;
  req: WithoutId<WorkerRequest>;
  timeoutMs: number;
  short: boolean;
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
}

/** Leave cores for the agents and the UI: half the machine, at most 4. */
function inferenceThreads(): number {
  const n = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  return Math.max(1, Math.min(4, Math.floor(n / 2)));
}

export class LocalEngine {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private current: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onBusy: (busy: boolean) => void;

  constructor(onBusy: (busy: boolean) => void = () => {}) {
    this.onBusy = onBusy;
  }

  get busy(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  /** Queue a job. `audioMs` sizes nothing but its place in the queue. */
  run(req: WithoutId<WorkerRequest>, timeoutMs: number, audioMs = Number.POSITIVE_INFINITY): Promise<WorkerResponse> {
    const wasBusy = this.busy;
    const p = new Promise<WorkerResponse>((resolve, reject) => {
      const job: Job = { id: this.nextId++, req, timeoutMs: Math.max(30_000, timeoutMs), short: audioMs < SHORT_AUDIO_MS, resolve, reject };
      const at = job.short ? this.queue.findIndex((j) => !j.short) : -1;
      if (at >= 0) this.queue.splice(at, 0, job);
      else this.queue.push(job);
    });
    if (!wasBusy) this.onBusy(true);
    this.pump();
    return p;
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const err = new Error('transcription stopped');
    for (const j of this.queue.splice(0)) j.reject(err);
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.job.reject(err);
      this.current = null;
    }
    this.stopWorker();
  }

  private pump(): void {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) {
      this.onBusy(false);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.stopWorker(), IDLE_MS);
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    let w: Worker;
    try {
      w = this.ensure();
    } catch (e) {
      job.reject(e instanceof Error ? e : new Error(String(e)));
      this.pump();
      return;
    }
    const timer = setTimeout(() => this.failCurrent(new Error('transcription timed out')), job.timeoutMs);
    this.current = { job, timer };
    w.postMessage({ ...job.req, id: job.id } as WorkerRequest);
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const init: WorkerInit = { threads: inferenceThreads() };
    const w = new Worker(workerPath, { workerData: init });
    w.on('message', (msg: WorkerResponse) => this.settle(msg));
    w.on('error', (e) => {
      console.error('[transcribe] worker error:', e);
      if (this.worker === w) this.failCurrent(e instanceof Error ? e : new Error(String(e)));
    });
    w.on('exit', (code) => {
      if (this.worker !== w) return;
      this.worker = null;
      if (this.current) this.failCurrent(new Error(`transcription worker exited (${code})`));
    });
    // An idle worker must not keep the app alive at quit.
    w.unref();
    this.worker = w;
    return w;
  }

  private settle(msg: WorkerResponse): void {
    const c = this.current;
    if (!c || c.job.id !== msg.id) return;
    clearTimeout(c.timer);
    this.current = null;
    if (msg.type === 'error') c.job.reject(new Error(msg.error));
    else c.job.resolve(msg);
    this.pump();
  }

  /** The running job failed (timeout, crash): drop the worker, fail that job
   *  alone, and go on with the queue in a fresh worker. */
  private failCurrent(err: Error): void {
    const c = this.current;
    this.current = null;
    this.stopWorker();
    if (c) {
      clearTimeout(c.timer);
      c.job.reject(err);
    }
    this.pump();
  }

  private stopWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate().catch(() => {});
  }
}
