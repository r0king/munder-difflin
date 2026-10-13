/**
 * The orchestrator screen's IPC contract (`feat:orchestrator:*`), shared by
 * src/main/features/orchestrator.ts, src/preload/features/orchestrator.ts and
 * the renderer's workspace/orchestrator/**.
 *
 * Types and constants only (its imports are type-only), so every side can load it.
 */
import type { CapLevel, CapTrip } from './orchestratorBudget';
import type { RoutingEntry } from './orchestratorRouting';

export const ORCH_CHANNELS = {
  /** invoke → OrchestratorState */
  getState: 'feat:orchestrator:getState',
  /** invoke(capUsd: number | null) → OrchestratorState */
  setDailyCap: 'feat:orchestrator:setDailyCap',
  /** invoke(tokens: number | null) → OrchestratorState */
  setDefaultTokenCap: 'feat:orchestrator:setDefaultTokenCap',
  /** invoke(paused: boolean) → OrchestratorState */
  setDeliveriesPaused: 'feat:orchestrator:setDeliveriesPaused',
  /** invoke({ limit?: number }) → RoutingLogResult */
  routingLog: 'feat:orchestrator:routingLog',
  /** main → app windows: OrchestratorState, whenever it changes */
  state: 'feat:orchestrator:state'
} as const;

/** Why the floor's deliveries are held. 'budget' = the daily cap tripped it. */
export type DeliveryPauseReason = 'manual' | 'budget';

export interface DeliveryState {
  paused: boolean;
  reason: DeliveryPauseReason | null;
  /** When the current pause began (epoch ms), null while not paused. */
  since: number | null;
}

export interface BudgetSnapshot {
  /** False until the cost ledger has been read to the end once — the UI shows
   *  "reading" instead of a confident $0. */
  ready: boolean;
  /** No hive is open (onboarding, hive picker): nothing to read. */
  noHive: boolean;
  /** Local `YYYY-MM-DD` the figures below belong to. */
  today: string;
  spendTodayUsd: number;
  dailyCapUsd: number | null;
  level: CapLevel;
  /** spend / cap, unclamped; 0 without a cap. */
  fraction: number;
  remainingUsd: number | null;
  /** The last 7 local days, oldest first, today last. */
  history: Array<{ day: string; usd: number }>;
  /** Today's spend per agent id, biggest first. */
  byAgent: Array<{ agentId: string; usd: number }>;
  /** Default per-agent token cap (work tokens), applied by the breaker to any
   *  agent without a cap of its own. null = none. */
  defaultAgentTokenCap: number | null;
  /** When the cap last paused the floor. */
  lastTrip: CapTrip | null;
}

export interface OrchestratorState {
  budget: BudgetSnapshot;
  delivery: DeliveryState;
}

export interface RoutingLogResult {
  ok: boolean;
  entries: RoutingEntry[];
  /** True when only the newest part of a long log was read. */
  truncated: boolean;
  error?: string;
}

/** Bounds on the routing-log request. */
export const ROUTING_LOG_DEFAULT_LIMIT = 1500;
export const ROUTING_LOG_MAX_LIMIT = 5000;
