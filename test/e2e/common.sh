#!/bin/bash
# Shared helpers for the end-to-end scenarios. Runs real app instances, each
# with its own clone, profile and DevTools port, and drives them over CDP.
set -u
E2E_DIR=${E2E_DIR:-/tmp/drawio-e2e}
APP_DIR=$(cd "$(dirname "$0")/../.." && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
# DevTools port of each person (bash 3 has no associative arrays)
port() { case $1 in alice) echo 9333;; bob) echo 9334;; carol) echo 9335;; esac; }

nap() { perl -e "select(undef,undef,undef,$1)"; }

# eval <name> <js>: evaluates js in that person's window, prints the result
ev() { CDP_PORT=$(port $1) node "$HERE/cdp.mjs" eval "$2"; }

launch()
{
	local name=$1 port=$(port $1)
	stop "$name"
	rm -f "$E2E_DIR/$name/.\$arch.drawio.dtmp" "$E2E_DIR/$name/.\$arch.drawio.bkp"
	(cd "$APP_DIR" && nohup ./node_modules/.bin/electron . --remote-debugging-port=$port \
		--user-data-dir="$E2E_DIR/profile-$name" "$E2E_DIR/$name/arch.drawio" > "$E2E_DIR/$name.log" 2>&1 &)
	for i in $(seq 1 60); do curl -s http://127.0.0.1:$port/json | grep -q index.html && break; nap 0.5; done
}

stop() { pkill -f "remote-debugging-port=$(port $1)" 2>/dev/null; nap 1; }
kill9() { pkill -9 -f "remote-debugging-port=$(port $1)" 2>/dev/null; }
stopall() { for n in alice bob carol; do pkill -f "remote-debugging-port=$(port $n)" 2>/dev/null; done; nap 1.5; }
reset() { for n in "$@"; do git -C "$E2E_DIR/$n" checkout -q -- arch.drawio; done; }

setvalue() { ev "$1" "var m=window.__drawioGit.ui.editor.graph.model; m.setValue(m.getCell('$2'), '$3'); 'ok'" > /dev/null; }

# Prints "hash | web | db | api" for a person
state() { ev "$1" "var ui=window.__drawioGit.ui, m=ui.editor.graph.model; [ui.getHashValueForPages(ui.pages), m.getCell('web').value, m.getCell('db').value, m.getCell('api').value].join(' | ')"; }

readypeers() { ev "$1" "Object.values(window.__drawioGit.live.peers).filter(p=>p.ready).length"; }

# check <description> <condition>
FAILED=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; FAILED=1; fi; }
