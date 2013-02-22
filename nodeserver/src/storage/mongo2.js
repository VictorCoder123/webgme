/*
 * Copyright (C) 2012-2013 Vanderbilt University, All rights reserved.
 * 
 * Author: Miklos Maroti
 */

define([ "mongodb", "util/assert" ], function (MONGODB, ASSERT) {
	"use strict";

	var PROJECT_REGEXP = new RegExp("^[0-9a-zA-Z_]*$");
	var HASH_REGEXP = new RegExp("^#[0-9a-zA-Z_]*$");
	var BRANCH_REGEXP = new RegExp("^\\*[0-9a-zA-Z_]*$");

	var STATUS_CLOSED = "mongodb closed";
	var STATUS_UNREACHABLE = "mongodb unreachable";
	var STATUS_CONNECTED = "connected";

	// ------- Database -------

	var Database = function (options) {
		ASSERT(typeof options === "object" && options !== null);

		this._host = options.host || "localhost";
		this._port = options.port || 27017;
		this._name = options.database || "webgme";
		this._timeout = options.timeout || 1000;

		this._mongo = null;
		this._projects = {};
	};

	Database.prototype._validProjectName = function (project) {
		ASSERT(typeof project === "string");

		return project.substr(0, 7) !== "system." && PROJECT_REGEXP.test(project);
	};

	Database.prototype.openDatabase = function (callback) {
		ASSERT(this._mongo === null && typeof callback === "function");

		this._mongo = new MONGODB.Db(this._name, new MONGODB.Server(this._host, this._port), {
			w: 1
		});

		this._mongo.open(function (err) {
			if (err) {
				this._mongo.close();
				this._mongo = null;
				callback(err);
			} else {
				callback(null);
			}
		});
	};

	Database.prototype.closeDatabase = function (callback) {
		ASSERT(typeof callback === "function");

		var that = this;
		if (this._mongo !== null) {
			this.fsyncDatabase(function () {
				that._mongo.close(function () {
					that._mongo = null;
					callback(null);
				});
			});
		} else {
			callback(null);
		}
	};

	Database.prototype.fsyncDatabase = function (callback) {
		ASSERT(this._mongo !== null && typeof callback === "function");

		var error = null;
		var synced = 0;
		var mongo = this._mongo;

		function fsyncConnection (conn) {
			mongo.lastError({
				fsync: true
			}, {
				connection: conn
			}, function (err, res) {
				error = error || err || res[0].err;
				if (++synced === conns.length) {
					callback(error);
				}
			});
		}

		var conns = mongo.serverConfig.allRawConnections();
		ASSERT(Array.isArray(conns) && conns.length >= 1);

		for ( var i = 0; i < conns.length; ++i) {
			fsyncConnection(conns[i]);
		}
	};

	Database.prototype.getDatabaseStatus = function (oldstatus, callback) {
		ASSERT(oldstatus === null || typeof oldstatus === "string");
		ASSERT(typeof callback === "function");

		if (this._mongo === null) {
			this._reportStatus(oldstatus, STATUS_CLOSED, callback);
		} else {
			var that = this;
			this._mongo.command({
				ping: 1
			}, function (err) {
				that._reportStatus(oldstatus, err ? STATUS_UNREACHABLE : STATUS_CONNECTED, callback);
			});
		}
	};

	Database.prototype._reportStatus = function (oldstatus, newstatus, callback) {
		if (oldstatus !== newstatus) {
			callback(null, newstatus);
		} else {
			setTimeout(callback, this._timeout, null, newstatus);
		}
	};

	Database.prototype.getProjectNames = function (callback) {
		ASSERT(this._mongo !== null && typeof callback === "function");

		var that = this;
		this._mongo.collectionNames(function (err, collections) {
			if (err) {
				callback(err);
			} else {
				var names = [];
				for ( var i = 0; i < collections.length; i++) {
					var p = collections[i].name.indexOf(".");
					var n = collections[i].name.substring(p + 1);
					if (that._validProjectName(n)) {
						names.push(n);
					}
				}
				callback(null, names);
			}
		});
	};

	Database.prototype.openProject = function (name, callback) {
		ASSERT(typeof name === "string" && PROJECT_REGEXP.test(name));
		ASSERT(this._mongo !== null && typeof callback === "function");

		var p = this._projects[name];
		if (p instanceof Project) {
			ASSERT(p._refcount >= 1);
			p._refcount += 1;
			callback(null, p);
		} else if (p instanceof Array) {
			p.push(callback);
		} else {
			ASSERT(typeof p === "undefined");
			this._projects[name] = [ callback ];

			var that = this;
			p = new Project(this, name);
			p._openProject(function (err) {
				var callbacks = that._projects[name];
				ASSERT(callbacks instanceof Array);

				if (err) {
					delete that._projects[name];
					p = undefined;
				} else {
					err = null;
					that._projects[name] = p;
					p._refcount += callbacks.length;
				}

				for ( var i = 0; i < callbacks.length; ++i) {
					callbacks[i](err, p);
				}
			});
		}
	};

	Database.prototype.deleteProject = function (name, callback) {
		ASSERT(this._mongo !== null && typeof callback === "function");
		ASSERT(typeof name === "string" && PROJECT_REGEXP.test(name));

		this._mongo.dropCollection(name, callback);
	};

	// ------- Project -------

	var Project = function (database, name) {
		ASSERT(database instanceof Database);
		ASSERT(typeof name === "string" && PROJECT_REGEXP.test(name));

		this._database = database;
		this._name = name;
		this._refcount = 0;
		this._collection = null;
		this._branches = {};
	};

	Project.prototype._openProject = function (callback) {
		ASSERT((this._refcount === 0 && this._collection === null));
		ASSERT(typeof callback === "function");

		var that = this;
		this._database._mongo.collection(this._name, function (err, result) {
			if (err) {
				callback(err);
			} else {
				ASSERT(that._collection === null && that._refcount === 0);

				that._refcount = 1;
				that._collection = result;
				callback(null);
			}
		});
	};

	Project.prototype.closeProject = function (callback) {
		ASSERT((this._refcount >= 1 && this._collection !== null));
		ASSERT(typeof callback === "function");

		if (--this._refcount === 0) {
			this._collection = null;

			ASSERT(this._database._projects[this._name] === this);
			delete this._database._projects[this._name];
		}

		callback(null);
	};

	Project.prototype.loadObject = function (hash, callback) {
		ASSERT(typeof hash === "string" && HASH_REGEXP.test(hash));
		ASSERT(this._collection !== null && typeof callback === "function");

		this._collection.findOne({
			_id: hash
		}, callback);
	};

	Project.prototype.insertObject = function (object, callback) {
		ASSERT(object !== null && typeof object === "object");
		ASSERT(typeof object._id === "string" && HASH_REGEXP.test(object._id));

		this._collection.insert(object, callback);
	};

	Project.prototype.findHash = function (beginning, callback) {
		ASSERT(typeof beginning === "string" && typeof callback === "function");

		if (!HASH_REGEXP.test(beginning)) {
			callback(new Error("hash " + beginning + " not valid"));
		} else {
			this._collection.find({
				_id: {
					$regex: "^" + beginning
				}
			}, {
				limit: 2
			}).toArray(function (err, docs) {
				if (err) {
					callback(err);
				} else if (docs.length === 0) {
					callback(new Error("hash " + beginning + " not found"));
				} else if (docs.length !== 1) {
					callback(new Error("hash " + beginning + " not unique"));
				} else {
					callback(null, docs[0]._id);
				}
			});
		}
	};

	Project.prototype.dumpObjects = function (callback) {
		ASSERT(typeof callback === "function");

		this._collection.find().each(function (err, item) {
			if (err || item === null) {
				callback(err);
			} else {
				console.log(item);
			}
		});
	};

	Project.prototype.getBranchNames = function (callback) {
		ASSERT(typeof callback === "function");

		this._collection.find({
			_id: {
				$regex: "^\\*"
			}
		}).toArray(function (err, docs) {
			if (err) {
				callback(err);
			} else {
				var branches = {};
				for ( var i = 0; i < docs.length; ++i) {
					branches[docs[i]._id] = docs[i].hash;
				}
			}
		});
	};

	Project.prototype.getBranchHash = function (name, oldhash, callback) {
		ASSERT(typeof name === "string" && BRANCH_REGEXP.test(name));
		ASSERT(typeof oldhash === "string" && HASH_REGEXP.test(oldhash));
		ASSERT(typeof callback === "function");

		this.
	};

	Project.prototype.setBranchHash = function (name, oldhash, newhash, callback) {
		ASSERT(typeof name === "string" && BRANCH_REGEXP.test(name));
		ASSERT(typeof oldhash === "string" && HASH_REGEXP.test(oldhash));
		ASSERT(typeof newhash === "string" && HASH_REGEXP.test(newhash));
		ASSERT(typeof callback === "function");

	};

	// ------- Branch -------

	var Branch = function (collection, name) {
		ASSERT(typeof name === "string" && BRANCH_REGEXP.test(name));

		this._collection = collection;
		this._name = name;
		this._hash = "";
		this._callbacks = [];
	};

	Branch.prototype._getHash = function (callback) {
		this._collection.findOne({
			_id: this._branch
		}, function (err, data) {
			console.log(err, data);
			if (err) {
			}
		});
	};

	Branch.prototype._setHash = function (oldhash, newhash, callback) {
		ASSERT(typeof oldhash === "string" && (oldhash === "" || HASH_REGEXP.test(oldhash)));
		ASSERT(typeof newhash === "string" && (newhash === "" || HASH_REGEXP.test(newhash)));
		ASSERT((oldhash !== "" || newhash !== "") && typeof callback === "function");

		if (oldhash === "") {
			this._collection.insert({
				_id: this._branch,
				hash: newhash
			}, callback);
		} else if (newhash === "") {
			this._collection.remove({
				_id: this._branch,
				hash: oldhash
			}, callback);
		} else {
			this._collection.update({
				_id: this._branch,
				hash: oldhash
			}, {
				$set: {
					hash: newhash
				}
			}, callback);
		}
	};

	Branch.prototype._notify = function () {
	};

	return {
		Database: Database,
		Project: Project,
		Brach: Branch
	};
});