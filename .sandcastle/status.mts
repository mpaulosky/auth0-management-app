// Prints why each open Sandcastle PR is held, and the Sandcastle workflow's runs (#65).
//
// Usage: pnpm run sandcastle:status
//
// Read-only: it posts no comment, changes no label, pushes nothing, starts no sandbox and calls no model. It needs only an authenticated gh.
// It always reports what GitHub Actions' sweep would do, so it reads the default Sandcastle queue scope whatever the environment asks for.

import { QUEUE_LABEL } from "./lib/config.mts";
import { protectHostGit } from "./lib/host-safety.mts";
import { useQueueScope } from "./lib/queue.mts";
import { statusCommand } from "./lib/status.mts";

// gh reads git remotes, and the main checkout's .git is shared with agents, so git is pinned before the first gh call, as main.mts does.
protectHostGit();
useQueueScope({ kind: "label", label: QUEUE_LABEL });
process.exitCode = statusCommand();
