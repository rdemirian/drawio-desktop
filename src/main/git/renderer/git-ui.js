// GitHub source control panel for draw.io desktop. Injected into the main
// world of each editor window by src/main/git/index.js (the bundle wrapper
// defines `css`). Talks to the main process through window.electron.
//
// Untrusted text (commit messages, author names, branch names, labels from
// diagrams) is only ever assigned through textContent.

if (window.__drawioGitLoaded || typeof EditorUi === 'undefined' || urlParams['chrome'] == '0' ||
	urlParams['lightbox'] == '1' || typeof electron === 'undefined')
{
	return;
}

window.__drawioGitLoaded = true;

var PREFS_KEY = '.drawio-git-prefs';

function loadPrefs()
{
	try
	{
		return Object.assign({autoPull: false, notify: true, panelOpen: false},
			JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
	}
	catch (e)
	{
		return {autoPull: false, notify: true, panelOpen: false};
	}
}

var prefs = loadPrefs();

function savePrefs()
{
	try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Helpers

function git(op, args)
{
	return new Promise(function(resolve, reject)
	{
		electron.request({action: 'git', op: op, args: args || {}}, resolve, function(msg, e)
		{
			var err = new Error(msg || 'Unknown error');
			err.kind = (e != null && e.kind) ? e.kind : 'unknown';
			reject(err);
		});
	});
}

function h(tag, attrs)
{
	var el = document.createElement(tag);

	if (attrs != null)
	{
		for (var k in attrs)
		{
			var v = attrs[k];

			if (v == null || v === false) continue;

			if (k == 'class') el.className = v;
			else if (k == 'text') el.textContent = v;
			else if (k == 'style' && typeof v === 'object') Object.assign(el.style, v);
			else if (k.substring(0, 2) == 'on') el.addEventListener(k.substring(2), v);
			else el.setAttribute(k, v === true ? '' : v);
		}
	}

	for (var i = 2; i < arguments.length; i++)
	{
		var c = arguments[i];

		if (c == null || c === false) continue;

		if (Array.isArray(c))
		{
			c.forEach(function(cc) { if (cc != null && cc !== false) el.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc); });
		}
		else
		{
			el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
		}
	}

	return el;
}

function ago(ms)
{
	if (ms == null) return '';

	var s = Math.round((Date.now() - ms) / 1000);

	if (s < 45) return 'just now';
	if (s < 90) return '1 min ago';
	if (s < 3600) return Math.round(s / 60) + ' min ago';
	if (s < 5400) return '1 hour ago';
	if (s < 86400) return Math.round(s / 3600) + ' hours ago';
	if (s < 172800) return 'yesterday';
	if (s < 30 * 86400) return Math.round(s / 86400) + ' days ago';

	return new Date(ms).toLocaleDateString();
}

function basename(p)
{
	return String(p || '').replace(/^.*[\\\/]/, '');
}

function hashColor(str)
{
	var h = 0;
	str = String(str || '');

	for (var i = 0; i < str.length; i++)
	{
		h = (h * 31 + str.charCodeAt(i)) | 0;
	}

	return 'hsl(' + (Math.abs(h) % 360) + ', 55%, 48%)';
}

function avatar(name, email, size)
{
	size = size || 22;
	var initials = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).
		map(function(s) { return s.charAt(0).toUpperCase(); }).join('') || '?';
	var el = h('span', {class: 'dgit-avatar', title: name + (email ? ' <' + email + '>' : ''),
		style: {width: size + 'px', height: size + 'px', lineHeight: size + 'px', background: hashColor(email || name),
			fontSize: Math.round(size * 0.42) + 'px'}}, initials);

	// GitHub noreply addresses carry the user id: show the real avatar
	var m = String(email || '').match(/^(\d+)\+[^@]+@users\.noreply\.github\.com$/i);

	if (m != null)
	{
		var img = h('img', {src: 'https://avatars.githubusercontent.com/u/' + m[1] + '?s=' + (size * 2), alt: ''});
		img.onerror = function() { img.remove(); };
		el.appendChild(img);
	}

	return el;
}

function explain(err)
{
	var kind = err && err.kind;
	var msg = err && err.message ? err.message : String(err);

	switch (kind)
	{
		case 'auth': return 'GitHub did not accept your credentials. In Terminal run “gh auth login” and then “gh auth setup-git”, then try again.';
		case 'network': return 'Could not reach GitHub. Check your internet connection and try again.';
		case 'rejected': return 'Someone pushed changes before you. Pull their changes first, then push again.';
		case 'dirty': return 'Other files in this repository have uncommitted changes that the update would overwrite. Commit or discard them first.\n\n' + msg;
		case 'locked': return 'Another git process is using this repository. Wait a moment and try again.';
		case 'identity': return 'Git needs your name and email before it can commit.';
		case 'no-git': return msg;
		case 'no-gh': return msg;
		default: return msg;
	}
}

// ---------------------------------------------------------------------------
// Captures the EditorUi instance: there is no global reference to it, so the
// next windowResized call (triggered right away) hands it over.

function captureUi(callback)
{
	var orig = EditorUi.prototype.windowResized;
	var done = false;

	EditorUi.prototype.windowResized = function()
	{
		if (!done && this.editor != null && this.editor.graph != null && typeof this.getCurrentFile === 'function' &&
			this.container == document.body)
		{
			done = true;
			EditorUi.prototype.windowResized = orig;
			window.setTimeout(callback.bind(null, this), 0);
		}

		return orig.apply(this, arguments);
	};

	window.dispatchEvent(new Event('resize'));

	window.setTimeout(function()
	{
		if (!done) window.dispatchEvent(new Event('resize'));
	}, 1500);
}

// ---------------------------------------------------------------------------

function SourceControl(ui)
{
	this.ui = ui;
	this.merger = new DiagramMerge(ui);
	this.filePath = null;
	this.status = null;
	this.activity = null;
	this.history = null;
	this.busy = null;
	this.seenIncoming = {};
	this.pendingMerge = null;

	var style = document.createElement('style');
	style.textContent = css;
	document.head.appendChild(style);

	this.createPill();
	this.createPanel();
	this.installMenu();
	this.installListeners();
	this.track();

	if (prefs.panelOpen)
	{
		this.setPanelVisible(true);
	}
}

SourceControl.prototype.isDark = function()
{
	try { return Editor.isDarkMode(); } catch (e) { return false; }
};

SourceControl.prototype.applyTheme = function()
{
	var dark = this.isDark();
	[this.pill, this.panel, this.liveBar].concat(Array.from(document.querySelectorAll('.dgit-modal'))).forEach(function(el)
	{
		if (el != null) el.classList.toggle('dgit-dark', dark);
	});
};

SourceControl.prototype.installListeners = function()
{
	var self = this;

	electron.registerMsgListener('git-activity', function(msg)
	{
		if (msg != null && msg.path == self.filePath)
		{
			self.onActivity(msg.activity);
		}
	});

	electron.registerMsgListener('git-changed', function(msg)
	{
		if (msg != null && msg.path == self.filePath && self.busy == null)
		{
			self.refresh();
		}
	});

	this.ui.addListener('darkModeChanged', function() { self.applyTheme(); });

	document.addEventListener('keydown', function(e)
	{
		// Cmd/Ctrl+Shift+G toggles the panel
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key == 'g' || e.key == 'G'))
		{
			e.preventDefault();
			e.stopPropagation();
			self.setPanelVisible(!self.panelVisible);
		}
	}, true);

	window.addEventListener('focus', function()
	{
		if (self.filePath != null && self.busy == null) self.refresh();
	});
};

// Follows the current file and its saves
SourceControl.prototype.track = function()
{
	var self = this;
	var lastMtime = null;
	var lastModified = null;

	window.setInterval(function()
	{
		var file = self.ui.getCurrentFile();
		var p = (file != null && file.fileObject != null) ? file.fileObject.path : null;

		if (p != self.filePath)
		{
			self.filePath = p;
			self.status = null;
			self.activity = null;
			self.history = null;
			self.seenIncoming = {};
			lastMtime = null;
			self.render();

			if (p != null)
			{
				git('watch', {path: p}).catch(function() {});
				self.refresh(true);
			}
			else
			{
				git('unwatch').catch(function() {});
			}

			if (self.updateLive != null) self.updateLive();
		}
		else if (file != null && p != null)
		{
			var mtime = (file.stat != null) ? file.stat.mtimeMs : null;
			var modified = file.isModified();

			// Saved since the last check
			if (mtime != lastMtime && lastMtime != null && self.busy == null)
			{
				self.refresh();
			}
			else if (modified != lastModified)
			{
				self.renderPill();
				if (self.panelVisible) self.renderPanel();
			}

			lastMtime = mtime;
			lastModified = modified;
		}
	}, 1000);
};

SourceControl.prototype.refresh = function(withHistory)
{
	var self = this;
	var p = this.filePath;

	if (p == null) return Promise.resolve();

	return git('status', {path: p}).then(function(st)
	{
		if (p != self.filePath) return;

		var headChanged = self.status != null && self.status.head != null && st.head != null &&
			self.status.head.hash != st.head.hash;
		self.status = st;
		self.render();

		if (self.updateLive != null)
		{
			self.updateLive();

			if (headChanged && self.live != null && self.live.active)
			{
				live('update', {path: p}).then(function(r) { if (self.live.me) self.live.me.blob = r.blob; }).catch(function() {});
			}
		}

		if (st.isRepo)
		{
			git('activity', {path: p}).then(function(a)
			{
				if (p == self.filePath && a != null) self.onActivity(a, true);
			}).catch(function() {});

			if (withHistory || self.panelVisible)
			{
				self.loadHistory();
			}
		}
	}).catch(function(e)
	{
		self.status = {error: explain(e)};
		self.render();
	});
};

SourceControl.prototype.loadHistory = function()
{
	var self = this;
	var p = this.filePath;

	return git('history', {path: p, limit: 100}).then(function(list)
	{
		if (p == self.filePath)
		{
			self.history = list;
			if (self.panelVisible) self.renderPanel();
		}
	}).catch(function() {});
};

