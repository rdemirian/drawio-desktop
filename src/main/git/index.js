// Main process side of GitHub source control: routes 'git' requests from the
// renderer to GitService, authorises paths, and watches the repository of the
// diagram open in each window so that pushes by others show up without the
// user having to do anything.

import fs from 'fs';
import path from 'path';
import { GitService, GitError, DRAWIO_XML_EXT, remoteToWebUrl } from './git-service.js';
import { normaliseRemote } from '../live/live-crypto.js';

const DEFAULT_FETCH_INTERVAL = 60 * 1000;
const MIN_FETCH_INTERVAL = 15 * 1000;

function serialiseError(e)
{
	const err = new Error(e && e.message ? e.message : String(e));
	err.kind = (e instanceof GitError) ? e.kind : (e && e.kind) || 'unknown';

	return err;
}

// Reads a share link: a GitHub file URL (https://github.com/o/r/blob/<branch>/<path>)
// or drawio-git://open?repo=<url>&path=<path>&branch=<branch>
export function parseShareLink(link)
{
	let u;

	try
	{
		u = new URL(String(link).trim());
	}
	catch (e)
	{
		return null;
	}

	if (u.protocol == 'drawio-git:')
	{
		const repo = u.searchParams.get('repo'), file = u.searchParams.get('path');

		if (!repo || !file || !/^(https:\/\/|git@|ssh:\/\/)\S+$/.test(repo)) return null;

		return {repo, path: file.replace(/^\/+/, ''), branch: u.searchParams.get('branch') || null, branchAndPath: null};
	}

	if (u.protocol == 'https:' && /github/i.test(u.hostname))
	{
		const m = u.pathname.match(/^\/([^\/]+)\/([^\/]+)\/(?:blob|tree|raw)\/(.+)$/);

		if (m == null) return null;

		// The branch may contain slashes: resolved against the remote later
		return {repo: 'https://' + u.hostname + '/' + m[1] + '/' + m[2].replace(/\.git$/, '') + '.git',
			path: null, branch: null, branchAndPath: decodeURIComponent(m[3])};
	}

	return null;
}

