/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    if (!self.moto) self.moto = {};
    if (self.moto.KV) return;

    /**
     * @param {String} dbname
     * @param {number} [version]
     * @constructor
     */
    function KV() {
        this.__data__ = {};
        this.__mem__ = true;
    }

    var KP = KV.prototype;

    KP.getItem = function(key) {
        return this[key];
    };

    KP.setItem = function(key, val) {
        this.__data__[key] = val;
        this[key] = val;
    };

    KP.removeItem = function(key) {
        delete this.__data__[key];
    };

    KP.clear = function() {
        var d = this.__data__, key;
        for (key in d) {
            if (d.hasOwnProperty(key)) {
                delete d[key];
                delete this[key];
            }
        }
    };

    try {
        self.moto.KV = self.localStorage;
        self.moto.KV.setItem('__test', 1);
        self.moto.KV.getItem('__test');
    } catch (e) {
        self.moto.KV = new KV();
        let msg = "in private or restricted browsing mode. local storage blocked. application may not function.";
        console.log(msg);
        alert(msg);
    }

})();