SourceControl.prototype.onActivity = function(a, quiet)
{
	var self = this;
	var prev = this.activity;
	this.activity = a;

	// Keeps ahead/behind in sync with the latest fetch
	if (this.status != null && this.status.isRepo && a.upstream != null)
	{
		this.status.behind = a.incoming.length;
		this.status.ahead = a.outgoing.length;
	}

	var fresh = (a.incomingFile || []).filter(function(c) { return !self.seenIncoming[c.hash]; });
	(a.incomingFile || []).forEach(function(c) { self.seenIncoming[c.hash] = true; });

	if (fresh.length > 0 && (prev != null || !quiet))
	{
		this.notifyIncoming(fresh);
	}

	this.render();
};

SourceControl.prototype.notifyIncoming = function(commits)
{
	var self = this;
	var authors = [];

	commits.forEach(function(c) { if (authors.indexOf(c.author) < 0) authors.push(c.author); });

	var who = authors.length == 1 ? authors[0] : authors.slice(0, -1).join(', ') + ' and ' + authors[authors.length - 1];
	var text = who + ' pushed ' + (commits.length == 1 ? 'a change' : commits.length + ' changes') +
		' to ' + basename(this.filePath);
	var file = this.ui.getCurrentFile();
	var canAuto = prefs.autoPull && file != null && !file.isModified() &&
		this.status != null && this.status.fileState == 'clean' && !this.status.merging;

	if (canAuto)
	{
		this.pull({auto: true}).then(function(ok)
		{
			if (ok) self.toast('Merged: ' + text, 'info');
		});
	}
	else
	{
		this.toast(text, 'incoming', [
			{label: 'Preview', action: function() { self.previewIncoming(); }},
			{label: 'Pull', primary: true, action: function() { self.pull(); }}
		], 15000);
	}

	if (prefs.notify && !document.hasFocus())
	{
		try
		{
			var n = new Notification('draw.io: ' + basename(this.filePath), {body: text + '\n“' + commits[0].subject + '”', silent: false});
			n.onclick = function() { window.focus(); self.setPanelVisible(true); };
		}
		catch (e)
		{
			// ignore
		}
	}
};

// ---------------------------------------------------------------------------
// Pill (always visible status)

SourceControl.prototype.createPill = function()
{
	var self = this;
	this.dock = h('div', {class: 'dgit-dock'});
	this.pill = h('div', {class: 'dgit-pill', title: 'Source control (⇧⌘G)',
		onclick: function() { self.setPanelVisible(!self.panelVisible); }});
	this.dock.appendChild(this.pill);
	document.body.appendChild(this.dock);
	this.applyTheme();
};

SourceControl.prototype.render = function()
{
	this.renderPill();

	if (this.panelVisible)
	{
		this.renderPanel();
	}
};

SourceControl.prototype.renderPill = function()
{
	var st = this.status;
	var pill = this.pill;
	pill.textContent = '';
	pill.className = 'dgit-pill';

	if (this.filePath == null || st == null || st.error != null)
	{
		pill.style.display = (this.filePath == null) ? 'none' : '';
		pill.appendChild(h('span', {class: 'dgit-icon'}, '⎇'));
		pill.appendChild(h('span', null, st && st.error ? 'Git error' : 'Source control'));
		this.applyTheme();
		return;
	}

	pill.style.display = '';

	if (!st.isRepo)
	{
		pill.appendChild(h('span', {class: 'dgit-icon'}, '⎇'));
		pill.appendChild(h('span', null, 'Not versioned'));
		pill.classList.add('dgit-muted');
	}
	else
	{
		var file = this.ui.getCurrentFile();
		var unsaved = file != null && file.isModified();
		var incomingFile = this.activity ? this.activity.incomingFile.length : 0;

		pill.appendChild(h('span', {class: 'dgit-icon'}, '⎇'));
		pill.appendChild(h('span', {class: 'dgit-branch'}, st.branch || (st.detached ? 'detached' : '?')));

		if (st.conflicts.length > 0 || this.pendingMerge != null)
		{
			pill.classList.add('dgit-alert');
			pill.appendChild(h('span', {class: 'dgit-badge dgit-badge-red'}, 'Conflicts'));
		}
		else
		{
			if (st.fileState != 'clean' || unsaved)
			{
				pill.appendChild(h('span', {class: 'dgit-dot', title: unsaved ? 'Unsaved changes' : 'Uncommitted changes'}));
			}

			if (st.behind > 0)
			{
				pill.appendChild(h('span', {class: 'dgit-badge' + (incomingFile > 0 ? ' dgit-badge-blue' : ''),
					title: st.behind + ' incoming commits'}, '↓' + st.behind));
			}

			if (st.ahead > 0)
			{
				pill.appendChild(h('span', {class: 'dgit-badge', title: st.ahead + ' commits to push'}, '↑' + st.ahead));
			}

			if (incomingFile > 0)
			{
				pill.classList.add('dgit-incoming');
			}
		}

		if (this.busy != null)
		{
			pill.appendChild(h('span', {class: 'dgit-spinner'}));
		}
	}

	this.applyTheme();
};

// ---------------------------------------------------------------------------
// Panel

SourceControl.prototype.createPanel = function()
{
	var self = this;
	this.panel = h('div', {class: 'dgit-panel', style: {display: 'none'}});
	this.panelBody = h('div', {class: 'dgit-body'});
	this.panelHeader = h('div', {class: 'dgit-header'});
	this.panel.appendChild(this.panelHeader);
	this.panel.appendChild(this.panelBody);
	document.body.appendChild(this.panel);

	// Keeps keystrokes in the panel away from the diagram shortcuts
	['keydown', 'keypress', 'keyup'].forEach(function(evt)
	{
		self.panel.addEventListener(evt, function(e) { e.stopPropagation(); });
	});
};

SourceControl.prototype.setPanelVisible = function(visible)
{
	this.panelVisible = visible;
	prefs.panelOpen = visible;
	savePrefs();
	this.panel.style.display = visible ? '' : 'none';
	this.pill.classList.toggle('dgit-pill-open', visible);

	if (visible)
	{
		this.renderPanel();

		if (this.filePath != null)
		{
			this.refresh(true);
		}
	}
};

SourceControl.prototype.renderPanel = function()
{
	var self = this;
	var st = this.status;
	var head = this.panelHeader;
	var body = this.panelBody;
	var scroll = body.scrollTop;

	// The commit message survives re-renders through draftMessage, which
	// the textarea's input listener keeps up to date
	head.textContent = '';
	body.textContent = '';

	head.appendChild(h('div', {class: 'dgit-title'},
		h('span', {class: 'dgit-icon'}, '⎇'),
		h('span', null, st && st.isRepo ? st.repoName : 'Source Control')));

	var actions = h('div', {class: 'dgit-head-actions'});

	if (st && st.isRepo)
	{
		actions.appendChild(h('button', {class: 'dgit-icon-btn', title: 'Check for changes on GitHub',
			onclick: function() { self.fetchNow(); }}, '↻'));
	}

	actions.appendChild(h('button', {class: 'dgit-icon-btn', title: 'Close (⇧⌘G)',
		onclick: function() { self.setPanelVisible(false); }}, '✕'));
	head.appendChild(actions);

	if (this.filePath == null)
	{
		var file = this.ui.getCurrentFile();
		body.appendChild(h('div', {class: 'dgit-empty'},
			h('p', null, file != null ? 'Save this diagram to a folder to put it under version control.' :
				'Open a diagram to see its version history.'),
			h('button', {class: 'dgit-btn', onclick: function() { self.cloneDialog(); }}, 'Clone a GitHub repository…'),
			h('div', {class: 'dgit-or'}, 'or'),
			h('button', {class: 'dgit-btn', onclick: function() { self.openLinkDialog(); }}, 'Open a shared link…')));
		return;
	}

	if (st == null)
	{
		body.appendChild(h('div', {class: 'dgit-empty'}, h('span', {class: 'dgit-spinner'}), ' Loading…'));
		return;
	}

	if (st.error != null)
	{
		body.appendChild(h('div', {class: 'dgit-error'}, st.error));
		return;
	}

	if (!st.isRepo)
	{
		this.renderNotRepo(body, st);
		return;
	}

	// Branch row
	var branchRow = h('div', {class: 'dgit-row dgit-branch-row'},
		h('button', {class: 'dgit-branch-btn', title: 'Switch branch', onclick: function(e) { self.branchMenu(e.currentTarget); }},
			h('span', {class: 'dgit-icon'}, '⎇'), h('span', null, st.branch || 'detached HEAD'), h('span', {class: 'dgit-caret'}, '▾')),
		h('span', {class: 'dgit-sub'}, st.upstream ? '⇄ ' + st.upstream : (st.remoteUrl ? 'not pushed yet' : 'local only')));
	body.appendChild(branchRow);

	if (this.activity != null && this.activity.fetchError != null)
	{
		body.appendChild(h('div', {class: 'dgit-warn'}, 'Could not check GitHub: ' + explain(this.activity.fetchError)));
	}
	else if (st.lastFetch != null)
	{
		body.appendChild(h('div', {class: 'dgit-sub dgit-pad'}, 'Checked GitHub ' + ago(this.activity && this.activity.checkedAt || st.lastFetch)));
	}

	if (st.userName == null || st.userEmail == null)
	{
		this.renderIdentity(body, st);
	}

	if (this.live != null)
	{
		this.live.renderSection(body);
	}

	// Conflicts
	if (st.conflicts.length > 0 || st.merging)
	{
		this.renderConflicts(body, st);
	}

	// Incoming
	var a = this.activity;

	if (a != null && a.incoming.length > 0)
	{
		var touchFile = a.incomingFile.length;
		var box = h('div', {class: 'dgit-card dgit-card-blue'});
		var authors = [];
		(touchFile > 0 ? a.incomingFile : a.incoming).forEach(function(c) { if (authors.indexOf(c.author) < 0) authors.push(c.author); });

		box.appendChild(h('div', {class: 'dgit-card-title'},
			h('span', {class: 'dgit-avatars'}, authors.slice(0, 4).map(function(name)
			{
				var c = a.incoming.find(function(c) { return c.author == name; });
				return avatar(name, c && c.email, 20);
			})),
			h('span', null, touchFile > 0 ?
				authors.join(', ') + ' changed this diagram' :
				a.incoming.length + ' new commit' + (a.incoming.length == 1 ? '' : 's') + ' on ' + a.upstream)));

		var list = h('ul', {class: 'dgit-mini-list'});
		(touchFile > 0 ? a.incomingFile : a.incoming).slice(0, 4).forEach(function(c)
		{
			list.appendChild(h('li', null, h('b', null, c.author), ' ', c.subject, h('span', {class: 'dgit-sub'}, ' · ' + ago(c.date))));
		});
		box.appendChild(list);

		box.appendChild(h('div', {class: 'dgit-actions'},
			touchFile > 0 ? h('button', {class: 'dgit-btn', onclick: function() { self.previewIncoming(); }}, 'Preview changes') : null,
			h('button', {class: 'dgit-btn dgit-primary', disabled: this.busy != null, onclick: function() { self.pull(); }},
				'Pull ↓' + a.incoming.length)));
		body.appendChild(box);
	}

	// Others working on this diagram on other branches
	if (a != null && a.otherBranches.length > 0)
	{
		var box = h('div', {class: 'dgit-card'});
		box.appendChild(h('div', {class: 'dgit-card-title'}, 'Also being edited on other branches'));
		a.otherBranches.slice(0, 5).forEach(function(b)
		{
			box.appendChild(h('div', {class: 'dgit-branch-activity'},
				avatar(b.latest.author, b.latest.email, 20),
				h('div', {class: 'dgit-grow'},
					h('div', null, h('b', null, b.authors.join(', ')), ' on ', h('code', null, b.branch)),
					h('div', {class: 'dgit-sub'}, b.count + ' commit' + (b.count == 1 ? '' : 's') + ' · ' + ago(b.latest.date) + ' · “' + b.latest.subject + '”')),
				h('button', {class: 'dgit-link', onclick: function() { self.compareRevs('HEAD', b.branch, 'Your branch', b.branch); }}, 'Preview')));
		});
		box.appendChild(h('div', {class: 'dgit-sub'}, 'Merge these branches on GitHub with a pull request; this diagram merges cell by cell when you pull.'));
		body.appendChild(box);
	}

	this.renderChanges(body, st);
	this.renderHistory(body, st);
	this.renderFooter(body, st);

	body.scrollTop = scroll;
	this.applyTheme();
};

