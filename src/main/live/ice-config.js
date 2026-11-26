// Relay (TURN) servers for people whose networks block direct connections.
// Configured once per repository in .drawio/live.json, so everyone who has
// the repository gets them without any setup:
//
//   { "iceServers": [{"urls": "turn:turn.example.com:3478", "username": "u", "credential": "p"}] }
//
//   { "turn": {"urls": ["turn:turn.example.com:3478"], "secret": "<coturn static-auth-secret>", "ttl": 86400} }
//     Short-lived logins (coturn use-auth-secret / TURN REST API)
//
//   { "iceServersUrl": "https://turn-token.example.workers.dev" }
//     A service that returns {"iceServers": [...]} with short-lived logins,
//     eg. a Cloudflare Worker in front of Cloudflare's TURN service. Best for
//     public repositories, where a secret in the repository would be public.

import crypto from 'crypto';
import { promises as fsProm } from 'fs';
import path from 'path';

export const DEFAULT_STUN = [{urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun.cloudflare.com:3478'}];
const MAX_SERVERS = 8;

function validUrl(u)
{
	return typeof u === 'string' && u.length < 300 && /^(stun|turn|turns):[^\s]+$/.test(u);
}

// Keeps well formed entries only
export function sanitiseIceServers(list)
{
	if (!Array.isArray(list)) return [];

	const result = [];

	for (const s of list.slice(0, MAX_SERVERS))
	{
		if (s == null || typeof s !== 'object') continue;

		const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(validUrl);

		if (urls.length == 0) continue;

		const entry = {urls};

		if (typeof s.username === 'string' && s.username.length < 300) entry.username = s.username;
		if (typeof s.credential === 'string' && s.credential.length < 300) entry.credential = s.credential;

		result.push(entry);
	}

	return result;
}

// TURN REST API credentials (coturn --use-auth-secret)
export function turnRestCredentials(secret, ttlSeconds, now = Date.now(), user = 'drawio')
{
	const username = Math.floor(now / 1000 + (ttlSeconds || 86400)) + ':' + user;
	const credential = crypto.createHmac('sha1', String(secret)).update(username).digest('base64');

	return {username, credential};
}

export async function readLiveConfig(root)
{
	try
	{
		const text = await fsProm.readFile(path.join(root, '.drawio', 'live.json'), 'utf8');

		return JSON.parse(text);
	}
	catch (e)
	{
		return null;
	}
}

// Returns {iceServers, relay: 'none'|'static'|'rest'|'url', error}
export async function resolveIceServers(config, opts = {})
{
	const fetchFn = opts.fetch || globalThis.fetch;
	let extra = [];
	let relay = 'none';
	let error = null;

	try
	{
		if (config != null && typeof config === 'object')
		{
			if (Array.isArray(config.iceServers))
			{
				extra = sanitiseIceServers(config.iceServers);
				relay = extra.some(s => s.urls.some(u => /^turns?:/.test(u))) ? 'static' : 'none';
			}

			if (config.turn != null && typeof config.turn.secret === 'string')
			{
				const cred = turnRestCredentials(config.turn.secret, config.turn.ttl, opts.now);
				extra = extra.concat(sanitiseIceServers([Object.assign({urls: config.turn.urls}, cred)]));
				relay = 'rest';
			}

			if (typeof config.iceServersUrl === 'string')
			{
				if (!/^https:\/\//.test(config.iceServersUrl)) throw new Error('iceServersUrl must be https');

				const ctrl = new AbortController();
				const timer = setTimeout(() => ctrl.abort(), opts.timeout || 6000);

				try
				{
					const res = await fetchFn(config.iceServersUrl, {signal: ctrl.signal, headers: {accept: 'application/json'}});

					if (!res.ok) throw new Error('relay service answered ' + res.status);

					const body = await res.json();
					extra = extra.concat(sanitiseIceServers(body.iceServers || body));
					relay = 'url';
				}
				finally
				{
					clearTimeout(timer);
				}
			}
		}
	}
	catch (e)
	{
		error = e.message;
	}

	return {iceServers: DEFAULT_STUN.concat(extra), relay, error};
}
