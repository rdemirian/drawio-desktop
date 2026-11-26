import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { GitService, parseStatus, parseLog, remoteToWebUrl, assertSafeRev, assertSafeBranchName,
	classifyGitError, describeEntry, buildGitEnv } from '../main/git/git-service.js';

const diagram = (label, extra = '') => `<mxfile host="Electron"><diagram id="p1" name="Page-1"><mxGraphModel><root>` +
	`<mxCell id="0"/><mxCell id="1" parent="0"/>` +
	`<mxCell id="a" value="${label}" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>` +
	extra + `</root></mxGraphModel></diagram></mxfile>`;

describe('parsers and validators', () =>
{
	test('parseStatus reads branch, ahead/behind and entries', () =>
	{
		const out = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3',
			'1 .M N... 100644 100644 100644 aaa bbb dir/my file.drawio',
			'u UU N... 100644 100644 100644 100644 a b c conflicted.drawio',
			'? new.drawio', ''].join('\0');
		const st = parseStatus(out);
		assert.equal(st.branch, 'main');
		assert.equal(st.upstream, 'origin/main');
		assert.equal(st.ahead, 2);
		assert.equal(st.behind, 3);
		assert.equal(st.entries[0].path, 'dir/my file.drawio');
		assert.equal(describeEntry(st.entries[0]), 'modified');
		assert.equal(describeEntry(st.entries[1]), 'conflicted');
		assert.equal(describeEntry(st.entries[2]), 'untracked');
	});

	test('parseStatus handles renames and detached heads', () =>
	{
		const st = parseStatus(['# branch.head (detached)', '2 R. N... 100644 100644 100644 a b R100 new.drawio', 'old.drawio', ''].join('\0'));
		assert.equal(st.branch, null);
		assert.equal(st.detached, true);
		assert.equal(st.entries[0].path, 'new.drawio');
		assert.equal(st.entries[0].origPath, 'old.drawio');
	});

	test('remoteToWebUrl', () =>
	{
		assert.equal(remoteToWebUrl('git@github.com:org/repo.git'), 'https://github.com/org/repo');
		assert.equal(remoteToWebUrl('https://github.com/org/repo.git'), 'https://github.com/org/repo');
		assert.equal(remoteToWebUrl('https://user:tok@github.com/org/repo'), 'https://github.com/org/repo');
		assert.equal(remoteToWebUrl('ssh://git@github.com/org/repo.git'), 'https://github.com/org/repo');
		assert.equal(remoteToWebUrl('https://gitlab.com/org/repo.git'), null);
		assert.equal(remoteToWebUrl(null), null);
	});

	test('revision and branch validation rejects option injection', () =>
	{
		assert.equal(assertSafeRev('HEAD'), 'HEAD');
		assert.equal(assertSafeRev('@{u}'), '@{u}');
		assert.equal(assertSafeRev('abc123^'), 'abc123^');
		assert.equal(assertSafeRev('origin/feature-x'), 'origin/feature-x');
		assert.throws(() => assertSafeRev('--output=/tmp/x'));
		assert.throws(() => assertSafeRev('a b'));
		assert.throws(() => assertSafeRev('HEAD..main'));
		assert.throws(() => assertSafeRev(''));
		assert.equal(assertSafeBranchName('alex/new-layout'), 'alex/new-layout');
		assert.throws(() => assertSafeBranchName('-f'));
		assert.throws(() => assertSafeBranchName('a..b'));
		assert.throws(() => assertSafeBranchName('x.lock'));
	});

	test('classifyGitError', () =>
	{
		assert.equal(classifyGitError('! [rejected] main -> main (fetch first)'), 'rejected');
		assert.equal(classifyGitError('fatal: Authentication failed for'), 'auth');
		assert.equal(classifyGitError('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'), 'auth');
		assert.equal(classifyGitError('Could not resolve host: github.com'), 'network');
		assert.equal(classifyGitError('error: Your local changes to the following files would be overwritten by merge'), 'dirty');
		assert.equal(classifyGitError('*** Please tell me who you are.'), 'identity');
		assert.equal(classifyGitError('something else'), 'unknown');
	});

	test('parseLog', () =>
	{
		const out = 'h1\x1fs1\x1fAda\x1fada@x\x1f1700000000\x1fFirst\x1fHEAD -> main\x1e\nh2\x1fs2\x1fBob\x1fbob@x\x1f1700000100\x1fSecond\x1f\x1e';
		const log = parseLog(out);
		assert.equal(log.length, 2);
		assert.equal(log[0].author, 'Ada');
		assert.equal(log[0].date, 1700000000000);
		assert.deepEqual(log[0].refs, ['HEAD -> main']);
		assert.equal(log[1].subject, 'Second');
	});

	test('buildGitEnv never prompts and extends PATH', () =>
	{
		const env = buildGitEnv({PATH: '/usr/bin'});
		assert.equal(env.GIT_TERMINAL_PROMPT, '0');
		assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/);
		if (process.platform == 'darwin') assert.match(env.PATH, /\/opt\/homebrew\/bin/);
	});
});