SourceControl.prototype.renderNotRepo = function(body, st)
{
	var self = this;

	if (!st.gitAvailable)
	{
		body.appendChild(h('div', {class: 'dgit-error'}, 'Git is not installed. Install the Xcode command line tools by running “xcode-select --install” in Terminal, then reopen this panel.'));
		return;
	}

	body.appendChild(h('div', {class: 'dgit-empty'},
		h('p', null, h('b', null, basename(this.filePath)), ' is not in a git repository.'),
		h('p', {class: 'dgit-sub'}, st.dir),
		h('button', {class: 'dgit-btn dgit-primary', onclick: function()
		{
			self.run('Creating repository', function()
			{
				return git('init', {path: self.filePath}).then(function()
				{
					return self.refresh(true);
				});
			});
		}}, 'Start versioning this folder'),
		h('div', {class: 'dgit-or'}, 'or'),
		h('button', {class: 'dgit-btn', onclick: function() { self.cloneDialog(); }}, 'Clone a GitHub repository…')));
};

SourceControl.prototype.renderIdentity = function(body, st)
{
	var self = this;
	var name = h('input', {class: 'dgit-input', placeholder: 'Your name', value: st.userName || ''});
	var email = h('input', {class: 'dgit-input', placeholder: 'Email used on GitHub', value: st.userEmail || ''});

	body.appendChild(h('div', {class: 'dgit-card dgit-card-amber'},
		h('div', {class: 'dgit-card-title'}, 'Who are you?'),
		h('div', {class: 'dgit-sub'}, 'Your name appears on every change you share.'),
		name, email,
		h('div', {class: 'dgit-actions'}, h('button', {class: 'dgit-btn dgit-primary', onclick: function()
		{
			self.run('Saving', function()
			{
				return git('setIdentity', {path: self.filePath, name: name.value, email: email.value}).then(function()
				{
					return self.refresh();
				});
			});
		}}, 'Save'))));
};

SourceControl.prototype.renderConflicts = function(body, st)
{
	var self = this;
	var box = h('div', {class: 'dgit-card dgit-card-red'});
	box.appendChild(h('div', {class: 'dgit-card-title'}, '⚠ Merge in progress'));

	if (this.pendingMerge != null)
	{
		box.appendChild(h('div', null, 'This diagram has conflicting edits that need your decision.'));
		box.appendChild(h('div', {class: 'dgit-actions'},
			h('button', {class: 'dgit-btn dgit-primary', onclick: function() { self.resumeMerge(); }}, 'Resolve conflicts…')));
	}

	if (st.conflicts.length > 0)
	{
		box.appendChild(h('div', {class: 'dgit-sub'}, st.conflicts.length + ' file' + (st.conflicts.length == 1 ? '' : 's') + ' with conflicts:'));

		st.conflicts.forEach(function(rel)
		{
			var isDiagram = /\.(drawio|dio|xml)$/i.test(rel);
			var isCurrent = rel == st.relPath;
			box.appendChild(h('div', {class: 'dgit-conflict-file'},
				h('code', {class: 'dgit-grow'}, rel),
				isDiagram ? h('button', {class: 'dgit-link', onclick: function() { self.resolveFile(rel); }}, isCurrent && self.pendingMerge ? 'Resolve' : 'Merge…') : null,
				h('button', {class: 'dgit-link', onclick: function() { self.pickSide(rel, 'ours'); }}, 'Keep mine'),
				h('button', {class: 'dgit-link', onclick: function() { self.pickSide(rel, 'theirs'); }}, 'Take theirs')));
		});
	}
	else if (st.merging && this.pendingMerge == null)
	{
		box.appendChild(h('div', {class: 'dgit-sub'}, 'All conflicts are resolved.'));
		box.appendChild(h('div', {class: 'dgit-actions'}, h('button', {class: 'dgit-btn dgit-primary', onclick: function()
		{
			self.run('Completing merge', function()
			{
				return git('commit', {path: self.filePath, message: 'Merge remote changes'}).then(function() { return self.refresh(true); });
			});
		}}, 'Complete merge')));
	}

	box.appendChild(h('div', {class: 'dgit-actions'}, h('button', {class: 'dgit-btn dgit-danger', onclick: function()
	{
		if (confirm('Abort the merge and go back to your version? Incoming changes stay on GitHub and can be pulled again later.'))
		{
			self.abortMerge();
		}
	}}, 'Abort merge')));

	body.appendChild(box);
};

SourceControl.prototype.renderChanges = function(body, st)
{
	var self = this;
	var file = this.ui.getCurrentFile();
	var unsaved = file != null && file.isModified();
	var changed = st.fileState != 'clean' || unsaved;
	var others = st.changes.filter(function(c) { return c.path != st.relPath; });
	var box = h('div', {class: 'dgit-section'});
	box.appendChild(h('div', {class: 'dgit-section-title'}, 'Your changes'));

	var stateText = {clean: 'No changes since the last commit', modified: 'Modified', untracked: 'New file (not tracked yet)',
		added: 'New file', deleted: 'Deleted', renamed: 'Renamed', conflicted: 'Conflicted'}[st.fileState] || st.fileState;

	box.appendChild(h('div', {class: 'dgit-file-row'},
		h('span', {class: 'dgit-state dgit-state-' + st.fileState}, {clean: '✓', modified: 'M', untracked: 'U', added: 'A', deleted: 'D', renamed: 'R', conflicted: '!'}[st.fileState] || '?'),
		h('span', {class: 'dgit-grow'}, h('div', null, basename(this.filePath)),
			h('div', {class: 'dgit-sub'}, unsaved ? 'Unsaved edits · ' + stateText : stateText)),
		(st.fileState == 'modified' && !st.merging) ? h('button', {class: 'dgit-link', onclick: function() { self.compareRevs('HEAD', null, 'Last commit', 'Now'); }}, 'Compare') : null,
		(st.fileState == 'modified' && !st.merging) ? h('button', {class: 'dgit-link dgit-danger-text', onclick: function() { self.discard(); }}, 'Discard') : null));

	var msg = h('textarea', {class: 'dgit-input dgit-commit-msg', rows: 3,
		placeholder: 'Describe your change (e.g. “Add payment service to architecture”)'});
	msg.value = this.draftMessage || '';
	msg.addEventListener('input', function() { self.draftMessage = msg.value; });
	msg.addEventListener('keydown', function(e)
	{
		if ((e.metaKey || e.ctrlKey) && e.key == 'Enter')
		{
			e.preventDefault();
			self.sync();
		}
	});

	var includeAll = h('input', {type: 'checkbox'});
	includeAll.checked = !!this.includeAll;
	includeAll.addEventListener('change', function() { self.includeAll = includeAll.checked; });

	if (changed || st.merging)
	{
		box.appendChild(msg);
	}

	if (others.length > 0 && (changed || st.merging))
	{
		box.appendChild(h('label', {class: 'dgit-check'}, includeAll,
			' Also commit ' + others.length + ' other changed file' + (others.length == 1 ? '' : 's') + ' in the repository'));
	}

	var syncLabel = this.syncLabel(st, unsaved);
	box.appendChild(h('div', {class: 'dgit-actions'},
		changed ? h('button', {class: 'dgit-btn', disabled: this.busy != null, onclick: function() { self.commitOnly(); }}, 'Commit') : null,
		h('button', {class: 'dgit-btn dgit-primary dgit-wide', disabled: this.busy != null || st.conflicts.length > 0,
			title: 'Save, commit, pull and push (⌘↩ in the message box)', onclick: function() { self.sync(); }},
			this.busy != null ? h('span', {class: 'dgit-spinner'}) : null, this.busy != null ? this.busy + '…' : syncLabel)));

	if (st.ahead > 0 && !changed)
	{
		box.appendChild(h('div', {class: 'dgit-sub'}, st.ahead + ' commit' + (st.ahead == 1 ? '' : 's') + ' not pushed yet'));
	}

	body.appendChild(box);
};

