// Keys for a live session. Everyone who has the repository can derive them
// (they come from the repository's root commit, its remote and the path of
// the diagram); nobody else can join a session or read its signalling.
// The WebRTC data channels themselves are encrypted by DTLS.

import crypto from 'crypto';

export function normaliseRemote(url)
{
	if (typeof url !== 'string' || url.length == 0) return '';

	let u = url.trim().toLowerCase()
		.replace(/^[a-z+]+:\/\//, '')    // protocol
		.replace(/^[^@\/]+@/, '')         // credentials / git@
		.replace(/\.git\/?$/, '')
		.replace(/\/+$/, '');

	// git@host:org/repo -> host/org/repo
	u = u.replace(/^([^\/:]+):(?!\d+\/)/, '$1/');
	// host:port/org/repo -> host/org/repo
	u = u.replace(/^([^\/:]+):\d+\//, '$1/');

	return u;
}

// Each branch of a diagram is its own session: people on different branches
// have different diagrams and must not overwrite each other's
export function deriveSessionKeys(rootCommit, remoteUrl, relPath, branch)
{
	if (typeof rootCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(rootCommit))
	{
		throw new Error('A commit is needed before starting a live session');
	}

	const material = ['drawio-live/1', rootCommit, normaliseRemote(remoteUrl), String(relPath), String(branch || '')].join('\n');
	const secret = crypto.createHash('sha256').update(material).digest();
	const docId = crypto.createHmac('sha256', secret).update('doc-id').digest('hex').substring(0, 32);

	return {secret, docId};
}

// AES-256-GCM, returns base64(iv | tag | ciphertext)
export function seal(secret, obj)
{
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
	const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);

	return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function open(secret, b64)
{
	try
	{
		const buf = Buffer.from(String(b64), 'base64');

		if (buf.length < 29) return null;

		const decipher = crypto.createDecipheriv('aes-256-gcm', secret, buf.subarray(0, 12));
		decipher.setAuthTag(buf.subarray(12, 28));
		const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);

		return JSON.parse(pt.toString('utf8'));
	}
	catch (e)
	{
		return null;
	}
}

export function randomPeerId()
{
	return crypto.randomBytes(8).toString('hex');
}
