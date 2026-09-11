// Every turn receives a generation ID and AbortController. Starting a newer
// turn aborts in-flight work and prevents stale state or speech from landing.

export type TurnTicket = {
  readonly id: number;
  readonly signal: AbortSignal;
  /** True while no newer turn has begun. Check before every commit point. */
  isCurrent(): boolean;
};

let current = 0;
let ctrl: AbortController | null = null;

export function beginTurn(): TurnTicket {
  ctrl?.abort(); // a newer turn invalidates the prior model/TTS work
  ctrl = new AbortController();
  const id = ++current;
  const signal = ctrl.signal;
  return { id, signal, isCurrent: () => id === current };
}

export function currentTurnId(): number {
  return current;
}