SourceControl.prototype.syncLabel = function(st, unsaved)
{
	var changed = st.fileState != 'clean' || unsaved;

	if (!st.remoteUrl) return changed ? 'Commit' : 'Up to date';
	if (changed) return 'Commit & Sync';
	if (!st.upstream) return 'Publish branch ↑';
	if (st.behind > 0 && st.ahead > 0) return 'Sync ↓' + st.behind + ' ↑' + st.ahead;
	if (st.behind > 0) return 'Pull ↓' + st.behind;
	if (st.ahead > 0) return 'Push ↑' + st.ahead;

	return '✓ Up to date';
};

SourceControl.prototype.renderHistory = function(body, st)
{
	var self = this;
	var box = h('div', {class: 'dgit-section'});
	box.appendChild(h('div', {class: 'dgit-section-title'}, 'History of this diagram'));

	if (this.history == null)
	{
		box.appendChild(h('div', {class: 'dgit-sub'}, h('span', {class: 'dgit-spinner'}), ' Loading…'));
	}
	else if (this.history.length == 0)
	{
		box.appendChild(h('div', {class: 'dgit-sub'}, 'No commits yet. Commit to start the history.'));
	}
	else
	{
		var list = h('div', {class: 'dgit-history'});

		this.history.forEach(function(c, idx)
		{
			var row = h('div', {class: 'dgit-commit'},
				avatar(c.author, c.email, 26),
				h('div', {class: 'dgit-grow'},
					h('div', {class: 'dgit-commit-subject'}, c.subject),
					h('div', {class: 'dgit-sub'}, c.author + ' · ' + ago(c.date) + ' · ', h('code', null, c.short),
						!c.pushed && st.upstream ? h('span', {class: 'dgit-badge dgit-badge-amber'}, 'not pushed') : null)),
				h('div', {class: 'dgit-commit-actions'},
					h('button', {class: 'dgit-link', title: 'See what this commit changed',
						onclick: function() { self.compareRevs(c.hash + '^', c.hash, 'Before', c.short + ' · ' + c.author, c); }}, 'Changes'),
					idx > 0 ? h('button', {class: 'dgit-link', title: 'Compare this version with the diagram now',
						onclick: function() { self.compareRevs(c.hash, null, c.short + ' · ' + ago(c.date), 'Now'); }}, 'vs now') : null,
					idx > 0 ? h('button', {class: 'dgit-link', title: 'Bring this version back',
						onclick: function() { self.restore(c); }}, 'Restore') : null,
					st.webUrl && c.pushed ? h('button', {class: 'dgit-link', title: 'Open on GitHub',
						onclick: function() { self.openUrl(st.webUrl + '/commit/' + c.hash); }}, '↗') : null));
			list.appendChild(row);
		});

		box.appendChild(list);
	}

	body.appendChild(box);
};

SourceControl.prototype.renderFooter = function(body, st)
{
	var self = this;
	var box = h('div', {class: 'dgit-section dgit-footer'});

	if (st.webUrl)
	{
		var links = h('div', {class: 'dgit-actions dgit-wrap'},
			h('button', {class: 'dgit-btn', onclick: function()
			{
				self.openUrl(st.webUrl + '/blob/' + encodeURIComponent(st.branch || 'HEAD').replace(/%2F/g, '/') + '/' +
					st.relPath.split('/').map(encodeURIComponent).join('/'));
			}}, 'Open on GitHub'),
			h('button', {class: 'dgit-btn', onclick: function() { self.openUrl(st.webUrl + '/commits/' + encodeURIComponent(st.branch || '').replace(/%2F/g, '/') + '/' + st.relPath.split('/').map(encodeURIComponent).join('/')); }}, 'History on GitHub'));

		if (st.branch && st.upstream && !/^(main|master|dev|develop)$/.test(st.branch))
		{
			links.appendChild(h('button', {class: 'dgit-btn', onclick: function()
			{
				self.openUrl(st.webUrl + '/compare/' + st.branch.split('/').map(encodeURIComponent).join('/') + '?expand=1');
			}}, 'Create pull request'));
		}

		box.appendChild(links);
	}
	else if (!st.remoteUrl)
	{
		box.appendChild(h('div', {class: 'dgit-card'},
			h('div', {class: 'dgit-card-title'}, 'Share with your team'),
			h('div', {class: 'dgit-sub'}, 'This repository only exists on your Mac. Publish it to GitHub so others can collaborate.'),
			h('div', {class: 'dgit-actions dgit-wrap'},
				h('button', {class: 'dgit-btn dgit-primary', onclick: function() { self.publishDialog(); }}, 'Publish to GitHub…'),
				h('button', {class: 'dgit-btn', onclick: function() { self.addRemoteDialog(); }}, 'Use existing repo…'))));
	}

	var auto = h('input', {type: 'checkbox'});
	auto.checked = !!prefs.autoPull;
	auto.addEventListener('change', function() { prefs.autoPull = auto.checked; savePrefs(); });

	var notify = h('input', {type: 'checkbox'});
	notify.checked = !!prefs.notify;
	notify.addEventListener('change', function() { prefs.notify = notify.checked; savePrefs(); });

	var interval = h('select', {class: 'dgit-select'});
	[[15, '15 sec'], [30, '30 sec'], [60, '1 min'], [300, '5 min']].forEach(function(o)
	{
		interval.appendChild(h('option', {value: o[0] * 1000}, 'every ' + o[1]));
	});

	git('getFetchInterval').then(function(r) { interval.value = String(r.ms); }).catch(function() {});
	interval.addEventListener('change', function() { git('setFetchInterval', {ms: parseInt(interval.value, 10)}).catch(function() {}); });

	var liveOn = h('input', {type: 'checkbox'});
	liveOn.checked = prefs.live !== false;
	liveOn.addEventListener('change', function() { prefs.live = liveOn.checked; savePrefs(); if (self.updateLive) self.updateLive(); });

	var liveNet = h('input', {type: 'checkbox'});
	liveNet.checked = true;
	live('getSettings').then(function(r) { liveNet.checked = r.internet; }).catch(function() {});
	liveNet.addEventListener('change', function()
	{
		live('setSettings', {internet: liveNet.checked}).then(function()
		{
			if (self.live && self.live.active) self.live.stop().then(function() { self.updateLive(); });
		});
	});

	box.appendChild(h('details', {class: 'dgit-settings'},
		h('summary', null, 'Collaboration settings'),
		h('label', {class: 'dgit-check'}, liveOn, ' Edit live with teammates who have this diagram open'),
		h('label', {class: 'dgit-check'}, liveNet, ' Find teammates over the internet (through hidden refs in the GitHub repository), not only on this network'),
		h('label', {class: 'dgit-check'}, 'Check GitHub for changes ', interval),
		h('label', {class: 'dgit-check'}, notify, ' Notify me when someone pushes changes to this diagram'),
		h('label', {class: 'dgit-check'}, auto, ' Merge their changes automatically when I have no local edits'),
		h('div', {class: 'dgit-sub'}, 'Diagrams merge shape by shape: you only decide when you and a teammate changed the same thing.')));

	body.appendChild(box);
};

// ---------------------------------------------------------------------------
// Operations

SourceControl.prototype.run = function(label, fn)
{
	var self = this;

	if (this.busy != null) return Promise.resolve(false);

	this.busy = label;
	this.render();

	return Promise.resolve().then(fn).then(function(r)
	{
		self.busy = null;
		self.render();
		return r === undefined ? true : r;
	}, function(e)
	{
		self.busy = null;
		self.render();
		self.handleError(e);
		return false;
	});
};

SourceControl.prototype.handleError = function(e)
{
	var self = this;

	if (e != null && e.kind == 'identity')
	{
		this.setPanelVisible(true);
		this.toast(explain(e), 'error');
	}
	else if (e != null && e.kind == 'rejected')
	{
		this.toast(explain(e), 'error', [{label: 'Pull & retry', primary: true, action: function() { self.sync(); }}]);
	}
	else if (e != null && e.canceled)
	{
		// user canceled
	}
	else
	{
		this.toast(explain(e), 'error', null, 12000);
	}
};

SourceControl.prototype.openUrl = function(url)
{
	electron.request({action: 'openExternal', url: url}, function() {}, function() {});
};

SourceControl.prototype.currentFile = function()
{
	var file = this.ui.getCurrentFile();

	if (file == null || file.fileObject == null || file.fileObject.path != this.filePath)
	{
		throw new Error('The diagram changed. Try again.');
	}

	return file;
};

SourceControl.prototype.saveIfNeeded = function()
{
	var file = this.currentFile();

	if (!file.isModified())
	{
		return Promise.resolve();
	}

	return new Promise(function(resolve, reject)
	{
		file.save(false, function() { resolve(); }, function(e)
		{
			reject(e || new Error('Saving failed'));
		});
	});
};

// The editor watches its file; changes made by git are not external edits
SourceControl.prototype.pauseWatch = function()
{
	var ui = this.ui;
	var p = ui.watchedPath;

	if (p != null)
	{
		ui.watchedPath = null;
		return Promise.resolve(ui.unwatchPath(p)).catch(function() {});
	}

	return Promise.resolve();
};

SourceControl.prototype.resumeWatch = function()
{
	var file = this.ui.getCurrentFile();
	return Promise.resolve(this.ui.watchFile(file)).catch(function() {});
};

SourceControl.prototype.reloadFromDisk = function()
{
	var file = this.currentFile();
	var ui = this.ui;
	var wasModified = file.isModified();

	return new Promise(function(resolve, reject)
	{
		file.reloadFile(function()
		{
			// The editor now shows exactly what is on disk: patching the
			// pages during the reload must not leave the file dirty
			var current = ui.getCurrentFile();

			if (!wasModified && current != null)
			{
				current.setModified(false);
				current.setShadowPages(ui.clonePages(ui.pages));
				ui.editor.setStatus('');
				ui.updateDocumentTitle();
			}

			resolve();
		}, function(e) { reject(e || new Error('Reloading failed')); });
	});
};

