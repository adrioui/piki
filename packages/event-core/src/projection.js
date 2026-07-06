"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectionStore = void 0;
/**
 * Resolve the initial state from a ProjectionDefinition, supporting both
 * plain values and factory functions (mirroring Magnitude's `initialState: () => ...`).
 */
function resolveInitialState(definition) {
    var raw = definition.initialState;
    return typeof raw === "function" ? raw() : raw;
}
/**
 * Projection store that applies events to registered projections synchronously.
 *
 * Supports:
 * - `reads`/`writes` dependency metadata (for topological ordering)
 * - `extractSignals` to emit signals after each reduce
 * - `initialState` as value or factory
 * - Replay/hydration by re-applying a sequence of events
 */
var ProjectionStore = /** @class */ (function () {
    function ProjectionStore() {
        this.definitions = new Map();
        this.states = new Map();
        /** Signals emitted during the last apply() call, keyed by projection name. */
        this.pendingSignals = [];
        /** Ordered projection names (topological order by reads/writes if available). */
        this.orderedNames = [];
    }
    ProjectionStore.prototype.register = function (definition) {
        this.definitions.set(definition.name, definition);
        this.states.set(definition.name, {
            state: resolveInitialState(definition),
            lastSequence: 0,
        });
        this.recomputeOrder();
    };
    /** Recompute the topological order of projections based on reads/writes. */
    ProjectionStore.prototype.recomputeOrder = function () {
        var _a, _b, _c, _d, _e;
        var names = Array.from(this.definitions.keys());
        var deps = new Map();
        for (var _i = 0, _f = this.definitions; _i < _f.length; _i++) {
            var _g = _f[_i], name_1 = _g[0], def = _g[1];
            var reads = new Set((_a = def.reads) !== null && _a !== void 0 ? _a : []);
            // Also depend on anything this projection writes to (if another reads from it)
            for (var _h = 0, _j = this.definitions; _h < _j.length; _h++) {
                var _k = _j[_h], otherName = _k[0], otherDef = _k[1];
                if (otherName === name_1)
                    continue;
                if (((_b = otherDef.writes) !== null && _b !== void 0 ? _b : []).includes(name_1)) {
                    reads.add(otherName);
                }
            }
            deps.set(name_1, reads);
        }
        // Kahn's algorithm for topological sort
        var inDegree = new Map();
        for (var _l = 0, names_1 = names; _l < names_1.length; _l++) {
            var name_2 = names_1[_l];
            inDegree.set(name_2, (_d = (_c = deps.get(name_2)) === null || _c === void 0 ? void 0 : _c.size) !== null && _d !== void 0 ? _d : 0);
        }
        var ordered = [];
        var queue = names.filter(function (name) { var _a; return ((_a = inDegree.get(name)) !== null && _a !== void 0 ? _a : 0) === 0; }).sort();
        while (queue.length > 0) {
            var current = queue.shift();
            ordered.push(current);
            for (var _m = 0, names_2 = names; _m < names_2.length; _m++) {
                var name_3 = names_2[_m];
                if (name_3 === current)
                    continue;
                var d = deps.get(name_3);
                if (d === null || d === void 0 ? void 0 : d.has(current)) {
                    d.delete(current);
                    var deg = ((_e = inDegree.get(name_3)) !== null && _e !== void 0 ? _e : 0) - 1;
                    inDegree.set(name_3, deg);
                    if (deg === 0)
                        queue.push(name_3);
                }
            }
        }
        // Any remaining names (cyclic or unresolved) are appended in registration order
        for (var _o = 0, names_3 = names; _o < names_3.length; _o++) {
            var name_4 = names_3[_o];
            if (!ordered.includes(name_4))
                ordered.push(name_4);
        }
        this.orderedNames = ordered;
    };
    ProjectionStore.prototype.apply = function (event) {
        var _a;
        this.pendingSignals.length = 0;
        for (var _i = 0, _b = this.orderedNames; _i < _b.length; _i++) {
            var name_5 = _b[_i];
            var definition = this.definitions.get(name_5);
            if (!definition)
                continue;
            var current = this.states.get(name_5);
            var currentState = (_a = current === null || current === void 0 ? void 0 : current.state) !== null && _a !== void 0 ? _a : resolveInitialState(definition);
            var nextState = definition.reduce(currentState, event);
            this.states.set(name_5, {
                state: nextState,
                lastSequence: event.sequence,
            });
            if (definition.extractSignals) {
                var signals = definition.extractSignals(nextState, event);
                for (var _c = 0, signals_1 = signals; _c < signals_1.length; _c++) {
                    var sig = signals_1[_c];
                    this.pendingSignals.push(sig);
                }
            }
        }
        return __spreadArray([], this.pendingSignals, true);
    };
    /** Replay a sequence of events to rebuild projection state (hydration). */
    ProjectionStore.prototype.replay = function (events) {
        for (var _i = 0, _a = this.definitions; _i < _a.length; _i++) {
            var _b = _a[_i], name_6 = _b[0], def = _b[1];
            this.states.set(name_6, {
                state: resolveInitialState(def),
                lastSequence: 0,
            });
        }
        for (var _c = 0, events_1 = events; _c < events_1.length; _c++) {
            var event_1 = events_1[_c];
            this.apply(event_1);
        }
    };
    ProjectionStore.prototype.get = function (name) {
        var _a;
        return (_a = this.states.get(name)) === null || _a === void 0 ? void 0 : _a.state;
    };
    ProjectionStore.prototype.getLastSequence = function (name) {
        var _a;
        return (_a = this.states.get(name)) === null || _a === void 0 ? void 0 : _a.lastSequence;
    };
    ProjectionStore.prototype.snapshots = function () {
        return Array.from(this.states.entries()).map(function (_a) {
            var name = _a[0], value = _a[1];
            return ({
                name: name,
                state: value.state,
                lastSequence: value.lastSequence,
            });
        });
    };
    /** Get the ordered list of projection names (topological order). */
    ProjectionStore.prototype.getOrderedNames = function () {
        return __spreadArray([], this.orderedNames, true);
    };
    return ProjectionStore;
}());
exports.ProjectionStore = ProjectionStore;
