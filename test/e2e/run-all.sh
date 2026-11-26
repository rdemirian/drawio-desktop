#!/bin/bash
# Usage: test/e2e/run-all.sh   (macOS; uses ports 9333-9335 and $E2E_DIR)
cd "$(dirname "$0")"
./setup.sh || exit 1
status=0
for s in scenario-*.sh; do echo "== $s"; ./$s || status=1; done
exit $status
