/** The orchestrator screen's six tabs, in order. The route's `tab` param is
 *  one of these ids; anything else opens the first. */
export const ORCH_TABS = ['terminal', 'messages', 'routing', 'budget', 'board', 'config'] as const;

export type OrchTab = (typeof ORCH_TABS)[number];

export function toOrchTab(value: string | undefined): OrchTab {
  return (ORCH_TABS as readonly string[]).includes(value ?? '') ? (value as OrchTab) : 'terminal';
}
