// GitHub / git source control for draw.io desktop.
//
// Thin, defensive wrapper around the system git CLI. Using the real git binary
// (instead of a JS reimplementation) means the user's existing credential
// helpers (macOS keychain, `gh auth setup-git`, SSH agent), hooks, config and
// LFS all just work, and behaviour matches what they see on the command line.
//
// Every command is run with execFile (no shell) and every operation on a
// repository is serialised through a per-repository queue so that the
// background fetcher can never race a user initiated pull/commit/push and
// trip over .git/index.lock.

import { execFile } from 'child_process';
import fs from 'fs';
import { promises as fsProm } from 'fs';
import path from 'path';

// Extensions of files that hold draw.io XML which we can merge semantically
export const DRAWIO_XML_EXT = /\.(drawio|dio|xml)$/i;

// Files that git must never merge line-by-line: a textual merge of diagram
// XML either produces a broken file or silently drops cells. Marking them as
// binary for merging makes git leave every both-sides change as a conflict
// with the base/ours/theirs stages intact, which the editor then merges cell
// by cell. Written to .git/info/attributes so the user's repo is untouched.
const ATTRIBUTES_MARKER = '# drawio-desktop source control';
const ATTRIBUTES_BLOCK = [
	ATTRIBUTES_MARKER,
	'*.drawio merge=binary',
	'*.dio merge=binary',
	'*.drawio.svg merge=binary',
	'*.drawio.png binary',
	''
].join('\n');

const FIELD = '\x1f';
const RECORD = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%at', '%s', '%D'].join('%x1f') + '%x1e';

const MAC_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export class GitError extends Error
{
	constructor(message, {code, stderr, stdout, args, kind} = {})
	{
		super(message);
		this.name = 'GitError';
		this.code = code;
		this.stderr = stderr;
		this.stdout = stdout;
		this.args = args;
		this.kind = kind || classifyGitError(stderr || message);
	}
}

// Maps git's (LC_ALL=C) error output to a small set of kinds the UI can
// explain in plain language
export function classifyGitError(text)
{
	text = String(text || '');

	if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|403|Repository not found|invalid credentials/i.test(text))
	{
		return 'auth';
	}
	else if (/non-fast-forward|\[rejected\]|fetch first|Updates were rejected/i.test(text))
	{
		return 'rejected';
	}
	else if (/Could not resolve host|unable to access|Connection timed out|Network is unreachable|Operation timed out|Could not read from remote/i.test(text))
	{
		return 'network';
	}
	else if (/would be overwritten by merge|Please commit your changes or stash them/i.test(text))
	{
		return 'dirty';
	}
	else if (/index\.lock/i.test(text))
	{
		return 'locked';
	}
	else if (/no upstream|has no upstream branch|no tracking information/i.test(text))
	{
		return 'no-upstream';
	}
	else if (/Please tell me who you are|unable to auto-detect email/i.test(text))
	{
		return 'identity';
	}

	return 'unknown';
}

// Revisions passed by the renderer are validated so they can never be read as
// options ("--upload-pack=...") or contain anything but a ref expression
export function assertSafeRev(rev)
{
	if (typeof rev !== 'string' || rev.length == 0 || rev.length > 200 ||
		rev.startsWith('-') || !/^[A-Za-z0-9_.\/@{}~^:+-]+$/.test(rev) || rev.includes('..'))
	{
		throw new Error('Invalid revision: ' + rev);
	}

	return rev;
}

export function assertSafeBranchName(name)
{
	if (typeof name !== 'string' || name.length == 0 || name.length > 200 ||
		name.startsWith('-') || name.startsWith('/') || name.endsWith('/') ||
		name.endsWith('.lock') || name.includes('..') || name.includes('@{') ||
		!/^[A-Za-z0-9_.\/+-]+$/.test(name))
	{
		throw new Error('Invalid branch name: ' + name);
	}

	return name;
}

// Converts a git remote URL to the https URL of the repository on GitHub (or
// any GitHub Enterprise host), or null for other hosts.
export function remoteToWebUrl(remote)
{
	if (typeof remote !== 'string') return null;

	remote = remote.trim();
	let m = remote.match(/^git@([^:]+):(.+?)(\.git)?\/?$/) ||
		remote.match(/^ssh:\/\/git@([^\/:]+)(?::\d+)?\/(.+?)(\.git)?\/?$/) ||
		remote.match(/^https?:\/\/(?:[^@\/]+@)?([^\/]+)\/(.+?)(\.git)?\/?$/);

	if (m == null || !/github/i.test(m[1]))
	{
		return null;
	}

	return 'https://' + m[1] + '/' + m[2];
}

