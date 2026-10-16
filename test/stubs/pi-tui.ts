/** Test stub for the pi-tui `Text` component used by the entry renderer. */
export class Text {
	text;
	paddingX;
	paddingY;
	constructor(text, paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}
}
