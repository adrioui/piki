import type {
	EditorFactory,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../core/extensions/index.ts";
import { type Theme, theme } from "./interactive/theme/theme.ts";

function resolveDefault<T>(opts: ExtensionUIDialogOptions | undefined, value: T): Promise<T> {
	if (opts?.signal?.aborted) {
		return Promise.resolve(value);
	}
	return new Promise((resolve) => {
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timeoutId) clearTimeout(timeoutId);
			resolve(value);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts?.timeout) {
			timeoutId = setTimeout(() => {
				opts?.signal?.removeEventListener("abort", onAbort);
				resolve(value);
			}, opts.timeout);
		}
		if (!opts?.timeout) {
			opts?.signal?.removeEventListener("abort", onAbort);
			resolve(value);
		}
	});
}

export function createHeadlessExtensionUIContext(): ExtensionUIContext {
	let editorFactory: EditorFactory | undefined;

	return {
		select: (_title, _options, opts) => resolveDefault(opts, undefined),
		confirm: (_title, _message, opts) => resolveDefault(opts, false),
		input: (_title, _placeholder, opts) => resolveDefault(opts, undefined),
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: (_options?: WorkingIndicatorOptions) => {},
		setHiddenThinkingLabel: () => {},
		setWidget: (
			_key: string,
			_content: string[] | ((...args: any[]) => any) | undefined,
			_options?: ExtensionWidgetOptions,
		) => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		async custom() {
			return undefined as never;
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: (_title: string, _prefill?: string) => Promise.resolve(undefined),
		addAutocompleteProvider: () => {},
		setEditorComponent: (factory) => {
			editorFactory = factory;
		},
		getEditorComponent: () => editorFactory,
		get theme(): Theme {
			return theme;
		},
		getAllThemes() {
			return [];
		},
		getTheme(_name: string) {
			return undefined;
		},
		setTheme(_theme: string | Theme) {
			return { success: false, error: "Theme switching is unavailable in headless mode" };
		},
		getToolsExpanded() {
			return false;
		},
		setToolsExpanded: () => {},
	};
}
