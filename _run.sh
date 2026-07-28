#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
OUT="${1:-./_shots}"
JOBS="${2:-_jobs_all.json}"
pkill -f ed-cdp-profile >/dev/null 2>&1
sleep 1
node _shot.mjs "$OUT" "$JOBS" > ./_shots_log.txt 2>&1
echo "exit=$?"
grep -c saved ./_shots_log.txt
grep -i 'error\|failed' ./_shots_log.txt | head -5
