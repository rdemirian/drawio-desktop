// Main process side of live collaboration. The renderer owns the WebRTC mesh
// (peer connections, host election, edits, cursors); this module finds the
// other people who have the same diagram open and carries the connection
// handshakes between them:
//
//  - on the local network through UDP multicast (instant, no internet), and
//  - over the internet through hidden refs in the shared GitHub repository.
//
// It also stores comments in a JSON-lines file next to the diagram.

import fs from 'fs';
import { promises as fsProm } from 'fs';
import path from 'path';
import { LanBus } from './lan-bus.js';
import { GitSignal } from './git-signal.js';
import { deriveSessionKeys, seal, open, randomPeerId } from './live-crypto.js';

const BEACON_INTERVAL = 2000;
const COMMENTS_SUFFIX = '.comments.jsonl';
const MAX_COMMENTS_FILE = 5 * 1024 * 1024;

export function commentsPathFor(diagramPath)
{
	return diagramPath + COMMENTS_SUFFIX;
}

export function createLiveIpc({service, assertReadablePath, log, store})
{
	// webContents.id -> session
	const sessions = new Map();
	let lan = null;

	function send(webContents, channel, data)
	{
		if (webContents != null && !webContents.isDestroyed())
		{
			webContents.send(channel, data);
		}
	}

	function getLan()
	{
		if (lan == null)
		{
			lan = new LanBus({log});
			lan.on('packet', onLanPacket);
		}

		return lan;
	}

	function onLanPacket(packet)
	{
		for (const s of sessions.values())
		{
			if (packet.doc != s.docId || packet.from == s.peerId) continue;

			if (packet.t == 'beacon')
			{
				const info = open(s.secret, packet.box);

				if (info != null && info.peer == packet.from)
				{
					peerSeen(s, info, 'lan');
				}
			}
			else if (packet.t == 'signal' && packet.to == s.peerId)
			{
				const data = open(s.secret, packet.box);

				if (data != null && data.from == packet.from && data.to == s.peerId)
				{
					send(s.webContents, 'live-signal', {from: packet.from, data: data.signal, via: 'lan'});
				}
			}
			else if (packet.t == 'bye')
			{
				const info = open(s.secret, packet.box);

				if (info != null && info.peer == packet.from)
				{
					s.known.delete(packet.from);
					send(s.webContents, 'live-peer-gone', {peer: packet.from});
				}
			}
		}
	}

	function peerSeen(s, info, via)
	{
		const prev = s.known.get(info.peer);
		// The local network is preferred whenever it reaches the peer
		s.known.set(info.peer, {seen: Date.now(), via: (via == 'lan' || (prev && prev.via == 'lan')) ? 'lan' : via});

		send(s.webContents, 'live-peer', {
			peer: info.peer, name: info.name, email: info.email, joinedAt: info.joinedAt,
			blob: info.blob, head: info.head, via: s.known.get(info.peer).via, fresh: prev == null
		});
	}

	function beaconInfo(s)
	{
		return {peer: s.peerId, name: s.name, email: s.email, joinedAt: s.joinedAt, blob: s.blob, head: s.head, ts: Date.now()};
	}

	async function join(webContents, a)
	{
		await leave(webContents);

		const loc = await service.locate(a.path);

		if (loc == null) throw new Error('Live sessions need the diagram to be in a git repository');

		const roots = (await service.git(loc.root, ['rev-list', '--max-parents=0', 'HEAD'], {allowFail: true})).stdout.trim().split('\n');
		const rootCommit = roots.sort()[0];
		const remotes = await service.remotes(loc.root);
		const remoteName = remotes.origin ? 'origin' : Object.keys(remotes)[0] || null;
		const remoteUrl = remoteName ? remotes[remoteName] : '';
		const branch = await service.currentBranch(loc.root);

		if (branch == 'HEAD') throw new Error('Switch to a branch to edit live (this is a detached checkout)');

		const {secret, docId} = deriveSessionKeys(rootCommit, remoteUrl, loc.relPath, branch);
		const blob = (await service.git(loc.root, ['rev-parse', 'HEAD:' + loc.relPath], {allowFail: true})).stdout.trim() || null;
		const head = (await service.git(loc.root, ['rev-parse', 'HEAD'], {allowFail: true})).stdout.trim() || null;

		const s = {
			webContents, path: a.path, root: loc.root, relPath: loc.relPath, docId, secret,
			peerId: randomPeerId(), joinedAt: Date.now(), blob, head,
			name: String(a.name || 'Someone').substring(0, 80), email: String(a.email || '').substring(0, 120),
			known: new Map(), git: null
		};

		sessions.set(webContents.id, s);

		// DRAWIO_LIVE_NO_LAN=1 forces the internet path (for testing)
		const lanOk = process.env.DRAWIO_LIVE_NO_LAN == '1' ? false : await getLan().start();
		const sendBeacon = () => getLan().send({t: 'beacon', doc: s.docId, from: s.peerId, box: seal(s.secret, beaconInfo(s))});

		if (lanOk)
		{
			sendBeacon();
			s.beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL);
		}

		const internet = a.internet !== false && remoteName != null && (store == null || store.get('liveInternet') !== false);

		if (internet)
		{
			s.git = new GitSignal({service, root: loc.root, remote: remoteName, docId, peerId: s.peerId, log});

			s.git.on('presence', (peer, msg) =>
			{
				const info = open(s.secret, msg);

				if (info != null && info.peer == peer) peerSeen(s, info, 'git');
			});

			s.git.on('signal', (from, msg) =>
			{
				const data = open(s.secret, msg);

				if (data != null && data.from == from && data.to == s.peerId)
				{
					send(s.webContents, 'live-signal', {from, data: data.signal, via: 'git'});
				}
			});

			// Tells the panel when finding people through GitHub stops or starts working
			s.git.on('error', (e) =>
			{
				const text = String(e.message || '');
				const kind = /Permission to .* denied|403|not allowed to push|protected|write access/i.test(text) ? 'no-write' :
					/Authentication failed|could not read Username|terminal prompts disabled|publickey/i.test(text) ? 'auth' :
					/Could not resolve host|unable to access|timed out|Network is unreachable/i.test(text) ? 'network' : 'unknown';
				s.gitHealthy = false;
				send(s.webContents, 'live-transport', {transport: 'git', error: text.split('\n')[0].substring(0, 200), kind});
			});

			s.git.on('healthy', () =>
			{
				if (s.gitHealthy !== true)
				{
					s.gitHealthy = true;
					send(s.webContents, 'live-transport', {transport: 'git', ok: true});
				}
			});

			s.git.start(() => seal(s.secret, beaconInfo(s)));
		}

		if (!webContents.__liveCleanup)
		{
			webContents.__liveCleanup = true;
			webContents.on('destroyed', () => leave(webContents));
			webContents.on('did-navigate', () => leave(webContents));
		}

		return {peerId: s.peerId, docId, joinedAt: s.joinedAt, blob, head, lan: lanOk, internet, branch,
			relPath: loc.relPath};
	}

	async function leave(webContents)
	{
		const s = sessions.get(webContents.id);

		if (s == null) return {left: false};

		sessions.delete(webContents.id);
		clearInterval(s.beaconTimer);

		if (lan != null)
		{
			await lan.send({t: 'bye', doc: s.docId, from: s.peerId, box: seal(s.secret, {peer: s.peerId})});
		}

		if (s.git != null)
		{
			await s.git.stop();
		}

		if (sessions.size == 0 && lan != null)
		{
			lan.stop();
			lan = null;
		}

		return {left: true};
	}

	async function signal(webContents, a)
	{
		const s = sessions.get(webContents.id);

		if (s == null) throw new Error('Not in a live session');

		if (typeof a.to !== 'string' || !/^[0-9a-f]{16}$/.test(a.to)) throw new Error('bad arg: to');

		const box = seal(s.secret, {from: s.peerId, to: a.to, signal: a.signal});
		const known = s.known.get(a.to);
		const via = a.via || (known && known.via) || 'lan';
		let sent = false;

		if (via == 'lan' && lan != null)
		{
			sent = await lan.send({t: 'signal', doc: s.docId, from: s.peerId, to: a.to, box});
		}

		if ((!sent || via == 'git') && s.git != null)
		{
			await s.git.send(a.to, box);
			sent = true;
		}

		return {sent};
	}

	// Comments live next to the diagram, one JSON object per line. Edits
	// and deletions append a newer version of the comment, so git's union
	// merge combines everyone's comments without conflicts.
	async function readComments(a)
	{
		const file = commentsPathFor(a.path);

		try
		{
			const stat = await fsProm.stat(file);

			if (stat.size > MAX_COMMENTS_FILE) throw new Error('Comments file too large');

			return await fsProm.readFile(file, 'utf8');
		}
		catch (e)
		{
			if (e.code == 'ENOENT') return '';
			throw e;
		}
	}

	async function appendComments(a)
	{
		if (!Array.isArray(a.records) || a.records.length > 500) throw new Error('bad arg: records');

		const lines = a.records.map((r) =>
		{
			if (r == null || typeof r !== 'object' || typeof r.id !== 'string') throw new Error('bad record');
			return JSON.stringify(r);
		}).join('\n') + '\n';

		const file = commentsPathFor(a.path);
		let prefix = '';

		try
		{
			const fh = await fsProm.open(file, 'r');

			try
			{
				const stat = await fh.stat();

				if (stat.size > 0)
				{
					const buf = Buffer.alloc(1);
					await fh.read(buf, 0, 1, stat.size - 1);
					if (buf[0] != 10) prefix = '\n';
				}
			}
			finally
			{
				await fh.close();
			}
		}
		catch (e)
		{
			// new file
		}

		await fsProm.appendFile(file, prefix + lines, 'utf8');

		// Makes git combine comment files from different people line by line
		const loc = await service.locate(a.path);

		if (loc != null)
		{
			await ensureUnionMerge(loc.root);
		}

		return {ok: true};
	}

	async function ensureUnionMerge(root)
	{
		const file = await service.gitPath2(root, 'info/attributes');
		let current = '';

		try { current = await fsProm.readFile(file, 'utf8'); } catch (e) {}

		if (!current.includes('*.comments.jsonl merge=union'))
		{
			await fsProm.mkdir(path.dirname(file), {recursive: true});
			await fsProm.writeFile(file, (current.length > 0 && !current.endsWith('\n') ? current + '\n' : current) +
				'*.comments.jsonl merge=union\n', 'utf8');
		}
	}

	async function handle(webContents, args)
	{
		const a = args.args || {};

		if (a.path != null)
		{
			if (typeof a.path !== 'string') throw new Error('bad arg: path');
			await assertReadablePath(webContents, a.path);
		}

		switch (args.op)
		{
			case 'join':
				if (a.path == null) throw new Error('bad arg: path');
				return await join(webContents, a);
			case 'leave':
				return await leave(webContents);
			case 'update':
			{
				// The diagram's committed version changed (commit, pull, checkout)
				const s = sessions.get(webContents.id);
				if (s == null) return {blob: null};
				s.blob = (await service.git(s.root, ['rev-parse', 'HEAD:' + s.relPath], {allowFail: true})).stdout.trim() || null;
				s.head = (await service.git(s.root, ['rev-parse', 'HEAD'], {allowFail: true})).stdout.trim() || null;
				return {blob: s.blob, head: s.head};
			}
			case 'signal':
				return await signal(webContents, a);
			case 'commentsRead':
				if (a.path == null) throw new Error('bad arg: path');
				return await readComments(a);
			case 'commentsAppend':
				if (a.path == null) throw new Error('bad arg: path');
				return await appendComments(a);
			case 'getSettings':
				return {internet: store == null || store.get('liveInternet') !== false};
			case 'setSettings':
				if (store != null && typeof a.internet === 'boolean') store.set('liveInternet', a.internet);
				return {ok: true};
			default:
				throw new Error('Unknown live operation: ' + args.op);
		}
	}

	// Removes our presence from every session (LAN goodbye, GitHub refs)
	async function leaveAll()
	{
		const all = Array.from(sessions.values()).map(s => leave(s.webContents));
		await Promise.all(all.map(p => p.catch(() => {})));
	}

	return {handle, leave, leaveAll, hasSessions: () => sessions.size > 0};
}
