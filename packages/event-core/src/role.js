"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
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
exports.InMemorySignalBus = exports.RoleHost = void 0;
/**
 * Role host that runs roles asynchronously after events are applied to projections.
 *
 * This is Phase 2 of Magnitude's two-phase processing:
 * - Phase 1 (synchronous): Projections reduce events to state
 * - Phase 2 (asynchronous): Roles react to events, read projections, publish new events
 *
 * Roles are serialized per concurrency key to prevent race conditions.
 */
var RoleHost = /** @class */ (function () {
    function RoleHost(options) {
        var _a, _b;
        this.roles = [];
        this.inflightByKey = new Map();
        this.matching = new Set();
        this.failures = [];
        this.projections = options.projections;
        this.publishEvent = options.publish;
        this.signalBus = (_a = options.signals) !== null && _a !== void 0 ? _a : new InMemorySignalBus();
        this.signal = (_b = options.signal) !== null && _b !== void 0 ? _b : new AbortController().signal;
    }
    RoleHost.prototype.register = function (role) {
        this.roles.push(role);
    };
    /** Get the signal bus (for external access to emitted signals). */
    RoleHost.prototype.getSignalBus = function () {
        return this.signalBus;
    };
    RoleHost.prototype.handle = function (event_1) {
        return __awaiter(this, arguments, void 0, function (event, extractedSignals) {
            var _i, extractedSignals_1, sig, _loop_1, this_1, _a, _b, role, state_1;
            var _this = this;
            var _c;
            if (extractedSignals === void 0) { extractedSignals = []; }
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        // Signals are ephemeral per-event — clear before dispatch so roles see only signals emitted for this specific event
                        this.signalBus.clear();
                        // Dispatch signals extracted by projections
                        for (_i = 0, extractedSignals_1 = extractedSignals; _i < extractedSignals_1.length; _i++) {
                            sig = extractedSignals_1[_i];
                            this.signalBus.dispatch(sig);
                        }
                        _loop_1 = function (role) {
                            var matches, matchPromise, hasMatchingSignal, key, previous, next;
                            return __generator(this, function (_e) {
                                switch (_e.label) {
                                    case 0:
                                        if (this_1.signal.aborted)
                                            return [2 /*return*/, { value: void 0 }];
                                        matches = true;
                                        if (!role.match) return [3 /*break*/, 4];
                                        matchPromise = Promise.resolve(role.match(event, this_1.projections)).then(function (result) {
                                            matches = result;
                                        });
                                        this_1.matching.add(matchPromise);
                                        _e.label = 1;
                                    case 1:
                                        _e.trys.push([1, , 3, 4]);
                                        return [4 /*yield*/, matchPromise];
                                    case 2:
                                        _e.sent();
                                        return [3 /*break*/, 4];
                                    case 3:
                                        this_1.matching.delete(matchPromise);
                                        return [7 /*endfinally*/];
                                    case 4:
                                        if (!matches)
                                            return [2 /*return*/, "continue"];
                                        // Also check if role listens for specific signals
                                        if (role.listenSignals && role.listenSignals.length > 0) {
                                            hasMatchingSignal = role.listenSignals.some(function (sigType) { return _this.signalBus.read(sigType) !== undefined; });
                                            if (!hasMatchingSignal)
                                                return [2 /*return*/, "continue"];
                                        }
                                        key = role.concurrencyKey ? "".concat(role.name, ":").concat(role.concurrencyKey(event)) : role.name;
                                        previous = (_c = this_1.inflightByKey.get(key)) !== null && _c !== void 0 ? _c : Promise.resolve();
                                        next = previous
                                            .catch(function () { })
                                            .then(function () { return __awaiter(_this, void 0, void 0, function () {
                                            var context, error_1;
                                            var _this = this;
                                            return __generator(this, function (_a) {
                                                switch (_a.label) {
                                                    case 0:
                                                        if (this.signal.aborted)
                                                            return [2 /*return*/];
                                                        context = {
                                                            event: event,
                                                            projections: this.projections,
                                                            publish: this.publishEvent,
                                                            emitSignal: function (sig) { return _this.signalBus.dispatch(sig); },
                                                            readSignal: function (type) { return _this.signalBus.read(type); },
                                                            signal: this.signal,
                                                        };
                                                        _a.label = 1;
                                                    case 1:
                                                        _a.trys.push([1, 3, , 4]);
                                                        return [4 /*yield*/, role.run(context)];
                                                    case 2:
                                                        _a.sent();
                                                        return [3 /*break*/, 4];
                                                    case 3:
                                                        error_1 = _a.sent();
                                                        this.failures.push(error_1);
                                                        return [3 /*break*/, 4];
                                                    case 4: return [2 /*return*/];
                                                }
                                            });
                                        }); })
                                            .finally(function () {
                                            if (_this.inflightByKey.get(key) === next) {
                                                _this.inflightByKey.delete(key);
                                            }
                                        });
                                        this_1.inflightByKey.set(key, next);
                                        return [2 /*return*/];
                                }
                            });
                        };
                        this_1 = this;
                        _a = 0, _b = this.roles;
                        _d.label = 1;
                    case 1:
                        if (!(_a < _b.length)) return [3 /*break*/, 4];
                        role = _b[_a];
                        return [5 /*yield**/, _loop_1(role)];
                    case 2:
                        state_1 = _d.sent();
                        if (typeof state_1 === "object")
                            return [2 /*return*/, state_1.value];
                        _d.label = 3;
                    case 3:
                        _a++;
                        return [3 /*break*/, 1];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    RoleHost.prototype.waitForIdle = function () {
        return __awaiter(this, void 0, void 0, function () {
            var failures;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!(this.matching.size > 0)) return [3 /*break*/, 2];
                        return [4 /*yield*/, Promise.allSettled(__spreadArray([], this.matching, true))];
                    case 1:
                        _a.sent();
                        return [3 /*break*/, 0];
                    case 2:
                        if (!(this.inflightByKey.size > 0)) return [3 /*break*/, 4];
                        return [4 /*yield*/, Promise.allSettled(__spreadArray([], this.inflightByKey.values(), true))];
                    case 3:
                        _a.sent();
                        return [3 /*break*/, 2];
                    case 4:
                        if (this.failures.length > 0) {
                            failures = this.failures.splice(0);
                            throw new AggregateError(failures, "One or more roles failed");
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    return RoleHost;
}());
exports.RoleHost = RoleHost;
/**
 * In-memory signal bus for ephemeral inter-role communication.
 * Signals are not persisted — they are coordination messages that flow
 * through the runtime and are available for the duration of a turn.
 */
var InMemorySignalBus = /** @class */ (function () {
    function InMemorySignalBus() {
        this.signals = new Map();
        this.listeners = new Map();
    }
    InMemorySignalBus.prototype.dispatch = function (signal) {
        this.signals.set(signal.type, signal);
        var listeners = this.listeners.get(signal.type);
        if (listeners) {
            for (var _i = 0, listeners_1 = listeners; _i < listeners_1.length; _i++) {
                var listener = listeners_1[_i];
                listener(signal);
            }
        }
    };
    InMemorySignalBus.prototype.read = function (type) {
        return this.signals.get(type);
    };
    InMemorySignalBus.prototype.clear = function () {
        this.signals.clear();
    };
    InMemorySignalBus.prototype.on = function (type, listener) {
        var _this = this;
        var _a;
        if (!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        (_a = this.listeners.get(type)) === null || _a === void 0 ? void 0 : _a.push(listener);
        return function () {
            var arr = _this.listeners.get(type);
            if (arr) {
                var idx = arr.indexOf(listener);
                if (idx >= 0)
                    arr.splice(idx, 1);
            }
        };
    };
    return InMemorySignalBus;
}());
exports.InMemorySignalBus = InMemorySignalBus;