export function createGitIpc({assertReadablePath, blessPath, dialog, BrowserWindow, log, store})
{
	const service = new GitService({log});
	// webContents.id -> {webContents, filePath, root, timer, watcher, lastSig}
	const watches = new Map();

	function getInterval()
	{
		const v = store != null ? store.get('gitFetchInterval') : null;
		return (typeof v === 'number' && v >= MIN_FETCH_INTERVAL) ? v : DEFAULT_FETCH_INTERVAL;
	}

	function send(webContents, channel, data)
	{
		if (webContents != null && !webContents.isDestroyed())
		{
			webContents.send(channel, data);
		}
	}

	async function poll(w, doFetch)
	{
		if (w.polling) return;

		w.polling = true;

		try
		{
			let fetchError = null;

			if (doFetch)
			{
				try
				{
					await service.fetch(w.root);
				}
				catch (e)
				{
					fetchError = {message: e.message, kind: e.kind};
				}
			}

			const activity = await service.activity(w.filePath);

			if (activity == null) return;

			activity.fetchError = fetchError;
			activity.checkedAt = Date.now();
			send(w.webContents, 'git-activity', {path: w.filePath, activity});
		}
		catch (e)
		{
			log.warn('git poll failed', e.message);
		}
		finally
		{
			w.polling = false;
		}
	}

	function unwatch(webContents)
	{
		const w = watches.get(webContents.id);

		if (w != null)
		{
			clearInterval(w.timer);
			clearTimeout(w.debounce);

			try { w.watcher?.close(); } catch (e) {}

			watches.delete(webContents.id);
		}
	}

	async function watch(webContents, filePath)
	{
		const existing = watches.get(webContents.id);

		if (existing != null && existing.filePath == filePath) return {root: existing.root};

		unwatch(webContents);

		const loc = await service.locate(filePath);

		if (loc == null) return {root: null};

		rememberRepo(loc.root);

		const w = {webContents, filePath, root: loc.root, polling: false};
		watches.set(webContents.id, w);

		w.timer = setInterval(() => poll(w, true), getInterval());

		// Commits, checkouts and pulls made from a terminal or another app
		// refresh the panel too
		try
		{
			const gitDir = (await service.git(loc.root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();

			w.watcher = fs.watch(gitDir, {persistent: false}, (evt, name) =>
			{
				if (name == null || /^(HEAD|index|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|packed-refs)$/.test(name) ||
					String(name).startsWith('refs'))
				{
					clearTimeout(w.debounce);
					w.debounce = setTimeout(() =>
					{
						send(w.webContents, 'git-changed', {path: w.filePath});
						poll(w, false);
					}, 700);
				}
			});
		}
		catch (e)
		{
			log.warn('git dir watch failed', e.message);
		}

		if (!webContents.__gitCleanup)
		{
			webContents.__gitCleanup = true;
			webContents.on('destroyed', () => unwatch(webContents));
			webContents.on('did-navigate', () => unwatch(webContents));
		}

		poll(w, true);

		return {root: loc.root};
	}

	// Repositories this app has worked with, so share links open the existing clone
	async function rememberRepo(root)
	{
		if (store == null) return;

		try
		{
			const remotes = await service.remotes(root);
			const list = (store.get('gitRepos') || []).filter(r => r.root != root);
			list.unshift({root, remotes: Object.values(remotes).map(normaliseRemote)});
			store.set('gitRepos', list.slice(0, 100));
		}
		catch (e)
		{
			// ignore
		}
	}

	function findClone(repoUrl)
	{
		const key = normaliseRemote(repoUrl);
		const list = (store != null ? store.get('gitRepos') : null) || [];

		for (const r of list)
		{
			if (r.remotes.includes(key) && fs.existsSync(path.join(r.root, '.git'))) return r.root;
		}

		return null;
	}

	// Opens the diagram a share link points to: in the existing clone if
	// there is one (updated if it is behind), otherwise in a new clone
	async function openLink(webContents, link)
	{
		const info = parseShareLink(link);

		if (info == null)
		{
			throw new GitError('That is not a link to a diagram on GitHub. Copy the link from the Share dialog or from the file page on GitHub.', {kind: 'bad-link'});
		}

		let root = findClone(info.repo);
		let cloned = false;

		if (root == null)
		{
			const win = BrowserWindow.fromWebContents(webContents);
			const answer = await dialog.showMessageBox(win, {
				type: 'question', buttons: ['Choose Folder…', 'Cancel'], defaultId: 0, cancelId: 1,
				message: 'Download the repository?',
				detail: 'This diagram is in ' + info.repo.replace(/\.git$/, '') + ', which is not on this Mac yet. Choose where to put it.'
			});

			if (answer.response != 0) return {canceled: true};

			const parent = await pickFolder(webContents, 'Choose where to put the repository', 'Download Here');

			if (parent == null) return {canceled: true};

			root = (await service.clone(info.repo, parent)).root;
			cloned = true;
			rememberRepo(root);
		}
		else
		{
			await service.fetch(root).catch(() => {});
		}

		// Splits "<branch>/<path>" using the branches that exist on the remote
		let branch = info.branch, rel = info.path;

		if (info.branchAndPath != null)
		{
			const heads = (await service.git(root, ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'])).stdout.
				split('\n').filter(b => b.length > 0 && b != 'HEAD').sort((a, b) => b.length - a.length);
			branch = heads.find(b => info.branchAndPath.startsWith(b + '/')) || info.branchAndPath.split('/')[0];
			rel = info.branchAndPath.substring(branch.length + 1);
		}

		const current = await service.currentBranch(root);
		let note = null;

		if (branch != null && branch != current)
		{
			const st = await service.git(root, ['status', '--porcelain', '--untracked-files=no']);

			if (st.stdout.trim().length == 0)
			{
				const exists = (await service.git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], {allowFail: true})).code == 0;
				await service.git(root, exists ? ['checkout', '-q', branch] : ['checkout', '-q', '--track', 'origin/' + branch]);
			}
			else
			{
				note = 'You are on ' + current + ' with uncommitted changes, so the diagram opened from ' + current + ' instead of ' + branch + '.';
			}
		}

		const abs = path.resolve(root, rel);

		if (path.relative(root, abs).startsWith('..')) throw new Error('Path outside repository');

		// Gets the diagram when it only exists on GitHub so far
		if (!fs.existsSync(abs))
		{
			await service.git(root, ['merge', '--ff-only', '-q', '@{u}'], {allowFail: true});
		}

		if (!fs.existsSync(abs))
		{
			throw new GitError('The diagram ' + rel + ' was not found in the repository' + (branch ? ' on ' + branch : '') + '.');
		}

		blessPath(abs);
		send(webContents, 'args-obj', {args: [abs]});

		return {opened: abs, cloned, note};
	}

	async function ghAvailable()
	{
		for (const p of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'])
		{
			if (fs.existsSync(p)) return p;
		}

		try
		{
			await service.exec('gh', null, ['--version'], {timeout: 10000});
			return 'gh';
		}
		catch (e)
		{
			return null;
		}
	}

	async function gh(args, cwd, opts = {})
	{
		const bin = await ghAvailable();

		if (bin == null)
		{
			throw new GitError('The GitHub CLI (gh) is not installed. Install it with "brew install gh" and run "gh auth login".', {kind: 'no-gh'});
		}

		return service.exec(bin, cwd, args, Object.assign({timeout: 120000}, opts));
	}

	async function pickFolder(webContents, title, buttonLabel)
	{
		const win = BrowserWindow.fromWebContents(webContents);
		const res = await dialog.showOpenDialog(win, {
			title, buttonLabel,
			properties: ['openDirectory', 'createDirectory']
		});

		return res.canceled || res.filePaths.length == 0 ? null : res.filePaths[0];
	}

	async function openDiagramIn(webContents, dir)
	{
		const win = BrowserWindow.fromWebContents(webContents);
		const res = await dialog.showOpenDialog(win, {
			title: 'Open a diagram from the repository',
			defaultPath: dir,
			filters: [{name: 'draw.io diagrams', extensions: ['drawio', 'dio', 'xml', 'svg', 'png']}],
			properties: ['openFile']
		});

		if (res.canceled || res.filePaths.length == 0) return null;

		blessPath(res.filePaths[0]);
		send(webContents, 'args-obj', {args: [res.filePaths[0]]});

		return res.filePaths[0];
	}

	async function handle(webContents, args)
	{
		const a = args.args || {};

		// Every request that names a diagram must name one the user opened
		if (a.path != null)
		{
			if (typeof a.path !== 'string') throw new Error('bad arg: path');

			await assertReadablePath(webContents, a.path);
		}

		const needPath = () =>
		{
			if (a.path == null) throw new Error('bad arg: path');
			return a.path;
		};

		try
		{
			switch (args.op)
			{
				case 'status':
					return await service.status(needPath());
				case 'activity':
					return await service.activity(needPath());
				case 'history':
					return await service.history(needPath(), Math.min(parseInt(a.limit, 10) || 100, 500));
				case 'show':
					return await service.show(needPath(), a.rev);
				case 'commit':
					return await service.commit(needPath(), a.message, {all: !!a.all});
				case 'pull':
					return await service.pull(needPath());
				case 'resolve':
					if (a.relPath != null && typeof a.relPath !== 'string') throw new Error('bad arg: relPath');
					return await service.resolve(needPath(), a.relPath, {
						side: a.side, content: a.content, complete: a.complete});
				case 'showStage':
				{
					const loc = await service.locate(needPath());
					if (loc == null || typeof a.relPath !== 'string') throw new Error('bad arg');
					return await service.showRel(loc.root, a.stage, a.relPath);
				}
				case 'abortMerge':
					return await service.abortMerge(needPath(), a.restore);
				case 'push':
					return await service.push(needPath());
				case 'fetch':
				{
					const loc = await service.locate(needPath());
					if (loc == null) return {fetched: false};
					const res = await service.fetch(loc.root);
					const w = watches.get(webContents.id);
					if (w != null) poll(w, false);
					return res;
				}
				case 'discard':
					return await service.discard(needPath());
				case 'branches':
					return await service.branches(needPath());
				case 'checkout':
					return await service.checkout(needPath(), a.branch, {create: !!a.create, remote: !!a.remote});
				case 'watch':
					return await watch(webContents, needPath());
				case 'unwatch':
					unwatch(webContents);
					return {ok: true};
				case 'init':
				{
					const res = await service.init(path.dirname(needPath()));
					await watch(webContents, a.path);
					return res;
				}
				case 'addRemote':
					return await service.addRemote(needPath(), a.url);
				case 'setIdentity':
					return await service.setIdentity(needPath(), a.name, a.email);
				case 'clone':
				{
					const parent = await pickFolder(webContents, 'Choose where to clone the repository', 'Clone Here');
					if (parent == null) return {canceled: true};
					const res = await service.clone(a.url, parent);
					const opened = await openDiagramIn(webContents, res.root);
					return {root: res.root, opened};
				}
				case 'ghStatus':
				{
					const bin = await ghAvailable();
					if (bin == null) return {installed: false};
					const st = await gh(['api', 'user', '--jq', '.login'], null, {allowFail: true});
					return {installed: true, loggedIn: st.code == 0, login: st.code == 0 ? st.stdout.trim() : null};
				}
				case 'ghRepos':
				{
					const res = await gh(['repo', 'list', '--limit', '100', '--json',
						'nameWithOwner,url,description,isPrivate,updatedAt']);
					return JSON.parse(res.stdout);
				}
				case 'ghPublish':
				{
					// Creates a GitHub repository for a local repo and pushes it
					const loc = await service.locate(needPath());
					if (loc == null) throw new Error('Not in a git repository');
					const name = String(a.name || '').trim();
					if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(name)) throw new Error('Invalid repository name');
					const head = await service.git(loc.root, ['rev-parse', '--verify', 'HEAD'], {allowFail: true});
					if (head.code != 0) throw new Error('Commit the diagram before publishing');
					await gh(['repo', 'create', name, a.private === false ? '--public' : '--private',
						'--source', loc.root, '--remote', 'origin', '--push'], loc.root, {timeout: 300000});
					return await service.status(a.path);
				}
				case 'ghCollaborators':
				{
					const st = await service.status(needPath());
					const m = st.webUrl && st.webUrl.match(/^https:\/\/github\.com\/([^\/]+\/[^\/]+)$/);
					if (m == null) return [];
					const res = await gh(['api', 'repos/' + m[1] + '/collaborators', '--jq',
						'[.[] | {login, avatar_url, role_name}]'], null, {allowFail: true});
					return res.code == 0 ? JSON.parse(res.stdout || '[]') : [];
				}
				case 'openFromRepo':
				{
					const loc = await service.locate(needPath());
					return await openDiagramIn(webContents, loc ? loc.root : path.dirname(a.path));
				}
				case 'openConflictedFile':
				{
					// Opens another conflicted diagram of the same repository
					const loc = await service.locate(needPath());
					if (loc == null || typeof a.relPath !== 'string') throw new Error('bad arg');
					const abs = path.resolve(loc.root, a.relPath);
					if (path.relative(loc.root, abs).startsWith('..')) throw new Error('Path outside repository');
					if (!DRAWIO_XML_EXT.test(abs)) throw new Error('Not a diagram');
					blessPath(abs);
					send(webContents, 'args-obj', {args: [abs]});
					return {opened: abs};
				}
				case 'openLink':
					return await openLink(webContents, a.link);
				case 'shareInfo':
				{
					const st = await service.status(needPath());
					if (!st.isRepo) return {shareable: false};
					const web = st.webUrl;
					const branch = st.branch || 'main';
					const rel = st.relPath.split('/').map(encodeURIComponent).join('/');
					return {
						shareable: st.remoteUrl != null,
						webLink: web ? web + '/blob/' + branch.split('/').map(encodeURIComponent).join('/') + '/' + rel : null,
						appLink: st.remoteUrl ? 'drawio-git://open?repo=' + encodeURIComponent(web ? web + '.git' : st.remoteUrl) +
							'&path=' + encodeURIComponent(st.relPath) + '&branch=' + encodeURIComponent(branch) : null,
						repo: web, isGitHub: web != null
					};
				}
				case 'invite':
				{
					const st = await service.status(needPath());
					const m = st.webUrl && st.webUrl.match(/^https:\/\/github\.com\/([^\/]+\/[^\/]+)$/);
					if (m == null) throw new Error('Invites work for repositories on github.com');
					const user = String(a.user || '').trim().replace(/^@/, '');
					if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) throw new Error('Enter a GitHub username');
					const res = await gh(['api', '-X', 'PUT', 'repos/' + m[1] + '/collaborators/' + user, '-f', 'permission=push'], null, {allowFail: true});
					if (res.code != 0) throw new GitError(res.stderr.trim() || 'Invite failed', {kind: /404/.test(res.stderr) ? 'no-access' : 'unknown'});
					return {invited: true, already: res.stdout.trim().length == 0};
				}
				case 'setFetchInterval':
				{
					const ms = Math.max(MIN_FETCH_INTERVAL, parseInt(a.ms, 10) || DEFAULT_FETCH_INTERVAL);
					if (store != null) store.set('gitFetchInterval', ms);
					for (const w of watches.values())
					{
						clearInterval(w.timer);
						w.timer = setInterval(() => poll(w, true), ms);
					}
					return {ms};
				}
				case 'getFetchInterval':
					return {ms: getInterval()};
				default:
					throw new Error('Unknown git operation: ' + args.op);
			}
		}
		catch (e)
		{
			throw serialiseError(e);
		}
	}

	return {handle, service, unwatch, openLink};
}

// The renderer side (UI) is injected into each editor window once the app
// has loaded. It talks back through the existing window.electron bridge.
export function loadRendererBundle(dir)
{
	const js = ['diagram-merge.js', 'git-ui.js', 'live-ui.js'].map(f =>
		fs.readFileSync(path.join(dir, 'renderer', f), 'utf8')).join('\n;\n');
	const css = fs.readFileSync(path.join(dir, 'renderer', 'git-ui.css'), 'utf8');

	return '(function(){var css=' + JSON.stringify(css) + ';\n' + js + '\n})();';
}
