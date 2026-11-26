import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { normaliseRemote, deriveSessionKeys, seal, open, randomPeerId } from '../main/live/live-crypto.js';
import { LanBus } from '../main/live/lan-bus.js';
import { GitSignal } from '../main/live/git-signal.js';
import { GitService } from '../main/git/git-service.js';

const ROOT = 'a'.repeat(40);

describe('live session keys', () =>
{
	test('remote URLs of the same repository normalise to the same value', () =>
	{
		const forms = ['git@github.com:Org/Repo.git', 'https://github.com/org/repo', 'https://user:token@github.com/org/repo.git/',
			'ssh://git@github.com/org/repo.git', 'ssh://git@github.com:22/org/repo.git'];
		for (const f of forms) assert.equal(normaliseRemote(f), 'github.com/org/repo', f);
		assert.equal(normaliseRemote(''), '');
	});

	test('everyone with the repository derives the same session, others do not', () =>
	{
		const a = deriveSessionKeys(ROOT, 'git@github.com:org/repo.git', 'arch.drawio');
		const b = deriveSessionKeys(ROOT, 'https://github.com/org/repo', 'arch.drawio');
		const otherFile = deriveSessionKeys(ROOT, 'https://github.com/org/repo', 'other.drawio');
		const otherRepo = deriveSessionKeys('b'.repeat(40), 'https://github.com/org/repo', 'arch.drawio');
		assert.equal(a.docId, b.docId);
		assert.ok(a.secret.equals(b.secret));
		assert.notEqual(a.docId, otherFile.docId);
		assert.notEqual(a.docId, otherRepo.docId);
		assert.match(a.docId, /^[0-9a-f]{32}$/);
		assert.throws(() => deriveSessionKeys(null, '', 'x'), /commit/);
		// Branches are separate sessions
		assert.notEqual(deriveSessionKeys(ROOT, '', 'a.drawio', 'main').docId, deriveSessionKeys(ROOT, '', 'a.drawio', 'feature').docId);
	});

	test('sealed messages open only with the session key and detect tampering', () =>
	{
		const {secret} = deriveSessionKeys(ROOT, '', 'a.drawio');
		const other = deriveSessionKeys(ROOT, '', 'b.drawio').secret;
		const box = seal(secret, {hello: 'world', n: 1});
		assert.deepEqual(open(secret, box), {hello: 'world', n: 1});
		assert.equal(open(other, box), null);
		const buf = Buffer.from(box, 'base64');
		buf[buf.length - 1] ^= 1;
		assert.equal(open(secret, buf.toString('base64')), null);
		assert.equal(open(secret, 'garbage'), null);
		assert.match(randomPeerId(), /^[0-9a-f]{16}$/);
	});
});

describe('LAN bus', () =>
{
	test('two buses on the same machine see each other', async (t) =>
	{
		const port = 42000 + Math.floor(Math.random() * 1000);
		const a = new LanBus({port}), b = new LanBus({port});

		if (!(await a.start()) || !(await b.start()))
		{
			a.stop(); b.stop();
			t.skip('multicast not available here');
			return;
		}

		try
		{
			const got = new Promise((resolve) => b.on('packet', (p) => { if (p.t == 'beacon') resolve(p); }));
			await a.send({t: 'beacon', doc: 'd1', from: 'p1', box: 'x'});
			const p = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
			assert.equal(p.doc, 'd1');
			assert.equal(p.app, 'drawio-live');
		}
		finally
		{
			a.stop();
			b.stop();
		}
	});
});

