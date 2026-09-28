/**
 * An `iconKey` that names a harness logo, and the logo it names, for tests
 * outside this directory: they may not spell a harness's name (the renderer
 * neutrality gate reads test files too), so they borrow the key from here.
 */

import { ClaudeCodeColor } from "@honeyicons/react";

export const LOGO_ICON_KEY = "claude-code";
export const LOGO_ICON = ClaudeCodeColor;