describe('GitService against real repositories', () =>
{
	let tmp, remote, alice, bob, svcA, svcB;
	const g = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}}).trim();

	const setupClone = (name, user) =>
	{
		const dir = path.join(tmp, name);
		g(tmp, 'clone', '-q', remote, dir);
		g(dir, 'config', 'user.name', user);
		g(dir, 'config', 'user.email', user.toLowerCase() + '@example.com');
		g(dir, 'config', 'commit.gpgsign', 'false');
		return dir;
	};

	before(() =>
	{
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-git-')));
		remote = path.join(tmp, 'remote.git');
		g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
		alice = setupClone('alice', 'Alice');
		g(alice, 'checkout', '-q', '-b', 'main');
		fs.writeFileSync(path.join(alice, 'arch.drawio'), diagram('Start'));
		fs.writeFileSync(path.join(alice, 'notes.txt'), 'hello\n');
		g(alice, 'add', '.');
		g(alice, 'commit', '-q', '-m', 'Initial diagram');
		g(alice, 'push', '-q', '-u', 'origin', 'main');
		bob = setupClone('bob', 'Bob');
		svcA = new GitService();
		svcB = new GitService();
	});

	after(() =>
	{
		fs.rmSync(tmp, {recursive: true, force: true});
	});

	test('status of a non-repo file', async () =>
	{
		const f = path.join(tmp, 'loose.drawio');
		fs.writeFileSync(f, diagram('x'));
		const st = await svcA.status(f);
		assert.equal(st.isRepo, false);
		assert.equal(st.gitAvailable, true);
	});

	test('status reports branch, upstream, clean file and GitHub-less remote', async () =>
	{
		const st = await svcA.status(path.join(alice, 'arch.drawio'));
		assert.equal(st.isRepo, true);
		assert.equal(st.branch, 'main');
		assert.equal(st.upstream, 'origin/main');
		assert.equal(st.relPath, 'arch.drawio');
		assert.equal(st.fileState, 'clean');
		assert.equal(st.userName, 'Alice');
		assert.equal(st.head.subject, 'Initial diagram');
		assert.equal(st.webUrl, null);
	});

	test('commit, push, and the other side sees it as incoming', async () =>
	{
		const fa = path.join(alice, 'arch.drawio');
		fs.writeFileSync(fa, diagram('Alice v2'));
		assert.equal((await svcA.status(fa)).fileState, 'modified');

		const c = await svcA.commit(fa, 'Rename start');
		assert.equal(c.committed, true);
		assert.equal(c.commit.author, 'Alice');
		assert.equal((await svcA.status(fa)).ahead, 1);

		await svcA.push(fa);
		assert.equal((await svcA.status(fa)).ahead, 0);

		const fb = path.join(bob, 'arch.drawio');
		await svcB.fetch(bob);
		const act = await svcB.activity(fb);
		assert.equal(act.incoming.length, 1);
		assert.equal(act.incomingFile.length, 1);
		assert.equal(act.incomingFile[0].author, 'Alice');
		assert.ok(act.mergeBase);

		const res = await svcB.pull(fb);
		assert.equal(res.result, 'merged');
		assert.equal(res.needsDiagramMerge, false);
		assert.equal(res.fileChanged, true);
		assert.match(fs.readFileSync(fb, 'utf8'), /Alice v2/);
	});

	test('pull keeps uncommitted edits and hands back base/ours/theirs', async () =>
	{
		const fa = path.join(alice, 'arch.drawio');
		const fb = path.join(bob, 'arch.drawio');

		// Alice pushes a new shape
		fs.writeFileSync(fa, diagram('Alice v2', '<mxCell id="b" value="Alice shape" vertex="1" parent="1"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell>'));
		await svcA.commit(fa, 'Add shape');
		await svcA.push(fa);

		// Bob has unsaved-to-git edits of his own
		const bobEdit = diagram('Alice v2', '<mxCell id="c" value="Bob shape" vertex="1" parent="1"><mxGeometry x="10" y="200" width="80" height="40" as="geometry"/></mxCell>');
		fs.writeFileSync(fb, bobEdit);

		const res = await svcB.pull(fb);
		assert.equal(res.result, 'merged');
		assert.equal(res.fileDirty, true);
		assert.equal(res.needsDiagramMerge, true);
		assert.match(res.base, /Alice v2/);
		assert.doesNotMatch(res.base, /Alice shape|Bob shape/);
		assert.match(res.theirs, /Alice shape/);
		assert.equal(res.ours, bobEdit);
		// Working copy still holds Bob's version until the editor writes the merge
		assert.equal(fs.readFileSync(fb, 'utf8'), bobEdit);
		assert.ok(fs.existsSync(res.backupPath));
		assert.equal(res.incoming[0].author, 'Alice');

		// Merged result is written and stays uncommitted
		const merged = diagram('Alice v2', '<mxCell id="b" value="Alice shape" vertex="1" parent="1"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell><mxCell id="c" value="Bob shape" vertex="1" parent="1"><mxGeometry x="10" y="200" width="80" height="40" as="geometry"/></mxCell>');
		const r = await svcB.resolve(fb, null, {content: merged});
		assert.equal(r.completed, false);
		const st = await svcB.status(fb);
		assert.equal(st.fileState, 'modified');
		assert.equal(st.behind, 0);
	});

	test('pull restores local edits when incoming commits do not touch the diagram', async () =>
	{
		const fb = path.join(bob, 'arch.drawio');
		const before = fs.readFileSync(fb, 'utf8');

		fs.writeFileSync(path.join(alice, 'notes.txt'), 'changed\n');
		await svcA.commit(path.join(alice, 'arch.drawio'), 'Notes', {all: true});
		await svcA.push(path.join(alice, 'arch.drawio'));

		const res = await svcB.pull(fb);
		assert.equal(res.result, 'merged');
		assert.equal(res.needsDiagramMerge, false);
		assert.equal(fs.readFileSync(fb, 'utf8'), before);
		assert.equal(fs.readFileSync(path.join(bob, 'notes.txt'), 'utf8'), 'changed\n');

		await svcB.commit(fb, 'Bob shape');
		await svcB.push(fb);
	});

	test('committed changes on both sides become a conflict, never a textual merge', async () =>
	{
		const fa = path.join(alice, 'arch.drawio');
		const fb = path.join(bob, 'arch.drawio');
		await svcA.pull(fa);

		fs.writeFileSync(fa, fs.readFileSync(fa, 'utf8').replace('Alice shape', 'Alice renamed'));
		await svcA.commit(fa, 'Alice renames');
		await svcA.push(fa);

		fs.writeFileSync(fb, fs.readFileSync(fb, 'utf8').replace('Bob shape', 'Bob renamed'));
		await svcB.commit(fb, 'Bob renames');

		// Push is rejected until Bob pulls
		await assert.rejects(svcB.push(fb), e => e.kind == 'rejected');

		const res = await svcB.pull(fb);
		assert.equal(res.result, 'conflicts');
		assert.equal(res.fileConflicted, true);
		assert.equal(res.needsDiagramMerge, true);
		assert.deepEqual(res.conflicts, ['arch.drawio']);
		assert.match(res.theirs, /Alice renamed/);
		assert.match(res.ours, /Bob renamed/);
		// No conflict markers in the working copy
		assert.doesNotMatch(fs.readFileSync(fb, 'utf8'), /<<<<<<<|>>>>>>>/);

		const st = await svcB.status(fb);
		assert.equal(st.merging, true);
		assert.deepEqual(st.conflicts, ['arch.drawio']);

		// Stage contents are available for merging other conflicted files
		assert.match(await svcB.showRel(bob, ':3', 'arch.drawio'), /Alice renamed/);

		const merged = res.ours.replace('Alice shape', 'Alice renamed');
		const r = await svcB.resolve(fb, null, {content: merged});
		assert.equal(r.completed, true);
		assert.deepEqual(r.remaining, []);
		assert.equal((await svcB.status(fb)).merging, false);

		await svcB.push(fb);
		const hist = await svcB.history(fb);
		assert.ok(hist.length >= 5);
		assert.ok(hist.every(c => c.pushed));
		assert.match(await svcB.show(fb, 'HEAD'), /Alice renamed[\s\S]*Bob renamed/);
	});

	test('abortMerge restores the local edits', async () =>
	{
		const fa = path.join(alice, 'arch.drawio');
		const fb = path.join(bob, 'arch.drawio');
		await svcA.pull(fa);

		fs.writeFileSync(fb, fs.readFileSync(fb, 'utf8').replace('Start', 'x').replace('Alice v2', 'Bob title'));
		await svcB.commit(fb, 'Bob title');
		await svcB.push(fb);

		fs.writeFileSync(fa, fs.readFileSync(fa, 'utf8').replace('Alice v2', 'Alice title'));
		await svcA.commit(fa, 'Alice title');
		const uncommitted = fs.readFileSync(fa, 'utf8').replace('Alice title', 'Alice title + wip');
		fs.writeFileSync(fa, uncommitted);

		const res = await svcA.pull(fa);
		assert.equal(res.result, 'conflicts');
		await svcA.abortMerge(fa, res.ours);
		assert.equal(fs.readFileSync(fa, 'utf8'), uncommitted);
		assert.equal((await svcA.status(fa)).merging, false);

		await svcA.resolve(fa, null, {content: uncommitted});
		g(alice, 'checkout', '-q', '--', 'arch.drawio');
		g(alice, 'reset', '-q', '--hard', 'origin/main');
	});

	test('resolve refuses non diagram content and paths outside the repo', async () =>
	{
		const fb = path.join(bob, 'arch.drawio');
		await assert.rejects(svcB.resolve(fb, null, {content: 'hello'}), /not a draw.io diagram/);
		await assert.rejects(svcB.resolve(fb, '../outside.drawio', {content: diagram('x')}), /outside/);
	});

	test('other branches touching the diagram are reported', async () =>
	{
		const fa = path.join(alice, 'arch.drawio');
		const fb = path.join(bob, 'arch.drawio');
		await svcB.pull(fb);
		await svcB.checkout(fb, 'bob/new-layout', {create: true});
		fs.writeFileSync(fb, fs.readFileSync(fb, 'utf8').replace('Bob renamed', 'Bob WIP'));
		await svcB.commit(fb, 'WIP layout');
		await svcB.push(fb);
		await svcB.checkout(fb, 'main');

		await svcA.fetch(alice);
		const act = await svcA.activity(fa);
		const other = act.otherBranches.find(b => b.branch == 'origin/bob/new-layout');
		assert.ok(other, JSON.stringify(act.otherBranches));
		assert.deepEqual(other.authors, ['Bob']);
		assert.equal(other.latest.subject, 'WIP layout');

		const br = await svcA.branches(fa);
		assert.ok(br.remote.some(b => b.name == 'origin/bob/new-layout'));
		const co = await svcA.checkout(fa, 'origin/bob/new-layout', {remote: true});
		assert.equal(co.branch, 'bob/new-layout');
		assert.match(fs.readFileSync(fa, 'utf8'), /Bob WIP/);
		await svcA.checkout(fa, 'main');
	});

	test('discard keeps a backup', async () =>
	{
		const fa = path.join(alice, 'arch.drawio');
		const orig = fs.readFileSync(fa, 'utf8');
		fs.writeFileSync(fa, diagram('oops'));
		const r = await svcA.discard(fa);
		assert.equal(fs.readFileSync(fa, 'utf8'), orig);
		assert.match(fs.readFileSync(r.backupPath, 'utf8'), /oops/);
	});

	test('diagram files are never merged textually', async () =>
	{
		const attrs = fs.readFileSync(path.join(bob, '.git', 'info', 'attributes'), 'utf8');
		assert.match(attrs, /\*\.drawio merge=binary/);
	});

	test('draw.io drafts and backups are never committed', async () =>
	{
		const fb = path.join(bob, 'arch.drawio');
		fs.writeFileSync(path.join(bob, '.$arch.drawio.dtmp'), 'draft');
		fs.writeFileSync(path.join(bob, '.$arch.drawio.bkp'), 'backup');
		const st = await svcB.status(fb);
		assert.deepEqual(st.changes, []);
	});

	test('init and clone', async () =>
	{
		const dir = path.join(tmp, 'fresh');
		fs.mkdirSync(dir);
		const f = path.join(dir, 'd.drawio');
		fs.writeFileSync(f, diagram('new'));
		await svcA.init(dir);
		assert.equal((await svcA.status(f)).fileState, 'untracked');

		const c = await svcA.clone('https://example.invalid/none.git', tmp).catch(e => e);
		assert.ok(c instanceof Error);
		await assert.rejects(svcA.clone('--upload-pack=evil', tmp), /URL/);
	});

	test('operations on one repository are serialised', async () =>
	{
		const fa = path.join(alice, 'arch.drawio');
		const results = await Promise.all([svcA.status(fa), svcA.fetch(alice), svcA.activity(fa), svcA.history(fa), svcA.status(fa)]);
		assert.equal(results.length, 5);
		assert.equal(results[0].isRepo, true);
	});
});
