/*jshint node:true*/
/**
 * @author pmeijer / https://github.com/pmeijer
 */

define(['util/assert', 'common/core/core'], function (ASSERT, Core) {

    /**
     * Opens the context specified by the parameters and returns a result object.
     * If no error is returned the database and the project are kept open, otherwise they are closed.
     * @param {object} storage - client-storage, server-user-storage or local-storage
     * @param {object} gmeConfig - global webgme configuration
     * @param {object} parameters
     * @param {string} [parameters.projectName] - name of project to open -> result.project
     * @param {boolean} [parameters.createProject] - if not found will create a project
     *                                              -> result.rootNode, result.commitHash, result.core
     * @param {boolean} [parameters.overwriteProject] - if found will overwrite the existing project
     *                                              -> result.rootNode, result.commitHash, result.core
     *
     * The following group is only valid when not creating a new project:
     * @param {string} [parameters.branchName] - name of branch to load root from. -> result.rootNode, result.commitHash
     * @param {string} [parameters.commitHash] - if branchName not given commitHash will be loaded. -> result.rootNode
     * @param {[string]} [parameters.nodeIds] -loads all specified node ids. -> result.nodes
     * @param {boolean} [parameters.meta] - loads all META-nodes. -> result.META
     *
     * @param {object} [parameters.core] - Used if branchName or commitHash is specified (a new Core will be created
     *                                     if needed and not provided here). -> result.core
     * @param {function} callback
     */
    var openContext = function (storage, gmeConfig, parameters, callback) {
        var result = {},
            core,
            closeOnError = function (err) {
                if (result.project) {
                    result.project.closeProject(function () {
                        storage.closeDatabase(function () {
                            callback(err);
                        });
                    });
                } else {
                    storage.closeDatabase(function () {
                        callback(err);
                    });
                }
            };

        ASSERT(typeof storage !== 'undefined' && storage.hasOwnProperty('openDatabase'), 'storage must be given');
        ASSERT(typeof callback === 'function', 'a callback must be given');

        storage.openDatabase(function (err) {
            if (err) {
                closeOnError(err);
                return;
            }
            if (parameters.projectName) {
                storage.getProjectNames(function (err, projectNames) {
                    var projectExists = projectNames.indexOf(parameters.projectName) > -1;
                    if (err) {
                        closeOnError(err);
                        return;
                    }
                    if (!projectExists && !parameters.createProject && !parameters.overwriteProject) {
                        closeOnError('"' + parameters.projectName + '" does not exists among: ' +
                        projectNames.toString() + '. Set flag "createProject" to create a new project.');
                        return;
                    } else if (projectExists && parameters.createProject && !parameters.overwriteProject) {
                        closeOnError('"' + parameters.projectName + '" already exists: ' +
                        projectNames.toString() + '. Set flag "overwriteProject" to overwrite project.');
                        return;
                    }

                    storage.openProject(parameters.projectName, function (err, project) {
                        if (err) {
                            closeOnError(err);
                            return;
                        }
                        result.project = project;
                        if (parameters.createProject || parameters.overwriteProject) {
                            if (projectExists) {
                                _deleteAndPersistEmptyProject(storage, parameters, result, gmeConfig, function (err) {
                                    if (err) {
                                        closeOnError(err);
                                        return;
                                    }
                                    callback(null, result);
                                });
                            } else {
                                _persistEmptyProject(parameters, result, gmeConfig, function (err) {
                                    if (err) {
                                        closeOnError(err);
                                        return;
                                    }
                                    callback(null, result);
                                });
                            }
                        } else if (parameters.branchName || parameters.commitHash) {
                            _getCommitHash(parameters, result, function (err) {
                                if (err) {
                                    closeOnError(err);
                                    return;
                                }
                                _loadCommitHash(parameters, result, gmeConfig, function (err) {
                                    if (err) {
                                        closeOnError(err);
                                        return;
                                    }

                                    if (parameters.nodeIds || parameters.meta) {
                                        _loadNodes(parameters, result, function (err) {
                                            if (err) {
                                                closeOnError(err);
                                                return;
                                            }
                                            callback(null, result);
                                        });
                                    } else {
                                        callback(null, result);
                                    }
                                });
                            });
                        } else {
                            callback(null, result);
                        }
                    });
                });
            } else {
                callback(null, result);
            }
        });
    };

    function _getCommitHash(parameters, result, callback) {
        if (parameters.branchName) {
            result.project.getBranchNames(function (err, names) {
                if (err) {
                    callback(err);
                } else if (names.hasOwnProperty(parameters.branchName) === false) {
                    callback('"' + parameters.branchName + '" not in project: "' +
                    parameters.projectName + '".');
                } else {
                    result.commitHash = names[parameters.branchName];
                    callback(null);
                }
            });
        } else {
            result.commitHash = parameters.commitHash;
            callback(null);
        }
    }

    function _loadCommitHash(parameters, result, gmeConfig, callback) {
        var core;
        result.project.loadObject(result.commitHash, function (err, commitObj) {
            if (err || !commitObj) {
                if (commitObj) {
                    callback(err);
                } else {
                    callback('No such commitHash "' + result.commitHash + '", in project "' +
                        parameters.projectName + '".');
                }
                return;
            }
            core = parameters.core || new Core(result.project, {globConf: gmeConfig});
            core.loadRoot(commitObj.root, function (err, rootNode) {
                if (err) {
                    callback(err);
                    return;
                }
                result.rootNode = rootNode;
                result.core = core;
                callback(null);
            });
        });
    }

    function _loadNodes(parameters, result, callback) {
        var metaNodes = [],
            metaIds,
            loadSpecifiedNodes = function () {
                _loadNodesById(result, parameters.nodeIds, false, function (err, nodes) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    result.nodes = nodes;
                    callback(null);
                });
            };

        if (parameters.meta) {
            metaIds = result.core.getMemberPaths(result.rootNode, 'MetaAspectSet');
            _loadNodesById(result, metaIds, true, function (err, metaNodes) {
                if (err) {
                    callback(err);
                    return;
                }
                result.META = metaNodes;
                if (parameters.nodeIds) {
                    loadSpecifiedNodes();
                } else {
                    callback(null);
                }
            });
        } else {
            loadSpecifiedNodes();
        }
    }

    function _loadNodesById(result, nodeIds, insertByName, callback) {
        var len = nodeIds.length,
            error = '',
            nodeObjs = [];


        var allNodesLoadedHandler = function () {
            var i,
                objMap = {};

            if (error) {
                callback(error);
                return;
            }

            for (i = 0; i < nodeObjs.length; i += 1) {
                if (insertByName) {
                    objMap[result.core.getAttribute(nodeObjs[i], 'name')] = nodeObjs[i];
                } else {
                    objMap[result.core.getPath(nodeObjs[i])] = nodeObjs[i];
                }
            }
            callback(null, objMap);
        };

        var loadedNodeHandler = function (err, nodeObj) {
            if (err) {
                error += err;
            }
            nodeObjs.push(nodeObj);

            if (nodeObjs.length === nodeIds.length) {
                allNodesLoadedHandler();
            }
        };

        while (len--) {
            result.core.loadByPath(result.rootNode, nodeIds[len], loadedNodeHandler);
        }
    };

    function _deleteAndPersistEmptyProject(storage, parameters, result, gmeConfig, callback) {
        result.project.closeProject(function (err) {
            if (err) {
                callback(err);
                return;
            }
            storage.deleteProject(parameters.projectName, function (err) {
                if (err) {
                    callback(err);
                    return;
                }
                storage.openProject(parameters.projectName, function (err, project) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    result.project = project;
                    _persistEmptyProject(parameters, result, gmeConfig, callback);
                });
            });
        });

    };

    function _persistEmptyProject(parameters, result, gmeConfig, callback) {
        var core = parameters.core || new Core(result.project, {globConf: gmeConfig});

        result.core = core;
        result.rootNode = result.core.createNode();

        result.core.persist(result.rootNode, function (err) {
            if (err) {
                callback(err);
                return;
            }

            result.project.makeCommit([], result.core.getHash(result.rootNode), 'create empty project', function (err, commitHash) {
                if (err) {
                    callback(err);
                    return;
                }
                result.commitHash = commitHash;

                result.project.setBranchHash('master', '', result.commitHash, function (err) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    callback(null);
                });
            });
        });
    };

    return openContext;
});