export function parseLog(stdout)
{
	return String(stdout || '').split(RECORD).map(r => r.replace(/^\n/, '')).
		filter(r => r.length > 0).map(r =>
	{
		const f = r.split(FIELD);

		return {
			hash: f[0], short: f[1], author: f[2], email: f[3],
			date: parseInt(f[4], 10) * 1000, subject: f[5] || '',
			refs: (f[6] || '').split(',').map(s => s.trim()).filter(s => s.length > 0),
			source: (f[7] || '').trim() || undefined
		};
	});
}

// Parses `git status --porcelain=v2 --branch -z`
export function parseStatus(stdout)
{
	const result = {branch: null, oid: null, upstream: null, ahead: 0, behind: 0, entries: []};
	const parts = String(stdout || '').split('\0');

	for (let i = 0; i < parts.length; i++)
	{
		const line = parts[i];

		if (line.length == 0) continue;

		if (line.startsWith('# branch.oid '))
		{
			result.oid = line.substring(13);
		}
		else if (line.startsWith('# branch.head '))
		{
			const head = line.substring(14);
			result.branch = (head == '(detached)') ? null : head;
			result.detached = head == '(detached)';
		}
		else if (line.startsWith('# branch.upstream '))
		{
			result.upstream = line.substring(18);
		}
		else if (line.startsWith('# branch.ab '))
		{
			const m = line.match(/\+(\d+) -(\d+)/);

			if (m != null)
			{
				result.ahead = parseInt(m[1], 10);
				result.behind = parseInt(m[2], 10);
			}
		}
		else if (line.startsWith('1 '))
		{
			const f = line.split(' ');
			result.entries.push({type: 'changed', xy: f[1], path: f.slice(8).join(' ')});
		}
		else if (line.startsWith('2 '))
		{
			const f = line.split(' ');
			// Renames are followed by the original path as the next field
			result.entries.push({type: 'renamed', xy: f[1], path: f.slice(9).join(' '), origPath: parts[++i]});
		}
		else if (line.startsWith('u '))
		{
			const f = line.split(' ');
			result.entries.push({type: 'conflict', xy: f[1], path: f.slice(10).join(' ')});
		}
		else if (line.startsWith('? '))
		{
			result.entries.push({type: 'untracked', xy: '??', path: line.substring(2)});
		}
	}

	return result;
}

// Human readable state of one status entry
export function describeEntry(entry)
{
	if (entry == null) return 'clean';
	if (entry.type == 'conflict') return 'conflicted';
	if (entry.type == 'untracked') return 'untracked';

	const x = entry.xy[0], y = entry.xy[1];

	if (x == 'A') return 'added';
	if (x == 'D' || y == 'D') return 'deleted';
	if (entry.type == 'renamed') return 'renamed';

	return 'modified';
}

export function buildGitEnv(base = process.env)
{
	const sep = path.delimiter;
	const parts = String(base.PATH || '').split(sep).filter(p => p.length > 0);

	// Apps started from Finder get a minimal PATH, so credential helpers such
	// as `gh` or git-credential-manager installed by Homebrew are not found
	if (process.platform == 'darwin')
	{
		for (const p of MAC_PATHS)
		{
			if (!parts.includes(p)) parts.push(p);
		}
	}

	const env = Object.assign({}, base, {
		PATH: parts.join(sep),
		// Never block on an interactive prompt: there is no terminal
		GIT_TERMINAL_PROMPT: '0',
		// Stable, parseable messages
		LC_ALL: 'C',
		LANG: 'C'
	});

	if (env.GIT_SSH_COMMAND == null && env.GIT_SSH == null)
	{
		env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20';
	}

	return env;
}

export class GitService
{
	constructor(opts = {})
	{
		this.log = opts.log || (() => {});
		this.gitPath = opts.gitPath || null;
		this.env = opts.env || buildGitEnv();
		this.queues = new Map();
		this.execFile = opts.execFile || execFile;
	}

