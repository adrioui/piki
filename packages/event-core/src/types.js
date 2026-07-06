"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSignal = createSignal;
/**
 * Creates a typed signal definition (mirrors Magnitude's `exports_signal.create`).
 */
function createSignal(type, description) {
    return { type: type, description: description };
}
