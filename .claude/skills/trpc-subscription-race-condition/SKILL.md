---
name: trpc-subscription-race-condition
description: |
  Fix for tRPC observable subscriptions that receive no data because they resolve
  a dynamic target (e.g. terminal runtime) before a separate async mutation populates
  the target mapping. Use when: (1) subscription works after navigating away and back
  but not on first mount, (2) stream events never arrive despite successful createOrAttach,
  (3) React useSubscription fires before useEffect that sets up the target mapping.
  Applies to trpc-electron observable patterns with dynamic runtime dispatch.
author: Claude Code
version: 1.0.0
date: 2026-03-02
---

# tRPC Subscription Race Condition with Dynamic Runtime Dispatch

## Problem
Observable subscriptions that resolve a dynamic target at subscription time receive no
events when the target is populated by a separate async operation that hasn't completed yet.

## Context / Trigger Conditions
- Terminal (or similar feature) loads forever with no content on first mount
- Navigating away and back immediately fixes the issue (subscription re-runs after state is populated)
- Debug logs show the full initialization lifecycle completes successfully but zero stream data events arrive
- The subscription resolves its target via a Map lookup that falls back to a default
- A separate mutation (`createOrAttach`) populates the Map after the subscription starts
- React hook ordering: `useSubscription` fires before `useEffect` that triggers the mutation

## Root Cause
In `terminal.ts`, the `stream` subscription called `getTerminalForPane(paneId)` which
returned `paneTerminals.get(paneId) ?? defaultTerminal`. But `paneTerminals` is only
populated by the `createOrAttach` mutation. Since React's subscription hook runs before
the effect that calls `createOrAttach`:

1. Subscription starts -> attaches listeners to `defaultTerminal` (local)
2. `createOrAttach` runs -> assigns remote terminal to `paneTerminals`
3. Remote PTY output emits on remote terminal -> nobody listening
4. Switching tabs re-runs subscription -> now `paneTerminals` has correct mapping -> works

## Solution
Use an `EventEmitter` to notify subscriptions when the target assignment changes,
allowing dynamic re-attachment of listeners:

```typescript
import { EventEmitter } from "node:events";

const paneAssignmentEmitter = new EventEmitter();

// In the mutation that populates the mapping:
paneTerminals.set(paneId, terminal);
paneAssignmentEmitter.emit(`assigned:${paneId}`, terminal);

// In the subscription:
stream: publicProcedure
  .input(z.string())
  .subscription(({ input: paneId }) => {
    return observable((emit) => {
      let detachCurrent: (() => void) | null = null;

      const attachTo = (terminal: TerminalRuntime) => {
        detachCurrent?.();
        const onData = (data) => emit.next({ type: "data", data });
        terminal.on(`data:${paneId}`, onData);
        detachCurrent = () => terminal.off(`data:${paneId}`, onData);
      };

      let currentTerminal = getTerminalForPane(paneId);
      attachTo(currentTerminal);

      const onAssigned = (newTerminal) => {
        if (newTerminal === currentTerminal) return;
        currentTerminal = newTerminal;
        attachTo(newTerminal);
      };
      paneAssignmentEmitter.on(`assigned:${paneId}`, onAssigned);

      return () => {
        detachCurrent?.();
        paneAssignmentEmitter.off(`assigned:${paneId}`, onAssigned);
      };
    });
  }),
```

## Verification
1. Open a new terminal tab on a remote workspace
2. Terminal should display content immediately without needing to switch tabs and back
3. Check main process logs for `[Terminal Stream] Reassigning` to confirm re-attachment fires

## Debugging Strategy
When a subscription receives zero events:
1. Add traces to BOTH the "queuing" (not-ready) and "live" data paths in the renderer
2. If neither path fires, the problem is in the main process subscription, not the renderer
3. Check whether the subscription resolves its target before or after the target is assigned
4. The symptom "works after navigating away and back" is the key tell - it means the
   subscription re-runs after state has been populated

## Notes
- This pattern applies to any observable subscription with dynamic dispatch, not just terminals
- The `attachTo` pattern cleanly handles cleanup by detaching from the previous target before attaching to the new one
- Identity check (`newTerminal === currentTerminal`) prevents unnecessary re-attachment when the same runtime is assigned
- This is specific to `trpc-electron` which requires observables (not async generators)
