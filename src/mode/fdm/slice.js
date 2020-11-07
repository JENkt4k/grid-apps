/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    const KIRI = self.kiri,
        BASE = self.base,
        POLY = BASE.polygons,
        UTIL = BASE.util,
        CONF = BASE.config,
        FDM = KIRI.driver.FDM,
        SLICER = KIRI.slicer,
        fillArea = POLY.fillArea,
        newPoint = BASE.newPoint,
        newSlice = KIRI.newSlice,
        FILL = KIRI.fill,
        FILLFIXED = KIRI.fill_fixed,
        COLOR = {
            shell: { face: 0x003399, line: 0x003399, opacity: 1 },
            fill: { face: 0x003399, line: 0x003399, opacity: 1 },
            infill: { face: 0x003399, line: 0x003399, opacity: 1 },
            support: { face: 0x993399, line: 0x006699, opacity: 1 }
        };

    let isThin = false; // force line rendering
    let offset = 0; // poly line generation offsets

    function thin(opt) {
        return isThin ? null : opt;
    }

    /**
     * DRIVER SLICE CONTRACT
     *
     * Given a widget and settings object, call functions necessary to produce
     * slices and then the computations using those slices. This function is
     * designed to run client or server-side and provides all output via
     * callback functions.
     *
     * @param {Object} settings
     * @param {Widget} Widget
     * @param {Function} onupdate (called with % complete and optional message)
     * @param {Function} ondone (called when complete with an array of Slice objects)
     */
    FDM.slice = function(settings, widget, onupdate, ondone) {
        FDM.fixExtruders(settings);
        let spro = settings.process,
            sdev = settings.device,
            update_start = Date.now(),
            minSolid = spro.sliceSolidMinArea,
            solidLayers = spro.sliceSolidLayers,
            vaseMode = spro.sliceFillType === 'vase',
            doSolidLayers = solidLayers && !vaseMode,
            metadata = settings.widget[widget.id] || {},
            extruder = metadata.extruder || 0,
            sliceHeight = spro.sliceHeight,
            nozzleSize = sdev.extruders[extruder].extNozzle,
            firstOffset = nozzleSize / 2,
            shellOffset = nozzleSize,
            fillOffsetMult = 1.0 - bound(spro.sliceFillOverlap, 0, 0.8),
            fillSpacing = nozzleSize,
            fillOffset = nozzleSize * fillOffsetMult,
            sliceFillAngle = spro.sliceFillAngle,
            view = widget.mesh && widget.mesh.newGroup ? widget.mesh.newGroup() : null;

        isThin = settings.controller.thinRender;
        offset = nozzleSize / 2;

        if (!(sliceHeight > 0 && sliceHeight < 100)) {
            return ondone("invalid slice height");
        }
        if (!(nozzleSize >= 0.01 && nozzleSize < 100)) {
            return ondone("invalid nozzle size");
        }

        if (spro.firstSliceHeight === 0) {
            spro.firstSliceHeight = sliceHeight;
        }

        if (spro.firstSliceHeight < sliceHeight) {
            DBUG.log("invalid first layer height < slice height");
            DBUG.log("reverting to slice height");
            spro.firstSliceHeight = sliceHeight;
        }

        SLICER.sliceWidget(widget, {
            height: sliceHeight,
            minHeight: sliceHeight > spro.sliceMinHeight ? spro.sliceMinHeight : 0,
            firstHeight: spro.firstSliceHeight,
            view: view
        }, onSliceDone, onSliceUpdate);

        function onSliceUpdate(update) {
            return onupdate(0.0 + update * 0.5);
        }

        function onSliceDone(slices) {
            // slices = slices.filter(slice => slice.tops.length);
            // remove all empty slices above part but leave below
            // for multi-part (multi-extruder) setups where the void is ok
            let found = false;
            slices = slices.reverse().filter(slice => {
                if (slice.tops.length) {
                    return found = true;
                } else {
                    return found;
                }
            }).reverse();

            widget.slices = slices;

            if (!slices) {
                return;
            }

            if (slices.length > 150) {
                isThin = true;
            }

            // calculate % complete and call onupdate()
            function doupdate(index, from, to, msg) {
                onupdate(0.5 + (from + ((index/slices.length) * (to-from))) * 0.5, msg);
            }

            // for each slice, performe a function and call doupdate()
            function forSlices(from, to, fn, msg) {
                slices.forEach(function(slice) {
                    fn(slice);
                    doupdate(slice.index, from, to, msg)
                });
            }

            // do not hint polygin fill longer than a max span length
            CONF.hint_len_max = UTIL.sqr(spro.sliceBridgeMax);

            // reset for solids, support projections
            // and other annotations
            slices.forEach(function(slice) {
                slice.extruder = extruder;
                slice.solids = [];
            });

            let supportEnabled = spro.sliceSupportEnable && spro.sliceSupportDensity > 0.0,
                supportMinArea = spro.sliceSupportArea;

            // create shells and diff inner fillable areas
            forSlices(0.0, 0.2, function(slice) {
                let solid = (
                        slice.index < spro.sliceBottomLayers ||
                        slice.index > slices.length - spro.sliceTopLayers-1 ||
                        spro.sliceFillSparse > 0.95
                    ) && !vaseMode;
                doShells(slice, spro.sliceShells, firstOffset, shellOffset, fillOffset, {
                    vase: vaseMode,
                    thin: spro.detectThinWalls
                });
                if (solid) {
                    doSolidLayerFill(slice, fillSpacing, sliceFillAngle);
                }
                sliceFillAngle += 90.0;
            }, "offsets");

            // calculations only relevant when solid layers are used
            if (doSolidLayers) {
                forSlices(0.2, 0.34, function(slice) {
                    if (slice.index > 0) doDiff(slice, minSolid);
                }, "diff");
                forSlices(0.34, 0.35, function(slice) {
                    projectFlats(slice, solidLayers);
                    projectBridges(slice, solidLayers);
                }, "solids");
                forSlices(0.35, 0.5, function(slice) {
                    doSolidsFill(slice, fillSpacing, sliceFillAngle, minSolid);
                    sliceFillAngle += 90.0;
                }, "solids");
            }

            // sparse layers only present when non-vase mose and sparse % > 0
            if (!vaseMode && spro.sliceFillSparse > 0.0) {
                forSlices(0.5, 0.7, function(slice) {
                    doSparseLayerFill(slice, {
                        settings: settings,
                        process: spro,
                        device: sdev,
                        lineWidth: nozzleSize,
                        spacing: fillOffset,
                        density: spro.sliceFillSparse,
                        bounds: widget.getBoundingBox(),
                        height: sliceHeight,
                        type: spro.sliceFillType
                    });
                }, "infill");
            }

            // calculations only relevant when supports are enabled
            if (supportEnabled) {
                forSlices(0.7, 0.8, function(slice) {
                    if (slice.index > 0) doSupport(slice, spro.sliceSupportOffset, spro.sliceSupportSpan, spro.sliceSupportExtra, supportMinArea, spro.sliceSupportSize, spro.sliceSupportOffset, spro.sliceSupportGap);
                }, "support");
                forSlices(0.8, 0.9, function(slice) {
                    doSupportFill(slice, nozzleSize, spro.sliceSupportDensity, supportMinArea);
                }, "support");
            }

            forSlices(0.9, 1.0, function(slice) {
                doRender(slice);
            }, "render");

            // let polish = spro.polishLayers;
            // // experimental polishing
            // if (polish) {
            //     let polish_layer = Math.floor(polish);
            //     let polish_step = Math.max(polish - polish_layer || 1, 0.25);
            //     widget.polish = {};
            //     let px = [];
            //     let py = [];
            //     // compute x polishing slices
            //     SLICER.sliceWidget(widget, {
            //         height: nozzleSize * polish_step,
            //         swapX: true,
            //         swapY: false,
            //         simple: true
            //     }, (polish_done => {
            //         widget.polish.x = polish_done
            //             .filter(s => s.groups.length)
            //             .map(s => s.groups)
            //             .forEach(p => px.appendAll(p));
            //     }), (polish_update) => {
            //         // console.log({polish_update});
            //     });
            //     // compute y polishing slices
            //     SLICER.sliceWidget(widget, {
            //         height: nozzleSize * polish_step,
            //         swapX: false,
            //         swapY: true,
            //         simple: true
            //     }, (polish_done => {
            //         widget.polish.y = polish_done
            //             .filter(s => s.groups.length)
            //             .map(s => s.groups)
            //             .forEach(p => py.appendAll(p));
            //     }), (polish_update) => {
            //         // console.log({polish_update});
            //     });
            //     // apply polishing finishes to layers
            //     forSlices(1.0, 1.0, (slice) => {
            //         if (polish_layer >= 2) {
            //             let sai = (slice.index - polish_layer);
            //             if (sai % (polish_layer-1) !== 0) {
            //                 return;
            //             }
            //         }
            //         if (slice.index >= polish_layer) {
            //             let sd = slice;
            //             for (let i=0; i<polish_layer; i++) {
            //                 sd = sd.down;
            //             }
            //             let zb = sd.z;
            //             let zt = slice.z;
            //             let pout = [];
            //             let cont = 0;
            //             [px, py].forEach(pa => {
            //
            //             let polys = [];
            //             pa.forEach(p => {
            //                 // rotate and test for self-intersection (points under model)
            //                 p.ensureXY();
            //                 let ox = p._aligned == 'yz' ? 0.1 : 0;
            //                 let oy = p._aligned == 'yz' ? 0 : 0.1;
            //                 p.forEachPoint(pt => {
            //                     let int = p.intersections(
            //                         pt.offset(ox,oy,0),
            //                         pt.offset(ox*10000,oy*10000,0));
            //                     if (int.length > 0) {
            //                         pt._under = true;
            //                     }
            //                 });
            //                 p.restoreXY();
            //
            //                 let lastp = undefined;
            //                 let poly = [];
            //                 // look for qualifying segments
            //                 p.forEachSegment((p1, p2) => {
            //                     // eliminate segments that projected up
            //                     // intersect with the polygon (bottom faces)
            //                     if (p1._under || p2._under) {
            //                         return;
            //                     }
            //                     // skip when both below layer range
            //                     if (p1.z < zb && p2.z < zb) {
            //                         return;
            //                     }
            //                     // skip when both above layer range
            //                     if (p1.z > zt && p2.z > zt) {
            //                         return;
            //                     }
            //                     // skip vertical
            //                     if (p1.x === p2.x && p1.y === p2.y) {
            //                         return;
            //                     }
            //                     // skip horizontal
            //                     // if (p1.z === p2.z) {
            //                     //     return;
            //                     // }
            //                     // order points lowest to highest
            //                     let swap = false;
            //                     if (p1.z > p2.z) {
            //                         let t = p2;
            //                         p2 = p1;
            //                         p1 = t;
            //                         swap = true;
            //                     }
            //                     let trimlo = false;
            //                     let trimhi = false;
            //                     if (p1.z < zb) {
            //                         trimlo = true;
            //                     }
            //                     if (p2.z > zt) {
            //                         trimhi = true;
            //                     }
            //                     let xaxis = p1.x === p2.x;
            //                     if (xaxis) {
            //                         p1 = BASE.newPoint(p1.y,p1.z,p1.x);
            //                         p2 = BASE.newPoint(p2.y,p2.z,p2.x);
            //                     } else {
            //                         p1 = BASE.newPoint(p1.x,p1.z,p1.y);
            //                         p2 = BASE.newPoint(p2.x,p2.z,p2.y);
            //                     }
            //                     let slope = BASE.newSlope(p1, p2);
            //                     let angle = slope.angle;
            //                     if (angle > 80 && angle < 100) {
            //                         return;
            //                     }
            //                     let len = p1.distTo2D(p2);
            //                     let np1 = p1;
            //                     if (trimlo) {
            //                         let zunder = zb - p1.y;
            //                         let zover = p2.y - zb;
            //                         let zdelt = p2.y - p1.y;
            //                         let pct = zunder / zdelt;
            //                         np1 = p1.follow(slope, len * pct);
            //                     }
            //                     if (trimhi) {
            //                         let zunder = zt - p1.y;
            //                         let zover = p2.y - zt;
            //                         let zdelt = p2.y - p1.y;
            //                         let pct = zover / zdelt;
            //                         p2 = p2.follow(slope.invert(), len * pct);
            //                     }
            //                     p1 = np1;
            //                     if (xaxis) {
            //                         p1 = BASE.newPoint(p1.z,p1.x,p1.y);
            //                         p2 = BASE.newPoint(p2.z,p2.x,p2.y);
            //                     } else {
            //                         p1 = BASE.newPoint(p1.x,p1.z,p1.y);
            //                         p2 = BASE.newPoint(p2.x,p2.z,p2.y);
            //                     }
            //                     if (!lastp) {
            //                         poly.push(p1);
            //                         poly.push(p2);
            //                     } else if (p1.isMergable2D(lastp)) {
            //                     // } else if (p1.isEqual(lastp)) {
            //                         poly.push(p2);
            //                         cont++;
            //                     } else if (poly.length) {
            //                         polys.push(poly);
            //                         poly = [p1, p2];
            //                     }
            //                     lastp = p2;
            //                 });
            //                 if (poly.length) {
            //                     polys.push(poly);
            //                 }
            //             });
            //             pout.push(polys);
            //             polys = [];
            //             });
            //
            //             if (pout.length && slice.tops.length) {
            //                 slice.tops[0].polish = {
            //                     x: pout[0]
            //                         .map(a => BASE.newPolygon(a).setOpen())
            //                         // .filter(p => p.perimeter() > nozzleSize)
            //                         ,
            //                     y: pout[1]
            //                         .map(a => BASE.newPolygon(a).setOpen())
            //                         // .filter(p => p.perimeter() > nozzleSize)
            //                 };
            //             }
            //         }
            //     });
            // }

            // report slicing complete
            ondone();
        }

    }

    function bound(v,min,max) {
        return Math.max(min,Math.min(max,v));
    }

    function doRender(slice) {
        const output = slice.output();

        slice.tops.forEach(top => {
            if (isThin) {
                output
                    .setLayer('slice', { line: 0x000066 })
                    .addPolys(top.poly);
            }

            output
                .setLayer("shells", COLOR.shell)
                .addPolys(top.shells, thin({ offset }));

            // if (isThin && debug) {
            //     slice.output()
            //         .setLayer('offset', { face: 0, line: 0x888888 })
            //         .addPolys(top.fill_off)
            //         .setLayer('last', { face: 0, line: 0x008888 })
            //         .addPolys(top.last)
            //     ;
            // }

            if (top.fill_lines) output
                .setLayer("fill", COLOR.fill)
                .addLines(top.fill_lines, thin({ offset }));

            if (top.fill_sparse) output
                .setLayer("infill", COLOR.infill)
                .addPolys(top.fill_sparse, thin({ offset }))

            // emit solid areas
            // if (isThin && debug) {
            //     render.setLayer("solids", { face: 0x00dd00 }).addAreas(solids);
            // }
        });

        if (slice.supports) output
            .setLayer("support", COLOR.support)
            .addPolys(slice.supports, thin({ offset }));

        if (slice.supports) slice.supports.forEach(poly => {
            output
                .setLayer("support", COLOR.support)
                .addLines(poly.fill, thin({ offset }));
        })

        // if (isThin && debug) {
        //     top.output()
        //         .setLayer("bridges", { face: 0x00aaaa, line: 0x00aaaa })
        //         .addAreas(bridges)
        //
        //     down.output()
        //         .setLayer("flats", { face: 0xaa00aa, line: 0xaa00aa })
        //         .addAreas(flats)
        // }
    }

    /**
     * Compute offset shell polygons. For FDM, the first offset is usually half
     * of the nozzle width.  Each subsequent offset is a full nozzle width.  User
     * parameters control tweaks to these numbers to allow for better shell bonding.
     * The last shell generated is a "fillOffset" shell.  Fill lines are clipped to
     * this polygon.  Adjusting fillOffset controls bonding of infill to the shells.
     *
     * @param {number} count
     * @param {number} offset1 first offset
     * @param {number} offsetN all subsequent offsets
     * @param {number} fillOffset
     * @param {Obejct} options
     */
    function doShells(slice, count, offset1, offsetN, fillOffset, options) {
        const opt = options || {};

        slice.tops.forEach(function(top) {
            let top_poly = [ top.poly ];

            if (slice.index === 0) {
                // console.log({slice_top_0: top_poly, count});
                // segment polygon
            }

            if (opt.vase) {
                // remove top poly inners in vase mode
                top.poly = top.poly.clone(false);
            }

            top.shells = [];
            top.fill_off = [];
            top.fill_lines = [];

            let last = [],
                gaps = [],
                z = top.poly.getZ();

            if (count) {
                // permit offset of 0 for laser and drag knife
                if (offset1 === 0 && count === 1) {
                    last = top_poly.clone(true);
                    top.shells = last;
                } else {
                    if (opt.thin) {
                        top.thin_fill = [];
                        let oso = {z, count, gaps: [], outs: [], minArea: 0.05};
                        POLY.offset(top_poly, [-offset1, -offsetN], oso);

                        oso.outs.forEach((polys, i) => {
                            polys.forEach(p => {
                                p.depth = i;
                                if (p.fill_off) {
                                    p.fill_off.forEach(pi => pi.depth = i);
                                }
                                top.shells.push(p);
                            });
                            last = polys;
                        });

                        // slice.solids.trimmed = slice.solids.trimmed || [];
                        oso.gaps.forEach((polys, i) => {
                            let off = (i == 0 ? offset1 : offsetN);
                            polys = POLY.offset(polys, -off * 0.8, {z, minArea: 0});
                            // polys.forEach(p => { slice.solids.trimmed.push(p); });
                            top.thin_fill.appendAll(cullIntersections(
                                fillArea(polys, 45, off/2, [], 0.01, off*2),
                                fillArea(polys, 135, off/2, [], 0.01, off*2),
                                // fillArea(polys, 90, off, [], 0.05, off*4),
                                // fillArea(polys, 180, off, [], 0.05, off*4),
                            ));
                            gaps = polys;
                        });
                    } else {
                        // standard wall offsetting strategy
                        POLY.expand(
                            top_poly,   // reference polygon(s)
                            -offset1,   // first inset distance
                            z,          // set new polys to this z
                            top.shells, // accumulator array
                            count,      // number of insets to perform
                            -offsetN,   // subsequent inset distance
                            // on each new offset trace ...
                            function(polys, countNow) {
                                last = polys;
                                // mark each poly with depth (offset #) starting at 0
                                polys.forEach(function(p) {
                                    p.depth = count - countNow;
                                    if (p.fill_off) p.fill_off.forEach(function(pi) {
                                        // use negative offset for inners
                                        pi.depth = -(count - countNow);
                                    });
                                });
                            });
                    }
                }
            } else {
                // no shells, just infill, is permitted
                last = [top.poly];
            }

            // generate fill offset poly set from last offset to top.fill_off
            if (fillOffset && last.length > 0) {
                // if gaps present, remove that area from fill inset
                if (gaps.length) {
                    let nulast = [];
                    POLY.subtract(last, gaps, nulast, null, slice.z);
                    last = nulast;
                }
                last.forEach(function(inner) {
                    POLY.offset([inner], -fillOffset, {outs: top.fill_off, flat: true, z: slice.z});
                });
            }

            // for diffing
            top.last = last;
        });
    };

    /**
     * Create an entirely solid layer by filling all top polygons
     * with an alternating pattern.
     *
     * @param {number} linewidth
     * @param {number} angle
     * @param {number} density
     */
     function doSolidLayerFill(slice, spacing, angle) {
        if (slice.tops.length === 0 || typeof(angle) != 'number') {
            slice.isSolidLayer = false;
            return;
        }

        const render = slice.output();

        slice.tops.forEach(function(top) {
            const lines = fillArea(top.fill_off, angle, spacing, null);
            top.fill_lines.appendAll(lines);
        });

        slice.isSolidLayer = true;
    };

    /**
     * Take output from pluggable sparse infill algorithm and clip to
     * the bounds of the top polygons and their inner solid areas.
     */
    function doSparseLayerFill(slice, options) {
        let process = options.process,
            spacing = options.spacing,  // spacing space between fill lines
            density = options.density,  // density of infill 0.0 - 1.0
            bounds = options.bounds,    // bounding box of widget
            height = options.height,    // z layer height
            type = options.type || 'hex';

        if (slice.tops.length === 0 || density === 0.0 || slice.isSolidLayer) {
            slice.isSparseFill = false;
            return;
        }

        let tops = slice.tops,
            down = slice.down,
            clib = self.ClipperLib,
            ctyp = clib.ClipType,
            ptyp = clib.PolyType,
            cfil = clib.PolyFillType,
            clip = new clib.Clipper(),
            ctre = new clib.PolyTree(),
            poly,
            polys = [],
            lines = [],
            line = [],
            solids = [],
            // callback passed to pluggable infill algorithm
            target = {
                // slice and slice property access
                slice: function() { return slice },
                zIndex: function() { return slice.index },
                zValue: function() { return slice.z },
                // various option map access
                options: function() { return options },
                lineWidth: function() { return options.lineWidth },
                bounds: function() { return bounds },
                zHeight: function() { return height },
                offset: function() { return spacing },
                density: function() { return density },
                // output functions
                emit: function(x,y) {
                    if (isNaN(x)) {
                        solids.push(x);
                    } else {
                        line.push(newPoint(x,y,slice.z));
                        slice.isSparseFill = true;
                    }
                },
                newline: function() {
                    if (line.length > 0) {
                        lines.push(line);
                        line = [];
                    }
                }
            };

        // use specified fill type
        if (type && FILL[type]) {
            FILL[type](target);
        } else {
            console.log({missing_infill: type});
            return;
        }

        // force emit of last line
        target.newline();

        // prepare top infill structure
        tops.forEach(function(top) {
            top.fill_sparse = [];
            polys.appendAll(top.fill_off);
            polys.appendAll(top.solids);
        });

        // update fill fingerprint for this slice
        slice._fill_finger = POLY.fingerprint(polys);

        let skippable = FILLFIXED[type] ? true : false;
        let miss = false;
        // if the layer below has the same fingerprint,
        // we may be able to clone the infill instead of regenerating it
        if (skippable && slice.fingerprintSame(down)) {
            // the fill fingerprint can slightly different because of solid projections
            if (down._fill_finger && POLY.fingerprintCompare(slice._fill_finger, down._fill_finger)) {
                for (let i=0; i<tops.length; i++) {
                    // the layer below may not have infill computed if it's solid
                    if (down.tops[i].fill_sparse) {
                        tops[i].fill_sparse = down.tops[i].fill_sparse.map(poly => {
                            return poly.clone().setZ(slice.z);
                        });
                    } else {
                        miss = true;
                    }
                }
                // if any of the fills as missing from below, re-compute
                if (!miss) {
                    return;
                }
            }
        }

        let sparse_clip = slice.isSparseFill;

        // solid fill areas
        if (solids.length) {
            tops.forEach(top => {
                if (!top.fill_off) return;
                let masks = top.fill_off.slice();
                if (top.solids) {
                    masks = POLY.subtract(masks, top.solids, [], null, slice.z);
                }
                let angl = process.sliceFillAngle * ((slice.index % 2) + 1);
                solids.forEach(solid => {
                    let inter = [],
                        fillable = [];
                    masks.forEach(mask => {
                        let p = solid.mask(mask);
                        if (p && p.length) inter.appendAll(p);
                    });
                    // offset fill area to accommodate trace
                    if (inter.length) {
                        POLY.expand(inter, -options.lineWidth/2, slice.z, fillable);
                    }
                    // fill intersected areas
                    if (inter.length) {
                        slice.isSparseFill = true;
                        inter.forEach(p => {
                            p.forEachSegment((p1, p2) => {
                                top.fill_lines.push(p1, p2);
                            });
                        });
                    }
                    if (fillable.length) {
                        let lines = POLY.fillArea(fillable, angl, options.lineWidth);
                        top.fill_lines.appendAll(lines);
                    }
                });
            });
        }

        // if only solids were added and no lines to clip
        if (!sparse_clip) {
            return;
        }

        clip.AddPaths(lines, ptyp.ptSubject, false);
        clip.AddPaths(POLY.toClipper(polys), ptyp.ptClip, true);

        if (clip.Execute(ctyp.ctIntersection, ctre, cfil.pftNonZero, cfil.pftEvenOdd)) {
            ctre.m_AllPolys.forEach(function(node) {
                poly = POLY.fromClipperNode(node, slice.z);
                tops.forEach(function(top) {
                    // use only polygons inside this top
                    if (poly.isInside(top.poly)) {
                        top.fill_sparse.push(poly);
                    }
                });
            });
        }
    };

    /**
     * Find difference between fill inset poly on two adjacent layers.
     * Used to calculate bridges, flats and then solid projections.
     * 'expand' is used for top offsets in SLA mode
     */
    function doDiff(slice, minArea, sla) {
        const top = slice,
            down = slice.down,
            topInner = sla ? top.topPolys() : top.topInners(),
            downInner = sla ? down.downPolys() : down.topInners(),
            bridges = top.bridges = [],
            flats = down.flats = [];

        // skip diffing layers that are identical
        if (slice.fingerprintSame(down)) {
            top.bridges = bridges;
            down.flats = flats;
            return;
        }

        POLY.subtract(topInner, downInner, bridges, flats, slice.z, minArea);
    };

    /**
     *
     *
     * @param {Polygon[]} polys
     */
    function addSolidFills(slice, polys) {
        slice.solids.appendAll(polys);
    };

    /**
     * project bottom flats down
     */
    function projectFlats(slice, count) {
        if (slice.isSolidLayer || !slice.down || !slice.flats) return;
        projectSolid(slice, slice.flats, count, false, true);
    };

    /**
     * project top bridges up
     */
    function projectBridges(slice, count) {
        if (slice.isSolidLayer || !slice.up || !slice.bridges) return;
        projectSolid(slice, slice.bridges, count, true, true);
    };

    /**
     * fill projected areas and store line data
     * @return {boolean} true if filled, false if not
     */
    function doSolidsFill(slice, spacing, angle, minArea) {

        const render = slice.output();

        let minarea = minArea || 1,
            tops = slice.tops,
            solids = slice.solids,
            unioned = POLY.union(solids),
            isSLA = (spacing === undefined && angle === undefined);

        if (solids.length === 0) return false;
        if (unioned.length === 0) return false;

        let masks,
            trims = [],
            inner = isSLA ? slice.topPolys() : slice.topFillOff();

        // trim each solid to the inner bounds
        unioned.forEach(function(p) {
            p.setZ(slice.z);
            inner.forEach(function(i) {
                if (p.del) return;
                masks = p.mask(i);
                if (masks && masks.length > 0) {
                    p.del = true;
                    trims.appendAll(masks);
                }
            });
        });

        // clear old solids and make array for new
        tops.forEach(top => { top.solids = [] });

        // replace solids with merged and trimmed solids
        slice.solids = solids = trims;

        // parent each solid polygon inside the smallest bounding top
        solids.forEach(function(solid) {
            tops.forEach(function(top) {
                if (top.poly.overlaps(solid)) {
                    if (!solid.parent || solid.parent.area() > top.poly.area()) {
                        if (solid.areaDeep() < minarea) {
                            // console.log({i:slice.index,cull_solid:solid,area:solid.areaDeep()});
                            return;
                        }
                        solid.parent = top.poly;
                        top.solids.push(solid);
                    }
                }
            });
        });

        // for SLA to bypass line infill
        if (isSLA) {
            return true;
        }

        // create empty filled line array for each top
        tops.forEach(function(top) {
            const tofill = [];
            const angfill = [];
            const newfill = [];
            // determine fill orientation from top
            solids.forEach(function(solid) {
                if (solid.parent === top.poly) {
                    if (solid.fillang) {
                        angfill.push(solid);
                    } else {
                        tofill.push(solid);
                    }
                }
            });
            if (tofill.length > 0) {
                fillArea(tofill, angle, spacing, newfill);
                top.fill_lines_norm = {angle:angle,spacing:spacing};
            }
            if (angfill.length > 0) {
                top.fill_lines_ang = {spacing:spacing,list:[],poly:[]};
                angfill.forEach(function(af) {
                    fillArea([af], af.fillang.angle + 45, spacing, newfill);
                    top.fill_lines_ang.list.push(af.fillang.angle + 45);
                    top.fill_lines_ang.poly.push(af.clone());
                });
            }

            top.fill_lines.appendAll(newfill);
        });

        return true;
    };

    /**
     * calculate external overhangs requiring support
     * this is done bottom-up
     *
     * @param {number} minOffset trigger for unsupported distance
     * @param {number} maxBridge max length before mid supports added
     * @param {number} expand outer support clip
     * @param {number} offset inner support clip
     * @param {number} gap layers between supports and part
     */
    function doSupport(slice, minOffset, maxBridge, expand, minArea, pillarSize, offset, gap) {
        let min = minArea || 0.01,
            size = (pillarSize || 1),
            mergeDist = size * 3, // pillar merge dist
            tops = slice.topPolys(),
            trimTo = tops;

        // creates outer clip offset from tops
        if (expand) {
            POLY.expand(tops, expand, slice.z, trimTo = []);
        }

        // create inner clip offset from tops
        POLY.expand(tops, offset, slice.z, slice.offsets = []);

        let traces = POLY.flatten(slice.topShells().clone(true)),
            fill = slice.topFill(),
            points = [],
            down = slice.down,
            down_tops = down.topPolys(),
            down_traces = POLY.flatten(down.topShells().clone(true));

        // check if point is supported by layer below
        function checkPointSupport(point) {
            // skip points close to other support points
            for (let i=0; i<points.length; i++) {
                if (point.distTo2D(points[i]) < size/4) return;
            }
            let supported = point.isInPolygonOnly(down_tops);
            if (!supported) down_traces.forEach(function(trace) {
                trace.forEachSegment(function(p1, p2) {
                    if (point.distToLine(p1, p2) <= minOffset) {
                        return supported = true;
                    }
                });
                return supported;
            });
            if (!supported) points.push(point);
        }

        // todo support entire line if both endpoints unsupported
        // segment line and check if midpoints are supported
        function checkLineSupport(p1, p2, poly) {
            let dist, i = 1;
            if ((dist = p1.distTo2D(p2)) >= maxBridge) {
                let slope = p1.slopeTo(p2).factor(1/dist),
                    segs = Math.floor(dist / maxBridge) + 1,
                    seglen = dist / segs;
                while (i < segs) {
                    checkPointSupport(p1.projectOnSlope(slope, i++ * seglen));
                }
            }
            if (poly) checkPointSupport(p2);
        }

        // check trace line support needs
        traces.forEach(function(trace) {
            trace.forEachSegment(function(p1, p2) { checkLineSupport(p1, p2, true) });
        });

        let supports = [];

        // add offset solids to supports (or fill depending)
        fill.forEachPair(function(p1,p2) { checkLineSupport(p1, p2, false) });
        // if (top.bridges) POLY.expand(top.bridges, -maxBridge/2, top.z, supports, 1);

        // skip the rest if no points or supports
        if (!(points.length || supports.length)) return;

        let pillars = [];

        // TODO project points down instead of unioned pillars
        // TODO merge point/rect into hull of next nearest (up to maxBridge/2 away)
        // TODO eliminate unions in favor of progress hulling (using previous w/nearness)
        // TODO align pillar diamond along line (when doing line checks)

        // for each point, create a bounding rectangle
        points.forEach(function(point) {
            pillars.push(BASE.newPolygon().centerRectangle(point, size/2, size/2));
        });

        // merge pillars and replace with convex hull of outer points (aka smoothing)
        pillars = POLY.union(pillars).forEach(function(pillar) {
            supports.push(BASE.newPolygon().createConvexHull(pillar.points));
        });

        // return top.supports = supports;
        // then union supports
        supports = POLY.union(supports);

        // constrain support poly to top polys
        supports = POLY.trimTo(supports, trimTo);

        let depth = 0;
        while (down && supports.length > 0) {
            down.supports = down.supports || [];

            let trimmed = [],
                culled = [];

            // clip supports to shell offsets
            POLY.subtract(supports, down.topPolys(), trimmed, null, slice.z, min);

            // set depth hint on support polys for infill density
            trimmed.forEach(function(trim) {
                if (trim.area() < 0.1) return;
                culled.push(trim.setZ(down.z));
            });

            // exit when no more support polys exist
            if (culled.length === 0) break;

            // new bridge polys for next pass (skip first layer below)
            if (depth >= gap) {
                down.supports.appendAll(culled);
            }

            supports = culled;
            down = down.down;
            depth++;
        }

    };

    /**
     * @param {number} linewidth
     * @param {number} angle
     * @param {number} density
     * @param {number} offset
     */
    function doSupportFill(slice, linewidth, density, minArea) {
        let supports = slice.supports,
            nsB = [],
            nsC = [],
            min = minArea || 0.1;

        // create support clip offset
        // POLY.expand(slice.gatherTopPolys([]), offset, slice.z, slice.offsets = []);

        if (!supports) return;

        // union supports
        supports = POLY.union(supports);

        // trim to clip offsets
        if (slice.offsets) POLY.subtract(supports, slice.offsets, nsB, null, slice.z, min);
        supports = nsB;

        // also trim to lower offsets, if they exist
        if (slice.down && slice.down.offsets) {
            POLY.subtract(nsB, slice.down.offsets, nsC, null, slice.z, min);
            supports = nsC;
        }

        if (supports) supports.forEach(function (poly) {
            // angle based on width/height ratio
            let angle = (poly.bounds.width() / poly.bounds.height() > 1) ? 90 : 0;
            // calculate fill density
            let spacing = linewidth * (1 / density);
            // inset support poly for fill lines 33% of nozzle width
            let inset = POLY.offset([poly], -linewidth/3, {flat: true, z: slice.z});
            // do the fill
            if (inset && inset.length > 0) {
                fillArea(inset, angle, spacing, poly.fill = []);
            }
            return true;
        });

        // re-assign new supports back to slice
        slice.supports = supports;
    };

    /**
     *
     * @param {Slice} slice
     * @param {Polygon[]} polys
     * @param {number} count
     * @param {boolean} up
     * @param {boolean} first
     * @returns {*}
     */
    function projectSolid(slice, polys, count, up, first) {
        if (!slice || slice.isSolidLayer || count <= 0) {
            return;
        }
        let clones = polys.clone(true);
        if (first) {
            clones.forEach(function(p) {
                p.hintFillAngle();
            });
        }
        addSolidFills(slice, clones);
        if (count > 0) {
            if (up) projectSolid(slice.up, polys, count-1, true, false);
            else projectSolid(slice.down, polys, count-1, false, false);
        }
    }

    /**
     * given an array of arrays of points (lines), eliminate intersections
     * between groups, then return a unified array of shortest non-intersects.
     *
     * @returns {Point[]}
     */
    function cullIntersections() {
        function toLines(pts) {
            let lns = [];
            for (let i=0, il=pts.length; i<il; i += 2) {
                lns.push({a: pts[i], b: pts[i+1], l: pts[i].distTo2D(pts[i+1])});
            }
            return lns;
        }
        let aOa = [...arguments].filter(t => t);
        if (aOa.length < 1) return;
        let aa = toLines(aOa.shift());
        while (aOa.length) {
            let bb = toLines(aOa.shift());
            loop: for (let i=0, il=aa.length; i<il; i++) {
                let al = aa[i];
                if (al.del) {
                    continue;
                }
                for (let j=0, jl=bb.length; j<jl; j++) {
                    let bl = bb[j];
                    if (bl.del) {
                        continue;
                    }
                    if (UTIL.intersect(al.a, al.b, bl.a, bl.b, BASE.key.SEGINT)) {
                        if (al.l < bl.l) {
                            bl.del = true;
                        } else {
                            al.del = true;
                        }
                        continue;
                    }
                }
            }
            aa = aa.filter(l => !l.del).concat(bb.filter(l => !l.del));
        }
        let good = [];
        for (let i=0, il=aa.length; i<il; i++) {
            let al = aa[i];
            good.push(al.a);
            good.push(al.b);
        }
        return good.length > 2 ? good : [];
    }

})();