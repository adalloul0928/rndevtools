package setup

import (
	"reflect"
	"strings"
	"testing"
)

func segmentWords(line string) [][]string {
	var words [][]string
	for _, segment := range splitShell(line) {
		words = append(words, segment.words)
	}
	return words
}

func TestSplitShellBreaksOnControlOperatorsOutsideQuotes(t *testing.T) {
	for line, want := range map[string][][]string{
		"rndevtools doctor; expo start":          {{"rndevtools", "doctor"}, {"expo", "start"}},
		"a && b || c | d |& e & f":               {{"a"}, {"b"}, {"c"}, {"d"}, {"e"}, {"f"}},
		"a\nb":                                   {{"a"}, {"b"}},
		"(cd app; expo start)":                   {{"cd", "app"}, {"expo", "start"}},
		`echo "a; b && c" 'd | e'`:               {{"echo", "a; b && c", "d | e"}},
		`echo a\;b`:                              {{"echo", "a;b"}},
		"expo start > log 2>&1 &":                {{"expo", "start", ">", "log", "2>&1"}},
		"cmd &> log":                             {{"cmd", "&>", "log"}},
		"npx expo \\\nstart":                     {{"npx", "expo", "start"}},
		"git status # expo start\nls":            {{"git", "status"}, {"ls"}},
		"curl http://example.com/#top":           {{"curl", "http://example.com/#top"}},
		`printf ''`:                              {{"printf", ""}},
		"  ;; ;":                                 nil,
		`echo "unterminated; still quoted`:       {{"echo", "unterminated; still quoted"}},
		`'/Applications/RN Devtools.app/x' hook`: {{"/Applications/RN Devtools.app/x", "hook"}},
	} {
		if got := segmentWords(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
}

func TestSplitShellGivesSubstitutionsTheirOwnSegments(t *testing.T) {
	for line, want := range map[string][][]string{
		"rndevtools claim --note $(xcrun simctl boot X)": {
			{"xcrun", "simctl", "boot", "X"},
			{"rndevtools", "claim", "--note", "$(xcrun simctl boot X)"},
		},
		`rndevtools claim --note "$(expo start)"`: {
			{"expo", "start"},
			{"rndevtools", "claim", "--note", "$(expo start)"},
		},
		"echo `expo start`": {{"expo", "start"}, {"echo", "`expo start`"}},
		"diff <(a) >(b)":    {{"a"}, {"b"}, {"diff", "<(a)", ">(b)"}},
		"echo $(a $(b) (c))": {
			{"b"}, {"a", "$(b)"}, {"c"}, {"echo", "$(a $(b) (c))"},
		},
		`echo '$(not run)'`: {{"echo", "$(not run)"}},
	} {
		if got := segmentWords(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
	// Pathological nesting is bounded rather than followed forever.
	deep := strings.Repeat("$(", 10_000) + "expo start" + strings.Repeat(")", 10_000)
	if segments := splitShell(deep); len(segments) > maxShellDepth+1 {
		t.Fatalf("followed %d nested substitutions", len(segments))
	}
}

func TestParseShellLineRecordsTerminatorsAndScopes(t *testing.T) {
	type shape struct {
		program    string
		terminator string
		scope      int
	}
	for line, want := range map[string][]shape{
		"cd a && b; c | d & e || f |& g\nh": {
			{"cd", "&&", 0}, {"b", ";", 0}, {"c", "|", 0}, {"d", "&", 0}, {"e", "||", 0}, {"f", "|&", 0}, {"g", "\n", 0}, {"h", "", 0},
		},
		"(cd x; y) && z":          {{"cd", ";", 1}, {"y", "", 1}, {"z", "", 0}},
		"echo $(cd x; y) && z":    {{"cd", ";", 1}, {"y", "", 1}, {"echo", "&&", 0}, {"z", "", 0}},
		"(a) ; (b)":               {{"a", "", 1}, {"b", "", 2}},
		`x "$(y)" ` + "`z`":       {{"y", "", 1}, {"z", "", 2}, {"x", "", 0}},
		"supabase status >| .env": {{"supabase", "", 0}},
	} {
		parsed := parseShellLine(line)
		var got []shape
		for _, segment := range parsed.segments {
			got = append(got, shape{segment.program(), segment.terminator, segment.scope})
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %+v, want %+v", line, got, want)
		}
		if parsed.parents[0] != -1 {
			t.Errorf("%q: the line's own scope has no parent", line)
		}
	}
	nested := parseShellLine("a $(b $(c))")
	if !reflect.DeepEqual(nested.parents, []int{-1, 0, 1}) {
		t.Fatalf("substitution scopes nest: %v", nested.parents)
	}
	if words := segmentWords("supabase status >| .env"); !reflect.DeepEqual(words, [][]string{{"supabase", "status", ">|", ".env"}}) {
		t.Fatalf(">| is a redirection, not a pipe: %q", words)
	}
	assignments, words := splitShell("env FOO=1 sudo -E BAR=2 supabase start")[0].commandWords()
	if !reflect.DeepEqual(assignments, []string{"FOO=1", "BAR=2"}) || !reflect.DeepEqual(words, []string{"supabase", "start"}) {
		t.Fatalf("commandWords: %q %q", assignments, words)
	}
}

func TestSplitShellSkipsHereDocumentBodies(t *testing.T) {
	for line, want := range map[string][][]string{
		"cat > notes.md <<'EOF'\nsupabase stop --all\nxcrun simctl boot X\nEOF\nsupabase start": {
			{"cat", ">", "notes.md", "<<'EOF'"}, {"supabase", "start"},
		},
		"cat <<EOF > a; echo b\nline one\nEOF\nnext": {
			{"cat", "<<EOF", ">", "a"}, {"echo", "b"}, {"next"},
		},
		"cat <<-\"END\"\n\tpkill postgres\n\tEND\ndone": {{"cat", `<<-"END"`}, {"done"}},
		"cat <<A <<B\nfirst\nA\nsecond\nB\nafter":       {{"cat", "<<A", "<<B"}, {"after"}},
		"cat <<EOF\nnever closed\nsupabase stop --all":  {{"cat", "<<EOF"}},
		"git commit -m \"$(cat <<'EOF'\nfix: supabase stop --all\nEOF\n)\" && git push": {
			{"cat", "<<'EOF'"}, {"git", "commit", "-m", "$(cat <<'EOF'\nfix: supabase stop --all\nEOF\n)"}, {"git", "push"},
		},
		"grep -c x <<< \"supabase start\"": {{"grep", "-c", "x", "<<<", "supabase start"}},
		"echo $(( 1 << 2 ))\nnext":         {{"1", "<<", "2"}, {"echo", "$(( 1 << 2 ))"}, {"next"}},
	} {
		if got := segmentWords(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
	// Substitutions run as their own segments, so the text the pattern rules
	// read for the command around them holds only a placeholder.
	segments := splitShell("git commit -m \"$(cat <<'EOF'\nxcrun simctl boot X\nEOF\n)\"")
	if text := segments[len(segments)-1].text; text != `git commit -m "$(…)"` {
		t.Fatalf("text %q", text)
	}
}

func TestSegmentProgramSkipsAssignmentsKeywordsAndWrappers(t *testing.T) {
	for line, want := range map[string]string{
		"rndevtools doctor":                                "rndevtools",
		"~/.local/bin/rndevtools doctor":                   "rndevtools",
		`"/Applications/RN Devtools.app/bin/rndevtools" x`: "rndevtools",
		"FOO=1 BAR_2=x rndevtools doctor":                  "rndevtools",
		"env -i PATH=/bin rndevtools doctor":               "rndevtools",
		"time nohup rndevtools doctor":                     "rndevtools",
		"{ rndevtools doctor":                              "rndevtools",
		"then rndevtools doctor":                           "rndevtools",
		"! rndevtools doctor":                              "rndevtools",
		"echo rndevtools":                                  "echo",
		"rndevtools-dev doctor":                            "rndevtools-dev",
		"1FOO=bar rndevtools":                              "1FOO=bar",
		"sudo -u root rndevtools":                          "root",
		"FOO=1":                                            "",
	} {
		segments := splitShell(line)
		if len(segments) != 1 {
			t.Fatalf("%q: %d segments", line, len(segments))
		}
		if got := segments[0].program(); got != want {
			t.Errorf("%q: program %q, want %q", line, got, want)
		}
	}
}