// Runs fn with the file watcher paused and reloads the editor afterwards if
// fn says the file on disk changed
SourceControl.prototype.withFileOp = function(fn)
{
	var self = this;

	return this.pauseWatch().then(fn).then(function(r)
	{
		return (r && r.reload ? self.reloadFromDisk() : Promise.resolve()).then(function()
		{
			return self.resumeWatch();
		}).then(function() { return r; });
	}, function(e)
	{
		return self.resumeWatch().then(function() { throw e; });
	});
};

SourceControl.prototype.defaultMessage = function()
{
	return 'Update ' + basename(this.filePath);
};

SourceControl.prototype.commitOnly = function()
{
	var self = this;

	return this.run('Committing', function()
	{
		return self.saveIfNeeded().then(function()
		{
			return git('commit', {path: self.filePath, message: (self.draftMessage || '').trim() || self.defaultMessage(), all: !!self.includeAll});
		}).then(function(r)
		{
			if (r.committed)
			{
				self.draftMessage = '';
				self.toast('Committed “' + r.commit.subject + '”', 'success');
			}
			else
			{
				self.toast('Nothing to commit', 'info');
			}

			return self.refresh(true);
		});
	});
};

// Save → commit → pull (cell level merge) → push
SourceControl.prototype.sync = function()
{
	var self = this;
	var st = this.status;

	if (st == null || !st.isRepo) return Promise.resolve(false);

	return this.run('Syncing', function()
	{
		var file = self.currentFile();
		var needsCommit = file.isModified() || st.fileState != 'clean';

		return self.saveIfNeeded().then(function()
		{
			if (needsCommit || self.includeAll)
			{
				self.busy = 'Committing';
				self.render();

				return git('commit', {path: self.filePath, message: (self.draftMessage || '').trim() || self.defaultMessage(),
					all: !!self.includeAll}).then(function(r)
				{
					if (r.committed) self.draftMessage = '';
				});
			}
		}).then(function()
		{
			return git('status', {path: self.filePath});
		}).then(function(st2)
		{
			self.status = st2;

			if (!st2.remoteUrl)
			{
				self.toast('Committed locally. Publish the repository to GitHub to share it.', 'success');
				return true;
			}

			var pull = st2.upstream ? self.doPull() : Promise.resolve(true);

			return pull.then(function(ok)
			{
				if (!ok) return false;

				self.busy = 'Pushing';
				self.render();

				return git('status', {path: self.filePath}).then(function(st3)
				{
					if (st3.upstream && st3.ahead == 0)
					{
						return true;
					}

					return git('push', {path: self.filePath}).then(function()
					{
						self.toast('Your changes are on GitHub', 'success');
						return true;
					});
				});
			});
		}).then(function(r)
		{
			self.refresh(true);
			return r;
		});
	});
};

SourceControl.prototype.pull = function(opts)
{
	var self = this;

	return this.run('Pulling', function()
	{
		return self.saveIfNeeded().then(function()
		{
			return self.doPull(opts);
		}).then(function(ok)
		{
			self.refresh(true);
			return ok;
		});
	});
};

// Pulls and merges the open diagram cell by cell. Resolves to false if the
// user still has to resolve conflicts.
SourceControl.prototype.doPull = function(opts)
{
	var self = this;
	opts = opts || {};

	return this.withFileOp(function()
	{
		return git('pull', {path: self.filePath}).then(function(res)
		{
			if (res.result == 'up-to-date')
			{
				return {reload: false, ok: true};
			}

			if (!res.needsDiagramMerge)
			{
				self.reportPull(res, opts);
				return {reload: res.fileChanged || res.fileDirty, ok: res.conflicts.length == 0};
			}

			var merge = self.merger.merge(res.base, res.ours, res.theirs);

			if (merge.conflicts.length == 0)
			{
				return self.writeMerge(res, merge.apply({})).then(function(r)
				{
					self.reportPull(res, opts, merge);
					return {reload: true, ok: r.remaining.length == 0};
				});
			}

			// Needs decisions. The working copy still holds "ours" so
			// nothing is lost if the dialog is closed; the merge can be
			// resumed from the panel.
			self.pendingMerge = {res: res, merge: merge};

			return {reload: res.fileDirty, ok: false, conflicts: true};
		});
	}).then(function(r)
	{
		if (r.conflicts)
		{
			self.setPanelVisible(true);
			return self.resumeMerge(true);
		}

		return r.ok;
	});
};

SourceControl.prototype.reportPull = function(res, opts, merge)
{
	var authors = [];
	(res.incoming || []).forEach(function(c) { if (authors.indexOf(c.author) < 0) authors.push(c.author); });

	if (opts.auto) return;

	if (res.conflicts.length > 0 && !res.fileConflicted)
	{
		this.toast('Pulled, but ' + res.conflicts.length + ' other file(s) have conflicts. See the Source Control panel.', 'error');
	}
	else if (authors.length > 0)
	{
		this.toast('Merged changes from ' + authors.join(', ') + (res.fileDirty ? '. Your unsaved work was kept.' : ''), 'success');
	}
	else
	{
		this.toast('Up to date with GitHub', 'success');
	}
};

SourceControl.prototype.writeMerge = function(res, xml)
{
	return git('resolve', {path: this.filePath, content: xml, complete: true});
};

SourceControl.prototype.resumeMerge = function(fromPull)
{
	var self = this;
	var pending = this.pendingMerge;

	if (pending == null) return Promise.resolve(false);

	return this.conflictDialog(pending.merge, {
		title: 'Merge “' + basename(this.filePath) + '”',
		incoming: pending.res.incoming
	}).then(function(choices)
	{
		if (choices == null)
		{
			self.render();
			return false;
		}

		var doIt = function()
		{
			return self.withFileOp(function()
			{
				var xml = pending.merge.apply(choices);

				return self.writeMerge(pending.res, xml).then(function(r)
				{
					self.pendingMerge = null;
					self.toast(r.completed ? 'Merge complete' : 'Diagram merged', 'success');
					return {reload: true, ok: r.remaining.length == 0};
				});
			}).then(function(r) { return r.ok; });
		};

		// Inside sync() the busy state is already held
		var p = fromPull ? doIt() : self.run('Merging', doIt);

		return p.then(function(ok)
		{
			self.refresh(true);
			return ok;
		});
	});
};

SourceControl.prototype.resolveFile = function(rel)
{
	var self = this;
	var st = this.status;

	if (rel == st.relPath && this.pendingMerge != null)
	{
		return this.resumeMerge();
	}

	// Any conflicted diagram: merge from the index stages
	return Promise.all([':1', ':2', ':3'].map(function(stage)
	{
		return git('showStage', {path: self.filePath, relPath: rel, stage: stage});
	})).then(function(v)
	{
		var merge = self.merger.merge(v[0], v[1], v[2]);
		var go = function(choices)
		{
			return self.run('Merging', function()
			{
				return self.withFileOp(function()
				{
					return git('resolve', {path: self.filePath, relPath: rel, content: merge.apply(choices), complete: true}).then(function()
					{
						return {reload: rel == st.relPath};
					});
				}).then(function()
				{
					self.toast('Merged ' + rel, 'success');
					return self.refresh(true);
				});
			});
		};

		if (merge.conflicts.length == 0)
		{
			return go({});
		}

		return self.conflictDialog(merge, {title: 'Merge “' + basename(rel) + '”'}).then(function(choices)
		{
			if (choices != null) return go(choices);
		});
	}).catch(function(e) { self.handleError(e); });
};

SourceControl.prototype.pickSide = function(rel, side)
{
	var self = this;
	var st = this.status;

	return this.run('Resolving', function()
	{
		return self.withFileOp(function()
		{
			return git('resolve', {path: self.filePath, relPath: rel, side: side, complete: true}).then(function(r)
			{
				if (rel == st.relPath) self.pendingMerge = null;
				return {reload: rel == st.relPath};
			});
		}).then(function() { return self.refresh(true); });
	});
};

SourceControl.prototype.abortMerge = function()
{
	var self = this;
	var pending = this.pendingMerge;

	return this.run('Aborting', function()
	{
		return self.withFileOp(function()
		{
			return git('abortMerge', {path: self.filePath,
				restore: (pending != null && pending.res.fileDirty) ? pending.res.ours : null}).then(function()
			{
				self.pendingMerge = null;
				return {reload: true};
			});
		}).then(function()
		{
			self.toast('Merge aborted. Your version is unchanged.', 'info');
			return self.refresh(true);
		});
	});
};

SourceControl.prototype.fetchNow = function()
{
	var self = this;

	return this.run('Checking GitHub', function()
	{
		return git('fetch', {path: self.filePath}).then(function()
		{
			return self.refresh(true);
		});
	});
};

SourceControl.prototype.discard = function()
{
	var self = this;

	if (!confirm('Discard all changes to “' + basename(this.filePath) + '” since the last commit? A backup copy is kept in the repository’s .git/drawio-backups folder.'))
	{
		return Promise.resolve(false);
	}

	return this.run('Discarding', function()
	{
		var file = self.currentFile();
		file.setModified(false);

		return self.withFileOp(function()
		{
			return git('discard', {path: self.filePath}).then(function() { return {reload: true}; });
		}).then(function() { return self.refresh(true); });
	});
};

SourceControl.prototype.restore = function(commit)
{
	var self = this;

	if (!confirm('Bring back the version from ' + ago(commit.date) + ' by ' + commit.author + ' (“' + commit.subject + '”)?\n\nThe current version stays in the history; commit afterwards to share the restored version.'))
	{
		return Promise.resolve(false);
	}

	return this.run('Restoring', function()
	{
		return self.saveIfNeeded().then(function()
		{
			return git('show', {path: self.filePath, rev: commit.hash});
		}).then(function(xml)
		{
			if (xml == null) throw new Error('This version could not be read');

			return self.withFileOp(function()
			{
				return git('resolve', {path: self.filePath, content: xml, complete: false}).then(function() { return {reload: true}; });
			});
		}).then(function()
		{
			self.draftMessage = 'Restore version ' + commit.short + ' (“' + commit.subject + '”)';
			self.toast('Restored. Commit to share it.', 'success');
			return self.refresh(true);
		});
	});
};

