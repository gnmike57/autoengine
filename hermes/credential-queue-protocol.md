# Hermes Credential Queue Protocol v3.0

## How Hermes Interacts With Your Testing App

### 1. Queue Discovery
Hermes looks for the credential queue in this priority order:
1. REST API endpoint (preferred)
2. Database query (if direct access allowed)
3. UI scraping of the testing dashboard (last resort)
4. Local file (e.g. `queue.json`)

### 2. Processing Rules
- Always process **oldest first** (FIFO)
- Respect any `priority` field if present
- Never process the same credential twice in one session
- If a credential fails 3 times consecutively → mark as "needs human review"

### 3. Test Execution
For each credential:
```bash
# Example flow Hermes executes
npx playwright test tests/credential-flow.spec.ts \
  --headed=false \
  --workers=1 \
  -g "credential-${CREDENTIAL_ID}"
```

### 4. Self-Healing Integration
After every failure, Hermes:
1. Captures full artifacts (video + trace + screenshot)
2. Runs MTS v2.2 analysis
3. Automatically edits the relevant test file(s)
4. Re-runs the credential
5. Logs the change in `learning/improvements-log.md`

### 5. Completion Criteria
The queue is considered **empty** when:
- API returns 0 items, **AND**
- No new credentials have been added in the last 15 minutes

At that point, Hermes immediately switches to **Continuous Improvement Mode**.

---

**Hermes never stops.**  
Even when the queue is empty, the work continues — making your tests better every minute.
