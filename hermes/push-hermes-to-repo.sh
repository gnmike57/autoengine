#!/bin/bash
set -euo pipefail
REPO="https://github.com/maryjpww-star/automati1.git"
TOKEN="${GITHUB_TOKEN:?Set GITHUB_TOKEN env var}"
BRANCH="hermes-v5.1-automati"
git clone $REPO /tmp/automati-hermes && cd /tmp/automati-hermes && git checkout -b $BRANCH
mkdir -p hermes-24-7-qa-agent
cp -r /home/workdir/.grok/skills/hermes-24-7-qa-agent/* hermes-24-7-qa-agent/
git add hermes-24-7-qa-agent/ && git commit -m "feat: Hermes v5.1.0 - Fully customized for Automati" && git push https://x-access-token:$TOKEN@github.com/maryjpww-star/automati1.git $BRANCH
echo "✅ Pushed to branch: $BRANCH"