import { Context } from "effect";

export interface WorkingDirectory {
	cwd: string;
	scratchpadPath: string;
}

export const WorkingDirectoryTag = Context.GenericTag<WorkingDirectory>("@piki/WorkingDirectory");
