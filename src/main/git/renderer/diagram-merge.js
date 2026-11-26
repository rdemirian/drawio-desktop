// Three-way, cell level merge of draw.io diagrams.
//
// Uses the diff/patch engine draw.io itself uses for real-time collaboration
// (EditorUi.diffPages / patchPages). The changes from base to "theirs" are
// applied on top of "ours". Wherever both sides changed the same property of
// the same shape (or one side deleted what the other changed) a conflict is
// reported, and the user decides per conflict which side wins.
//
// Runs in the page (main world), injected by src/main/git/index.js.

var DiagramMerge = (function()
{
	var U = 'u', R = 'r', I = 'i';

	var KEY_LABELS = {
		geometry: 'position / size', style: 'style', value: 'text', xmlValue: 'text / data',
		parent: 'grouping', previous: 'order', source: 'source connection',
		target: 'target connection', visible: 'visibility', collapsed: 'collapsed',
		name: 'page name', view: 'page settings', viewBox: 'initial view', alt: 'description',
		group: 'page group'
	};

	function clone(obj)
	{
		return (obj == null) ? obj : JSON.parse(JSON.stringify(obj));
	}

	function same(a, b)
	{
		return JSON.stringify(a) === JSON.stringify(b);
	}

	function keyLabel(k)
	{
		return KEY_LABELS[k] || k;
	}

	function DiagramMerge(ui)
	{
		this.ui = ui;
	}

	DiagramMerge.keyLabel = keyLabel;

	// Parses file content into fresh DiagramPages (safe to mutate)
	DiagramMerge.prototype.parse = function(xml)
	{
		if (xml == null || String(xml).trim().length == 0)
		{
			return [];
		}

		var doc = mxUtils.parseXml(xml);
		var bare = doc.documentElement != null && doc.documentElement.nodeName == 'mxGraphModel';
		var pages = this.ui.getPagesForNode(doc.documentElement);
		var result = [];

		for (var i = 0; i < pages.length; i++)
		{
			if (pages[i] != null)
			{
				// Bare models get random page IDs: make them stable so that
				// the three versions line up
				if (bare)
				{
					pages[i].node.setAttribute('id', 'diagram-' + (i + 1));
				}

				this.ui.updatePageRoot(pages[i]);
				result.push(pages[i]);
			}
		}

		return result;
	};

	DiagramMerge.prototype.serialize = function(pages, templateXml)
	{
		var doc = mxUtils.createXmlDocument();
		var file = doc.createElement('mxfile');

		try
		{
			var t = (templateXml != null) ? mxUtils.parseXml(templateXml).documentElement : null;

			if (t != null && t.nodeName == 'mxfile')
			{
				for (var i = 0; i < t.attributes.length; i++)
				{
					file.setAttribute(t.attributes[i].name, t.attributes[i].value);
				}
			}
		}
		catch (e)
		{
			// ignore
		}

		// Uncompressed XML gives readable diffs on GitHub
		file.removeAttribute('compressed');
		file.setAttribute('host', 'Electron');

		for (var i = 0; i < pages.length; i++)
		{
			var page = pages[i];

			if (page.root == null)
			{
				this.ui.updatePageRoot(page);
			}

			var enc = new mxCodec(mxUtils.createXmlDocument());
			var model = enc.encode(new mxGraphModel(page.root));
			this.ui.editor.graph.saveViewState(page.viewState, model);
			var node = doc.importNode(page.node.cloneNode(false), true);
			node.appendChild(doc.importNode(model, true));
			file.appendChild(node);
		}

		doc.appendChild(file);

		return mxUtils.getXml(file);
	};

	DiagramMerge.prototype.getModel = function(page)
	{
		if (page.__model == null)
		{
			this.ui.updatePageRoot(page);
			page.__model = new mxGraphModel(page.root);
		}

		return page.__model;
	};

	DiagramMerge.prototype.cellLabel = function(page, id)
	{
		var cell = (page != null) ? this.getModel(page).getCell(id) : null;

		if (cell == null)
		{
			return null;
		}

		var v = cell.value;

		if (v != null && typeof v === 'object' && v.getAttribute != null)
		{
			v = v.getAttribute('label') || v.getAttribute('tooltip') || '';
		}

		v = String(v || '');

		if (v.indexOf('<') >= 0)
		{
			// DOMParser never runs scripts or loads resources
			v = new DOMParser().parseFromString(v, 'text/html').body.textContent || '';
		}

		v = v.replace(/\s+/g, ' ').trim();

		if (v.length == 0)
		{
			var style = cell.style || '';
			var m = style.match(/(?:^|;)shape=([^;]+)/);
			v = cell.edge ? 'Connector' : (m != null ? m[1].replace(/^mxgraph\./, '').replace(/[._]/g, ' ') :
				(/(^|;)text(;|$)/.test(style) ? 'Text' : (/ellipse/.test(style) ? 'Ellipse' : 'Shape')));
			v = v.charAt(0).toUpperCase() + v.substring(1);
		}

		return v.length > 60 ? v.substring(0, 57) + '…' : v;
	};

	DiagramMerge.prototype.descendants = function(page, id)
	{
		var result = [];
		var cell = (page != null) ? this.getModel(page).getCell(id) : null;

		var visit = function(c)
		{
			result.push(c.getId());

			for (var i = 0; i < (c.children || []).length; i++)
			{
				visit(c.children[i]);
			}
		};

		if (cell != null)
		{
			visit(cell);
		}

		return result;
	};

	DiagramMerge.prototype.findPage = function(pages, id)
	{
		for (var i = 0; i < pages.length; i++)
		{
			if (pages[i].getId() == id)
			{
				return pages[i];
			}
		}

		return null;
	};

	// Top level removed cells (whose parent was not removed too)
	function topRemoved(merge, page, removed)
	{
		var set = {};
		var result = [];

		for (var i = 0; i < removed.length; i++)
		{
			set[removed[i]] = true;
		}

		var model = (page != null) ? merge.getModel(page) : null;

		for (var i = 0; i < removed.length; i++)
		{
			var cell = (model != null) ? model.getCell(removed[i]) : null;
			var parent = (cell != null) ? cell.parent : null;

			if (parent == null || !set[parent.getId()])
			{
				result.push(removed[i]);
			}
		}

		return result;
	}

	// Returns {conflicts, apply(choices) -> xml, summary}
	DiagramMerge.prototype.merge = function(baseXml, oursXml, theirsXml)
	{
		var ui = this.ui;
		var self = this;

		if (oursXml == null || theirsXml == null)
		{
			// Deleted on one side: whole file decision
			return {
				fileLevel: true,
				conflicts: [{id: 'file', kind: 'file-deleted', mineDeleted: oursXml == null,
					theirsDeleted: theirsXml == null, pageName: '', label: 'Whole diagram',
					mine: oursXml == null ? 'deleted the diagram' : 'kept and edited the diagram',
					theirs: theirsXml == null ? 'deleted the diagram' : 'kept and edited the diagram'}],
				apply: function(choices)
				{
					var c = choices['file'] || 'mine';
					return (c == 'mine') ? oursXml : theirsXml;
				}
			};
		}

		var base = this.parse(baseXml);
		var ours = this.parse(oursXml);
		var theirs = this.parse(theirsXml);
		var dOurs = ui.diffPages(base, ours);
		var dTheirs = ui.diffPages(base, theirs);
		var conflicts = [];
		var autoMerged = 0;

		var pageName = function(id)
		{
			var p = self.findPage(ours, id) || self.findPage(theirs, id) || self.findPage(base, id);
			return (p != null) ? (p.getName() || 'Page') : 'Page';
		};

		var oursRemovedPages = dOurs[R] || [];
		var theirsRemovedPages = dTheirs[R] || [];
		var oursUpdates = dOurs[U] || {};
		var theirsUpdates = dTheirs[U] || {};

		// Page removed on one side and edited on the other
		for (var i = 0; i < theirsRemovedPages.length; i++)
		{
			var pid = theirsRemovedPages[i];

			if (oursUpdates[pid] != null)
			{
				conflicts.push({id: 'page-r-t-' + pid, kind: 'page-removed-theirs', pageId: pid,
					pageName: pageName(pid), label: 'Page “' + pageName(pid) + '”',
					mine: 'edited this page', theirs: 'deleted this page'});
			}
		}

		for (var i = 0; i < oursRemovedPages.length; i++)
		{
			var pid = oursRemovedPages[i];

			if (theirsUpdates[pid] != null)
			{
				conflicts.push({id: 'page-r-o-' + pid, kind: 'page-removed-ours', pageId: pid,
					pageName: pageName(pid), label: 'Page “' + pageName(pid) + '”',
					mine: 'deleted this page', theirs: 'edited this page'});
			}
		}

		for (var pid in theirsUpdates)
		{
			var tp = theirsUpdates[pid];
			var op = oursUpdates[pid];

			if (op == null)
			{
				continue;
			}

			// Page level properties
			['name', 'view', 'viewBox', 'group', 'alt'].forEach(function(key)
			{
				if (tp[key] !== undefined && op[key] !== undefined && !same(tp[key], op[key]))
				{
					conflicts.push({id: 'page-p-' + pid + '-' + key, kind: 'page-prop', pageId: pid, key: key,
						pageName: pageName(pid), label: 'Page “' + pageName(pid) + '”: ' + keyLabel(key),
						mine: key == 'name' ? 'renamed to “' + op[key] + '”' : 'changed ' + keyLabel(key),
						theirs: key == 'name' ? 'renamed to “' + tp[key] + '”' : 'changed ' + keyLabel(key)});
				}
			});

			var tc = tp.cells || {};
			var oc = op.cells || {};
			var basePage = this.findPage(base, pid);
			var oursPage = this.findPage(ours, pid);
			var theirsPage = this.findPage(theirs, pid);
			var tcu = tc[U] || {}, ocu = oc[U] || {};

			// Cells deleted by them that we changed (or changed inside of)
			var tRemoved = topRemoved(this, basePage, tc[R] || []);

			for (var j = 0; j < tRemoved.length; j++)
			{
				var cid = tRemoved[j];
				var sub = this.descendants(basePage, cid);
				var touched = sub.filter(function(id) { return ocu[id] != null; });

				if (touched.length > 0)
				{
					conflicts.push({id: 'cell-r-t-' + pid + '-' + cid, kind: 'cell-removed-theirs', pageId: pid,
						cellId: cid, subtree: sub, pageName: pageName(pid),
						label: this.cellLabel(oursPage, cid) || this.cellLabel(basePage, cid) || cid,
						mine: 'changed it', theirs: 'deleted it'});
				}
			}

			// Cells we deleted that they changed
			var oRemoved = topRemoved(this, basePage, oc[R] || []);

			for (var j = 0; j < oRemoved.length; j++)
			{
				var cid = oRemoved[j];
				var sub = this.descendants(basePage, cid);
				var touched = sub.filter(function(id) { return tcu[id] != null; });

				if (touched.length > 0)
				{
					conflicts.push({id: 'cell-r-o-' + pid + '-' + cid, kind: 'cell-removed-ours', pageId: pid,
						cellId: cid, subtree: sub, pageName: pageName(pid),
						label: this.cellLabel(theirsPage, cid) || this.cellLabel(basePage, cid) || cid,
						mine: 'deleted it', theirs: 'changed it'});
				}
			}

			// Same property changed differently on both sides
			for (var cid in tcu)
			{
				if (ocu[cid] == null)
				{
					autoMerged++;
					continue;
				}

				var keys = [];

				for (var key in tcu[cid])
				{
					if (ocu[cid][key] !== undefined && !same(ocu[cid][key], tcu[cid][key]))
					{
						keys.push(key);
					}
				}

				if (keys.length > 0)
				{
					conflicts.push({id: 'cell-p-' + pid + '-' + cid, kind: 'cell-prop', pageId: pid, cellId: cid,
						keys: keys, pageName: pageName(pid),
						label: this.cellLabel(oursPage, cid) || cid,
						mine: 'changed ' + keys.map(keyLabel).join(', '),
						theirs: 'changed ' + keys.map(keyLabel).join(', ')});
				}
				else
				{
					autoMerged++;
				}
			}

			autoMerged += (tc[I] || []).length;
		}

		var summary = {
			autoMerged: autoMerged,
			theirsPagesAdded: (dTheirs[I] || []).length,
			theirsPagesRemoved: theirsRemovedPages.length,
			hasTheirsChanges: !mxUtils.isEmptyObject(dTheirs),
			hasOursChanges: !mxUtils.isEmptyObject(dOurs)
		};

		var apply = function(choices)
		{
			choices = choices || {};

			if (!summary.hasTheirsChanges)
			{
				return oursXml;
			}

			if (!summary.hasOursChanges)
			{
				return theirsXml;
			}

			var patch = clone(dTheirs);
			var theirsFresh = self.parse(theirsXml);

			var pageCells = function(pid)
			{
				return (patch[U] != null && patch[U][pid] != null) ? patch[U][pid].cells : null;
			};

			for (var i = 0; i < conflicts.length; i++)
			{
				var c = conflicts[i];
				var mine = (choices[c.id] || 'mine') == 'mine';

				if (c.kind == 'cell-prop' && mine)
				{
					var cells = pageCells(c.pageId);
					var upd = (cells != null && cells[U] != null) ? cells[U][c.cellId] : null;

					if (upd != null)
					{
						c.keys.forEach(function(k) { delete upd[k]; });

						if (mxUtils.isEmptyObject(upd))
						{
							delete cells[U][c.cellId];
						}
					}
				}
				else if (c.kind == 'cell-removed-theirs' && mine)
				{
					var cells = pageCells(c.pageId);

					if (cells != null && cells[R] != null)
					{
						cells[R] = cells[R].filter(function(id) { return c.subtree.indexOf(id) < 0; });
					}
				}
				else if (c.kind == 'cell-removed-ours')
				{
					var cells = pageCells(c.pageId);

					if (cells != null && cells[U] != null)
					{
						c.subtree.forEach(function(id) { delete cells[U][id]; });
					}

					if (!mine && cells != null)
					{
						// Brings back their version of the shape and its children
						var tp = self.findPage(theirsFresh, c.pageId);
						var model = (tp != null) ? self.getModel(tp) : null;
						var cell = (model != null) ? model.getCell(c.cellId) : null;

						if (cell != null)
						{
							cells[I] = cells[I] || [];

							var add = function(cell)
							{
								var parent = cell.parent;
								var idx = (parent != null) ? parent.getIndex(cell) : -1;
								var prev = (idx > 0) ? parent.getChildAt(idx - 1) : null;
								cells[I].push(ui.getJsonForCell(cell, prev));

								for (var k = 0; k < cell.getChildCount(); k++)
								{
									add(cell.getChildAt(k));
								}
							};

							add(cell);
						}
					}
				}
				else if (c.kind == 'page-removed-theirs' && mine)
				{
					if (patch[R] != null)
					{
						patch[R] = patch[R].filter(function(id) { return id != c.pageId; });
					}
				}
				else if (c.kind == 'page-removed-ours')
				{
					if (patch[U] != null)
					{
						delete patch[U][c.pageId];
					}

					if (!mine)
					{
						var tp = self.findPage(theirsFresh, c.pageId);

						if (tp != null)
						{
							var idx = theirsFresh.indexOf(tp);
							patch[I] = patch[I] || [];
							patch[I].push({id: tp.getId(), data: ui.getPageXmlForDiff(tp),
								previous: (idx > 0) ? theirsFresh[idx - 1].getId() : ''});
						}
					}
				}
				else if (c.kind == 'page-prop' && mine)
				{
					if (patch[U] != null && patch[U][c.pageId] != null)
					{
						delete patch[U][c.pageId][c.key];
					}
				}
			}

			var result = self.parse(oursXml);
			var merged = ui.patchPages(result, patch, true);

			return self.serialize(merged, oursXml);
		};

		return {
			conflicts: conflicts,
			summary: summary,
			apply: apply,
			pages: {base: base, ours: ours, theirs: theirs}
		};
	};

	// Changes between two versions, per page, for the visual compare
	DiagramMerge.prototype.describe = function(oldXml, newXml)
	{
		var oldPages = this.parse(oldXml);
		var newPages = this.parse(newXml);
		var diff = this.ui.diffPages(oldPages, newPages);
		var self = this;
		var result = {oldPages: oldPages, newPages: newPages, pages: [], total: 0};

		var push = function(pid, entry)
		{
			var p = null;

			for (var i = 0; i < result.pages.length; i++)
			{
				if (result.pages[i].id == pid)
				{
					p = result.pages[i];
				}
			}

			if (p == null)
			{
				var np = self.findPage(newPages, pid), op = self.findPage(oldPages, pid);
				p = {id: pid, name: (np || op).getName() || 'Page', oldPage: op, newPage: np,
					added: [], removed: [], changed: [], pageAdded: op == null, pageRemoved: np == null, props: []};
				result.pages.push(p);
			}

			if (entry != null)
			{
				p[entry.type].push(entry);
				result.total++;
			}

			return p;
		};

		(diff[I] || []).forEach(function(ins) { push(ins.id).pageAdded = true; result.total++; });
		(diff[R] || []).forEach(function(id) { push(id).pageRemoved = true; result.total++; });

		var upd = diff[U] || {};

		for (var pid in upd)
		{
			var pd = upd[pid];
			var np = this.findPage(newPages, pid), op = this.findPage(oldPages, pid);
			var p = push(pid);

			['name', 'view', 'viewBox', 'group', 'alt'].forEach(function(k)
			{
				if (pd[k] !== undefined) { p.props.push(keyLabel(k)); result.total++; }
			});

			var cells = pd.cells || {};

			(cells[I] || []).forEach(function(c)
			{
				push(pid, {type: 'added', id: c.id, label: self.cellLabel(np, c.id) || c.id});
			});

			topRemoved(this, op, cells[R] || []).forEach(function(id)
			{
				push(pid, {type: 'removed', id: id, label: self.cellLabel(op, id) || id});
			});

			for (var cid in (cells[U] || {}))
			{
				var keys = Object.keys(cells[U][cid]);
				push(pid, {type: 'changed', id: cid, keys: keys, what: keys.map(keyLabel).join(', '),
					label: self.cellLabel(np, cid) || cid});
			}
		}

		return result;
	};

	return DiagramMerge;
})();
