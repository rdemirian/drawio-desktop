// Finds peers over the internet with nothing but the GitHub repository the
// diagram already lives in. Presence and WebRTC signalling are written as
// tiny commits (sealed with the session key) to hidden refs:
//
//   refs/drawio-live/<docId>/p/<peerId>            presence, refreshed
//   refs/drawio-live/<docId>/s/<toPeer>/<from>-<n> one signal, deleted once read
//
// These refs are not branches or tags: they do not show up on GitHub, in
// clones, or trigger workflows. Only connection setup goes through GitHub;
// the live session itself is peer to peer.

import { EventEmitter } from 'events';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// A presence older than this belongs to an app that quit without cleaning up
const PRESENCE_TTL = 50 * 1000;
// Handshakes for peers that never picked them up (they quit) and presence of
// apps that crashed are deleted by whoever polls next
const STALE_SIGNAL = 2 * 60 * 1000;
const STALE_PRESENCE = 5 * 60 * 1000;
const MAX_DELETES_PER_POLL = 100;
const IDENTITY_ENV = {
	GIT_AUTHOR_NAME: 'draw.io live', GIT_AUTHOR_EMAIL: 'live@drawio.invalid',
	GIT_COMMITTER_NAME: 'draw.io live', GIT_COMMITTER_EMAIL: 'live@drawio.invalid'
};

export class GitSignal extends EventEmitter
{
	// service: GitService, root: repository, remote: remote name
	constructor({service, root, remote, docId, peerId, log, pollInterval, presenceInterval})
	{
		super();
		this.service = service;
		this.root = root;
		this.remote = remote || 'origin';
		this.docId = docId;
		this.peerId = peerId;
		this.log = log || (() => {});
		this.pollInterval = pollInterval || 4000;
		this.presenceInterval = presenceInterval || 20000;
		this.counter = 0;
		this.seen = new Set();
		this.stopped = false;
		this.chain = Promise.resolve();
		this.base = 'refs/drawio-live/' + docId;
		this.localBase = 'refs/drawio-live-seen/' + docId;
	}

	git(args, opts = {})
	{
		return this.service.git(this.root, args, Object.assign({timeout: 30000}, opts, {env: IDENTITY_ENV}));
	}

	// Serialises git invocations of this signaller
	queue(fn)
	{
		const next = this.chain.then(() => this.stopped ? null : fn());
		this.chain = next.catch((e) => this.log('live: git signal', e.message));

		return next;
	}

	async writeRef(ref, message, force)
	{
		await this.git(['hash-object', '-t', 'tree', '-w', '--stdin'], {input: ''});
		const sha = (await this.git(['commit-tree', EMPTY_TREE, '-F', '-'], {input: message})).stdout.trim();
		await this.git(['push', '--quiet', '--no-verify', this.remote, (force ? '+' : '') + sha + ':' + ref], {timeout: 45000});
	}

	start(presenceMessage)
	{
		this.presenceMessage = presenceMessage;
		this.queue(() => this.writeRef(this.base + '/p/' + this.peerId, presenceMessage(), true));
		this.queue(() => this.poll());

		this.pollTimer = setInterval(() => this.queue(() => this.poll()), this.pollInterval);
		this.presenceTimer = setInterval(() =>
		{
			this.queue(() => this.writeRef(this.base + '/p/' + this.peerId, this.presenceMessage(), true));
		}, this.presenceInterval);
	}

	send(toPeer, message)
	{
		const ref = this.base + '/s/' + toPeer + '/' + this.peerId + '-' + Date.now().toString(36) + '-' + (this.counter++);

		return this.queue(() => this.writeRef(ref, message, false));
	}

	async poll()
	{
		const res = await this.git(['fetch', '--quiet', '--no-tags', '--prune', '--no-write-fetch-head', this.remote,
			'+' + this.base + '/*:' + this.localBase + '/*'], {allowFail: true, timeout: 30000});

		if (res.code != 0)
		{
			this.emit('error', new Error(res.stderr.trim() || 'fetch failed'));
			return;
		}

		const refs = await this.git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', this.localBase + '/'], {allowFail: true});
		const now = Date.now();
		const toDelete = [];

		for (const line of refs.stdout.split('\n'))
		{
			if (line.length == 0) continue;

			const [ref, sha, date] = line.split('\t');
			const rel = ref.substring(this.localBase.length + 1);
			const parts = rel.split('/');

			const age = now - parseInt(date, 10) * 1000;

			if (parts[0] == 'p' && parts[1] != this.peerId)
			{
				if (age < PRESENCE_TTL)
				{
					this.emit('presence', parts[1], await this.message(sha));
				}
				else if (age > STALE_PRESENCE)
				{
					toDelete.push(this.base + '/' + rel);
				}
			}
			else if (parts[0] == 's' && parts[1] != this.peerId && age > STALE_SIGNAL)
			{
				toDelete.push(this.base + '/' + rel);
			}
			else if (parts[0] == 's' && parts[1] == this.peerId && !this.seen.has(sha))
			{
				this.seen.add(sha);
				const from = parts[2].split('-')[0];
				this.emit('signal', from, await this.message(sha));
				toDelete.push(this.base + '/' + rel);
			}
		}

		if (toDelete.length > 0)
		{
			await this.git(['push', '--quiet', '--no-verify', this.remote].concat(
				toDelete.slice(0, MAX_DELETES_PER_POLL).map(r => ':' + r)), {allowFail: true});
		}
	}

	async message(sha)
	{
		return (await this.git(['log', '-1', '--format=%B', sha])).stdout.trim();
	}

	async stop()
	{
		clearInterval(this.pollTimer);
		clearInterval(this.presenceTimer);

		// Removes our presence and any signals we left behind
		await this.chain.catch(() => {});
		this.stopped = true;

		try
		{
			const refs = await this.git(['for-each-ref', '--format=%(refname)', this.localBase + '/'], {allowFail: true});
			const mine = [this.base + '/p/' + this.peerId];

			for (const ref of refs.stdout.split('\n'))
			{
				const rel = ref.substring(this.localBase.length + 1);

				if (/^s\/[^\/]+\//.test(rel) && rel.split('/')[2].startsWith(this.peerId + '-'))
				{
					mine.push(this.base + '/' + rel);
				}
			}

			await this.git(['push', '--quiet', '--no-verify', this.remote].concat(mine.map(r => ':' + r)), {allowFail: true});
		}
		catch (e)
		{
			// best effort
		}
	}
}
