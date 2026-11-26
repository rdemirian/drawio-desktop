# GitHub source control

> **Status: in testing.** Not production ready. See [TESTING.md](TESTING.md).

draw.io desktop has built-in git/GitHub source control so teams can collaborate on diagrams stored in a repository.

Open the panel with **⇧⌘G**, the status pill in the bottom-right corner, or **File → Source Control (GitHub)…**.

## What it does

- **Shows where you stand:** current branch, unsaved and uncommitted edits, commits waiting to be pushed (↑) and incoming commits (↓).
- **Tells you when someone else pushed:** the repository of the open diagram is fetched in the background (every minute by default; configurable). When a teammate pushes a change to the diagram you get a toast, a macOS notification if the window is in the background, and a card naming who changed what.
- **Preview before you pull:** a visual before/after of their change, with added shapes in green, removed in red and changed in amber.
- **Cell-by-cell merging:** diagrams are never merged line by line. Your edits (including unsaved ones) and theirs are merged shape by shape with draw.io's own diff/patch engine (the one behind its real-time collaboration). You only decide when you both changed the same property of the same shape, or one of you deleted a shape the other changed.
- **Conflict resolution UI:** each conflict shows your version and theirs side by side with the shape highlighted. Pick Mine or Theirs per conflict, or all at once. "Later" keeps your work and lets you resume from the panel; "Abort merge" restores your version exactly.
- **One-click Commit & Sync:** save → commit → pull (merge) → push. If someone pushed in the meantime, it pulls and merges first.
- **History of the diagram:** every commit with its author, a visual "what changed in this commit", "compare with now", Restore, and links to GitHub.
- **Others' work in progress:** commits on other branches that touch the diagram ("Sam is editing this on `sam/new-layout`") with a visual preview.
- **Branches:** switch, track remote branches, create new ones, and open a pull request on GitHub.
- **Getting started:** start versioning a folder, clone a GitHub repository (with a picker of your repos when the GitHub CLI is signed in), or publish a local repository to GitHub.

## How it works

- Uses the system `git` binary, so existing credentials work: macOS Keychain, `gh auth setup-git`, SSH agent, git-credential-manager. Git never prompts in the background; authentication problems are explained in the panel.
- `*.drawio`, `*.dio` and `*.drawio.svg` are marked `merge=binary` in `.git/info/attributes` so git leaves both-sides changes to the editor's merge. draw.io drafts and backups (`.$*.dtmp`, `.$*.bkp`) are added to `.git/info/exclude`. The repository's tracked files are not touched.
- Local edits are copied to `.git/drawio-backups/` before any operation that touches them (pull with local edits, discard).
- Merged diagrams are written uncompressed, which gives readable diffs on GitHub.

Code: `src/main/git/` (main process service and IPC) and `src/main/git/renderer/` (UI and merge engine, injected into the editor window). Tests: `src/test/git-service.test.js`.

## Requirements

- Git (Xcode command line tools: `xcode-select --install`, or Homebrew).
- Optional: the GitHub CLI (`brew install gh`, then `gh auth login` and `gh auth setup-git`) for browsing repositories, publishing, and HTTPS credentials.
