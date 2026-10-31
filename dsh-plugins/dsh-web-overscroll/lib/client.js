// dsh-web-overscroll — browser half.
//
// The DSH shell is a 100%-height app: html/body/#root are exactly the viewport and
// every list scrolls inside its own container. What was missing is the viewport-level
// guard, so a wheel/trackpad gesture that ran past the end of an inner scroller kept
// chaining up to the document root and the whole page came off the viewport.
//
// Fix: the root stops being a scroll container (overflow:hidden) and never bounces
// (overscroll-behavior:none); #root keeps its own chain barrier. Inner scrollers are
// not touched — the message list, the sidebar and the panes keep their own overflow,
// momentum and scrollbars.
window.__ModuleLoader__.load({
	id: 'dsh-web-overscroll',
	factory: () => {
		const css = `
html,
body{
	height:100%;
	overflow:hidden;
	overscroll-behavior:none;
}
#root{
	height:100%;
	overflow:hidden;
	overscroll-behavior-y:contain;
}
`;

		function apply(ctx) {
			ctx.effect(() => {
				// Idempotent: a re-apply (HMR / strict re-mount) must not stack tags.
				for (const stale of document.querySelectorAll('style[data-plugin="dsh-web-overscroll"]')) stale.remove();
				const style = document.createElement('style');
				style.dataset.plugin = 'dsh-web-overscroll';
				style.textContent = css;
				document.head.append(style);
				return () => style.remove();
			}, 'dsh-web-overscroll: viewport styles');
		}

		return { inject: [], apply };
	}
});
