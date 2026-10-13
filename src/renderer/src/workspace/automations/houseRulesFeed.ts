/**
 * The house rules as this window last heard them, for code that composes text
 * synchronously: useHive's standing-goal preamble for engines with no hook
 * channel (Cursor, Crush, …), which types the goal ahead of each queued
 * message and now the rules with it (prependStandingGoal).
 *
 * Main is the only writer; this mirrors its list — read once, then kept current
 * by the `feat:automations:rules` push every app window receives on a change.
 * No React, no timer. Until the first answer the list is empty, which only
 * matters for a delivery in the first moment after launch, and boot grace
 * holds every queue far longer than that.
 */
import type { HouseRule } from '@shared/workspace/automationsRules';

let rules: readonly HouseRule[] = [];
let started = false;
/** Bumped by every push, so a slow first read never overwrites a newer push. */
let pushes = 0;

/** Begin listening (idempotent). Safe before the bridge exists: it simply
 *  tries again on the next call. */
export function startHouseRulesFeed(): void {
  if (started) return;
  const api = window.cth?.features?.automations;
  if (!api) return;
  started = true;
  try {
    api.onRules((next) => {
      if (!Array.isArray(next)) return;
      pushes++;
      rules = next;
    });
  } catch { /* no push channel: the first read still stands */ }
  const seen = pushes;
  api.listRules().then(
    (next) => { if (Array.isArray(next) && pushes === seen) rules = next; },
    () => { /* keep what we have; a push will bring the list */ }
  );
}

/** The current list (possibly empty). */
export function currentHouseRules(): readonly HouseRule[] {
  startHouseRulesFeed();
  return rules;
}
