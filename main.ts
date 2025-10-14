import { Plugin, WorkspaceWindow } from 'obsidian';
import { TikzjaxPluginSettings, DEFAULT_SETTINGS, TikzjaxSettingTab } from "./settings";
import { optimize } from "./svgo.browser";

// @ts-ignore
import tikzjaxJs from 'inline:./tikzjax.js';


export default class TikzjaxPlugin extends Plugin {
	settings: TikzjaxPluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TikzjaxSettingTab(this.app, this));

		// Support pop-out windows
		this.app.workspace.onLayoutReady(() => {
			this.loadTikZJaxAllWindows();
			this.registerEvent(this.app.workspace.on("window-open", (win, window) => {
				this.loadTikZJax(window.document);
			}));
		});


		this.addSyntaxHighlighting();
		
		this.registerTikzCodeBlock();
	}

	onunload() {
		this.unloadTikZJaxAllWindows();
		this.removeSyntaxHighlighting();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


	loadTikZJax(doc: Document) {
		const s = document.createElement("script");
		s.id = "tikzjax";
		s.type = "text/javascript";
		s.innerText = tikzjaxJs;
		doc.body.appendChild(s);


		doc.addEventListener('tikzjax-load-finished', this.postProcessSvg);
	}

	unloadTikZJax(doc: Document) {
		const s = doc.getElementById("tikzjax");
		s.remove();

		doc.removeEventListener("tikzjax-load-finished", this.postProcessSvg);
	}

	loadTikZJaxAllWindows() {
		for (const window of this.getAllWindows()) {
			this.loadTikZJax(window.document);
		}
	}

	unloadTikZJaxAllWindows() {
		for (const window of this.getAllWindows()) {
			this.unloadTikZJax(window.document);
		}
	}

	getAllWindows() {
		// Via https://discord.com/channels/686053708261228577/840286264964022302/991591350107635753

		const windows = [];
		
		// push the main window's root split to the list
		windows.push(this.app.workspace.rootSplit.win);
		
		// @ts-ignore floatingSplit is undocumented
		const floatingSplit = this.app.workspace.floatingSplit;
		floatingSplit.children.forEach((child: any) => {
			// if this is a window, push it to the list 
			if (child instanceof WorkspaceWindow) {
				windows.push(child.win);
			}
		});

		return windows;
	}


	registerTikzCodeBlock() {
		this.registerMarkdownCodeBlockProcessor("tikz", async (source, el, ctx) => {
			console.log("TikZJax-wskorng: Processing tikz block");
			console.log("Source path:", ctx.sourcePath);
			
			const script = el.createEl("script");

			script.setAttribute("type", "text/tikz");
			script.setAttribute("data-show-console", "true");

			const preamble = await this.findPreambleFile(ctx.sourcePath);
			console.log("Found preamble:", preamble ? `${preamble.length} characters` : "none");
			
			const finalSource = this.tidyTikzSource(source, preamble);
			console.log("Final TikZ source:", finalSource);
			
			script.setText(finalSource);
		});
	}


	addSyntaxHighlighting() {
		// @ts-ignore
		window.CodeMirror.modeInfo.push({name: "Tikz", mime: "text/x-latex", mode: "stex"});
	}

	removeSyntaxHighlighting() {
		// @ts-ignore
		window.CodeMirror.modeInfo = window.CodeMirror.modeInfo.filter(el => el.name != "Tikz");
	}

	async findPreambleFile(sourcePath: string): Promise<string> {
		if (!sourcePath) {
			console.log("TikZJax-wskorng: No source path provided");
			return "";
		}
		
		console.log("TikZJax-wskorng: Searching for preamble file from:", sourcePath);
		
		// Split path into parts and work backwards
		const pathParts = sourcePath.split('/');
		
		// Try multiple filename patterns in order of preference
		const preambleFilenames = ['.tikz-preamble.tex', '.tikz-preamble', 'tikz-preamble.tex'];
		
		for (let i = pathParts.length - 1; i >= 0; i--) {
			const currentPath = pathParts.slice(0, i).join('/');
			
			for (const filename of preambleFilenames) {
				const preamblePath = currentPath ? `${currentPath}/${filename}` : filename;
				console.log("TikZJax-wskorng: Checking path:", preamblePath);
				
				try {
					// @ts-ignore - this.app is available in Plugin class
					const file = this.app.vault.getAbstractFileByPath(preamblePath);
					console.log("TikZJax-wskorng: File found:", !!file);
					
					// @ts-ignore - TFile type check
					if (file && file instanceof this.app.vault.TFile) {
						console.log("TikZJax-wskorng: Reading file:", preamblePath);
						// @ts-ignore - vault.read method
						const content = await this.app.vault.read(file);
						console.log("TikZJax-wskorng: Preamble content loaded:", content.substring(0, 100) + "...");
						return content;
					}
				} catch (error) {
					console.log("TikZJax-wskorng: Error reading file:", preamblePath, error);
				}
			}
		}
		
		console.log("TikZJax-wskorng: No preamble file found");
		return "";
	}

	tidyTikzSource(tikzSource: string, preamble: string = "") {

		// Remove non-breaking space characters, otherwise we get errors
		const remove = "&nbsp;";
		tikzSource = tikzSource.replaceAll(remove, "");


		let lines = tikzSource.split("\n");

		// Trim whitespace that is inserted when pasting in code, otherwise TikZJax complains
		lines = lines.map(line => line.trim());

		// Remove empty lines
		lines = lines.filter(line => line);

		// Insert preamble if available
		if (preamble.trim()) {
			const preambleLines = preamble.trim().split("\n");
			lines = [...preambleLines, ...lines];
		}

		return lines.join("\n");
	}


	colorSVGinDarkMode(svg: string) {
		// Replace the color "black" with currentColor (the current text color)
		// so that diagram axes, etc are visible in dark mode
		// And replace "white" with the background color

		svg = svg.replaceAll(/("#000"|"black")/g, `"currentColor"`)
				.replaceAll(/("#fff"|"white")/g, `"var(--background-primary)"`);

		return svg;
	}


	optimizeSVG(svg: string) {
		// Optimize the SVG using SVGO
		// Fixes misaligned text nodes on mobile

		return optimize(svg, {plugins:
			[
				{
					name: 'preset-default',
					params: {
						overrides: {
							// Don't use the "cleanupIDs" plugin
							// To avoid problems with duplicate IDs ("a", "b", ...)
							// when inlining multiple svgs with IDs
							cleanupIDs: false
						}
					}
				}
			]
		// @ts-ignore
		}).data;
	}


	postProcessSvg = (e: Event) => {

		const svgEl = e.target as HTMLElement;
		let svg = svgEl.outerHTML;

		if (this.settings.invertColorsInDarkMode) {
			svg = this.colorSVGinDarkMode(svg);
		}

		svg = this.optimizeSVG(svg);

		svgEl.outerHTML = svg;
	}
}

