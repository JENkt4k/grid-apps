/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    let KIRI = self.kiri,
        BASE = self.base,
        UTIL = BASE.util,
        POLY = BASE.polygons,
        FDM = KIRI.driver.FDM,
        newPoint = BASE.newPoint,
        newPolygon = BASE.newPolygon;

    /**
     * DRIVER PRINT CONTRACT
     *
     * @param {Function} update progress callback
     * @returns {Object[]} returns array of render objects
     */
    FDM.prepare = function(widgets, settings, update) {
        settings = FDM.fixExtruders(settings);

        let device = settings.device,
            nozzle = device.extruders[0].extNozzle,
            process = settings.process,
            bounds = settings.bounds,
            mode = settings.mode,
            output = [],
            printPoint = newPoint(0,0,0),
            firstLayerHeight = process.firstSliceHeight || process.sliceHeight,
            maxLayers = 0,
            layer = 0,
            zoff = 0,
            meshIndex,
            lastIndex,
            closest,
            mindist,
            minidx,
            find,
            layerout = [],
            slices = [],
            sliceEntry,
            print = self.worker.print = KIRI.newPrint(settings, widgets),
            isThin = settings.controller.lineType === "line",
            isFlat = settings.controller.lineType === "flat";

        // TODO pick a widget with a slice on the first layer and use that nozzle
        // create brim, skirt, raft if specificed in FDM mode (code shared by laser)
        if (process.outputBrimCount || process.outputRaft) {
            let brims = [],
                offset = process.outputBrimOffset || (process.outputRaft ? 4 : 0);

            // compute first brim
            widgets.forEach(function(widget) {
                let tops = [];
                // collect top outer polygons
                widget.slices[0].tops.forEach(function(top) {
                    tops.push(top.poly.clone());
                });
                // collect support polygons
                if (widget.slices[0].supports)
                widget.slices[0].supports.forEach(function(support) {
                    tops.push(support.clone());
                });
                // nest and offset tops
                POLY.nest(tops).forEach(function(poly) {
                    poly.offset(-offset + nozzle / 2).forEach(function(brim) {
                        brim.move(widget.mesh.position);
                        brims.push(brim);
                    });
                });
            });

            // merge brims
            brims = POLY.union(brims);

            // if brim is offset, over-expand then shrink to induce brims to merge
            if (offset && brims.length) {
                let extra = process.sliceSupportExtra + 2;
                let zheight = brims[0].getZ();
                brims = POLY.expand(brims, extra, zheight, null, 1);
                brims = POLY.expand(brims, -extra, zheight, null, 1);
            }

            // if raft is specified
            if (process.outputRaft) {
                let offset = newPoint(0,0,0),
                    height = nozzle;

                // cause first point of raft to be used
                printPoint = null;

                let raft = function(height, angle, spacing, speed, extrude) {
                    let slice = kiri.newSlice(zoff + height / 2);
                    brims.forEach(function(brim) {
                        // use first point of first brim as start point
                        if (printPoint === null) printPoint = brim.first();
                        let t = slice.addTop(brim);
                        t.traces = [ brim ];
                        t.inner = POLY.expand(t.traces, -nozzle * 0.5, 0, null, 1);
                        // tweak bounds for fill to induce an offset
                        t.inner[0].bounds.minx -= nozzle/2;
                        t.inner[0].bounds.maxx += nozzle/2;
                        t.fill_lines = POLY.fillArea(t.inner, angle, spacing, []);
                    })
                    offset.z = slice.z;
                    printPoint = print.slicePrintPath(slice, printPoint, offset, layerout, {
                        speed: speed,
                        mult: extrude,
                    });
                    layerout.height = height;
                    output.append(layerout);

                    layerout = [];
                    zoff += height;
                };

                raft(nozzle/1, process.sliceFillAngle + 0 , nozzle * 6.0, process.firstLayerRate / 3, 4);
                raft(nozzle/1, process.sliceFillAngle + 0 , nozzle * 6.0, process.firstLayerRate / 2, 4);
                raft(nozzle/2, process.sliceFillAngle + 90, nozzle * 3.0, process.outputFeedrate, 2.5);
                raft(nozzle/2, process.sliceFillAngle + 0 , nozzle * 1.0, process.outputFeedrate, 1.5);
                raft(nozzle/2, process.sliceFillAngle + 0 , nozzle * 1.0, process.outputFeedrate, 1.0);

                // raise first layer off raft slightly to lessen adhesion
                firstLayerHeight += process.outputRaftSpacing || 0;

                // retract after last raft layer
                output.last().last().retract = true;
            }
            // raft excludes brims
            else
            // if using brim vs raft
            if (process.outputBrimCount) {
                let polys = [],
                    preout = [];

                // expand specified # of brims
                brims.forEach(function(brim) {
                    POLY.offset([brim], nozzle, {
                        outs: polys,
                        flat: true,
                        count: process.outputBrimCount,
                        z: firstLayerHeight / 2
                    });
                });

                // output brim points
                printPoint = print.poly2polyEmit(polys, printPoint, function(poly, index, count, startPoint) {
                    return print.polyPrintPath(poly, startPoint, preout, {
                        rate: process.firstLayerRate,
                        onfirst: function(point) {
                            if (preout.length && point.distTo2D(startPoint) > 2) {
                                // retract between brims
                                preout.last().retract = true;
                            }
                        }
                    });
                });

                print.addPrintPoints(preout, layerout, null);

                if (preout.length) {
                    // retract between brims and print
                    preout.last().retract = true;
                }
            }
            // recompute bounds for purge block offsets
            let bbounds = BASE.newBounds();
            brims.forEach(brim => {
                bbounds.merge(brim.bounds);
            });
            bounds.min.x = Math.min(bounds.min.x, bbounds.minx);
            bounds.min.y = Math.min(bounds.min.y, bbounds.miny);
            bounds.max.x = Math.max(bounds.max.x, bbounds.maxx);
            bounds.max.y = Math.max(bounds.max.y, bbounds.maxy);
        }

        // synthesize a support widget, if needed
        {
            let swidget = KIRI.newWidget();
            let sslices = swidget.slices = [];
            widgets.forEach(function(widget) {
                let slices = widget.slices;
                while (sslices.length < slices.length) {
                    let sslice = KIRI.newSlice(slices[sslices.length].z);
                    sslice.extruder = process.sliceSupportNozzle;
                    sslices.push(sslice);
                }
                slices.forEach((slice,index) => {
                    if (!slice.supports) return;
                    if (!sslices[index].supports) {
                        sslices[index].supports = [];
                    }
                    sslices[index].supports.appendAll(slice.supports.map(p => {
                        if (p.fill) p.fill.forEach(p => p.move(widget.track.pos));
                        return p.move(widget.track.pos);
                    }));
                });
            });
            swidget.support = true;
            swidget.mesh = { widget: swidget }; // fake for lookup
            settings.widget[swidget.id] = { extruder: process.sliceSupportNozzle };
            widgets.push(swidget);
        }

        let extruders = [];
        let extcount = 0;

        // find max layers (for updates)
        // generate list of used extruders for purge blocks
        widgets.forEach(function(widget) {
            maxLayers = Math.max(maxLayers, widget.slices.length);
            let extruder = (settings.widget[widget.id] || {}).extruder || 0;
            if (!extruders[extruder]) {
                extruders[extruder] = {};
                extcount++;
            }
        });

        let blokpos, walkpos, blok;
        if (bounds.min.x < bounds.min.y) {
            let dx = ((bounds.max.x - bounds.min.x) - (extcount * 10)) / 2 + 5;
            blokpos = { x:bounds.min.x + dx, y: bounds.max.y + 5};
            walkpos  = { x:10, y:0 };
            blok = { x:9, y:4 };
        } else {
            let dy = ((bounds.max.y - bounds.min.y) - (extcount * 10)) / 2 + 5;
            blokpos = { x:bounds.max.x + 5, y: bounds.min.y + dy};
            walkpos  = { x:0, y:10 };
            blok = { x:4, y:9 };
        }

        // compute purge blocks
        extruders = extruders.map((ext,i) => {
            if (!ext) return ext;
            let noz = device.extruders[i].extNozzle,
                pos = {x:blokpos.x, y:blokpos.y, z:0},
                rec = {
                    extruder: i,
                    poly: newPolygon().centerSpiral(pos, blok.x, blok.y, noz*2, 3)
                };
            blokpos.x += walkpos.x;
            blokpos.y += walkpos.y;
            return rec;
        });

        // generate purge block for given nozzle
        function purge(nozzle, track, layer, start, z, using) {
            if (extcount < 2) {
                return start;
            }
            let rec = track[nozzle];
            if (rec) {
                track[nozzle] = null;
                if (layer.last()) layer.last().retract = true;
                start = print.polyPrintPath(rec.poly.clone().setZ(z), start, layer, {
                    tool: using || nozzle,
                    open: true,
                    simple: true
                });
                layer.last().retract = true;
                return start;
            } else {
                console.log({already_purged: nozzle, from: track, layer});
                return start;
            }
        }

        // increment layer count until no widget has remaining slices
        for (;;) {
            // create list of mesh slice arrays with their platform offsets
            for (meshIndex = 0; meshIndex < widgets.length; meshIndex++) {
                let mesh = widgets[meshIndex].mesh;
                if (!mesh.widget) {
                    continue;
                }
                let mslices = mesh.widget.slices;
                if (mslices && mslices[layer]) {
                    slices.push({
                        slice: mslices[layer],
                        offset: mesh.position || {x:0, y:0, z:0},
                        widget: mesh.widget
                    });
                }
            }

            // exit if no slices
            if (slices.length === 0) {
                break;
            }

            // track purge blocks generated for each layer
            let track = extruders.slice();
            let lastOut;
            let lastExt;

            // iterate over layer slices, find closest widget, print, eliminate
            for (;;) {
                closest = null;
                mindist = Infinity;
                let order = [];
                // select slices of the same extruder type first then distance
                for (meshIndex = 0; meshIndex < slices.length; meshIndex++) {
                    sliceEntry = slices[meshIndex];
                    if (sliceEntry) {
                        find = sliceEntry.slice.findClosestPointTo(printPoint.sub(sliceEntry.offset));
                        if (find) {
                            let ext = sliceEntry.slice.extruder;
                            let lex = lastOut ? lastOut.extruder : ext;
                            let dst = Math.abs(find.distance);
                            if (ext !== lex) dst *= 10000;
                            order.push({dst,sliceEntry,meshIndex});
                        }
                    }
                }
                order.sort((a,b) => {
                    return a.dst - b.dst;
                });
                if (order.length) {
                    let find = order.shift();
                    closest = find.sliceEntry;
                    minidx = find.meshIndex;
                }

                if (!closest) {
                    if (sliceEntry) lastOut = sliceEntry.slice;
                    break;
                }
                // retract between widgets
                if (layerout.length && minidx !== lastIndex) {
                    layerout.last().retract = true;
                }
                layerout.height = layerout.height || closest.slice.height;
                slices[minidx] = null;
                closest.offset.z = zoff;
                // detect extruder change and print purge block
                if (!lastOut || lastOut.extruder !== closest.slice.extruder) {
                    printPoint = purge(closest.slice.extruder, track, layerout, printPoint, closest.slice.z);
                }
                // output seek to start point between mesh slices if previous data
                printPoint = print.slicePrintPath(
                    closest.slice,
                    printPoint.sub(closest.offset),
                    closest.offset,
                    layerout,
                    {
                        first: closest.slice.index === 0,
                        support: closest.widget.support
                    }
                );
                lastOut = closest.slice;
                lastExt = lastOut.ext
                lastIndex = minidx;
            }

            // if a declared extruder isn't used in a layer, use selected
            // extruder to fill the relevant purge blocks for later support
            track.forEach(ext => {
                if (ext) {
                    printPoint = purge(ext.extruder, track, layerout, printPoint, lastOut.z, lastExt);
                }
            });

            // if layer produced output, append to output array
            if (layerout.length) output.append(layerout);

            // retract after last layer
            if (layer === maxLayers && layerout.length) {
                layerout.last().retract = true;
            }

            // notify progress
            layerout.layer = layer++;
            update((layer / maxLayers) * 0.5, "prepare");

            slices = [];
            layerout = [];
            lastOut = undefined;
        }

        print.output = output;
        print.render = FDM.prepareRender(output, (progress, layer) => {
            update(0.5 + progress * 0.5, "render", layer);
        }, { tools: device.extruders, thin: isThin, flat: isFlat, fdm: true });
        return print.render;
    };

    class Counter {
        constructor() {
            this.map = {};
            this.total = 0;
        }
        put(key) {
            const map = this.map;
            const kp = key || 'bad';
            map[kp] = (map[kp] || 0) + 1;
            this.total++;
        }
        get() {
            return { map: this.map, total: this.total };
        }
    }

    FDM.rateToColor = function(rate, max) {
        return currentColorFunction(rate/max, 1, 0.85);
    };

    FDM.prepareRender = function(levels, update, options) {
        levels = levels.filter(level => level.length);
        if (levels.length === 0) {
            self.worker.print.maxSpeed = 0;
            return [];
        }

        const opts = options || {};
        const tools = opts.tools || {};
        const flat = opts.flat;
        const thin = opts.thin && !flat;
        const ckspeed = opts.speed !== false;
        const moveColor = opts.move >= 0 ? opts.move : 0xaaaaaa;
        const printColor = opts.print >= 0 ? opts.print : 0x777700;
        const layers = [];

        const moveOpt = {
            face: moveColor,
            line: flat ? 1 : moveColor,
            opacity: flat ? 0.5 : 1
        };
        const printOpt = {
            face: printColor,
            line: flat ? 1 : printColor,
            opacity: flat ? 0.5 : 1
        };

        const maxspd = levels.map(level => {
            return level.map(o => o.speed || 0).reduce((a, v) => Math.max(a,v));
        }).reduce((a, v) => Math.max(a, v)) + 1;

        // for reporting
        self.worker.print.maxSpeed = maxspd - 1;
        self.worker.print.thinColor = thin;
        self.worker.print.flatColor = flat;

        let lastEnd = null;
        let lastOut = null;
        let current = null;
        let retracted = false;

        function color(point) {
            return FDM.rateToColor(point.speed, maxspd);
        }

        levels.forEach((level, index) => {
            const prints = {};
            const moves = [];
            const heads = [];
            const retracts = [];
            const engages = [];
            const output = new KIRI.Layers();
            layers.push(output);

            const pushPrint = (toolid, poly) => {
                toolid = toolid || 0;
                const array = prints[toolid] = prints[toolid] || [];
                const tool = tools[toolid] || {};
                array.width = (tool.extNozzle || 1) / 2;
                array.push(poly);
                emits++;
            };

            let height = level.height / 2;
            let width = 1;
            let emits = 0;

            level.forEach((out,oi) => {
                if (retracted && out.emit) {
                    retracted = false;
                    engages.push(lastOut.point);
                }
                if (out.retract) {
                    retracts.push(out.point);
                    retracted = true;
                }
                if (!out.point) {
                    // in cam mode, these are drilling or dwell ops
                    return;
                }

                if (lastOut) {
                    if (lastOut.emit !== out.emit) {
                        heads.push({p1: lastOut.point, p2: out.point});
                    }
                    const op = out.point, lp = lastOut.point;
                    // const moved = Math.max(
                    //     Math.abs(op.x - lp.x),
                    //     Math.abs(op.y - lp.y),
                    //     Math.abs(op.z - lp.z));
                    // if (moved < 0.0001) return;
                    if (out.emit) {
                        if (!lastOut.emit || (ckspeed && out.speed !== lastOut.speed) || lastEnd) {
                            current = newPolygon().setOpen();
                            current.push(lastOut.point);
                            current.color = color(out);
                            pushPrint(out.tool, current);
                        }
                        current.push(out.point);
                    } else {
                        if (lastOut.emit || lastEnd) {
                            current = newPolygon().setOpen();
                            current.push(lastOut.point);
                            moves.push(current);
                        }
                        current.push(out.point);
                    }
                    lastEnd = null;
                } else {
                    current = newPolygon().setOpen();
                    current.push(out.point);
                    if (out.emit) {
                        current.color = color(out);
                        pushPrint(out.tool, current);
                    } else {
                        moves.push(current);
                    }
                }
                lastOut = out;
            });
            // all moves with an emit at the very end (common in contouring)
            if (lastOut.emit && !emits) {
                pushPrint(lastOut.tool, current)
            }
            lastEnd = lastOut;
            if (retracts.length) {
                output
                    .setLayer('retract', { line: 0x550000, face: 0xff0000, opacity: 0.5 }, true)
                    .addAreas(retracts.map(point => {
                        return newPolygon().centerCircle(point, 0.2, 16).setZ(point.z + 0.01);
                    }), { outline: true });
            }
            if (engages.length) {
                output
                    .setLayer('engage', { line: 0x005500, face: 0x00ff00, opacity: 0.5 }, true)
                    .addAreas(engages.map(point => {
                        return newPolygon().centerCircle(point, 0.2, 16).setZ(point.z + 0.01);
                    }), { outline: true });
            }
            if (heads.length) {
                output
                    .setLayer('arrows', { face: moveColor, line: 0x555555, opacity: 0.5 }, true)
                    .addAreas(heads.map(points => {
                        const {p1, p2} = points;
                        const slope = p2.slopeTo(p1);
                        const s1 = BASE.newSlopeFromAngle(slope.angle + 20);
                        const s2 = BASE.newSlopeFromAngle(slope.angle - 20);
                        const p3 = points.p2.projectOnSlope(s1, 0.4);
                        const p4 = points.p2.projectOnSlope(s2, 0.4);
                        return newPolygon().addPoints([p2,p3,p4]).setZ(p2.z + 0.01);
                    }), { thin: true, outline: true });
            }
            output
                .setLayer(opts.other || 'move', moveOpt, opts.moves !== true)
                .addPolys(moves, { thin: true, z: opts.z });
            Object.values(prints).forEach(array => {
                array.forEach(poly => {
                    if (flat && poly.appearsClosed()) {
                        poly.setClosed();
                        poly.points.pop();
                        poly.length--;
                    }
                    output
                    .setLayer(opts.action || 'print', printOpt)
                    .addPolys([ poly ],
                        thin ? { thin, z: opts.z, color: poly.color } :
                        flat ? {
                            flat, z: opts.z, color: poly.color,
                            outline: true, offset: array.width, open: poly.open  } :
                        {
                            offset: array.width, height, z: opts.z,
                            color: { face: poly.color, line: poly.color }
                        })
                });
            });

            update(index / levels.length, output);
        });

        return layers;
    }

    const colorFunctions = {
        default: hsv2rgb.bind({ seg: 5, fn: color5 }),
        dark: hsv2rgb.bind({ seg: 3, fn: color3 })
    };

    let currentColorFunction = colorFunctions.default;

    // hsv values all = 0 to 1
    function hsv2rgb(h, s, v) {
        const div = this.seg;
        const ss = 1 / div;
        const seg = Math.floor(h / ss);
        const rem = h - (seg * ss);
        const inc = (rem / ss);
        const dec = (1 - inc);
        const rgb = {r: 0, g: 0, b: 0};
        this.fn(rgb, inc, seg);
        rgb.r = ((rgb.r * 255 * v) & 0xff) << 16;
        rgb.g = ((rgb.g * 255 * v) & 0xff) << 8;
        rgb.b = ((rgb.b * 255 * v) & 0xff);
        return rgb.r | rgb.g | rgb.b;
    }

    function color5(rgb, inc, seg) {
        const dec = 1 - inc;
        switch (seg) {
            case 0:
                rgb.r = 1;
                rgb.g = inc;
                rgb.b = 0;
                break;
            case 1:
                rgb.r = dec;
                rgb.g = 1;
                rgb.b = 0;
                break;
            case 2:
                rgb.r = 0;
                rgb.g = dec;
                rgb.b = inc;
                break;
            case 3:
                rgb.r = inc;
                rgb.g = 0;
                rgb.b = 1;
                break;
            case 4:
                rgb.r = dec;
                rgb.g = 0;
                rgb.b = dec;
                break;
        }
    }

    function color3(rgb, inc, seg) {
        const dec = 1 - inc;
        switch (seg) {
            case 0:
                rgb.r = dec;
                rgb.g = inc;
                rgb.b = 0;
                break;
            case 1:
                rgb.r = 0;
                rgb.g = dec;
                rgb.b = inc;
                break;
            case 2:
                rgb.r = inc/2;
                rgb.g = 0;
                rgb.b = dec/2 + 0.5;
                break;
        }
    }

})();
