// Live collaboration for draw.io desktop: everyone who has the same diagram
// (same repository and path) open is connected peer to peer in a WebRTC mesh.
//
//  - The person who has been in the session longest is the host. The host
//    puts all edits in one order, answers checksum questions and hands the
//    current diagram to people who join. If the host leaves, the next person
//    in line becomes host right away; nobody reconnects, as every peer is
//    already connected to every other peer.
//  - Edits are draw.io diffs (EditorUi.diffPages / DrawioFile.patch, the
//    engine behind draw.io's own real-time collaboration). Peers apply their
//    own edits immediately and send them to the host, which applies and
//    rebroadcasts them in order. The host broadcasts a checksum of the
//    diagram; a peer that disagrees asks the host for the full diagram.
//  - Cursors, selections and what people are doing go directly to everyone.
//  - Comments use draw.io's comments window, synced live and stored next to
//    the diagram as <diagram>.comments.jsonl so they are versioned with it.
//
// Runs in the same scope as git-ui.js (h, avatar, git, ago, ...).

var LIVE_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#f032e6', '#469990', '#9A6324', '#800000', '#000075'];
var CHUNK = 60000;

function live(op, args)
{
	return new Promise(function(resolve, reject)
	{
		electron.request({action: 'live', op: op, args: args || {}}, resolve, function(msg, e)
		{
			var err = new Error(msg || 'Unknown error');
			err.kind = (e != null && e.kind) ? e.kind : 'unknown';
			reject(err);
		});
	});
}

function cloneJson(o)
{
	return JSON.parse(JSON.stringify(o));
}

function isEmptyDiff(d)
{
	return d == null || mxUtils.isEmptyObject(d);
}

function colorFor(id)
{
	var h = 0;

	for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;

	return LIVE_COLORS[Math.abs(h) % LIVE_COLORS.length];
}

// ---------------------------------------------------------------------------

function LiveSession(sc)
{
	this.sc = sc;
	this.ui = sc.ui;
	this.graph = sc.ui.editor.graph;
	this.peers = {};
	this.others = {};          // seen but on a different version
	this.me = null;
	this.hostId = null;
	this.active = false;
	this.synced = false;
	this.lastSeq = 0;
	this.applying = false;
	this.activity = [];
	this.following = null;
	this.lastHashSent = null;
	this.resyncAt = 0;
	this.inbox = {};

	this.installEditorHooks();
}

// Recent connection events, for diagnosing (window.__drawioGit.live.trace)
LiveSession.prototype.debug = function()
{
	this.trace = this.trace || [];
	this.trace.push(new Date().toISOString().substring(17, 23) + ' ' + Array.prototype.slice.call(arguments).join(' '));

	if (this.trace.length > 300) this.trace.splice(0, 100);
};

LiveSession.prototype.myColor = function()
{
	return this.me ? colorFor(this.me.peerId) : '#888';
};

LiveSession.prototype.isHost = function()
{
	return this.me != null && this.hostId == this.me.peerId;
};

LiveSession.prototype.readyPeers = function()
{
	var result = [];

	for (var id in this.peers)
	{
		if (this.peers[id].ready) result.push(this.peers[id]);
	}

	return result;
};

// ---------------------------------------------------------------------------
// Session lifecycle

LiveSession.prototype.start = function()
{
	var self = this;
	var st = this.sc.status;
	var path = this.sc.filePath;

	if (this.active || this.starting || st == null || !st.isRepo || st.initial || !st.tracked)
	{
		return Promise.resolve(false);
	}

	this.starting = true;

	return live('join', {path: path, name: st.userName || 'Someone', email: st.userEmail || ''}).then(function(info)
	{
		self.starting = false;

		if (path != self.sc.filePath) return live('leave');

		self.me = info;
		self.path = path;
		self.active = true;
		self.synced = true; // alone: we are the host and the reference
		self.hostId = info.peerId;
		self.lastSeq = 0;
		self.shadow = self.ui.clonePages(self.ui.pages);
		self.confirmed = self.ui.clonePages(self.ui.pages);
		self.peers = {};
		self.others = {};
		self.activity = [];
		self.startTimers();
		self.sc.render();

		return true;
	}, function(e)
	{
		self.starting = false;
		self.lastError = e.message;
		self.sc.render();
		return false;
	});
};

LiveSession.prototype.stop = function()
{
	var wasActive = this.active;
	this.active = false;
	this.stopTimers();

	for (var id in this.peers)
	{
		this.dropPeer(id, true);
	}

	this.peers = {};
	this.others = {};
	this.me = null;
	this.hostId = null;
	this.following = null;
	this.renderPresence();

	return wasActive ? live('leave').catch(function() {}) : Promise.resolve();
};

LiveSession.prototype.startTimers = function()
{
	var self = this;

	this.pingTimer = window.setInterval(function()
	{
		var now = Date.now();

		for (var id in self.peers)
		{
			var p = self.peers[id];

			if (p.ready && now - p.lastSeen > 7000)
			{
				self.dropPeer(id);
			}
			else if (p.ready)
			{
				self.sendTo(p, {t: 'ping', roster: self.roster()});
			}
			else if (!p.ready && now - p.created > 10000)
			{
				self.failures = self.failures || {};
				self.failures[id] = (self.failures[id] || 0) + 1;
				self.debug('no direct connection to', id, 'attempt', self.failures[id]);

				// Connection never came up: allows a new attempt
				self.dropPeer(id, true);
			}
		}

		// Seen-but-different-version entries expire with their beacons
		for (var id in self.others)
		{
			if (now - self.others[id].seen > 20000) delete self.others[id];
		}

		self.connectViaRelays();
		self.updateRoutes();
		self.electHost();

		// Edits parked for a host that turned out to be someone else
		if (!self.isHost() && self.parked && self.parked.length > 0 && self.peers[self.hostId] && self.peers[self.hostId].ready)
		{
			self.parked.forEach(function(e)
			{
				if (now - e.at < 30000) self.sendTo(self.peers[self.hostId], {t: 'propose', pid: e.pid, origin: e.from, diff: e.diff});
			});
			self.parked = [];
		}

		// Keeps asking until the host hands over the diagram (the host may
		// not see itself as host yet while it notices that the old one left)
		if (!self.synced && !self.isHost() && self.peers[self.hostId] != null)
		{
			self.sendTo(self.peers[self.hostId], {t: 'snapshot-req'});
		}

		self.renderPresence();
	}, 2000);

	this.hashTimer = window.setInterval(function()
	{
		if (self.isHost() && self.readyPeers().length > 0)
		{
			self.flushLocal();
			var hash = self.ui.getHashValueForPages(self.ui.pages);

			if (hash != self.lastHashSent)
			{
				self.lastHashSent = hash;
				self.broadcast({t: 'hash', seq: self.lastSeq, hash: hash});
			}
		}
	}, 2000);
};

LiveSession.prototype.stopTimers = function()
{
	window.clearInterval(this.pingTimer);
	window.clearInterval(this.hashTimer);
};

// ---------------------------------------------------------------------------
// Discovery and connections (signalling arrives from the main process)

LiveSession.prototype.onPeerSeen = function(info)
{
	if (!this.active || info.peer == this.me.peerId) return;

	var p = this.peers[info.peer];

	if (p != null) p.blob = info.blob;

	if (p == null) this.debug('seen', info.peer, info.name, info.via);

	if (p == null && this.directFailed(info.peer))
	{
		// Reached through a peer we share instead (see connectViaRelays)
		this.candidates = this.candidates || {};
		this.candidates[info.peer] = info;
		return;
	}

	if (p == null)
	{
		p = this.createPeer(info.peer, info);

		// The peer with the smaller id makes the offer, so that two people
		// who find each other at the same time do not both call
		if (this.me.peerId < info.peer)
		{
			this.makeOffer(p);
		}
	}
	else
	{
		p.via = info.via;
	}
};