	async resolveGit()
	{
		if (this.gitPath != null) return this.gitPath;

		const candidates = process.platform == 'win32' ? ['git.exe', 'git'] :
			['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git', 'git'];

		for (const c of candidates)
		{
			if (c.includes('/') && !fs.existsSync(c)) continue;

			try
			{
				await this.exec(c, null, ['--version'], {timeout: 15000});
				this.gitPath = c;
				return c;
			}
			catch (e)
			{
				// try next
			}
		}

		throw new GitError('Git is not installed. Install the Xcode command line tools (xcode-select --install) or Git from https://git-scm.com.', {kind: 'no-git'});
	}

	exec(bin, cwd, args, opts = {})
	{
		return new Promise((resolve, reject) =>
		{
			const child = this.execFile(bin, args, {
				cwd: cwd || undefined,
				env: Object.assign({}, this.env, opts.env || {}),
				maxBuffer: 256 * 1024 * 1024,
				timeout: opts.timeout || 120000,
				encoding: opts.encoding || 'utf8',
				windowsHide: true
			}, (err, stdout, stderr) =>
			{
				if (err != null && !opts.allowFail)
				{
					const msg = String(stderr || '').trim() || err.message;
					reject(new GitError(msg, {code: err.code, stderr: String(stderr || ''), stdout, args}));
				}
				else
				{
					resolve({code: err ? (err.code || 1) : 0, stdout, stderr: String(stderr || '')});
				}
			});

			if (opts.input != null && child != null && child.stdin != null)
			{
				child.stdin.end(opts.input);
			}
		});
	}

	async git(cwd, args, opts)
	{
		const bin = await this.resolveGit();
		return this.exec(bin, cwd, args, opts);
	}

	// Serialises all operations on one repository
	enqueue(root, fn)
	{
		const prev = this.queues.get(root) || Promise.resolve();
		const next = prev.catch(() => {}).then(fn);
		const tail = next.catch(() => {});
		this.queues.set(root, tail);

		tail.then(() =>
		{
			if (this.queues.get(root) === tail) this.queues.delete(root);
		});

		return next;
	}

	// Returns {root, relPath} for a file, or null if it is not in a work tree
	async locate(filePath)
	{
		let real;

		try
		{
			real = await fsProm.realpath(filePath);
		}
		catch (e)
		{
			real = path.resolve(filePath);
		}

		const dir = path.dirname(real);
		const res = await this.git(dir, ['rev-parse', '--show-toplevel'], {allowFail: true});

		if (res.code != 0) return null;

		let root = res.stdout.trim();

		try
		{
			root = await fsProm.realpath(root);
		}
		catch (e)
		{
			// keep
		}

		return {root, relPath: path.relative(root, real).split(path.sep).join('/'), absPath: real};
	}

	async gitPath2(root, name)
	{
		const res = await this.git(root, ['rev-parse', '--git-path', name]);
		return path.resolve(root, res.stdout.trim());
	}

	async ensureAttributes(root)
	{
		const file = await this.gitPath2(root, 'info/attributes');
		let current = '';

		try
		{
			current = await fsProm.readFile(file, 'utf8');
		}
		catch (e)
		{
			// does not exist yet
		}

		if (!current.includes(ATTRIBUTES_MARKER))
		{
			await fsProm.mkdir(path.dirname(file), {recursive: true});
			await fsProm.writeFile(file, (current.length > 0 && !current.endsWith('\n') ?
				current + '\n' : current) + ATTRIBUTES_BLOCK, 'utf8');
		}
	}

	// draw.io writes drafts (.$name.dtmp) and backups (.$name.bkp) next to
	// diagrams: these are private to each user and must never be committed
	async ensureExcludes(root)
	{
		const file = await this.gitPath2(root, 'info/exclude');
		let current = '';

		try
		{
			current = await fsProm.readFile(file, 'utf8');
		}
		catch (e)
		{
			// does not exist yet
		}

		if (!current.includes(ATTRIBUTES_MARKER))
		{
			await fsProm.mkdir(path.dirname(file), {recursive: true});
			await fsProm.writeFile(file, (current.length > 0 && !current.endsWith('\n') ? current + '\n' : current) +
				[ATTRIBUTES_MARKER, '.$*.dtmp', '~$*.dtmp', '.$*.bkp', '~$*.bkp', ''].join('\n'), 'utf8');
		}
	}

	async ensureRepoSetup(root)
	{
		if (this.setupDone == null) this.setupDone = new Set();
		if (this.setupDone.has(root)) return;

		await this.ensureAttributes(root);
		await this.ensureExcludes(root);
		this.setupDone.add(root);
	}

