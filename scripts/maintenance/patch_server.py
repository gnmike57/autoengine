import sys

with open('src/server/server.ts', 'r') as f:
    c = f.read()

if "installGlobalCleanupHandlers" not in c:
    c = c.replace(
        'import { cleanPreviousZombies, startPeriodicZombieReaper } from "../services/process-cleaner.js";',
        'import { cleanPreviousZombies, startPeriodicZombieReaper, installGlobalCleanupHandlers } from "../services/process-cleaner.js";\ninstallGlobalCleanupHandlers({ label: "server" });'
    )

with open('src/server/server.ts', 'w') as f:
    f.write(c)
