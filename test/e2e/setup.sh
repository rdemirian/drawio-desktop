#!/bin/bash
# Creates a bare "GitHub" remote and three teammates' clones with a diagram.
source "$(dirname "$0")/common.sh"
rm -rf "$E2E_DIR" && mkdir -p "$E2E_DIR" && cd "$E2E_DIR"
git init -q --bare -b main remote.git
git clone -q remote.git alice 2>/dev/null
cp "$HERE/fixtures/arch.drawio" alice/
git -C alice -c user.name=Setup -c user.email=setup@example.com commit -q --allow-empty -m init
git -C alice add arch.drawio && git -C alice -c user.name=Setup -c user.email=setup@example.com commit -q -m "add diagram"
git -C alice push -q -u origin HEAD:main
for n in bob carol; do git clone -q remote.git $n; done
git -C alice config user.name "Alice Chen"; git -C alice config user.email alice@example.com
git -C bob config user.name "Bob Rivera"; git -C bob config user.email bob@example.com
git -C carol config user.name "Carol Diaz"; git -C carol config user.email carol@example.com
echo "Set up in $E2E_DIR"