	async config(root, key)
	{
		const res = await this.git(root, ['config', '--get', key], {allowFail: true});
		return res.code == 0 ? res.stdout.trim() : null;
	}

	async isMerging(root)
	{
		try
		{
			await fsProm.access(await this.gitPath2(root, 'MERGE_HEAD'));
			return true;
		}
		catch (e)
		{
			return false;
		}
	}

	async lastFetch(root)
	{
		try
		{
			return (await fsProm.stat(await this.gitPath2(root, 'FETCH_HEAD'))).mtimeMs;
		}
		catch (e)
		{
			return null;
		}
	}

	async remotes(root)
	{
		const res = await this.git(root, ['remote', '-v'], {allowFail: true});
		const map = {};

		for (const line of res.stdout.split('\n'))
		{
			const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
			if (m) map[m[1]] = m[2];
		}

		return map;
	}

	// Full status of the repository seen from one file
	async status(filePath)
	{
		const loc = await this.locate(filePath);

		if (loc == null)
		{
			let gitAvailable = true;

			try { await this.resolveGit(); } catch (e) { gitAvailable = false; }

			return {isRepo: false, gitAvailable, dir: path.dirname(filePath)};
		}

		return this.enqueue(loc.root, async () =>
		{
			try { await this.ensureRepoSetup(loc.root); } catch (e) { this.log('git setup failed', e.message); }

			const res = await this.git(loc.root, ['status', '--porcelain=v2', '--branch', '-z'],
				{env: {GIT_OPTIONAL_LOCKS: '0'}});
			const st = parseStatus(res.stdout);
			const entry = st.entries.find(e => e.path == loc.relPath) || null;
			const remotes = await this.remotes(loc.root);
			const upstreamRemote = st.upstream ? st.upstream.split('/')[0] : null;
			const remoteName = (upstreamRemote && remotes[upstreamRemote]) ? upstreamRemote :
				(remotes.origin ? 'origin' : Object.keys(remotes)[0] || null);
			const remoteUrl = remoteName ? remotes[remoteName] : null;
			let headCommit = null;

			if (st.oid && st.oid != '(initial)')
			{
				const h = await this.git(loc.root, ['log', '-1', '--format=' + LOG_FORMAT], {allowFail: true});
				headCommit = parseLog(h.stdout)[0] || null;
			}

			return {
				isRepo: true,
				gitAvailable: true,
				root: loc.root,
				relPath: loc.relPath,
				repoName: path.basename(loc.root),
				branch: st.branch,
				detached: !!st.detached,
				initial: st.oid == '(initial)',
				upstream: st.upstream,
				ahead: st.ahead,
				behind: st.behind,
				fileState: describeEntry(entry),
				tracked: entry == null || entry.type != 'untracked',
				changes: st.entries.map(e => ({path: e.path, state: describeEntry(e)})),
				conflicts: st.entries.filter(e => e.type == 'conflict').map(e => e.path),
				merging: await this.isMerging(loc.root),
				remoteName,
				remoteUrl,
				webUrl: remoteToWebUrl(remoteUrl),
				userName: await this.config(loc.root, 'user.name'),
				userEmail: await this.config(loc.root, 'user.email'),
				lastFetch: await this.lastFetch(loc.root),
				head: headCommit
			};
		});
	}

	async fetch(root)
	{
		return this.enqueue(root, async () =>
		{
			const remotes = await this.remotes(root);

			if (Object.keys(remotes).length == 0) return {fetched: false};

			await this.git(root, ['fetch', '--prune', '--quiet', '--no-recurse-submodules'], {timeout: 90000});

			return {fetched: true};
		});
	}

	async logRange(root, range, relPath, limit = 100)
	{
		const args = ['log', '-n', String(limit), '--format=' + LOG_FORMAT, range];

		if (relPath != null) args.push('--', relPath);

		const res = await this.git(root, args, {allowFail: true});

		return res.code == 0 ? parseLog(res.stdout) : [];
	}