// Who I am connected to, so that peers can find each other through me
LiveSession.prototype.roster = function()
{
	return this.readyPeers().filter(function(p) { return !p.virtual; }).map(function(p)
	{
		return {peer: p.id, name: p.name, email: p.email, joinedAt: p.joinedAt, blob: p.blob};
	});
};

// Sends a handshake both through discovery (main process) and through every
// connected peer, which passes it on if it is connected to the recipient
LiveSession.prototype.signalTo = function(p, signal, via)
{
	live('signal', {to: p.id, via: via == 'mesh' ? null : via, signal: signal}).catch(function() {});
	this.broadcast({t: 'relay', to: p.id, from: this.me.peerId, signal: signal});
};

// How each connection actually runs: same network, direct over the internet,
// through a TURN relay server, or through a teammate
LiveSession.prototype.updateRoutes = function()
{
	var self = this;

	this.readyPeers().forEach(function(p)
	{
		if (p.virtual || p.pc == null) return;

		p.pc.getStats().then(function(stats)
		{
			var pair = null, local = {}, remote = {};

			stats.forEach(function(r)
			{
				if (r.type == 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
				if (r.type == 'local-candidate') local[r.id] = r;
				if (r.type == 'remote-candidate') remote[r.id] = r;
			});

			if (pair == null)
			{
				stats.forEach(function(r) { if (r.type == 'candidate-pair' && r.nominated && r.state == 'succeeded') pair = r; });
			}

			if (pair != null)
			{
				var lt = (local[pair.localCandidateId] || {}).candidateType;
				var rt = (remote[pair.remoteCandidateId] || {}).candidateType;
				p.route = (lt == 'relay' || rt == 'relay') ? 'turn' : (lt == 'host' && rt == 'host') ? 'lan' : 'internet';
				p.rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
			}
		}).catch(function() {});
	});
};

LiveSession.prototype.routeText = function(p)
{
	if (p.virtual)
	{
		var r = this.peers[p.relay];
		return 'through ' + (r ? r.name : 'a teammate') + ' (no direct connection)';
	}

	var text = {lan: 'direct · same network', internet: 'direct · over the internet', turn: 'through the relay server'}[p.route] || 'connected';

	return text + (p.rtt != null ? ' · ' + p.rtt + ' ms' : '');
};

// Direct connections that cannot be made (eg. strict NATs, or blocked for
// tests through blockDirect) are replaced by a route through a shared peer
LiveSession.prototype.directFailed = function(id)
{
	return (this.blockDirect != null && this.blockDirect[id]) || (this.failures != null && this.failures[id] >= 2);
};

LiveSession.prototype.connectViaRelays = function()
{
	if (!this.active) return;

	var self = this;
	var now = Date.now();
	var direct = this.readyPeers().filter(function(p) { return !p.virtual; });

	direct.forEach(function(r)
	{
		(r.roster || []).forEach(function(info)
		{
			var id = info.peer;

			if (id == self.me.peerId || !self.directFailed(id)) return;

			var p = self.peers[id];

			if (p == null)
			{
				p = {id: id, virtual: true, relay: r.id, ready: false, created: now, lastSeen: now,
					name: info.name || 'Someone', email: info.email || '', joinedAt: info.joinedAt || now,
					color: colorFor(id), via: 'relay', blob: info.blob, selection: {}, cursor: null, lastCursor: null};
				self.peers[id] = p;
				self.debug('relaying to', id, 'via', r.id);
				self.sendTo(p, {t: 'hello', info: self.myInfo(), seq: self.lastSeq, synced: self.synced});
			}
		});
	});
};

LiveSession.prototype.createPeer = function(id, info)
{
	var self = this;
	var pc = new RTCPeerConnection({iceServers: this.me.iceServers || [],
		// Test hook: forces connections through the relay server
		iceTransportPolicy: this.forceRelay ? 'relay' : 'all'});
	var p = {
		id: id, pc: pc, dc: null, ready: false, created: Date.now(), lastSeen: Date.now(), blob: info.blob,
		name: info.name || 'Someone', email: info.email || '', joinedAt: info.joinedAt || Date.now(),
		color: colorFor(id), via: info.via, selection: {}, cursor: null, lastCursor: null,
		doing: null, page: null
	};

	this.peers[id] = p;

	pc.onconnectionstatechange = function()
	{
		if (pc.connectionState == 'failed' || pc.connectionState == 'closed')
		{
			self.dropPeer(id);
		}
		else if (pc.connectionState == 'disconnected')
		{
			// Gives a flaky network a moment to recover
			window.setTimeout(function()
			{
				if (pc.connectionState == 'disconnected') self.dropPeer(id);
			}, 3000);
		}
	};

	pc.ondatachannel = function(evt)
	{
		self.attachChannel(p, evt.channel);
	};

	return p;
};

LiveSession.prototype.waitForIce = function(pc)
{
	return new Promise(function(resolve)
	{
		if (pc.iceGatheringState == 'complete') return resolve();

		var done = function()
		{
			if (pc.iceGatheringState == 'complete') resolve();
		};

		pc.addEventListener('icegatheringstatechange', done);
		// Internet candidates can be slow: sends what we have after a while
		window.setTimeout(resolve, 2500);
	});
};

LiveSession.prototype.makeOffer = function(p)
{
	var self = this;
	this.attachChannel(p, p.pc.createDataChannel('drawio-live', {ordered: true}));

	return p.pc.createOffer().then(function(offer)
	{
		return p.pc.setLocalDescription(offer);
	}).then(function()
	{
		return self.waitForIce(p.pc);
	}).then(function()
	{
		p.offerId = Math.random().toString(36).substring(2);
		self.signalTo(p, {type: 'offer', id: p.offerId, sdp: p.pc.localDescription.sdp, info: self.myInfo()}, p.via);
	}).catch(function(e)
	{
		console.warn('live: offer failed', e);
		self.dropPeer(p.id, true);
	});
};

LiveSession.prototype.myInfo = function()
{
	var st = this.sc.status || {};
	return {name: st.userName || 'Someone', email: st.userEmail || '', joinedAt: this.me.joinedAt, blob: this.me.blob};
};

LiveSession.prototype.onSignal = function(msg)
{
	var self = this;

	if (!this.active || msg == null || msg.data == null) return;

	var data = msg.data;
	var p = this.peers[msg.from];

	this.debug('signal', data.type, 'from', msg.from, 'via', msg.via);

	if (this.blockDirect != null && this.blockDirect[msg.from]) return;

	if (data.type == 'offer')
	{
		// The same offer can arrive through several routes
		if (p != null && p.remoteOfferId == data.id) return;

		// A newer offer replaces a half-open connection
		if (p != null && !p.ready)
		{
			this.dropPeer(msg.from, true);
			p = null;
		}

		if (p != null) return;

		var info = Object.assign({via: msg.via}, data.info || {});
		p = this.createPeer(msg.from, info);
		p.remoteOfferId = data.id;

		p.pc.setRemoteDescription({type: 'offer', sdp: data.sdp}).then(function()
		{
			return p.pc.createAnswer();
		}).then(function(answer)
		{
			return p.pc.setLocalDescription(answer);
		}).then(function()
		{
			return self.waitForIce(p.pc);
		}).then(function()
		{
			self.signalTo(p, {type: 'answer', offerId: data.id, sdp: p.pc.localDescription.sdp}, msg.via);
		}).catch(function(e)
		{
			console.warn('live: answer failed', e);
			self.dropPeer(msg.from, true);
		});
	}
	else if (data.type == 'answer' && p != null && p.pc.signalingState == 'have-local-offer' &&
		(data.offerId == null || data.offerId == p.offerId) && !p.answered)
	{
		// The same answer can arrive through several routes
		p.answered = true;
		this.debug('answer from', msg.from, msg.via);
		p.pc.setRemoteDescription({type: 'answer', sdp: data.sdp}).catch(function(e)
		{
			console.warn('live: bad answer', e);
			self.dropPeer(msg.from, true);
		});
	}
};

LiveSession.prototype.onPeerGone = function(id)
{
	if (this.peers[id] != null) this.dropPeer(id);
	delete this.others[id];
	this.renderPresence();
};

LiveSession.prototype.attachChannel = function(p, dc)
{
	var self = this;
	p.dc = dc;

	dc.onopen = function()
	{
		self.sendTo(p, {t: 'hello', info: self.myInfo(), seq: self.lastSeq, synced: self.synced});
	};

	dc.onmessage = function(evt)
	{
		p.lastSeen = Date.now();

		try
		{
			self.receive(p, JSON.parse(evt.data));
		}
		catch (e)
		{
			console.warn('live: bad message', e);
		}
	};

	dc.onclose = function()
	{
		self.dropPeer(p.id);
	};
};

LiveSession.prototype.receiveForwarded = function(p, msg)
{
	if (!p.ready || p.virtual || typeof msg.from !== 'string' || !/^[0-9a-f]{16}$/.test(msg.from) || msg.msg == null) return;

	if (msg.to == this.me.peerId)
	{
		var v = this.peers[msg.from];

		if (v != null && !v.virtual && !v.ready)
		{
			// A relayed peer wins over a direct attempt that is not up
			this.dropPeer(msg.from, true);
			v = null;
		}

		if (v == null)
		{
			var now = Date.now();
			v = {id: msg.from, virtual: true, relay: p.id, ready: false, created: now, lastSeen: now,
				name: 'Someone', email: '', joinedAt: now, color: colorFor(msg.from), via: 'relay',
				selection: {}, cursor: null, lastCursor: null};
			this.peers[msg.from] = v;
			this.debug('relayed peer', msg.from, 'via', p.id);
			this.sendTo(v, {t: 'hello', info: this.myInfo(), seq: this.lastSeq, synced: this.synced});
		}

		if (v.virtual)
		{
			v.relay = p.id;
			v.lastSeen = Date.now();
			this.receive(v, msg.msg);
		}
	}
	else
	{
		// Passes it on, one hop, to a direct neighbour
		var target = this.peers[msg.to];

		if (target != null && target.ready && !target.virtual && msg.from == p.id)
		{
			this.sendTo(target, msg);
		}
	}
};

LiveSession.prototype.dropPeer = function(id, silent)
{
	var p = this.peers[id];

	if (p == null) return;

	delete this.peers[id];
	this.debug('drop', id, p.name, 'ready', p.ready, 'state', p.virtual ? 'relayed' : p.pc.connectionState, silent ? 'silent' : '');

	try { p.dc && p.dc.close(); } catch (e) {}
	try { p.pc && p.pc.close(); } catch (e) {}

	// Peers reached through this one need another route
	for (var vid in this.peers)
	{
		if (this.peers[vid].virtual && this.peers[vid].relay == id)
		{
			this.dropPeer(vid, true);
		}
	}

	this.clearPeerVisuals(p);

	if (p.ready && !silent && this.active)
	{
		this.log(p, 'left');
	}

	if (this.following == id) this.following = null;

	this.electHost();
	this.renderPresence();
};

// ---------------------------------------------------------------------------
// Messaging

LiveSession.prototype.sendTo = function(p, msg)
{
	if (p != null && p.virtual)
	{
		var r = this.peers[p.relay];

		if (r != null && r.ready && !r.virtual)
		{
			this.sendTo(r, {t: 'fwd', to: p.id, from: this.me.peerId, msg: msg});
		}

		return;
	}

	if (p == null || p.dc == null || p.dc.readyState != 'open') return;

	var data = JSON.stringify(msg);

	if (data.length <= CHUNK)
	{
		p.dc.send(data);
	}
	else
	{
		var id = Math.random().toString(36).substring(2);
		var n = Math.ceil(data.length / CHUNK);

		for (var i = 0; i < n; i++)
		{
			p.dc.send(JSON.stringify({t: 'chunk', id: id, i: i, n: n, d: data.substring(i * CHUNK, (i + 1) * CHUNK)}));
		}
	}
};

LiveSession.prototype.broadcast = function(msg, except)
{
	for (var id in this.peers)
	{
		if (this.peers[id].ready && id != except) this.sendTo(this.peers[id], msg);
	}
};

LiveSession.prototype.receive = function(p, msg)
{
	if (msg.t == 'chunk')
	{
		var box = this.inbox[msg.id] = this.inbox[msg.id] || {parts: [], count: 0};
		box.parts[msg.i] = msg.d;
		box.count++;

		if (box.count == msg.n)
		{
			delete this.inbox[msg.id];
			this.receive(p, JSON.parse(box.parts.join('')));
		}

		return;
	}

	if (msg.t == 'fwd')
	{
		this.receiveForwarded(p, msg);
		return;
	}

	if (msg.t == 'hello')
	{
		var first = !p.ready;
		p.ready = true;
		p.name = String(msg.info.name || p.name).substring(0, 80);
		p.email = String(msg.info.email || '').substring(0, 120);
		p.joinedAt = msg.info.joinedAt;
		p.blob = msg.info.blob;

		if (first)
		{
			this.debug('ready', p.id, p.name);
			var hostBefore = this.hostId;
			this.log(p, 'joined');
			this.electHost();

			// The host was known through gossip and is connected only now
			if (p.id == this.hostId && hostBefore == this.hostId && !this.isHost())
			{
				this.joinHost([]);
			}

			this.sendPresenceTo(p);
		}

		this.renderPresence();
		return;
	}

	if (!p.ready) return;

	switch (msg.t)
	{
		case 'ping':
			if (Array.isArray(msg.roster))
			{
				p.roster = msg.roster.slice(0, 50);
				var self = this;

				msg.roster.slice(0, 50).forEach(function(r)
				{
					if (r != null && typeof r.peer === 'string' && /^[0-9a-f]{16}$/.test(r.peer) &&
						r.peer != self.me.peerId && typeof r.joinedAt === 'number')
					{
						self.members = self.members || {};
						self.members[r.peer] = {joinedAt: r.joinedAt, heard: Date.now()};
					}

					if (r != null && typeof r.peer === 'string' && /^[0-9a-f]{16}$/.test(r.peer) &&
						r.peer != self.me.peerId && self.peers[r.peer] == null)
					{
						self.onPeerSeen({peer: r.peer, name: r.name, email: r.email, joinedAt: r.joinedAt, blob: r.blob, via: 'mesh'});
					}
				});
			}
			break;
		case 'relay':
			if (msg.to == this.me.peerId && typeof msg.from === 'string')
			{
				this.onSignal({from: msg.from, data: msg.signal, via: 'mesh'});
			}
			else if (this.peers[msg.to] != null && this.peers[msg.to].ready && msg.from == p.id)
			{
				// One hop only: passes on what a direct neighbour sends
				this.sendTo(this.peers[msg.to], msg);
			}
			break;
		case 'propose':
			// Edits passed on by a peer keep their author
			var origin = (typeof msg.origin === 'string' && msg.origin != this.me.peerId) ? msg.origin : p.id;

			if (this.isHost())
			{
				this.hostApply(origin, msg.diff, msg.pid);
			}
			else
			{
				// The sender already sees us as host: keeps the edit until we
				// notice it too (or hands it on if someone else is host)
				this.parked = this.parked || [];
				this.parked.push({from: origin, pid: msg.pid, diff: msg.diff, at: Date.now()});
			}
			break;
		case 'op':
			if (p.id == this.hostId) this.clientApply(msg);
			break;
		case 'hash':
			if (p.id == this.hostId) this.checkHash(msg);
			break;
		case 'snapshot-req':
			if (this.isHost()) this.sendSnapshot(p);
			break;
		case 'snapshot':
			if (p.id == this.hostId) this.applySnapshot(msg);
			break;
		case 'cursor':
			p.lastCursor = msg;
			p.page = msg.page;
			this.updateCursor(p, true);
			this.followUpdate(p);
			break;
		case 'sel':
			p.page = msg.page;
			p.selIds = (Array.isArray(msg.ids) ? msg.ids : []).slice(0, 1000);
			this.updateSelection(p);
			break;
		case 'doing':
			p.doing = msg.doing;
			p.page = msg.page;
			p.pageName = msg.pageName;
			this.renderPresence();
			break;
		case 'view':
			p.view = msg;
			this.followUpdate(p);
			break;
		case 'comments':
			if (this.sc.comments != null) this.sc.comments.receive(msg.records, p);
			break;
	}
};

// Who is host: whoever has been in the session longest
LiveSession.prototype.electHost = function()
{
	if (!this.active) return;

	var best = {id: this.me.peerId, at: this.me.joinedAt};
	var consider = function(id, at)
	{
		if (at < best.at || (at == best.at && id < best.id)) best = {id: id, at: at};
	};

	this.readyPeers().forEach(function(p) { consider(p.id, p.joinedAt); });

	// Members my peers are connected to count even before I am: otherwise
	// a half-connected newcomer would pick the wrong host
	var now = Date.now();

	for (var id in (this.members || {}))
	{
		var m = this.members[id];

		if (now - m.heard < 6000 && (this.peers[id] == null || this.peers[id].ready))
		{
			consider(id, m.joinedAt);
		}
		else if (now - m.heard >= 6000)
		{
			delete this.members[id];
		}
	}

	var prev = this.hostId;
	this.hostId = best.id;

	if (prev == this.hostId) return;

	var unconfirmed = this.pending || [];
	this.pending = [];

	if (this.isHost())
	{
		if (prev != null && prev != this.me.peerId && this.peers[prev] == null)
		{
			this.sc.toast('You are now hosting the live session', 'info');
		}

		this.synced = true;

		// Our own edits that the old host never confirmed are ours to
		// order now: they are already in the editor
		this.confirmed = this.ui.clonePages(this.ui.pages);
		this.shadow = this.ui.clonePages(this.ui.pages);
		this.lastHashSent = null;

		var parked = this.parked || [];
		this.parked = [];

		for (var i = 0; i < parked.length; i++)
		{
			this.hostApply(parked[i].from, parked[i].diff, parked[i].pid);
		}

		if (unconfirmed.length > 0 && this.readyPeers().length > 0)
		{
			var self = this;

			unconfirmed.forEach(function(e)
			{
				self.appliedPids = self.appliedPids || {};
				self.appliedPids[e.pid] = true;
				self.lastSeq++;
				self.broadcast({t: 'op', seq: self.lastSeq, from: self.me.peerId, pid: e.pid, diff: e.diff});
			});
		}
	}
	else
	{
		// A new host: hands it anything it may have missed, or asks for
		// the diagram when we have never been in sync with anyone
		var host = this.peers[this.hostId];

		// Sends what is not out yet, resends what the old host never
		// confirmed, then takes the new host's diagram (which includes them)

		this.joinHost(unconfirmed);
	}

	this.renderPresence();
};

// Resends edits the host has not confirmed and asks for its diagram, which
// will include them (the host handles messages in order)
LiveSession.prototype.joinHost = function(unconfirmed)
{
	var host = this.peers[this.hostId];
	this.synced = false;
	this.pending = [];

	if (host == null || !host.ready)
	{
		// Known through a peer but not connected yet: keeps the edits for later
		this.waitingEdits = (this.waitingEdits || []).concat(unconfirmed);
		return;
	}

	var all = (this.waitingEdits || []).concat(unconfirmed);
	this.waitingEdits = [];
	var self = this;

	all.forEach(function(e) { self.sendTo(host, {t: 'propose', pid: e.pid, diff: e.diff}); });
	this.sendTo(host, {t: 'snapshot-req'});
};

// ---------------------------------------------------------------------------
// Edits

LiveSession.prototype.currentFile = function()
{
	var file = this.ui.getCurrentFile();
	return (file != null && file.fileObject != null && file.fileObject.path == this.path) ? file : null;
};

LiveSession.prototype.installEditorHooks = function()
{
	var self = this;
	var graph = this.graph;

	graph.model.addListener(mxEvent.CHANGE, function()
	{
		if (!self.active || self.applying) return;

		window.clearTimeout(self.flushThread);
		self.flushThread = window.setTimeout(function() { self.flushLocal(); }, 60);
	});

	// Cursor
	var lastSent = 0, pendingMove = null;

	graph.addMouseListener({
		mouseDown: function() {},
		mouseMove: function(sender, me)
		{
			if (!self.active || self.readyPeers().length == 0) return;

			pendingMove = me;
			var now = Date.now();

			if (now - lastSent > 50)
			{
				lastSent = now;
				self.sendCursor(pendingMove);
			}
			else if (self.cursorThread == null)
			{
				self.cursorThread = window.setTimeout(function()
				{
					self.cursorThread = null;
					lastSent = Date.now();
					self.sendCursor(pendingMove);
				}, 50);
			}
		},
		mouseUp: function(sender, me)
		{
			if (self.active) self.sendCursor(me);
		}
	});

	// Selection
	graph.getSelectionModel().addListener(mxEvent.CHANGE, function()
	{
		if (!self.active) return;

		window.clearTimeout(self.selThread);
		self.selThread = window.setTimeout(function() { self.sendSelection(); self.sendDoing(); }, 120);
	});

	// What I am doing
	graph.addListener(mxEvent.START_EDITING, function(sender, evt)
	{
		self.editingCell = evt.getProperty('cell');
		self.sendDoing();
	});

	graph.addListener(mxEvent.EDITING_STOPPED, function()
	{
		self.editingCell = null;
		self.sendDoing();
	});

	// Remote cursors follow scrolling, zoom and page changes
	var refresh = function()
	{
		for (var id in self.peers)
		{
			self.updateCursor(self.peers[id]);
		}
	};

	mxEvent.addListener(graph.container, 'scroll', refresh);
	graph.getView().addListener(mxEvent.SCALE, refresh);
	graph.getView().addListener(mxEvent.TRANSLATE, refresh);
	graph.getView().addListener(mxEvent.SCALE_AND_TRANSLATE, refresh);

	this.ui.editor.addListener('pageSelected', function()
	{
		refresh();

		for (var id in self.peers)
		{
			self.updateSelection(self.peers[id]);
		}

		self.sendDoing();
		self.renderPresence();
	});

	// Leaving is handled by the main process when the window navigates or
	// closes: beforeunload also fires for unloads that draw.io cancels
};

// Sends my latest edits
LiveSession.prototype.flushLocal = function()
{
	window.clearTimeout(this.flushThread);

	if (!this.active || this.applying || this.shadow == null || this.currentFile() == null) return;

	// While waiting for the host's diagram, edits stay in the editor and
	// are sent once in sync (see applySnapshot)
	if (!this.synced && !this.isHost() && this.readyPeers().length > 0) return;

	var diff = this.ui.diffPages(this.shadow, this.ui.pages);

	if (isEmptyDiff(diff)) return;

	this.shadow = this.ui.clonePages(this.ui.pages);

	if (this.readyPeers().length == 0 || this.isHost())
	{
		// Alone or host: our edit is the reference
		this.confirmed = this.ui.clonePages(this.ui.pages);

		if (this.isHost() && this.readyPeers().length > 0)
		{
			this.lastSeq++;
			this.broadcast({t: 'op', seq: this.lastSeq, from: this.me.peerId, diff: diff});
		}
	}
	else if (this.synced)
	{
		this.propose(diff);
	}
};

// Edits sent to the host that have not come back in its order yet
LiveSession.prototype.propose = function(diff)
{
	var pid = this.me.peerId + '-' + (this.proposalCounter = (this.proposalCounter || 0) + 1);
	this.pending = this.pending || [];
	this.pending.push({pid: pid, overtaken: false, diff: diff});
	this.sendTo(this.peers[this.hostId], {t: 'propose', pid: pid, diff: diff});
};

LiveSession.prototype.patchEditor = function(diff, author)
{
	var file = this.currentFile();

	if (file == null) return;

	var before = this.labelsFor(diff);
	this.applying = true;

	try
	{
		file.patch([cloneJson(diff)], null, false);
	}
	finally
	{
		this.applying = false;
	}

	this.shadow = this.ui.clonePages(this.ui.pages);

	// Everyone's copy holds the live result: marks it unsaved (and
	// autosaves it when enabled) so nothing is lost when people leave
	file.fileChanged();

	if (author != null)
	{
		this.showChange(diff, author, before);
	}
};

// Host: an edit proposed by a peer
LiveSession.prototype.hostApply = function(fromId, diff, pid)
{
	// Resent edits (after a host change) are applied once
	this.appliedPids = this.appliedPids || {};

	if (pid != null && this.appliedPids[pid]) return;

	if (pid != null) this.appliedPids[pid] = true;

	this.flushLocal();
	this.patchEditor(diff, this.peers[fromId] || {name: 'Someone', color: '#888', id: fromId});
	this.confirmed = this.ui.clonePages(this.ui.pages);
	this.lastSeq++;
	this.broadcast({t: 'op', seq: this.lastSeq, from: fromId, pid: pid, diff: diff});
};

// Peer: an edit in the host's order
LiveSession.prototype.clientApply = function(msg)
{
	if (!this.synced) return;

	if (msg.seq != this.lastSeq + 1)
	{
		this.requestResync('missed an edit');
		return;
	}

	this.lastSeq = msg.seq;
	this.confirmed = this.ui.patchPages(this.confirmed, cloneJson(msg.diff), true);
	this.pending = this.pending || [];

	if (msg.from != this.me.peerId)
	{
		// Sends anything of ours that is not out yet before applying theirs
		this.flushLocal();
		this.patchEditor(msg.diff, this.peers[msg.from] || {name: 'Someone', color: '#888', id: msg.from});

		// Our edits still in flight now come after this one in the host's
		// order: they must be applied again when they come back
		this.pending.forEach(function(e) { e.overtaken = true; });
	}
	else
	{
		var idx = -1;

		for (var i = 0; i < this.pending.length; i++)
		{
			if (this.pending[i].pid == msg.pid) idx = i;
		}

		var mine = (idx >= 0) ? this.pending.splice(idx, 1)[0] : null;

		if (mine != null && mine.overtaken)
		{
			this.flushLocal();
			this.patchEditor(msg.diff, null);
		}
	}
};

LiveSession.prototype.checkHash = function(msg)
{
	if (!this.synced || msg.seq != this.lastSeq) return;

	// Compares what is on screen when nothing of ours is in flight
	this.flushLocal();
	var idle = this.pending == null || this.pending.length == 0;
	var hash = this.ui.getHashValueForPages(idle ? this.ui.pages : this.confirmed);

	if (hash != msg.hash)
	{
		this.requestResync('checksum');
	}
};

LiveSession.prototype.requestResync = function(reason)
{
	var now = Date.now();

	// At most once every 5 seconds
	if (now - this.resyncAt < 5000) return;

	this.resyncAt = now;
	console.info('live: resync (' + reason + ')');
	var host = this.peers[this.hostId];
	var self = this;
	this.joinHost(this.pending || []);
};

LiveSession.prototype.sendSnapshot = function(p)
{
	this.flushLocal();
	this.sendTo(p, {t: 'snapshot', seq: this.lastSeq,
		xml: mxUtils.getXml(this.ui.getXmlFileData(null, null, true))});
};

// Makes the editor match the host's diagram while keeping my own edits
// that the host does not have yet
LiveSession.prototype.applySnapshot = function(msg)
{
	var file = this.currentFile();

	if (file == null) return;

	var hostPages = this.sc.merger.parse(msg.xml);
	// Edits not sent yet: since the last send, or unsaved edits on first join
	var base = this.everSynced ? this.shadow : file.getShadowPages();
	var pending = (base != null) ? this.ui.diffPages(base, this.ui.pages) : {};
	var toHost = this.ui.diffPages(this.ui.pages, hostPages);

	this.applying = true;

	try
	{
		if (!isEmptyDiff(toHost))
		{
			file.patch([toHost], null, false);
			file.fileChanged();
		}
	}
	finally
	{
		this.applying = false;
	}

	this.confirmed = this.sc.merger.parse(msg.xml);
	this.pending = [];
	this.lastSeq = msg.seq;
	this.synced = true;
	this.everSynced = true;
	this.shadow = this.ui.clonePages(this.ui.pages);

	if (!isEmptyDiff(pending))
	{
		this.applying = true;

		try
		{
			file.patch([cloneJson(pending)], null, false);
		}
		finally
		{
			this.applying = false;
		}

		this.shadow = this.ui.clonePages(this.ui.pages);
		this.propose(pending);
	}

	this.sendSelection();
	this.sendDoing();
	this.renderPresence();
};

// ---------------------------------------------------------------------------
// Presence: cursors, selections, what people are doing

LiveSession.prototype.sendCursor = function(me)
{
	var graph = this.graph;
	var offset = mxUtils.getOffset(graph.container);
	var tr = graph.view.translate;
	var s = graph.view.scale;

	this.broadcast({t: 'cursor', page: this.ui.currentPage ? this.ui.currentPage.getId() : null,
		x: Math.round((me.getX() - offset.x + graph.container.scrollLeft) / s - tr.x),
		y: Math.round((me.getY() - offset.y + graph.container.scrollTop) / s - tr.y)});
};

LiveSession.prototype.sendSelection = function()
{
	var cells = this.graph.getSelectionCells();
	this.broadcast({t: 'sel', page: this.ui.currentPage ? this.ui.currentPage.getId() : null,
		ids: cells.length > 200 ? [] : cells.map(function(c) { return c.id; })});
};

LiveSession.prototype.cellLabel = function(cell)
{
	try
	{
		var page = {getId: function() { return null; }};
		var v = this.graph.convertValueToString(cell);
		v = String(v || '');

		if (v.indexOf('<') >= 0)
		{
			v = new DOMParser().parseFromString(v, 'text/html').body.textContent || '';
		}

		v = v.replace(/\s+/g, ' ').trim();

		return v.length > 0 ? (v.length > 40 ? v.substring(0, 38) + '…' : v) : (cell.edge ? 'a connector' : 'a shape');
	}
	catch (e)
	{
		return 'a shape';
	}
};

LiveSession.prototype.sendDoing = function()
{
	var graph = this.graph;
	var doing = null;

	if (this.editingCell != null)
	{
		doing = 'editing text of “' + this.cellLabel(this.editingCell) + '”';
	}
	else if (graph.getSelectionCount() == 1)
	{
		doing = 'selected “' + this.cellLabel(graph.getSelectionCell()) + '”';
	}
	else if (graph.getSelectionCount() > 1)
	{
		doing = 'selected ' + graph.getSelectionCount() + ' shapes';
	}

	var page = this.ui.currentPage;
	this.broadcast({t: 'doing', doing: doing, page: page ? page.getId() : null, pageName: page ? page.getName() : null});
};

LiveSession.prototype.sendPresenceTo = function(p)
{
	var self = this;

	window.setTimeout(function()
	{
		self.sendSelection();
		self.sendDoing();
	}, 200);
};

LiveSession.prototype.onMyPage = function(p)
{
	return this.ui.currentPage == null || p.page == null || p.page == this.ui.currentPage.getId();
};

LiveSession.prototype.updateCursor = function(p, transition)
{
	var graph = this.graph;

	if (p.lastCursor == null) return;

	if (p.cursor == null)
	{
		var el = h('div', {class: 'dlive-cursor'},
			h('img', {src: Graph.createSvgImage(8, 12, '<path d="M 4 0 L 8 12 L 4 10 L 0 12 Z" stroke="' + p.color +
				'" fill="' + p.color + '"/>').src}),
			h('div', {class: 'dlive-cursor-name', style: {background: p.color}}, p.name));
		this.ui.diagramContainer.appendChild(el);
		p.cursor = el;
	}

	if (!this.onMyPage(p))
	{
		p.cursor.style.display = 'none';
		return;
	}

	var tr = graph.view.translate, s = graph.view.scale;
	var x = (tr.x + p.lastCursor.x) * s + 8;
	var y = (tr.y + p.lastCursor.y) * s - 12;
	var c = graph.container;
	var cx = Math.max(c.scrollLeft, Math.min(c.scrollLeft + c.clientWidth - 30, x));
	var cy = Math.max(c.scrollTop - 22, Math.min(c.scrollTop + c.clientHeight - 30, y));

	p.cursor.style.transition = transition ? 'left 120ms linear, top 120ms linear' : 'none';
	p.cursor.firstChild.style.opacity = (cx != x || cy != y) ? 0 : 1;
	p.cursor.style.left = cx + 'px';
	p.cursor.style.top = cy + 'px';
	p.cursor.style.display = '';
};

LiveSession.prototype.updateSelection = function(p)
{
	var graph = this.graph;

	for (var id in p.selection)
	{
		p.selection[id].destroy();
	}

	p.selection = {};

	if (!this.onMyPage(p) || p.selIds == null) return;

	for (var i = 0; i < p.selIds.length; i++)
	{
		var cell = graph.model.getCell(p.selIds[i]);
		var state = (cell != null) ? graph.view.getState(cell) : null;

		if (state != null)
		{
			var hl = new mxCellHighlight(graph, p.color, 3, false);
			hl.opacity = 70;
			hl.highlight(state);
			p.selection[p.selIds[i]] = hl;
		}
	}
};

LiveSession.prototype.clearPeerVisuals = function(p)
{
	if (p.cursor != null) p.cursor.remove();

	for (var id in p.selection)
	{
		p.selection[id].destroy();
	}

	p.selection = {};
};

// Names of the shapes a diff touches, read before it is applied (for removals)
LiveSession.prototype.labelsFor = function(diff)
{
	var result = {};
	var model = this.graph.model;
	var page = this.ui.currentPage;
	var upd = diff[EditorUi.DIFF_UPDATE] || {};

	if (page != null && upd[page.getId()] != null && upd[page.getId()].cells != null)
	{
		var cells = upd[page.getId()].cells;
		(cells[EditorUi.DIFF_REMOVE] || []).forEach(function(id)
		{
			var cell = model.getCell(id);
			if (cell != null) result[id] = cell;
		});
	}

	return result;
};

// Flashes what someone changed in their colour and logs it
LiveSession.prototype.showChange = function(diff, author, removedCells)
{
	var self = this;
	var graph = this.graph;
	var model = graph.model;
	var page = this.ui.currentPage;
	var pid = page ? page.getId() : null;
	var entries = [];
	var upd = diff[EditorUi.DIFF_UPDATE] || {};

	(diff[EditorUi.DIFF_INSERT] || []).forEach(function() { entries.push('added a page'); });
	(diff[EditorUi.DIFF_REMOVE] || []).forEach(function() { entries.push('deleted a page'); });

	for (var id in upd)
	{
		var pd = upd[id];
		var cells = pd.cells || {};
		var here = id == pid;

		if (pd.name != null) entries.push('renamed a page to “' + pd.name + '”');

		(cells[EditorUi.DIFF_INSERT] || []).forEach(function(c)
		{
			var cell = here ? model.getCell(c.id) : null;

			if (cell != null)
			{
				entries.push('added “' + self.cellLabel(cell) + '”');
				graph.highlightCell(cell, author.color, 1600, 80, 3);
			}
			else if (!here)
			{
				entries.push('added a shape on another page');
			}
		});

		(cells[EditorUi.DIFF_REMOVE] || []).forEach(function(cid)
		{
			var cell = removedCells[cid];
			entries.push('deleted ' + (cell ? '“' + self.cellLabel(cell) + '”' : 'a shape'));
		});

		for (var cid in (cells[EditorUi.DIFF_UPDATE] || {}))
		{
			var cell = here ? model.getCell(cid) : null;
			var keys = Object.keys(cells[EditorUi.DIFF_UPDATE][cid]);

			if (cell != null)
			{
				entries.push('changed ' + keys.map(DiagramMerge.keyLabel).join(', ') + ' of “' + self.cellLabel(cell) + '”');
				graph.highlightCell(cell, author.color, 1200, 80, 3);
			}
		}
	}

	// Collapses a burst of edits (eg. a drag) into the last entry
	if (entries.length > 0)
	{
		var text = entries.length > 3 ? entries.slice(0, 2).join(', ') + ' and ' + (entries.length - 2) + ' more changes' : entries.join(', ');
		var last = this.activity[0];

		if (last != null && last.who == author.name && last.text == text && Date.now() - last.at < 10000)
		{
			last.at = Date.now();
			last.count = (last.count || 1) + 1;
		}
		else
		{
			this.activity.unshift({who: author.name, email: author.email, color: author.color, text: text, at: Date.now()});
			this.activity = this.activity.slice(0, 40);
		}

		this.renderPresence();
	}
};

LiveSession.prototype.log = function(p, what)
{
	this.activity.unshift({who: p.name, email: p.email, color: p.color, text: what + ' the live session', at: Date.now()});
	this.activity = this.activity.slice(0, 40);
};

// Follow mode: keeps someone's cursor in view and switches to their page
LiveSession.prototype.follow = function(id)
{
	this.following = (this.following == id) ? null : id;

	var p = this.peers[id];

	if (this.following != null && p != null)
	{
		this.followUpdate(p, true);
		this.sc.toast('Following ' + p.name + '. Click their name again to stop.', 'info');
	}

	this.renderPresence();
};

LiveSession.prototype.followUpdate = function(p, force)
{
	if (this.following != p.id) return;

	var ui = this.ui;

	if (p.page != null && (ui.currentPage == null || ui.currentPage.getId() != p.page))
	{
		var page = ui.getPageById(p.page);

		if (page != null)
		{
			ui.selectPage(page);
		}
	}

	if (p.lastCursor != null)
	{
		var graph = this.graph;
		var c = graph.container;
		var tr = graph.view.translate, s = graph.view.scale;
		var x = (tr.x + p.lastCursor.x) * s, y = (tr.y + p.lastCursor.y) * s;
		var margin = 80;

		if (force || x < c.scrollLeft + margin || x > c.scrollLeft + c.clientWidth - margin ||
			y < c.scrollTop + margin || y > c.scrollTop + c.clientHeight - margin)
		{
			c.scrollLeft = x - c.clientWidth / 2;
			c.scrollTop = y - c.clientHeight / 2;
		}
	}
};

// ---------------------------------------------------------------------------
// UI: avatars next to the status pill and the Live section of the panel

LiveSession.prototype.renderPresence = function()
{
	var self = this;
	var bar = this.sc.liveBar;

	if (bar == null) return;

	bar.textContent = '';
	var ready = this.readyPeers();

	if (!this.active)
	{
		bar.style.display = 'none';
	}
	else
	{
		bar.style.display = '';
		bar.title = ready.length == 0 ? 'Live: waiting for teammates to open this diagram' :
			'Live with ' + ready.map(function(p) { return p.name; }).join(', ');
		bar.appendChild(h('span', {class: 'dlive-dot' + (ready.length > 0 ? ' dlive-on' : '')}));

		ready.sort(function(a, b) { return a.joinedAt - b.joinedAt; }).slice(0, 5).forEach(function(p)
		{
			var av = avatar(p.name, p.email, 24);
			av.style.boxShadow = '0 0 0 2px ' + p.color;
			av.classList.toggle('dlive-following', self.following == p.id);
			av.title = p.name + (p.id == self.hostId ? ' (host)' : '') + (p.doing ? ' · ' + p.doing : '') +
				(self.onMyPage(p) ? '' : ' · on ' + (p.pageName || 'another page')) + '\nClick to follow';
			av.addEventListener('click', function(e) { e.stopPropagation(); self.follow(p.id); });

			if (p.id == self.hostId)
			{
				av.appendChild(h('span', {class: 'dlive-crown'}, '★'));
			}

			bar.appendChild(av);
		});

		if (ready.length > 5)
		{
			bar.appendChild(h('span', {class: 'dgit-badge'}, '+' + (ready.length - 5)));
		}

		if (ready.length == 0)
		{
			bar.appendChild(h('span', {class: 'dlive-label'}, 'Live'));
		}
	}

	if (this.sc.panelVisible && Date.now() - (this.lastPanelRender || 0) > 300)
	{
		this.lastPanelRender = Date.now();
		this.sc.renderPanel();
	}
};

LiveSession.prototype.renderSection = function(body)
{
	var self = this;
	var box = h('div', {class: 'dgit-card dlive-card'});
	var ready = this.readyPeers();

	if (!prefs.live)
	{
		box.appendChild(h('div', {class: 'dgit-card-title'}, h('span', {class: 'dlive-dot'}), 'Live collaboration is off'));
		box.appendChild(h('div', {class: 'dgit-actions'}, h('button', {class: 'dgit-btn', onclick: function()
		{
			prefs.live = true;
			savePrefs();
			self.sc.updateLive();
		}}, 'Turn on')));
		body.appendChild(box);
		return;
	}

	if (!this.active)
	{
		var st = this.sc.status;
		box.appendChild(h('div', {class: 'dgit-card-title'}, h('span', {class: 'dlive-dot'}), 'Live'));
		box.appendChild(h('div', {class: 'dgit-sub'}, this.lastError ? this.lastError :
			(st && (st.initial || !st.tracked)) ? 'Commit this diagram to edit it live with your team.' : 'Connecting…'));
		body.appendChild(box);
		return;
	}

	var transports = [this.me.lan ? 'local network' : null, this.me.internet ? 'GitHub' : null,
		(this.me.relay && this.me.relay != 'none') ? 'relay server' : null].filter(Boolean).join(' + ');

	box.appendChild(h('div', {class: 'dgit-card-title'},
		h('span', {class: 'dlive-dot' + (ready.length > 0 ? ' dlive-on' : '')}),
		h('span', {class: 'dgit-grow'}, ready.length == 0 ? 'Live: just you' : 'Live with ' + ready.length + (ready.length == 1 ? ' person' : ' people')),
		h('span', {class: 'dgit-sub'}, this.isHost() ? (ready.length > 0 ? 'you are hosting' : '') : 'hosted by ' + (this.peers[this.hostId] ? this.peers[this.hostId].name : '…'))));

	if (ready.length == 0)
	{
		box.appendChild(h('div', {class: 'dgit-sub'}, 'Anyone who opens this diagram from the repository joins you here and edits with you in real time. Looking for teammates via ' + transports + '.'));
	}

	ready.sort(function(a, b) { return a.joinedAt - b.joinedAt; }).forEach(function(p)
	{
		box.appendChild(h('div', {class: 'dlive-person'},
			avatar(p.name, p.email, 24),
			h('div', {class: 'dgit-grow'},
				h('div', null, h('b', null, p.name), p.id == self.hostId ? h('span', {class: 'dgit-sub'}, ' · host') : null),
				h('div', {class: 'dgit-sub'}, (p.doing || 'viewing') + (self.onMyPage(p) ? '' : ' on ' + (p.pageName || 'another page'))),
				h('div', {class: 'dgit-sub dlive-route'}, self.routeText(p))),
			h('span', {class: 'dlive-swatch', style: {background: p.color}}),
			h('button', {class: 'dgit-link', onclick: function() { self.follow(p.id); }}, self.following == p.id ? 'Unfollow' : 'Follow')));
	});

	var connecting = Object.keys(this.peers).map(function(id) { return self.peers[id]; }).filter(function(p) { return !p.ready; });

	if (connecting.length > 0)
	{
		box.appendChild(h('div', {class: 'dgit-sub'}, 'Connecting to ' + connecting.map(function(p) { return p.name; }).join(', ') + '…' +
			(connecting.some(function(p) { return (self.failures || {})[p.id] >= 1; }) ? ' (no direct connection yet; trying through teammates)' : '')));
	}

	if (this.me.relayError)
	{
		box.appendChild(h('div', {class: 'dgit-warn'}, 'The relay server in .drawio/live.json could not be used (' + this.me.relayError +
			'). People on strict networks may not be able to connect.'));
	}

	if (this.transportProblem != null)
	{
		var why = {
			'no-write': 'You don’t have write access to the GitHub repository, so teammates who aren’t on your network can’t find you. Ask an admin for write access.',
			'auth': 'Git couldn’t sign in to GitHub, so teammates who aren’t on your network can’t find you. In Terminal run “gh auth login” and “gh auth setup-git”.',
			'network': 'GitHub can’t be reached right now. Teammates on your network can still join.'
		}[this.transportProblem.kind] || ('Finding teammates through GitHub failed: ' + this.transportProblem.message);
		box.appendChild(h('div', {class: 'dgit-warn'}, why));
	}

	var host = this.peers[this.hostId];

	if (host != null && host.blob != this.me.blob)
	{
		box.appendChild(h('div', {class: 'dgit-warn'}, host.name + ' (host) has a different committed version of this diagram than you. ' +
			'You are seeing their version with everyone\'s live edits. Pull (or ask them to pull) before committing so nobody\'s commits are reverted.'));
	}

	if (this.activity.length > 0)
	{
		var feed = h('div', {class: 'dlive-feed'});

		this.activity.slice(0, 8).forEach(function(a)
		{
			feed.appendChild(h('div', {class: 'dlive-feed-row'},
				h('span', {class: 'dlive-swatch', style: {background: a.color}}),
				h('span', {class: 'dgit-grow'}, h('b', null, a.who), ' ' + a.text + (a.count > 1 ? ' (×' + a.count + ')' : '')),
				h('span', {class: 'dgit-sub'}, ago(a.at))));
		});

		box.appendChild(feed);
	}

	box.appendChild(h('div', {class: 'dgit-actions'},
		h('button', {class: 'dgit-btn dgit-primary', onclick: function() { self.sc.shareDialog(); }}, 'Share'),
		h('button', {class: 'dgit-btn', onclick: function() { self.sc.showComments(); }}, '💬 Comments'),
		h('span', {class: 'dgit-grow'}),
		h('span', {class: 'dgit-sub'}, 'via ' + transports)));

	body.appendChild(box);
};

// ---------------------------------------------------------------------------
// Comments: draw.io's comments window backed by <diagram>.comments.jsonl

function LiveComments(sc)
{
	this.sc = sc;
	this.ui = sc.ui;
	this.records = {};
	this.path = null;
	this.install();
}

LiveComments.prototype.install = function()
{
	var self = this;
	var ui = this.ui;

	// Comments for any local diagram that is saved in a folder
	LocalFile.prototype.commentsSupported = function()
	{
		return this.fileObject != null && this.fileObject.path != null && prefs.comments !== false;
	};

	LocalFile.prototype.anchoredCommentsSupported = function() { return true; };
	LocalFile.prototype.commentsRefreshNeeded = function() { return true; };
	LocalFile.prototype.commentsSaveNeeded = function() { return false; };
	LocalFile.prototype.canComment = function() { return true; };
	LocalFile.prototype.canReplyToReplies = function() { return false; };

	LocalFile.prototype.getCurrentUser = function()
	{
		var st = self.sc.status || {};
		var name = st.userName || 'Me';
		var email = st.userEmail || '';

		return new DrawioUser(email || name, email, name);
	};

	LocalFile.prototype.newComment = function(content, user)
	{
		return new LiveComment(this, null, content, Date.now(), Date.now(), false, user);
	};

	LocalFile.prototype.getComments = function(success, error)
	{
		var file = this;

		self.load(file.fileObject.path).then(function()
		{
			success(self.toComments(file));
		}, error);
	};

	LocalFile.prototype.addComment = function(comment, success, error)
	{
		var id = self.newId();
		comment.id = id;

		self.save([self.recordFor(comment, null)]).then(function() { success(id); }, error);
	};
};

LiveComments.prototype.newId = function()
{
	return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
};

LiveComments.prototype.recordFor = function(c, parentId)
{
	var u = c.user || {};

	return {id: c.id, parent: parentId || undefined, content: c.content, created: c.createdDate || Date.now(),
		modified: Date.now(), resolved: !!c.isResolved,
		user: {id: u.id || u.email || u.displayName, name: u.displayName, email: u.email},
		anchor: c.anchor || undefined};
};

LiveComments.prototype.load = function(path)
{
	var self = this;

	if (this.path == path && this.loaded) return Promise.resolve();

	// Comments that arrive while reading are kept: the file is merged into
	// what is in memory, which is only cleared for another diagram
	if (this.path != path)
	{
		this.path = path;
		this.records = {};
	}

	return live('commentsRead', {path: path}).then(function(text)
	{
		if (self.path != path) return;

		self.ingest(String(text || '').split('\n').map(function(line)
		{
			try { return line.trim().length > 0 ? JSON.parse(line) : null; } catch (e) { return null; }
		}).filter(Boolean));
		self.loaded = true;
	});
};

// Keeps the newest version of each comment; returns the records that were new
LiveComments.prototype.ingest = function(records)
{
	var fresh = [];

	for (var i = 0; i < records.length; i++)
	{
		var r = records[i];

		if (r == null || typeof r.id !== 'string') continue;

		var cur = this.records[r.id];

		if (cur == null || (r.modified || 0) > (cur.modified || 0))
		{
			this.records[r.id] = r;
			fresh.push(r);
		}
	}

	return fresh;
};

LiveComments.prototype.save = function(records)
{
	var self = this;
	var path = this.sc.filePath;

	this.ensurePath();
	this.ingest(records);

	return live('commentsAppend', {path: path, records: records}).then(function()
	{
		if (self.sc.live != null && self.sc.live.active)
		{
			self.sc.live.broadcast({t: 'comments', records: records});
		}

		self.ui.refreshCommentCache();
	});
};

// Ties the in-memory comments to the open diagram
LiveComments.prototype.ensurePath = function()
{
	if (this.path != this.sc.filePath)
	{
		this.path = this.sc.filePath;
		this.records = {};
		this.loaded = false;
	}
};

LiveComments.prototype.receive = function(records, from)
{
	var self = this;

	if (!Array.isArray(records) || this.sc.filePath == null) return;

	this.ensurePath();

	var known = {};

	for (var id in this.records) known[id] = true;

	var fresh = this.ingest(records.slice(0, 500));

	if (fresh.length == 0) return;

	live('commentsAppend', {path: this.sc.filePath, records: fresh}).catch(function() {});
	this.ui.refreshCommentCache();

	// Only new comments and replies are announced, not edits or resolving
	var added = fresh.filter(function(r) { return !known[r.id] && !r.deleted; });

	if (added.length > 0 && from != null)
	{
		var r = added[0];
		var who = (r.user && r.user.name) || from.name;
		this.sc.toast(who + (r.parent ? ' replied: “' : ' commented: “') + String(r.content || '').substring(0, 80) + '”', 'incoming',
			[{label: 'Open comments', action: function() { self.sc.showComments(); }}], 8000);
	}
};

LiveComments.prototype.toComments = function(file)
{
	var top = [], byParent = {};

	for (var id in this.records)
	{
		var r = this.records[id];

		if (r.deleted) continue;

		var c = new LiveComment(file, r.id, r.content, r.modified, r.created, !!r.resolved,
			new DrawioUser(r.user && r.user.id, r.user && r.user.email, (r.user && r.user.name) || 'Someone'), r.parent || null);
		c.anchor = r.anchor || null;

		if (r.parent)
		{
			(byParent[r.parent] = byParent[r.parent] || []).push(c);
		}
		else
		{
			top.push(c);
		}
	}

	top.forEach(function(c)
	{
		(byParent[c.id] || []).sort(function(a, b) { return a.createdDate - b.createdDate; }).forEach(function(r)
		{
			c.addReplyDirect(r);
		});
	});

	return top.sort(function(a, b) { return a.createdDate - b.createdDate; });
};

function LiveComment(file, id, content, modifiedDate, createdDate, isResolved, user, parentId)
{
	DrawioComment.call(this, file, id, content, modifiedDate, createdDate, isResolved, user);
	this.parentId = parentId || null;
}

mxUtils.extend(LiveComment, DrawioComment);

LiveComment.prototype.addReply = function(reply, success, error, doResolve, doReopen)
{
	var store = window.__drawioGit.comments;
	reply.id = store.newId();
	var records = [store.recordFor(reply, this.id)];

	if (doResolve || doReopen)
	{
		var me = store.records[this.id];

		if (me != null)
		{
			var upd = Object.assign({}, me, {resolved: !!doResolve, modified: Date.now()});
			records.push(upd);
		}
	}

	store.save(records).then(function() { success(reply.id); }, error);
};

LiveComment.prototype.editComment = function(newContent, success, error)
{
	var store = window.__drawioGit.comments;
	var cur = store.records[this.id];
	this.content = newContent;

	if (cur == null) return success();

	store.save([Object.assign({}, cur, {content: newContent, modified: Date.now()})]).then(function() { success(); }, error);
};

LiveComment.prototype.deleteComment = function(success, error)
{
	var store = window.__drawioGit.comments;
	var cur = store.records[this.id];

	if (cur == null) return success();

	store.save([{id: this.id, parent: cur.parent, deleted: true, modified: Date.now()}]).then(function() { success(); }, error);
};

// ---------------------------------------------------------------------------
// Wiring into the source control panel

function initLive(sc)
{
	if (prefs.live == null) prefs.live = true;

	var bar = h('div', {class: 'dlive-bar', style: {display: 'none'},
		onclick: function() { sc.setPanelVisible(true); }});
	sc.dock.insertBefore(bar, sc.dock.firstChild);
	sc.liveBar = bar;

	sc.comments = new LiveComments(sc);
	sc.live = new LiveSession(sc);

	electron.registerMsgListener('live-peer', function(info) { if (sc.live) sc.live.onPeerSeen(info); });
	electron.registerMsgListener('live-signal', function(msg) { if (sc.live) sc.live.onSignal(msg); });
	electron.registerMsgListener('live-peer-gone', function(msg) { if (sc.live && msg) sc.live.onPeerGone(msg.peer); });
	electron.registerMsgListener('live-transport', function(msg)
	{
		if (sc.live && msg)
		{
			sc.live.transportProblem = msg.ok ? null : {kind: msg.kind, message: msg.error};
			sc.live.renderPresence();
		}
	});

	sc.showComments = function()
	{
		var action = sc.ui.actions.get('comments');

		// The comments window would sit under the panel
		sc.setPanelVisible(false);

		if (action != null)
		{
			action.funct();
		}
	};

	// Starts or stops the session when the file, its status or the setting changes
	sc.updateLive = function()
	{
		var s = sc.live;
		var st = sc.status;
		var want = prefs.live && sc.filePath != null && st != null && st.isRepo && !st.initial && st.tracked;

		// Another diagram or another branch is another session
		if (s.active && (!want || s.path != sc.filePath || (s.me != null && st != null && st.branch != s.me.branch)))
		{
			s.stop().then(function() { if (want) s.start(); });
		}
		else if (!s.active && want)
		{
			s.start();
		}

		if (sc.comments.path != sc.filePath)
		{
			sc.comments.loaded = false;
		}

		s.renderPresence();
	};

	sc.updateLive();
}
