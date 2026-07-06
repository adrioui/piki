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
exports.JsonlEventStore = exports.InMemoryEventStore = void 0;
var node_fs_1 = require("node:fs");
var node_path_1 = require("node:path");
var InMemoryEventStore = /** @class */ (function () {
    function InMemoryEventStore() {
        this.events = [];
    }
    InMemoryEventStore.prototype.append = function (event) {
        this.events.push(event);
    };
    InMemoryEventStore.prototype.appendMany = function (events) {
        for (var _i = 0, events_1 = events; _i < events_1.length; _i++) {
            var event_1 = events_1[_i];
            this.events.push(event_1);
        }
    };
    InMemoryEventStore.prototype.list = function (options) {
        var results = this.events;
        if ((options === null || options === void 0 ? void 0 : options.afterSequence) !== undefined) {
            results = results.filter(function (event) { return event.sequence > options.afterSequence; });
        }
        if ((options === null || options === void 0 ? void 0 : options.limit) !== undefined) {
            results = results.slice(-options.limit);
        }
        return __spreadArray([], results, true);
    };
    return InMemoryEventStore;
}());
exports.InMemoryEventStore = InMemoryEventStore;
var JsonlEventStore = /** @class */ (function () {
    function JsonlEventStore(filePath) {
        this.filePath = filePath;
    }
    JsonlEventStore.prototype.append = function (event) {
        this.ensureFile();
        (0, node_fs_1.appendFileSync)(this.filePath, "".concat(JSON.stringify(event), "\n"));
    };
    JsonlEventStore.prototype.appendMany = function (events) {
        if (events.length === 0)
            return;
        this.ensureFile();
        (0, node_fs_1.appendFileSync)(this.filePath, "".concat(events.map(function (event) { return JSON.stringify(event); }).join("\n"), "\n"));
    };
    JsonlEventStore.prototype.list = function (options) {
        if (!(0, node_fs_1.existsSync)(this.filePath)) {
            return [];
        }
        var content = (0, node_fs_1.readFileSync)(this.filePath, "utf-8");
        if (content.trim().length === 0) {
            return [];
        }
        var events = content
            .split("\n")
            .map(function (line) { return line.trim(); })
            .filter(function (line) { return line.length > 0; })
            .map(function (line) { return JSON.parse(line); });
        if ((options === null || options === void 0 ? void 0 : options.afterSequence) !== undefined) {
            events = events.filter(function (event) { return event.sequence > options.afterSequence; });
        }
        if ((options === null || options === void 0 ? void 0 : options.limit) !== undefined) {
            events = events.slice(-options.limit);
        }
        return events;
    };
    JsonlEventStore.prototype.rewrite = function (events) {
        this.ensureDirectory();
        (0, node_fs_1.writeFileSync)(this.filePath, events.map(function (event) { return JSON.stringify(event); }).join("\n") + (events.length > 0 ? "\n" : ""));
    };
    JsonlEventStore.prototype.ensureFile = function () {
        this.ensureDirectory();
        if (!(0, node_fs_1.existsSync)(this.filePath)) {
            (0, node_fs_1.writeFileSync)(this.filePath, "");
        }
    };
    JsonlEventStore.prototype.ensureDirectory = function () {
        var folder = (0, node_path_1.dirname)(this.filePath);
        if (!(0, node_fs_1.existsSync)(folder)) {
            (0, node_fs_1.mkdirSync)(folder, { recursive: true });
        }
    };
    return JsonlEventStore;
}());
exports.JsonlEventStore = JsonlEventStore;
