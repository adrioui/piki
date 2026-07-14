export const SCRATCHPAD_SUBDIRS = ["designs", "plans", "processes", "reports", "results", "thoughts"] as const;
export type ScratchpadSubdir = (typeof SCRATCHPAD_SUBDIRS)[number];
