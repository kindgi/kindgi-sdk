---
"@kindgi/handler-runtime": patch
---

**A pack service child stopped by the terminal's Ctrl+C isn't reported as a crash while `kindgi dev` stops.** Ctrl+C (or closing the terminal) signals the whole process group, the pack service's child included. Under load, the child's exit could be handled before `kindgi dev`'s own stop, which printed "pack service exited (SIGINT) — restarting" mid-shutdown; nothing actually restarted. A child killed by SIGINT or SIGHUP now gets two event-loop turns for its owner's stop to arrive before it counts as a crash. Every other exit is reported at once, as before.
