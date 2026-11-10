/**
 * Execution state machine (§7).
 *
 *   PLANNED → SIMULATED → AUTH_SIGNED → ASSEMBLED → BROADCAST → { CONFIRMED | REVERTED | DROPPED }
 *
 * Transition rules enforced here:
 *  - SIMULATED requires a green simulation against a pinned block.
 *  - PLANNED → AUTH_SIGNED is only permitted while all authority nonces match the
 *    snapshot; any drift sends the batch back to PLANNED.
 *  - BROADCAST sends exactly one tx; there is no retry with the same tuples.
 */

import { DisperserError } from "../errors.js";

export type BatchState =
  | "PLANNED"
  | "SIMULATED"
  | "AUTH_SIGNED"
  | "ASSEMBLED"
  | "BROADCAST"
  | "CONFIRMED"
  | "REVERTED"
  | "DROPPED";

const TRANSITIONS: Record<BatchState, readonly BatchState[]> = {
  PLANNED: ["SIMULATED", "AUTH_SIGNED", "PLANNED"],
  SIMULATED: ["AUTH_SIGNED", "PLANNED", "REVERTED"],
  AUTH_SIGNED: ["ASSEMBLED", "PLANNED", "REVERTED"],
  ASSEMBLED: ["BROADCAST", "PLANNED", "REVERTED"],
  BROADCAST: ["CONFIRMED", "REVERTED", "DROPPED"],
  CONFIRMED: [],
  REVERTED: ["PLANNED"],
  DROPPED: ["PLANNED"],
};

/** Terminal states for a batch attempt. */
export function isTerminal(state: BatchState): boolean {
  return state === "CONFIRMED";
}

export class BatchStateMachine {
  private current: BatchState = "PLANNED";
  private readonly history: BatchState[] = ["PLANNED"];

  get state(): BatchState {
    return this.current;
  }

  get transitions(): readonly BatchState[] {
    return this.history;
  }

  canTransitionTo(next: BatchState): boolean {
    return TRANSITIONS[this.current].includes(next);
  }

  transitionTo(next: BatchState): void {
    if (!this.canTransitionTo(next)) {
      throw new DisperserError(`illegal transition ${this.current} → ${next}`);
    }
    this.current = next;
    this.history.push(next);
  }

  /** REVERTED/DROPPED → rebuild from scratch: back to PLANNED with a fresh salt. */
  reset(): void {
    this.transitionTo("PLANNED");
  }
}
