"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultEventSink = void 0;
var projection_ts_1 = require("./projection.ts");
var role_ts_1 = require("./role.ts");
/**
 * Default EventSink implementation.
 *
 * Implements Magnitude's two-phase processing:
 * - Phase 1 (synchronous): Apply projections → persist durable event → extract signals
 * - Phase 2 (asynchronous): Dispatch signals → run matching roles
 *
 * On startup, call `replay()` with the event log to hydrate projection state
 * from the persisted event store. This makes projections the authoritative
 * source of truth — the entire session state can be reconstructed from the
 * event log alone.
 */
var DefaultEventSink = /** @class */ (function () {
    function DefaultEventSink(store, options) {
        if (options === void 0) { options = {}; }
        var _this = this;
        var _a;
        this.controller = new AbortController();
        this.sequence = 0;
        this.publishChain = Promise.resolve();
        this.store = store;
        this.onEventApplied = options.onEventApplied;
        this._projections = (_a = options.projectionStore) !== null && _a !== void 0 ? _a : new projection_ts_1.ProjectionStore();
        this.signalBus = new role_ts_1.InMemorySignalBus();
        this.roleHost = new role_ts_1.RoleHost({
            projections: this._projections,
            publish: function (event) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.publish(event)];
                        case 1:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            }); },
            signals: this.signalBus,
            signal: this.controller.signal,
        });
    }
    DefaultEventSink.prototype.publish = function (event) {
        return __awaiter(this, void 0, void 0, function () {
            var publishTask;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        publishTask = this.publishChain.then(function () { return __awaiter(_this, void 0, void 0, function () {
                            var appliedEvent, signals;
                            var _a;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        if (this.controller.signal.aborted)
                                            return [2 /*return*/];
                                        appliedEvent = event.sequence > this.sequence ? event : __assign(__assign({}, event), { sequence: this.sequence + 1 });
                                        // Phase 1: apply projections, then persist durable events.
                                        this.sequence = Math.max(this.sequence, appliedEvent.sequence);
                                        signals = this._projections.apply(appliedEvent);
                                        (_a = this.onEventApplied) === null || _a === void 0 ? void 0 : _a.call(this, appliedEvent);
                                        if (!!appliedEvent.ephemeral) return [3 /*break*/, 2];
                                        return [4 /*yield*/, this.store.append(appliedEvent)];
                                    case 1:
                                        _b.sent();
                                        _b.label = 2;
                                    case 2:
                                        // Phase 2: Run roles asynchronously
                                        void this.roleHost.handle(appliedEvent, signals).catch(function () {
                                            // Role errors are non-fatal; they don't break the event pipeline
                                        });
                                        return [2 /*return*/];
                                }
                            });
                        }); });
                        this.publishChain = publishTask.catch(function () { });
                        return [4 /*yield*/, publishTask];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    DefaultEventSink.prototype.replay = function (events) {
        this._projections.replay(events);
        for (var _i = 0, events_1 = events; _i < events_1.length; _i++) {
            var event_1 = events_1[_i];
            this.sequence = Math.max(this.sequence, event_1.sequence);
        }
    };
    DefaultEventSink.prototype.projections = function () {
        return this._projections;
    };
    DefaultEventSink.prototype.registerProjection = function (definition) {
        this._projections.register(definition);
    };
    DefaultEventSink.prototype.registerRole = function (role) {
        this.roleHost.register(role);
    };
    DefaultEventSink.prototype.waitForIdle = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.roleHost.waitForIdle()];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    DefaultEventSink.prototype.getSequence = function () {
        return this.sequence;
    };
    DefaultEventSink.prototype.getSignalBus = function () {
        return this.signalBus;
    };
    DefaultEventSink.prototype.dispose = function () {
        this.controller.abort();
        this.signalBus.clear();
    };
    return DefaultEventSink;
}());
exports.DefaultEventSink = DefaultEventSink;