SourceControl.prototype.branchMenu = function(anchor)
{
	var self = this;

	git('branches', {path: this.filePath}).then(function(b)
	{
		var menu = h('div', {class: 'dgit-menu'});
		var close = function() { menu.remove(); document.removeEventListener('mousedown', outside, true); };
		var outside = function(e) { if (!menu.contains(e.target)) close(); };

		menu.appendChild(h('div', {class: 'dgit-menu-title'}, 'Branches'));
		b.local.forEach(function(br)
		{
			menu.appendChild(h('button', {class: 'dgit-menu-item' + (br.current ? ' dgit-current' : ''), onclick: function()
			{
				close();
				if (!br.current) self.checkout(br.name, {});
			}}, (br.current ? '✓ ' : '   ') + br.name, h('span', {class: 'dgit-sub'}, ' ' + ago(br.date))));
		});

		var localNames = b.local.map(function(x) { return x.upstream; });
		var remotes = b.remote.filter(function(r) { return localNames.indexOf(r.name) < 0; }).slice(0, 15);

		if (remotes.length > 0)
		{
			menu.appendChild(h('div', {class: 'dgit-menu-title'}, 'On GitHub'));
			remotes.forEach(function(br)
			{
				menu.appendChild(h('button', {class: 'dgit-menu-item', onclick: function()
				{
					close();
					self.checkout(br.name, {remote: true});
				}}, '   ' + br.name, h('span', {class: 'dgit-sub'}, ' ' + br.author + ' · ' + ago(br.date))));
			});
		}

		menu.appendChild(h('div', {class: 'dgit-menu-sep'}));
		menu.appendChild(h('button', {class: 'dgit-menu-item', onclick: function()
		{
			close();
			var name = prompt('New branch name (e.g. alex/new-network-layout):');
			if (name) self.checkout(name.trim().replace(/\s+/g, '-'), {create: true});
		}}, '+ New branch…'));

		var r = anchor.getBoundingClientRect();
		menu.style.left = r.left + 'px';
		menu.style.top = (r.bottom + 4) + 'px';
		document.body.appendChild(menu);
		self.applyTheme();
		menu.classList.toggle('dgit-dark', self.isDark());
		window.setTimeout(function() { document.addEventListener('mousedown', outside, true); }, 0);
	}).catch(function(e) { self.handleError(e); });
};

SourceControl.prototype.checkout = function(branch, opts)
{
	var self = this;

	return this.run('Switching branch', function()
	{
		var file = self.currentFile();

		if (!opts.create && (file.isModified() || self.status.fileState != 'clean'))
		{
			throw new Error('Commit or discard your changes to this diagram before switching branches.');
		}

		return self.saveIfNeeded().then(function()
		{
			return self.withFileOp(function()
			{
				return git('checkout', {path: self.filePath, branch: branch, create: !!opts.create, remote: !!opts.remote}).then(function(r)
				{
					if (!r.fileExists)
					{
						self.toast('This diagram does not exist on ' + r.branch + '.', 'info');
						return {reload: false};
					}

					return {reload: !opts.create};
				});
			}).then(function()
			{
				self.toast('Switched to ' + branch, 'success');
				return self.refresh(true);
			});
		});
	});
};

// ---------------------------------------------------------------------------
// Dialogs

SourceControl.prototype.modal = function(title, content, buttons, opts)
{
	var self = this;
	opts = opts || {};

	return new Promise(function(resolve)
	{
		var overlay = h('div', {class: 'dgit-modal'});
		var box = h('div', {class: 'dgit-modal-box' + (opts.wide ? ' dgit-modal-wide' : '')});
		var close = function(value)
		{
			overlay.remove();
			document.removeEventListener('keydown', onKey, true);
			resolve(value);
		};
		var onKey = function(e)
		{
			if (e.key == 'Escape') { e.stopPropagation(); close(null); }
		};

		box.appendChild(h('div', {class: 'dgit-modal-head'}, h('div', {class: 'dgit-modal-title'}, title),
			h('button', {class: 'dgit-icon-btn', onclick: function() { close(null); }}, '✕')));
		box.appendChild(h('div', {class: 'dgit-modal-body'}, content));

		if (buttons != null && buttons.length > 0)
		{
			var foot = h('div', {class: 'dgit-modal-foot'});

			buttons.forEach(function(b)
			{
				if (b == null) return;
				if (b.spacer) { foot.appendChild(h('span', {class: 'dgit-grow'})); return; }

				foot.appendChild(h('button', {class: 'dgit-btn' + (b.primary ? ' dgit-primary' : '') + (b.danger ? ' dgit-danger' : ''),
					onclick: function()
					{
						var v = b.value != null ? (typeof b.value === 'function' ? b.value() : b.value) : null;
						if (v !== undefined) close(v);
					}}, b.label));
			});

			box.appendChild(foot);
		}

		overlay.appendChild(box);
		['keydown', 'keypress', 'keyup'].forEach(function(evt)
		{
			overlay.addEventListener(evt, function(e) { if (e.key != 'Escape') e.stopPropagation(); });
		});
		document.addEventListener('keydown', onKey, true);
		document.body.appendChild(overlay);
		overlay.classList.toggle('dgit-dark', self.isDark());

		if (opts.onShow) opts.onShow(box);
	});
};

// Renders a page as an SVG data URI with highlight boxes around cells
SourceControl.prototype.renderPage = function(page, highlights)
{
	var ui = this.ui;

	if (page == null) return null;

	ui.updatePageRoot(page);
	var graph = ui.createTemporaryGraph(ui.editor.graph.getStylesheet());
	graph.shapeForegroundColor = ui.editor.graph.shapeForegroundColor;
	graph.shapeBackgroundColor = ui.editor.graph.shapeBackgroundColor;
	document.body.appendChild(graph.container);

	try
	{
		graph.model.setRoot(page.root);
		graph.view.revalidate();

		var model = graph.model;
		var boxes = [];

		for (var id in (highlights || {}))
		{
			var cell = model.getCell(id);
			var state = (cell != null) ? graph.view.getState(cell) : null;

			if (state != null && state.width + state.height > 0)
			{
				boxes.push({state: state, color: highlights[id]});
			}
		}

		if (boxes.length > 0)
		{
			var s = graph.view.scale, t = graph.view.translate;
			var layer = model.getChildAt(model.getRoot(), model.getChildCount(model.getRoot()) - 1);

			model.beginUpdate();

			try
			{
				boxes.forEach(function(b)
				{
					var pad = 5;
					var geo = new mxGeometry(b.state.x / s - t.x - pad, b.state.y / s - t.y - pad,
						Math.max(b.state.width / s, 2) + 2 * pad, Math.max(b.state.height / s, 2) + 2 * pad);
					var v = new mxCell('', geo, 'rounded=1;arcSize=6;absoluteArcSize=1;fillColor=' + b.color +
						';fillOpacity=12;strokeColor=' + b.color + ';strokeWidth=3;dashed=' + (b.color == '#E5484D' ? 1 : 0) + ';html=1;');
					v.vertex = true;
					model.add(layer, v);
				});
			}
			finally
			{
				model.endUpdate();
			}
		}

		var temp = Graph.foreignObjectWarningText;
		Graph.foreignObjectWarningText = '';
		var svg = graph.getSvg('#ffffff', 1, 12, null, null, true, null, null, null, null,
			null, null, null, null, true, true);
		Graph.foreignObjectWarningText = temp;

		return Editor.createSvgDataUri(mxUtils.getXml(svg));
	}
	catch (e)
	{
		console.error('git: render failed', e);
		return null;
	}
	finally
	{
		graph.container.remove();
		try { graph.destroy(); } catch (e) {}
	}
};

var GREEN = '#30A46C', RED = '#E5484D', AMBER = '#F5A524', BLUE = '#3E7BFA';

// Visual before/after compare of two revisions (null = the editor right now)
SourceControl.prototype.compareRevs = function(oldRev, newRev, oldLabel, newLabel, commit)
{
	var self = this;
	var get = function(rev)
	{
		if (rev == null)
		{
			return Promise.resolve(mxUtils.getXml(self.ui.getXmlFileData(true, false, true)));
		}

		return git('show', {path: self.filePath, rev: rev});
	};

	return Promise.all([get(oldRev), get(newRev)]).then(function(v)
	{
		return self.showCompare(v[0], v[1], oldLabel, newLabel, commit);
	}).catch(function(e) { self.handleError(e); });
};

SourceControl.prototype.previewIncoming = function()
{
	var a = this.activity;

	if (a == null || a.upstream == null) return;

	var c = a.incomingFile[0];
	var self = this;

	return this.compareRevs(a.mergeBase || 'HEAD', '@{u}', 'Before their changes', 'On GitHub (' + a.upstream + ')').then(function()
	{
		// nothing
	});
};