	// Commits on the upstream that are not local (incoming) and local commits
	// that are not pushed (outgoing), plus unmerged work by others on any
	// remote branch touching this file.
	async activity(filePath)
	{
		const loc = await this.locate(filePath);

		if (loc == null) return null;

		return this.enqueue(loc.root, async () =>
		{
			const up = await this.git(loc.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {allowFail: true});
			const upstream = up.code == 0 ? up.stdout.trim() : null;
			const result = {upstream, incoming: [], incomingFile: [], outgoing: [], outgoingFile: [], otherBranches: []};

			if (upstream != null)
			{
				result.incoming = await this.logRange(loc.root, 'HEAD..@{u}', null);
				result.incomingFile = await this.logRange(loc.root, 'HEAD..@{u}', loc.relPath);
				result.outgoing = await this.logRange(loc.root, '@{u}..HEAD', null);
				result.outgoingFile = await this.logRange(loc.root, '@{u}..HEAD', loc.relPath);
				const mb = await this.git(loc.root, ['merge-base', 'HEAD', '@{u}'], {allowFail: true});
				result.mergeBase = mb.code == 0 ? mb.stdout.trim() : null;
			}

			// Work in progress by others: commits on other remote branches that
			// touch this diagram and are not in our history yet
			const args = ['log', '--remotes', '--not', 'HEAD'];

			if (upstream != null) args.push('--not', '@{u}');

			args.push('--since=60.days', '--source', '-n', '200',
				'--format=' + LOG_FORMAT.replace('%x1e', '%x1f%S%x1e'), '--', loc.relPath);

			const res = await this.git(loc.root, args, {allowFail: true});
			const byBranch = new Map();

			for (const c of parseLog(res.stdout))
			{
				const branch = (c.source || '').replace(/^refs\/remotes\//, '');

				if (branch.length == 0 || branch.endsWith('/HEAD')) continue;

				if (!byBranch.has(branch))
				{
					byBranch.set(branch, {branch, count: 0, latest: c, authors: []});
				}

				const b = byBranch.get(branch);
				b.count++;

				if (!b.authors.includes(c.author)) b.authors.push(c.author);
			}

			result.otherBranches = Array.from(byBranch.values()).
				sort((a, b) => b.latest.date - a.latest.date);

			return result;
		});
	}

	async history(filePath, limit = 100)
	{
		const loc = await this.locate(filePath);

		if (loc == null) return [];

		return this.enqueue(loc.root, async () =>
		{
			const res = await this.git(loc.root, ['log', '-n', String(limit), '--follow',
				'--format=' + LOG_FORMAT, '--', loc.relPath], {allowFail: true});
			const commits = res.code == 0 ? parseLog(res.stdout) : [];
			const unpushed = new Set((await this.logRange(loc.root, '@{u}..HEAD', null, 1000)).map(c => c.hash));
			const hasUpstream = (await this.git(loc.root, ['rev-parse', '@{u}'], {allowFail: true})).code == 0;

			for (const c of commits)
			{
				c.pushed = hasUpstream && !unpushed.has(c.hash);
			}

			return commits;
		});
	}

	// Contents of the file at a revision. Uses the path the file had in that
	// revision when it was renamed since (--follow).
	async show(filePath, rev)
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		return this.enqueue(loc.root, () => this.showRel(loc.root, rev, loc.relPath));
	}

	async showRel(root, rev, relPath)
	{
		// Stage numbers for conflicts (":1", ":2", ":3") or a revision
		const spec = /^:[123]$/.test(rev) ? rev + ':' + relPath : assertSafeRev(rev) + ':' + relPath;
		let res = await this.git(root, ['show', spec], {allowFail: true, encoding: 'buffer'});

		if (res.code != 0 && !/^:/.test(rev))
		{
			// The file may have been renamed: find its old name in that commit
			const names = await this.git(root, ['log', '--follow', '--name-only', '--format=%H', rev, '--', relPath], {allowFail: true});
			const lines = names.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
			const idx = lines.findIndex(l => /^[0-9a-f]{40}$/.test(l));

			if (idx >= 0 && lines[idx + 1] != null && lines[idx + 1] != relPath)
			{
				res = await this.git(root, ['show', assertSafeRev(rev) + ':' + lines[idx + 1]], {allowFail: true, encoding: 'buffer'});
			}
		}

		if (res.code != 0)
		{
			return null;
		}

		return Buffer.from(res.stdout).toString('utf8');
	}

	async commit(filePath, message, opts = {})
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		if (typeof message !== 'string' || message.trim().length == 0)
		{
			throw new Error('A commit message is required');
		}

