// A "leak" is any Simulator-driving path that bypasses RN Devtools: mutating
// simctl verbs, a hand-started Metro, or a third-party driver (idb, axe,
// cliclick, maestro) the agent found on the machine. Read-only inspection
// (`simctl list`, `simctl spawn … launchctl print`, `idb ui describe-all`) is
// not a leak: orienting is fine, driving is the problem.
export function isLeak(command) {
	// Split on shell separators so `rndevtools input …; xcrun simctl boot …`
	// is judged per segment and an rndevtools call never shields a leak.
	return command
		.split(/\s*(?:&&|\|\||;|\|)\s*/)
		.some((segment) => {
			if (/\brndevtools\b/.test(segment)) return false;
			if (/\bsimctl\s+(boot|shutdown|openurl|install|launch|io|erase|delete|terminate|push|privacy|clone|addmedia|keychain|status_bar)\b/.test(segment)) return true;
			if (/\bsimctl\s+spawn\b/.test(segment) && !/\blaunchctl\s+(print|list)\b/.test(segment)) return true;
			if (/\b(expo|react-native)\s+start\b/.test(segment)) return true;
			if (/(^|\s)(idb|axe|cliclick|maestro)\s+(ui\s+)?(tap|swipe|button|text|input|key|launch|open|boot|shutdown|install|focus|type|press|click|run|record|screenshot)\b/.test(segment)) return true;
			return false;
		});
}
