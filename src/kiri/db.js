/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    const KIRI = self.kiri;

    class Catalog {
        constructor(motodb, options) {
            let store = this;
            this.db = motodb;
            this.files = {};
            this.listeners = [];
            this.options = options || {};
            this.deferredHandler = null;
            this.refresh();
        }

        setOptions(options) {
            this.options = options;
            return this;
        }

        refresh() {
            let store = this;
            store.db.get('files', function(files) {
                if (files) {
                    store.files = files;
                    notifyFileListeners(store);
                }
            });
        };

        wipe() {
            let key, files = this.files;
            for (key in files) {
                if (files.hasOwnProperty(key)) this.deleteFile(key);
            }
        };

        fileList() {
            return this.files;
        };

        addFileListener(listener) {
            if (!this.listeners.contains(listener)) {
                this.listeners.push(listener);
                listener(this.files);
            }
        };

        removeFileListener(listener) {
            this.listeners.remove(listener);
        };

        decimate(vertices, callback) {
            let options = this.options;
            if (vertices.length < (options.threshold || 500000)) {
                return callback(vertices);
            }
            KIRI.work.decimate(vertices, this.options, function(reply) {
                callback(reply);
            });
        };

        setDeferredHandler(handler) {
            this.deferredHandler = handler;
        };

        putDeferred(name, mark) {
            // triggers refresh callback
            this.files[name] = {
                deferred: mark
            };
            saveFileList(this);
        };

        /**
         * @param {String} name
         * @param {Float32Array} vertices
         * @param {Function} [callback]
         */
        putFile(name, vertices, callback) {
            let store = this;
            store.db.put('file-'+name, vertices, function(ok) {
                if (ok) {
                    store.files[name] = {
                        vertices: vertices.length/3,
                        updated: new Date().getTime()
                    };
                    saveFileList(store);
                    store.decimate(vertices, function(decimated) {
                        store.db.put('fdec-'+name, decimated);
                        if (callback) callback(decimated);
                    });
                } else if (callback) callback(ok);
            });
        };

        rename(name, newname, callback) {
            if (!this.files[name]) return callback({error: 'no such file'});
            if (!newname || newname == name) return callback({error: 'invalid new name'});
            let done = 0;
            let error = [];
            let store = this;
            function complete(ok, err) {
                if (err) error.push(err);
                if (++done === 2) {
                    store.files[newname] = store.files[name];
                    delete store.files[name];
                    saveFileList(store);
                    store.db.remove(`fdec-${name}`);
                    store.db.remove(`file-${name}`);
                    callback(error.length ? {error} : {});
                }
            }
            store.db.get(`fdec-${name}`, (vertices) => {
                if (!vertices) return complete(false, 'no decimation');
                store.db.put(`fdec-${newname}`, vertices, complete);
            });
            store.db.get(`file-${name}`, (vertices) => {
                if (!vertices) return complete(false, 'no raw file');
                store.db.put(`file-${newname}`, vertices, complete);
            });
        };

        /**
         * @param {String} name
         * @param {Function} callback
         */
        getFile(name, callback) {
            let store = this,
                rec = store.files[name];
            if (rec && rec.deferred) {
                if (store.deferredHandler) return store.deferredHandler(rec.deferred, name, callback);
                return callback();
            }
            this.db.get('fdec-'+name, function(vertices) {
                if (vertices) {
                    callback(vertices);
                } else {
                    store.db.get('file-'+name, function(vertices) {
                        if (vertices) {
                            store.decimate(vertices, function(decimated) {
                                store.db.put('fdec-'+name, decimated);
                                callback(vertices);
                            });
                        } else {
                            return callback();
                        }
                    });
                }
            });
        };

        /**
         * @param {String} name
         * @param {Function} callback
         */
        deleteFile(name, callback) {
            let store = this;
            if (store.files[name]) {
                delete store.files[name];
                store.db.remove('fdec-'+name);
                store.db.remove('file-'+name, function(ok) {
                    saveFileList(store);
                    if (callback) callback(ok);
                });
                return;
            }
            if (callback) callback(false);
        };
    }

    function saveFileList(store) {
        store.db.put('files', store.files);
        notifyFileListeners(store);
    }

    function notifyFileListeners(store) {
        for (let i=0; i<store.listeners.length; i++) {
            store.listeners[i](store.files);
        }
    }

    KIRI.openCatalog = function(motodb, options) {
        return new Catalog(motodb, options);
    };

})();