		return this.enqueue(loc.root, async () =>
		{
			await this.git(loc.root, ['add', '--', loc.relPath]);

			if (opts.all)
			{
				await this.git(loc.root, ['add', '-A']);
			}

			const staged = await this.git(loc.root, ['diff', '--cached', '--quiet'], {allowFail: true});

			if (staged.code == 0 && !(await this.isMerging(loc.root)))
			{
				return {committed: false};
			}

			await this.git(loc.root, ['commit', '-q', '-F', '-'], {input: message.trim() + '\n'});
			const head = await this.git(loc.root, ['log', '-1', '--format=' + LOG_FORMAT]);

			return {committed: true, commit: parseLog(head.stdout)[0]};
		});
	}

	// Merges the upstream into the current branch. Diagram files are never
	// merged textually (see ATTRIBUTES_BLOCK), so for the given diagram this
	// returns the three versions the renderer needs for a cell level merge:
	// base (merge base), ours (current working copy, including uncommitted
	// edits) and theirs (upstream).
	async pull(filePath)
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		const root = loc.root, rel = loc.relPath;

		await this.fetch(root);

		return this.enqueue(root, async () =>
		{
			await this.ensureRepoSetup(root);

			if (await this.isMerging(root))
			{
				throw new GitError('A merge is already in progress. Resolve or abort it first.', {kind: 'merging'});
			}

			const up = await this.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {allowFail: true});

			if (up.code != 0)
			{
				throw new GitError('This branch is not tracking a remote branch yet. Push it first.', {kind: 'no-upstream'});
			}

			const behind = parseInt((await this.git(root, ['rev-list', '--count', 'HEAD..@{u}'])).stdout.trim(), 10);

			if (behind == 0)
			{
				return {result: 'up-to-date'};
			}

			const oldHead = (await this.git(root, ['rev-parse', 'HEAD'])).stdout.trim();
			const upHead = (await this.git(root, ['rev-parse', '@{u}'])).stdout.trim();
			const mb = await this.git(root, ['merge-base', 'HEAD', '@{u}'], {allowFail: true});
			const mergeBase = mb.code == 0 ? mb.stdout.trim() : null;

			// The open diagram is taken out of the way if it has local edits so
			// that git can update it; the edits are merged back in by the editor
			let ours = null;
			let fileDirty = false;
			let backupPath = null;
			const exists = fs.existsSync(loc.absPath);

			if (exists)
			{
				const diff = await this.git(root, ['diff', '--quiet', 'HEAD', '--', rel], {allowFail: true});
				const tracked = (await this.git(root, ['ls-files', '--error-unmatch', '--', rel], {allowFail: true})).code == 0;
				fileDirty = tracked && diff.code != 0;
				ours = await fsProm.readFile(loc.absPath, 'utf8');

				if (fileDirty)
				{
					backupPath = await this.backup(root, rel, ours);
					await this.git(root, ['checkout', 'HEAD', '--', rel]);
				}
			}

			let mergeError = null;

			try
			{
				await this.git(root, ['merge', '--no-edit', '-m',
					'Merge ' + up.stdout.trim() + ' into ' + (await this.currentBranch(root)), '@{u}'],
					{timeout: 120000});
			}
			catch (e)
			{
				mergeError = e;
			}

			const st = parseStatus((await this.git(root, ['status', '--porcelain=v2', '--branch', '-z'])).stdout);
			const conflicts = st.entries.filter(e => e.type == 'conflict').map(e => e.path);

			if (mergeError != null && conflicts.length == 0)
			{
				// Merge did not start (eg. other local changes in the way):
				// put the diagram back exactly as it was
				if (fileDirty)
				{
					await fsProm.writeFile(loc.absPath, ours, 'utf8');
				}

				throw mergeError;
			}

			const fileConflicted = conflicts.includes(rel);
			const fileChanged = (await this.git(root, ['diff', '--quiet', oldHead, 'HEAD', '--', rel], {allowFail: true})).code != 0;
			const result = {
				result: conflicts.length > 0 ? 'conflicts' : 'merged',
				conflicts,
				fileDirty,
				fileConflicted,
				fileChanged: fileChanged || fileConflicted,
				backupPath,
				oldHead,
				upHead,
				needsDiagramMerge: fileConflicted || (fileDirty && fileChanged)
			};

			if (result.needsDiagramMerge)
			{
				result.base = mergeBase ? await this.showRel(root, mergeBase, rel) : null;
				result.ours = ours;
				result.theirs = await this.showRel(root, upHead, rel);
			}

			// Leaves the working copy with the local edits until the editor writes
			// the merged diagram, so nothing is lost if the app is closed. If the
			// incoming commits did not touch the diagram this just restores them.
			if (fileDirty || result.needsDiagramMerge)
			{
				await fsProm.writeFile(loc.absPath, ours, 'utf8');
			}

			result.incoming = await this.logRange(root, oldHead + '..' + upHead, rel, 50);

			return result;
		});
	}

	async currentBranch(root)
	{
		const res = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], {allowFail: true});
		return res.code == 0 ? res.stdout.trim() : 'HEAD';
	}

	// Keeps a copy of local edits under .git/drawio-backups before touching them
	async backup(root, rel, data)
	{
		const dir = await this.gitPath2(root, 'drawio-backups');
		await fsProm.mkdir(dir, {recursive: true});
		const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + rel.replace(/[\/\\]/g, '_');
		const file = path.join(dir, name);
		await fsProm.writeFile(file, data, 'utf8');

		return file;
	}

	// Writes the merged diagram (or picks one side for any conflicted file),
	// marks it resolved and completes the merge once nothing is left
	async resolve(filePath, relPath, opts)
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		const rel = relPath || loc.relPath;
		const abs = path.resolve(loc.root, rel);

		if (path.relative(loc.root, abs).startsWith('..'))
		{
			throw new Error('Path outside repository');
		}

		return this.enqueue(loc.root, async () =>
		{
			const merging = await this.isMerging(loc.root);
			const conflicted = (await this.git(loc.root, ['ls-files', '-u', '--', rel])).stdout.trim().length > 0;

			if (opts.side == 'ours' || opts.side == 'theirs')
			{
				const r = await this.git(loc.root, ['checkout', '--' + opts.side, '--', rel], {allowFail: true});

				if (r.code != 0)
				{
					// Deleted on that side
					await this.git(loc.root, ['rm', '-q', '--', rel]);
				}
			}
			else if (typeof opts.content === 'string')
			{
				if (!/<(mxfile|mxGraphModel)[\s>]/.test(opts.content))
				{
					throw new Error('Refusing to write: not a draw.io diagram');
				}

				await fsProm.writeFile(abs, opts.content, 'utf8');
			}

			if (conflicted && fs.existsSync(abs))
			{
				await this.git(loc.root, ['add', '--', rel]);
			}

			const remaining = (await this.git(loc.root, ['diff', '--name-only', '--diff-filter=U'])).stdout.
				split('\n').filter(l => l.length > 0);
			let completed = false;

			if (merging && remaining.length == 0 && opts.complete !== false)
			{
				await this.git(loc.root, ['commit', '-q', '--no-edit']);
				completed = true;
			}

			return {remaining, completed};
		});
	}

	// Aborts the merge. restoreContent puts back local (uncommitted) edits of
	// the diagram that pull() took out of the way before merging.
	async abortMerge(filePath, restoreContent)
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		return this.enqueue(loc.root, async () =>
		{
			if (await this.isMerging(loc.root))
			{
				await this.git(loc.root, ['merge', '--abort']);
			}

			if (typeof restoreContent === 'string' && /<(mxfile|mxGraphModel)[\s>]/.test(restoreContent))
			{
				await fsProm.writeFile(loc.absPath, restoreContent, 'utf8');
			}

			return {aborted: true};
		});
	}

	async push(filePath)
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		return this.enqueue(loc.root, async () =>
		{
			const branch = await this.currentBranch(loc.root);

			if (branch == 'HEAD') throw new GitError('Cannot push from a detached HEAD. Switch to a branch first.');

			const up = await this.git(loc.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {allowFail: true});

			if (up.code == 0)
			{
				const [remote, ...rest] = up.stdout.trim().split('/');
				await this.git(loc.root, ['push', '--porcelain', remote, 'HEAD:refs/heads/' + rest.join('/')], {timeout: 180000});
			}
			else
			{
				const remotes = await this.remotes(loc.root);
				const remote = remotes.origin ? 'origin' : Object.keys(remotes)[0];

				if (remote == null)
				{
					throw new GitError('This repository has no remote. Publish it to GitHub first.', {kind: 'no-remote'});
				}

				await this.git(loc.root, ['push', '--porcelain', '-u', remote, 'HEAD:refs/heads/' + branch], {timeout: 180000});
			}

			return {pushed: true, branch};
		});
	}

	async discard(filePath)
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		return this.enqueue(loc.root, async () =>
		{
			const data = await fsProm.readFile(loc.absPath, 'utf8').catch(() => null);
			const backupPath = data != null ? await this.backup(loc.root, loc.relPath, data) : null;
			await this.git(loc.root, ['checkout', 'HEAD', '--', loc.relPath]);

			return {backupPath};
		});
	}

	async branches(filePath)
	{
		const loc = await this.locate(filePath);

		if (loc == null) return null;

		return this.enqueue(loc.root, async () =>
		{
			const res = await this.git(loc.root, ['for-each-ref', '--sort=-committerdate',
				'--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(committerdate:unix)%1f%(authorname)%1f%(HEAD)',
				'refs/heads', 'refs/remotes']);
			const local = [], remote = [];

			for (const line of res.stdout.split('\n'))
			{
				if (line.length == 0) continue;

				const f = line.split(FIELD);
				const b = {name: f[1], upstream: f[2] || null, date: parseInt(f[3], 10) * 1000, author: f[4], current: f[5] == '*'};

				if (f[0].startsWith('refs/heads/'))
				{
					local.push(b);
				}
				else if (!f[0].endsWith('/HEAD'))
				{
					remote.push(b);
				}
			}

			return {local, remote, current: await this.currentBranch(loc.root)};
		});
	}

	async checkout(filePath, branch, opts = {})
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		assertSafeBranchName(branch);

		return this.enqueue(loc.root, async () =>
		{
			if (opts.create)
			{
				await this.git(loc.root, ['checkout', '-q', '-b', branch]);
			}
			else if (opts.remote)
			{
				// Tracks a remote branch with a local branch of the same name
				const local = branch.split('/').slice(1).join('/');
				assertSafeBranchName(local);
				const exists = (await this.git(loc.root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + local], {allowFail: true})).code == 0;
				await this.git(loc.root, exists ? ['checkout', '-q', local] : ['checkout', '-q', '--track', branch]);
			}
			else
			{
				await this.git(loc.root, ['checkout', '-q', branch]);
			}

			return {branch: await this.currentBranch(loc.root), fileExists: fs.existsSync(loc.absPath)};
		});
	}

	async init(dir)
	{
		await this.git(dir, ['init', '-q']);
		const root = (await this.git(dir, ['rev-parse', '--show-toplevel'])).stdout.trim();
		await this.ensureRepoSetup(root);

		return {root};
	}

	async clone(url, parentDir)
	{
		if (typeof url !== 'string' || url.startsWith('-') ||
			!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url.trim()))
		{
			throw new Error('Enter an https:// or git@ repository URL');
		}

		url = url.trim();
		const name = url.replace(/\/$/, '').replace(/\.git$/, '').split(/[\/:]/).pop();
		let target = path.join(parentDir, name);
		let i = 2;

		while (fs.existsSync(target))
		{
			target = path.join(parentDir, name + '-' + i++);
		}

		await this.git(parentDir, ['clone', '--quiet', '--', url, target], {timeout: 600000});
		await this.ensureRepoSetup(target);

		return {root: target};
	}

	async addRemote(filePath, url)
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		if (typeof url !== 'string' || url.startsWith('-') || !/^(https:\/\/|git@|ssh:\/\/)\S+$/.test(url.trim()))
		{
			throw new Error('Enter an https:// or git@ repository URL');
		}

		return this.enqueue(loc.root, async () =>
		{
			const remotes = await this.remotes(loc.root);
			await this.git(loc.root, remotes.origin ? ['remote', 'set-url', 'origin', url.trim()] :
				['remote', 'add', 'origin', url.trim()]);

			return {ok: true};
		});
	}

	async setIdentity(filePath, name, email)
	{
		const loc = await this.locate(filePath);

		if (loc == null) throw new Error('Not in a git repository');

		if (typeof name !== 'string' || typeof email !== 'string' || !name.trim() || !/^\S+@\S+$/.test(email.trim()))
		{
			throw new Error('Enter a name and a valid email');
		}

		await this.git(loc.root, ['config', 'user.name', name.trim()]);
		await this.git(loc.root, ['config', 'user.email', email.trim()]);

		return {ok: true};
	}
}
