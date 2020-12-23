/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    const KIRI = self.kiri,
        BASE = self.base,
        DBUG = BASE.debug,
        UTIL = BASE.util,
        POLY = BASE.polygons,
        FDM = KIRI.driver.FDM = {
            // init,           // src/mode/fdm/client.js
            // slice,          // src/mode/fdm/slice.js
            // prepare,        // src/mode/fdm/prepare.js
            // export,         // src/mode/fdm/export.js
            fixExtruders
        };

    function fixExtruders(settings) {
        Object.entries(settings.widget).forEach(arr => {
            let [wid,val] = arr;
            let dext = settings.device.extruders[val.extruder];
            if (!dext) {
                settings.widget[wid].extruder = 0;
            }
        });
        return settings;
    }

    // customer gcode post function for XYZ daVinci Mini W
    self.kiri_fdm_xyz_mini_w = function(gcode, options) {
        return btoa("; filename = kirimoto.gcode\n; machine = dv1MW0A000\n" + gcode);
    };

    // defer loading until KIRI.client and KIRI.worker exist
    KIRI.loader.push(function(API) {

        if (KIRI.client)
        // FDM.support_generate = KIRI.client.fdm_support_generate = function(ondone) {
        FDM.support_generate = function(ondone) {
            KIRI.client.sync();
            let settings = API.conf.get();
            let widgets = API.widgets.map();
            send('fdm_support_generate', { settings }, (gen) => {
                for (let g of gen) g.widget = widgets[g.id];
                ondone(gen);
            });
        };

        if (KIRI.worker)
        KIRI.worker.fdm_support_generate = function(data, send) {
            const { settings } = data;
            const widgets = Object.values(cache);
            const fresh = widgets.filter(widget => FDM.supports(settings, widget));
            send.done(KIRI.codec.encode(fresh.map(widget => { return {
                id: widget.id,
                supports: widget.supports,
            } } )));
        };

    });

})();
