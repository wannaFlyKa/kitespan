// The landing page's theme (DESIGN-W1 1.2): it follows the device until the visitor presses the theme button; the
// choice is kept in sessionStorage, for this tab only, and applied by THEME_SCRIPT in the page's head before the first
// paint (its SHA-256 is in the page's Content-Security-Policy). Pure code: site/render.ts and site/page.ts import it.

export const THEME_KEY = "kitespan.site.theme";
export type PageTheme = "light" | "dark";

export const THEME_SCRIPT = `try{var t=sessionStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
