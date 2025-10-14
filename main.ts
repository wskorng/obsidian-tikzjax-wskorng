import { Plugin, TFile, WorkspaceWindow } from 'obsidian';
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
			// The preamble processing should precede the creation of the script element,
			// otherwise the MutationObserver of tikzjax.js may not notice the change of the element.
			const preamble = await this.findPreambleFile(ctx.sourcePath);
			const sourceComplete = this.tidyTikzSource(source, preamble);

			const script = el.createEl("script");

			script.setAttribute("type", "text/tikz");
			script.setAttribute("data-show-console", "true");
			script.setText(sourceComplete);
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
		
		// Get the directory of the current file
		let currentDir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
		console.log("TikZJax-wskorng: Starting directory:", currentDir);
		
		// Try multiple filename patterns in order of preference
		const preambleFilenames = ['.tikz-preamble.tex', '.tikz-preamble', 'tikz-preamble.tex'];
		
		// Search from current directory up to vault root
		let searchCount = 0;
		
		while (searchCount < 10) { // Safety limit
			searchCount++;
			console.log(`TikZJax-wskorng: Search iteration ${searchCount}, current dir: "${currentDir}"`);
			
			for (const filename of preambleFilenames) {
				const preamblePath = currentDir ? `${currentDir}/${filename}` : filename;
				console.log("TikZJax-wskorng: Checking path:", preamblePath);
				
				try {
					const file = this.app.vault.getAbstractFileByPath(preamblePath);
					console.log("TikZJax-wskorng: File found:", !!file);
					
					if (file instanceof TFile) {
						console.log("TikZJax-wskorng: Reading preamble from:", preamblePath);
						const content = await this.app.vault.cachedRead(file);
						return content;
					}
				} catch (error) {
					console.log("TikZJax-wskorng: Error accessing file:", preamblePath, error);
				}
			}
			
			// If we're at the root (empty string), we're done
			if (!currentDir) {
				console.log("TikZJax-wskorng: Reached vault root, stopping search");
				break;
			}
			
			// Move to parent directory
			if (currentDir.includes('/')) {
				const parentDir = currentDir.substring(0, currentDir.lastIndexOf('/'));
				console.log(`TikZJax-wskorng: Moving from "${currentDir}" to parent "${parentDir}"`);
				currentDir = parentDir;
			} else {
				// We're one level below root, next iteration will be root (empty string)
				console.log(`TikZJax-wskorng: Moving from "${currentDir}" to vault root`);
				currentDir = '';
			}
		}
		
		console.log("TikZJax-wskorng: No preamble file found after searching", searchCount, "directories");
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

		// Insert preamble if available - but only before \begin{document}
		if (preamble.trim()) {
			const preambleLines = preamble.trim().split("\n").map(line => line.trim()).filter(line => line);
			
			// Find the position of \begin{document}
			const documentIndex = lines.findIndex(line => line.includes('\\begin{document}'));
			
			if (documentIndex !== -1) {
				// Insert preamble before \begin{document}
				lines.splice(documentIndex, 0, ...preambleLines);
			} else {
				// If no \begin{document} found, add preamble at the beginning
				lines = [...preambleLines, ...lines];
			}
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
