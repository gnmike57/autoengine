import sys

with open('src/services/clean-zombies.ts', 'r') as f:
    c = f.read()

c = c.replace(
    'import { findOurOrphans, killOurOrphans } from "./process-cleaner.js";',
    'import { findOurOrphans, killOurOrphans, installGlobalCleanupHandlers } from "./process-cleaner.js";\ninstallGlobalCleanupHandlers();'
)

with open('src/services/clean-zombies.ts', 'w') as f:
    f.write(c)
