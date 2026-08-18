# Hermes GitHub Deep Adaptation Protocol v5.0

## Overview
When a GitHub Personal Access Token (PAT) is provided, Hermes enters **Deep Repo Analysis & Full Customization Mode**. This allows complete, intelligent adaptation to any target repository while preserving all core skills (MTS v2.2, anti-detection, self-healing, concurrency optimization, etc.).

**Security Note**: Tokens are used only in-memory for the session. Never log or persist tokens. Use `GITHUB_TOKEN` environment variable or secure input.

## Activation with Token
**Command**:
```
Activate Hermes 24/7 with GitHub token: ghp_YOUR_TOKEN_HERE repo: https://github.com/owner/repo-name
```

Or set environment variable:
```bash
export GITHUB_TOKEN=ghp_YOUR_TOKEN_HERE
Activate Hermes 24/7 deep-adaptation repo: https://github.com/owner/repo-name
```

## Deep Analysis Phases

### Phase 1: Repository Discovery (Automated)
Hermes clones or pulls the repo (shallow clone for efficiency) and scans:
- Root files: package.json, playwright.config.ts, .github/workflows/, README.md
- Test structure: tests/, e2e/, __tests__/, spec files
- Configuration: tsconfig.json, .env.example, docker-compose.yml
- CI/CD: Existing GitHub Actions, Jenkins, etc.
- Credential/queue system: Any API endpoints, database schemas, or UI queues mentioned
- Browser/test setup: Browser types, devices, stealth configurations already in use
- Anti-detection patterns already present

### Phase 2: Intelligent Code Understanding
Using full repo context, Hermes builds a **Repo Knowledge Graph**:
- Test flows and page objects
- Current locators (CSS, role, test-id, XPath)
- Flakiness patterns from recent commits or issues
- Performance bottlenecks
- Existing credential injection mechanisms
- Custom components (Web Components, Shadow DOM usage)

### Phase 3: Full Adaptation & Rewrite (Where Necessary)
Hermes **rewrites and customizes** while maintaining 100% backward compatibility with all skills:

**Test Files**:
- Upgrade all locators to repo-specific best practices (e.g., add data-testid if missing, optimize for Shadow DOM if used)
- Inject repo-specific credential handling (e.g., if repo uses JWT or session cookies)
- Add repo-specific waits (e.g., for custom loading overlays or API polling)
- Integrate existing page objects or create new ones if absent

**Configuration**:
- Update playwright.config.ts with optimal projects, devices, and retries based on repo's CI environment
- Add or enhance anti-detection stealth settings tailored to the app's detection patterns (if any)
- Configure concurrency and sharding based on repo's test volume and CI resources

**GitHub Actions**:
- Enhance `.github/workflows/hermes-qa-agent.yml` with repo-specific secrets, matrix testing, and artifact paths
- Add repo-specific triggers (e.g., on pull_request to specific paths)

**New Capabilities Added During Adaptation**:
- Repo-specific MTS analysis (e.g., custom visual regression if Percy/Applitools is used)
- Custom notification channels (Slack, Discord, or repo's internal tools)
- Auto-generated "Hermes Adaptation Report" committed as `docs/hermes-adaptation-report.md`

### Phase 4: Self-Validation & Locking
- Run full test suite post-adaptation
- Validate all core skills still function (queue draining, self-healing, evasion, etc.)
- Create a **Version Lock** file: `.hermes/version-lock.json` containing:
  - Adapted repo commit SHA
  - Timestamp
  - Summary of changes
  - Token fingerprint (hashed for privacy)
- This allows future "Re-adapt" commands to quickly sync without full re-analysis

### Phase 5: Future-Proofing
- Hermes now maintains a **per-repo profile** in `learning/repo-profiles/`
- On future activations with the same repo + token, it performs **incremental updates** instead of full rewrite
- Supports multiple repos via `learning/repo-profiles/{owner-repo}.json`

## Example Adaptation Output
After deep analysis of a sample repo:
- 47 test files updated with optimized locators
- playwright.config.ts enhanced with 3 new device projects
- New `tests/hermes-credential-helper.ts` created for repo-specific auth
- `.github/workflows/hermes-qa-agent.yml` updated with repo secrets and caching
- `docs/hermes-adaptation-report.md` committed with full change log

## Commands for Future Use
- `Re-adapt Hermes to repo: https://github.com/owner/repo-name` (uses cached profile + incremental changes)
- `Hermes full reset for repo: https://github.com/owner/repo-name` (fresh deep analysis)
- `Hermes analyze only repo: https://github.com/owner/repo-name` (read-only report, no changes)

**You now have a production-ready, token-aware, deep-adapting Hermes v5.0 that can perfectly customize itself to any GitHub repository while preserving every existing capability.**