SourceControl.prototype.showCompare = function(oldXml, newXml, oldLabel, newLabel, commit)
{
	var self = this;
	var d = this.merger.describe(oldXml || '', newXml || '');
	var content = h('div', {class: 'dgit-compare'});

	if (commit != null)
	{
		content.appendChild(h('div', {class: 'dgit-commit-head'}, avatar(commit.author, commit.email, 28),
			h('div', null, h('div', {class: 'dgit-commit-subject'}, commit.subject),
				h('div', {class: 'dgit-sub'}, commit.author + ' · ' + new Date(commit.date).toLocaleString() + ' · ' + commit.short))));
	}

	if (oldXml == null)
	{
		content.appendChild(h('div', {class: 'dgit-sub'}, 'The diagram did not exist before this version.'));
	}

	if (d.total == 0)
	{
		content.appendChild(h('div', {class: 'dgit-empty'}, 'No visible changes to the diagram.'));
		return this.modal('Compare', content, [{label: 'Close', primary: true, value: true}], {wide: true});
	}

	var tabs = h('div', {class: 'dgit-tabs'});
	var view = h('div', {class: 'dgit-compare-view'});
	content.appendChild(tabs);
	content.appendChild(view);

	var show = function(p)
	{
		Array.from(tabs.children).forEach(function(t) { t.classList.toggle('dgit-active', t.__page == p); });
		view.textContent = '';

		var oldHl = {}, newHl = {};
		p.removed.forEach(function(c) { oldHl[c.id] = RED; });
		p.added.forEach(function(c) { newHl[c.id] = GREEN; });
		p.changed.forEach(function(c) { oldHl[c.id] = AMBER; newHl[c.id] = AMBER; });

		var oldSrc = p.pageAdded ? null : self.renderPage(p.oldPage, oldHl);
		var newSrc = p.pageRemoved ? null : self.renderPage(p.newPage, newHl);

		view.appendChild(h('div', {class: 'dgit-sides'},
			h('div', {class: 'dgit-side'}, h('div', {class: 'dgit-side-label'}, oldLabel),
				oldSrc ? h('div', {class: 'dgit-canvas'}, h('img', {src: oldSrc})) : h('div', {class: 'dgit-canvas dgit-none'}, 'Page did not exist')),
			h('div', {class: 'dgit-side'}, h('div', {class: 'dgit-side-label'}, newLabel),
				newSrc ? h('div', {class: 'dgit-canvas'}, h('img', {src: newSrc})) : h('div', {class: 'dgit-canvas dgit-none'}, 'Page deleted'))));

		var list = h('div', {class: 'dgit-change-list'});
		var legend = function(color, text) { return h('span', {class: 'dgit-legend'}, h('i', {style: {background: color}}), text); };
		list.appendChild(h('div', {class: 'dgit-legend-row'},
			legend(GREEN, p.added.length + ' added'), legend(RED, p.removed.length + ' removed'),
			legend(AMBER, p.changed.length + ' changed'),
			p.props.length > 0 ? h('span', {class: 'dgit-sub'}, 'Page: ' + p.props.join(', ')) : null));

		p.added.concat(p.removed, p.changed).slice(0, 200).forEach(function(c)
		{
			list.appendChild(h('div', {class: 'dgit-change dgit-change-' + c.type},
				h('span', {class: 'dgit-change-kind'}, {added: '+', removed: '−', changed: '~'}[c.type]),
				h('span', {class: 'dgit-grow'}, c.label),
				c.what ? h('span', {class: 'dgit-sub'}, c.what) : null));
		});

		view.appendChild(list);
	};

	d.pages.forEach(function(p)
	{
		var n = p.added.length + p.removed.length + p.changed.length + p.props.length;
		var t = h('button', {class: 'dgit-tab', onclick: function() { show(p); }}, p.name,
			h('span', {class: 'dgit-sub'}, p.pageAdded ? ' (new)' : p.pageRemoved ? ' (deleted)' : ' (' + n + ')'));
		t.__page = p;
		tabs.appendChild(t);
	});

	return this.modal('Compare: ' + oldLabel + ' → ' + newLabel, content, [{label: 'Close', primary: true, value: true}],
		{wide: true, onShow: function() { show(d.pages[0]); }});
};

// Lets the user decide each conflict. Resolves to {conflictId: 'mine'|'theirs'} or null.
SourceControl.prototype.conflictDialog = function(merge, opts)
{
	var self = this;
	var choices = {};
	var conflicts = merge.conflicts;
	var content = h('div', {class: 'dgit-conflicts'});
	var authors = [];

	(opts.incoming || []).forEach(function(c) { if (authors.indexOf(c.author) < 0) authors.push(c.author); });

	var theirName = authors.length > 0 ? authors.join(', ') : 'Theirs';

	content.appendChild(h('div', {class: 'dgit-merge-intro'},
		(merge.summary && merge.summary.autoMerged > 0) ? h('b', null, merge.summary.autoMerged + ' of their changes merged automatically. ') : null,
		conflicts.length + ' place' + (conflicts.length == 1 ? ' was' : 's were') + ' changed by both you and ' + theirName +
		'. Choose which version to keep for each.'));

	var layout = h('div', {class: 'dgit-conflict-layout'});
	var list = h('div', {class: 'dgit-conflict-list'});
	var preview = h('div', {class: 'dgit-conflict-preview'});
	layout.appendChild(list);
	layout.appendChild(preview);
	content.appendChild(layout);

	var selected = null;
	var rows = [];

	var showPreview = function(c)
	{
		selected = c;
		rows.forEach(function(r) { r.classList.toggle('dgit-active', r.__c == c); });
		preview.textContent = '';

		if (merge.pages == null || c.kind == 'file-deleted')
		{
			preview.appendChild(h('div', {class: 'dgit-empty'}, 'Mine: ' + c.mine + '. Theirs: ' + c.theirs + '.'));
			return;
		}

		var hl = function(pageSet)
		{
			var map = {};

			conflicts.forEach(function(o)
			{
				if (o.pageId == c.pageId && o.cellId != null) map[o.cellId] = (o == c) ? BLUE : '#9aa0a6';
			});

			return map;
		};

		var mineSrc = self.renderPage(self.merger.findPage(merge.pages.ours, c.pageId), hl());
		var theirsSrc = self.renderPage(self.merger.findPage(merge.pages.theirs, c.pageId), hl());
		var pick = function(side)
		{
			return function()
			{
				choices[c.id] = side;
				updateRows();
			};
		};

		preview.appendChild(h('div', {class: 'dgit-sides'},
			h('div', {class: 'dgit-side' + ((choices[c.id] || 'mine') == 'mine' ? ' dgit-chosen' : ''), onclick: pick('mine')},
				h('div', {class: 'dgit-side-label'}, 'Mine: ' + c.mine),
				mineSrc ? h('div', {class: 'dgit-canvas'}, h('img', {src: mineSrc})) : h('div', {class: 'dgit-canvas dgit-none'}, 'Page deleted')),
			h('div', {class: 'dgit-side' + (choices[c.id] == 'theirs' ? ' dgit-chosen' : ''), onclick: pick('theirs')},
				h('div', {class: 'dgit-side-label'}, theirName + ': ' + c.theirs),
				theirsSrc ? h('div', {class: 'dgit-canvas'}, h('img', {src: theirsSrc})) : h('div', {class: 'dgit-canvas dgit-none'}, 'Page deleted'))));
		preview.appendChild(h('div', {class: 'dgit-sub'}, 'Click a side to keep it. The highlighted shape is the one in conflict.'));
	};

	var updateRows = function()
	{
		rows.forEach(function(r)
		{
			var c = r.__c;
			var v = choices[c.id] || 'mine';
			r.querySelector('.dgit-seg-mine').classList.toggle('dgit-on', v == 'mine');
			r.querySelector('.dgit-seg-theirs').classList.toggle('dgit-on', v == 'theirs');
		});

		if (selected != null) showPreview(selected);
	};

	conflicts.forEach(function(c)
	{
		var row = h('div', {class: 'dgit-conflict', onclick: function() { showPreview(c); }},
			h('div', {class: 'dgit-grow'},
				h('div', {class: 'dgit-conflict-label'}, c.label),
				h('div', {class: 'dgit-sub'}, (c.pageName ? c.pageName + ' · ' : '') + 'You ' + c.mine + ' · ' + theirName + ' ' + c.theirs)),
			h('div', {class: 'dgit-seg'},
				h('button', {class: 'dgit-seg-mine', onclick: function(e) { e.stopPropagation(); choices[c.id] = 'mine'; showPreview(c); updateRows(); }}, 'Mine'),
				h('button', {class: 'dgit-seg-theirs', onclick: function(e) { e.stopPropagation(); choices[c.id] = 'theirs'; showPreview(c); updateRows(); }}, 'Theirs')));
		row.__c = c;
		rows.push(row);
		list.appendChild(row);
	});

	var all = function(side)
	{
		return function()
		{
			conflicts.forEach(function(c) { choices[c.id] = side; });
			updateRows();
			return undefined;
		};
	};

	return this.modal(opts.title || 'Resolve conflicts', content, [
		{label: 'Keep all mine', value: all('mine')},
		{label: 'Take all theirs', value: all('theirs')},
		{spacer: true},
		{label: 'Later', value: null},
		{label: 'Apply merge', primary: true, value: function() { return choices; }}
	], {wide: true, onShow: function() { updateRows(); if (conflicts.length > 0) showPreview(conflicts[0]); }});
};

SourceControl.prototype.cloneDialog = function()
{
	var self = this;
	var input = h('input', {class: 'dgit-input', placeholder: 'https://github.com/org/repo.git'});
	var repoList = h('div', {class: 'dgit-repo-list'});
	var content = h('div', null,
		h('div', {class: 'dgit-sub'}, 'Paste the repository URL, or pick one of your GitHub repositories.'),
		input, repoList);

	git('ghStatus').then(function(s)
	{
		if (!s.installed)
		{
			repoList.appendChild(h('div', {class: 'dgit-sub'}, 'Tip: install the GitHub CLI (brew install gh) and run “gh auth login” to browse your repositories here.'));
			return;
		}

		if (!s.loggedIn)
		{
			repoList.appendChild(h('div', {class: 'dgit-sub'}, 'Run “gh auth login” in Terminal to browse your repositories here.'));
			return;
		}

		repoList.appendChild(h('div', {class: 'dgit-sub'}, h('span', {class: 'dgit-spinner'}), ' Loading repositories for ' + s.login + '…'));

		return git('ghRepos').then(function(repos)
		{
			repoList.textContent = '';
			repos.forEach(function(r)
			{
				repoList.appendChild(h('button', {class: 'dgit-repo', onclick: function()
				{
					input.value = r.url + '.git';
					Array.from(repoList.children).forEach(function(c) { c.classList.remove('dgit-active'); });
					this.classList.add('dgit-active');
				}}, h('div', null, h('b', null, r.nameWithOwner), r.isPrivate ? h('span', {class: 'dgit-badge'}, 'private') : null),
					r.description ? h('div', {class: 'dgit-sub'}, r.description) : null));
			});
		});
	}).catch(function() {});

	return this.modal('Clone a GitHub repository', content, [
		{label: 'Cancel', value: null},
		{label: 'Choose folder & clone…', primary: true, value: function() { return input.value.trim() || undefined; }}
	], {onShow: function() { input.focus(); }}).then(function(url)
	{
		if (url == null) return;

		return self.run('Cloning', function()
		{
			return git('clone', {url: url}).then(function(r)
			{
				if (!r.canceled) self.toast('Cloned to ' + r.root, 'success');
			});
		});
	});
};