describe('signalling through the git remote', () =>
{
	let tmp, remote, alice, bob;
	const g = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();

	before(() =>
	{
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-live-')));
		remote = path.join(tmp, 'remote.git');
		g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
		alice = path.join(tmp, 'alice');
		g(tmp, 'clone', '-q', remote, alice);
		fs.writeFileSync(path.join(alice, 'd.drawio'), '<mxfile/>');
		g(alice, '-c', 'user.name=A', '-c', 'user.email=a@x', 'commit', '-q', '--allow-empty', '-m', 'init');
		g(alice, 'push', '-q', 'origin', 'HEAD:main');
		bob = path.join(tmp, 'bob');
		g(tmp, 'clone', '-q', remote, bob);
	});

	after(() => fs.rmSync(tmp, {recursive: true, force: true}));

	test('presence and signals reach the other peer, and are cleaned up', async () =>
	{
		const service = new GitService();
		const a = new GitSignal({service, root: alice, docId: 'doc1', peerId: 'aaaaaaaaaaaaaaaa', pollInterval: 300});
		const b = new GitSignal({service, root: bob, docId: 'doc1', peerId: 'bbbbbbbbbbbbbbbb', pollInterval: 300});

		const bSeesA = new Promise((resolve) => b.on('presence', (peer, msg) => { if (peer == 'aaaaaaaaaaaaaaaa') resolve(msg); }));
		const aGetsSignal = new Promise((resolve) => a.on('signal', (from, msg) => resolve({from, msg})));

		a.start(() => 'presence-of-alice');
		b.start(() => 'presence-of-bob');

		const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
		assert.equal(await Promise.race([bSeesA, timeout(15000)]), 'presence-of-alice');

		await b.send('aaaaaaaaaaaaaaaa', 'offer-from-bob');
		const sig = await Promise.race([aGetsSignal, timeout(15000)]);
		assert.deepEqual(sig, {from: 'bbbbbbbbbbbbbbbb', msg: 'offer-from-bob'});

		// Read signals are deleted from the remote
		await new Promise(r => setTimeout(r, 1000));
		await a.chain;
		const left = g(alice, 'ls-remote', 'origin', 'refs/drawio-live/*');
		assert.doesNotMatch(left, /\/s\//);

		// Hidden refs are not branches: a fresh clone does not get them
		const carol = path.join(tmp, 'carol');
		g(tmp, 'clone', '-q', remote, carol);
		assert.equal(g(carol, 'for-each-ref', 'refs/drawio-live'), '');

		await a.stop();
		await b.stop();
		assert.equal(g(alice, 'ls-remote', 'origin', 'refs/drawio-live/*'), '');
	});

	test('a remote that refuses our pushes is reported, not swallowed', async () =>
	{
		const ro = path.join(tmp, 'readonly.git');
		g(tmp, 'clone', '-q', '--bare', remote, ro);
		fs.writeFileSync(path.join(ro, 'hooks', 'pre-receive'), '#!/bin/sh\necho "Permission to acme/repo.git denied to someone." >&2\nexit 1\n', {mode: 0o755});
		const dir = path.join(tmp, 'ro-clone');
		g(tmp, 'clone', '-q', ro, dir);

		const sig = new GitSignal({service: new GitService(), root: dir, docId: 'doc3', peerId: 'eeeeeeeeeeeeeeee', pollInterval: 100000});
		const err = new Promise((resolve) => sig.on('error', resolve));
		sig.start(() => 'presence');
		const e = await Promise.race([err, new Promise((_, rej) => setTimeout(() => rej(new Error('no error reported')), 15000))]);
		assert.match(e.message, /Permission to .* denied/);
		await sig.stop();
	});

	test('stale handshakes and presence left by crashed apps are cleaned up', async () =>
	{
		// A crashed peer left a presence and an unread handshake 10 minutes ago
		const old = String(Math.floor(Date.now() / 1000) - 600) + ' +0000';
		const env = {...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old,
			GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x'};
		const tree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], {cwd: alice, input: '', encoding: 'utf8'}).trim();
		const sha = execFileSync('git', ['commit-tree', tree, '-m', 'old'], {cwd: alice, env, encoding: 'utf8'}).trim();
		g(alice, 'push', '-q', 'origin', sha + ':refs/drawio-live/doc2/p/cccccccccccccccc',
			sha + ':refs/drawio-live/doc2/s/cccccccccccccccc/dddddddddddddddd-1-0');

		const seen = [];
		const a = new GitSignal({service: new GitService(), root: alice, docId: 'doc2', peerId: 'aaaaaaaaaaaaaaaa', pollInterval: 100000});
		a.on('presence', (peer) => seen.push(peer));
		await a.poll();
		assert.deepEqual(seen, [], 'a dead peer is not reported');
		assert.equal(g(alice, 'ls-remote', 'origin', 'refs/drawio-live/doc2/*'), '');
	});
});

import { parseShareLink } from '../main/git/index.js';

describe('share links', () =>
{
	test('GitHub file URLs keep branch and path together until the remote resolves them', () =>
	{
		const r = parseShareLink('https://github.com/acme/infra/blob/feature/new-net/docs/arch%20v2.drawio');
		assert.equal(r.repo, 'https://github.com/acme/infra.git');
		assert.equal(r.branchAndPath, 'feature/new-net/docs/arch v2.drawio');
	});

	test('drawio-git links carry repo, path and branch', () =>
	{
		const r = parseShareLink('drawio-git://open?repo=' + encodeURIComponent('https://github.com/acme/infra.git') +
			'&path=docs%2Farch.drawio&branch=main');
		assert.deepEqual(r, {repo: 'https://github.com/acme/infra.git', path: 'docs/arch.drawio', branch: 'main', branchAndPath: null});
	});

	test('anything else is rejected', () =>
	{
		assert.equal(parseShareLink('https://example.com/acme/infra/blob/main/a.drawio'), null);
		assert.equal(parseShareLink('drawio-git://open?repo=--upload-pack%3Devil&path=a'), null);
		assert.equal(parseShareLink('drawio-git://open?repo=file%3A%2F%2F%2Fetc&path=a'), null);
		assert.equal(parseShareLink('not a url'), null);
	});
});
