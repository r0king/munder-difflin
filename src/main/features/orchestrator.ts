/**
 * The orchestrator's screen — main-process side (owned by the `wsOrchestrator` unit).
 *
 * Terminal, messages, routing log, budget and breaker, board, configuration.
 * Existing APIs: hiveLog (routing log), hiveMessages, hiveBoard, the
 * breaker (onBreakerState / setBreakerState), costCapUsd / costCapTokens /
 * agentTokenCaps in config, controlAutoDelivery (deliveries paused).
 *
 * Channels: feat:orchestrator:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const orchestratorFeature: FeatureModule = {
  name: 'orchestrator',
  register(ctx) {
    void ctx;
    // TODO(orchestrator): register feat:orchestrator:* ipcMain handlers here.
  }
};