SourceControl.prototype.publishDialog = function()
{
	var self = this;
	var st = this.status;
	var name = h('input', {class: 'dgit-input', value: st.repoName.replace(/[^A-Za-z0-9_.-]/g, '-')});
	var priv = h('input', {type: 'checkbox'});
	priv.checked = true;

	var content = h('div', null,
		h('div', {class: 'dgit-sub'}, 'Creates a repository on your GitHub account (or “org/name” for an organization) and pushes this one to it. Uses the GitHub CLI.'),
		name, h('label', {class: 'dgit-check'}, priv, ' Private repository'));

	return this.modal('Publish to GitHub', content, [
		{label: 'Cancel', value: null},
		{label: 'Publish', primary: true, value: function() { return name.value.trim() || undefined; }}
	]).then(function(n)
	{
		if (n == null) return;

		return self.run('Publishing', function()
		{
			var commitFirst = (st.head == null) ? git('commit', {path: self.filePath, message: 'Add ' + basename(self.filePath)}) : Promise.resolve();

			return self.saveIfNeeded().then(function() { return commitFirst; }).then(function()
			{
				return git('ghPublish', {path: self.filePath, name: n, private: priv.checked});
			}).then(function(s)
			{
				self.toast('Published to ' + (s.webUrl || 'GitHub'), 'success');
				return self.refresh(true);
			});
		});
	});
};

SourceControl.prototype.copyText = function(text)
{
	var self = this;

	return navigator.clipboard.writeText(text).then(function()
	{
		self.toast('Link copied', 'success');
	}, function()
	{
		electron.request({action: 'clipboardAction', method: 'writeText', data: text}, function()
		{
			self.toast('Link copied', 'success');
		}, function() {});
	});
};

// Sharing: the link is the diagram's GitHub URL. Access to the repository is
// the only permission; there is no session key or password to pass around.
SourceControl.prototype.shareDialog = function()
{
	var self = this;

	return git('shareInfo', {path: this.filePath}).then(function(info)
	{
		var content = h('div', {class: 'dshare'});

		if (!info.shareable)
		{
			content.appendChild(h('p', null, 'Publish this repository to GitHub first. Then anyone you give access to can open the diagram from a link and edit it live with you.'));

			return self.modal('Share', content, [{label: 'Close', value: null},
				{label: 'Publish to GitHub…', primary: true, value: true}]).then(function(r)
			{
				if (r) self.publishDialog();
			});
		}

		var link = info.webLink || info.appLink;
		var field = h('input', {class: 'dgit-input', readonly: true, value: link});
		field.addEventListener('focus', function() { field.select(); });

		content.appendChild(h('p', null, 'Send this link to your team. Opening it in draw.io gets the diagram (downloading the repository the first time) and puts them in the live session with whoever has it open: no key or password, their GitHub access is the permission.'));
		content.appendChild(h('div', {class: 'dshare-row'}, field,
			h('button', {class: 'dgit-btn dgit-primary', onclick: function() { self.copyText(link); }}, 'Copy link')));

		if (info.webLink && info.appLink)
		{
			content.appendChild(h('div', {class: 'dgit-sub'}, 'In a browser the link shows the diagram on GitHub. ',
				h('button', {class: 'dgit-link', onclick: function() { self.copyText(info.appLink); }}, 'Copy a link that opens draw.io directly')));
		}

		content.appendChild(h('div', {class: 'dshare-steps'},
			h('div', {class: 'dgit-section-title'}, 'How it works'),
			h('ol', null,
				h('li', null, 'Whoever opens the diagram first hosts the live session; everyone who opens it after joins them.'),
				h('li', null, 'If the host leaves, the next person takes over without anyone noticing.'),
				h('li', null, 'When everyone has left, the diagram is simply the file in the repository: commit & sync to keep the latest for next time. The next person to open it starts a new session.'))));

		if (info.isGitHub)
		{
			var user = h('input', {class: 'dgit-input', placeholder: 'GitHub username'});
			var status = h('div', {class: 'dgit-sub'});

			content.appendChild(h('div', {class: 'dgit-section-title', style: {marginTop: '14px'}}, 'Give someone access'));
			content.appendChild(h('div', {class: 'dshare-row'}, user, h('button', {class: 'dgit-btn', onclick: function()
			{
				status.textContent = 'Inviting…';

				git('invite', {path: self.filePath, user: user.value}).then(function(r)
				{
					status.textContent = r.already ? user.value + ' already has access.' :
						'Invited ' + user.value + '. GitHub emailed them; once they accept, send them the link.';
				}, function(e)
				{
					status.textContent = e.kind == 'no-access' ? 'You need admin access to the repository to invite people (or the user does not exist).' : explain(e);
				});
			}}, 'Invite')));
			content.appendChild(status);
		}

		return self.modal('Share “' + basename(self.filePath) + '”', content, [{label: 'Done', primary: true, value: true}]);
	}).catch(function(e) { self.handleError(e); });
};

SourceControl.prototype.openLinkDialog = function()
{
	var self = this;
	var input = h('input', {class: 'dgit-input', placeholder: 'https://github.com/org/repo/blob/main/diagram.drawio'});

	return this.modal('Open a shared diagram', h('div', null,
		h('div', {class: 'dgit-sub'}, 'Paste a link to a diagram on GitHub. It opens here and joins anyone who is editing it live.'), input), [
		{label: 'Cancel', value: null},
		{label: 'Open', primary: true, value: function() { return input.value.trim() || undefined; }}
	], {onShow: function() { input.focus(); }}).then(function(link)
	{
		if (link == null) return;

		return self.run('Opening', function()
		{
			return git('openLink', {link: link}).then(function(r)
			{
				if (r.note) self.toast(r.note, 'info', null, 10000);
			});
		});
	});
};

SourceControl.prototype.addRemoteDialog = function()
{
	var self = this;
	var input = h('input', {class: 'dgit-input', placeholder: 'https://github.com/org/repo.git'});

	return this.modal('Connect to a GitHub repository', h('div', null,
		h('div', {class: 'dgit-sub'}, 'The repository should be empty or share history with this one.'), input), [
		{label: 'Cancel', value: null},
		{label: 'Connect', primary: true, value: function() { return input.value.trim() || undefined; }}
	], {onShow: function() { input.focus(); }}).then(function(url)
	{
		if (url == null) return;

		return self.run('Connecting', function()
		{
			return git('addRemote', {path: self.filePath, url: url}).then(function() { return self.refresh(true); });
		});
	});
};

// ---------------------------------------------------------------------------
// Toasts

SourceControl.prototype.toast = function(text, type, actions, timeout)
{
	var self = this;

	if (this.toastHost == null)
	{
		this.toastHost = h('div', {class: 'dgit-toasts'});
		document.body.appendChild(this.toastHost);
	}

	this.toastHost.classList.toggle('dgit-dark', this.isDark());

	var el = h('div', {class: 'dgit-toast dgit-toast-' + (type || 'info')});
	var close = function() { el.classList.add('dgit-out'); window.setTimeout(function() { el.remove(); }, 200); };

	el.appendChild(h('div', {class: 'dgit-toast-text'}, text));

	if (actions != null)
	{
		var row = h('div', {class: 'dgit-actions'});

		actions.forEach(function(a)
		{
			row.appendChild(h('button', {class: 'dgit-btn' + (a.primary ? ' dgit-primary' : ''), onclick: function() { close(); a.action(); }}, a.label));
		});

		el.appendChild(row);
	}

	el.appendChild(h('button', {class: 'dgit-toast-x', onclick: close}, '✕'));
	this.toastHost.appendChild(el);
	window.setTimeout(close, timeout || (type == 'error' ? 10000 : 4500));
};

// ---------------------------------------------------------------------------
// Menu entries (File menu) for discoverability

SourceControl.prototype.installMenu = function()
{
	var self = this;
	var ui = this.ui;

	try
	{
		ui.actions.addAction('dgitToggle', function() { self.setPanelVisible(!self.panelVisible); }, null, null,
			Editor.ctrlKey + '+Shift+G');
		ui.actions.get('dgitToggle').label = 'Source Control (GitHub)…';
		ui.actions.addAction('dgitSync', function() { self.setPanelVisible(true); self.sync(); });
		ui.actions.get('dgitSync').label = 'Commit & Sync with GitHub';
		ui.actions.addAction('dgitComments', function() { if (self.showComments) self.showComments(); });
		ui.actions.get('dgitComments').label = 'Comments…';
		ui.actions.addAction('dgitShare', function() { self.shareDialog(); });
		ui.actions.get('dgitShare').label = 'Share…';
		ui.actions.addAction('dgitOpenLink', function() { self.openLinkDialog(); });
		ui.actions.get('dgitOpenLink').label = 'Open GitHub Link…';
		ui.actions.addAction('dgitClone', function() { self.cloneDialog(); });
		ui.actions.get('dgitClone').label = 'Clone GitHub Repository…';

		['file'].forEach(function(name)
		{
			var menu = ui.menus.get(name);

			if (menu != null)
			{
				var funct = menu.funct;

				menu.funct = function(m, parent)
				{
					funct.apply(this, arguments);
					m.addSeparator(parent);
					ui.menus.addMenuItems(m, ['dgitToggle', 'dgitSync', 'dgitShare', 'dgitComments', 'dgitOpenLink', 'dgitClone'], parent);
				};
			}
		});
	}
	catch (e)
	{
		console.warn('git: menu install failed', e);
	}
};

captureUi(function(ui)
{
	try
	{
		window.__drawioGit = new SourceControl(ui);

		if (typeof initLive === 'function')
		{
			initLive(window.__drawioGit);
		}
	}
	catch (e)
	{
		console.error('git: init failed', e);
	}
});
