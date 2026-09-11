# Architecture

Michi separates conversational judgment from application truth. The model may propose an activity, but only deterministic code can place it on the calendar or include it in the budget.

## Runtime boundaries

```text
Browser
  React UI
    ├─ turn orchestrator
    ├─ listener and acknowledgement policy
    ├─ Zustand application state
    └─ avatar adapter
         ├─ Perxona presenter
         └─ browser/static fallback

Node
  /api/michi
    ├─ model provider and response validation
    ├─ ElevenLabs proxy
    ├─ Perxona token service
    └─ local ONNX affect inference

Shared TypeScript
  activity retrieval → planning engine → budget and decision trace
```

The Vite development server and `server/main.ts` production entry point use the same API handler modules. Provider credentials remain in the Node process.

## Turn lifecycle

`src/flow/turn.ts` coordinates each utterance:

1. `beginTurn()` aborts older work and issues a new turn ticket.
2. The listener classifies intent and may play a short acknowledgement.
3. The browser posts bounded history and current trip context to `/api/michi/turn`.
4. `src/agent/core.ts` retrieves a relevant catalogue slice and calls the configured provider.
5. Reply phrases stream to speech, while state waits for the complete structured response.
6. Runtime guards validate the response before `applyAgentResponse()` updates the store.
7. `src/plan/engine.ts` calculates placements, conflicts, moves, and totals.

Every asynchronous commit checks its turn ticket. A late response from an interrupted turn is discarded.

## Ownership

- The model owns conversational wording, constraint extraction, ranking, and explanation.
- The planning engine owns time, availability, prices, hard constraints, and calendar mutation.
- The listener owns acknowledgements and presentation tone, but cannot change the plan.
- The avatar layer owns rendering and speech delivery, but not conversation state.
- React renders the state; durable trip data lives in the store and is validated during hydration.

## Graceful degradation

The optional integrations are layered:

- No Perxona configuration: use the browser/static avatar.
- No ElevenLabs key: use presenter TTS or browser speech synthesis.
- No local audio-affect model: use text emotion only.
- Slow affect inference: keep the deterministic listener decision.
- No planning-model key: use `?mockagent=1` for the scripted flow.
