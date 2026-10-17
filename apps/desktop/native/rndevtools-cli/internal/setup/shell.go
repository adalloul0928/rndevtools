package setup

import (
	"regexp"
	"strings"
)

// maxShellDepth bounds how far nested substitutions are followed. Agents
// rarely nest $(…) more than a level or two; deeper text stays part of the
// word it appears in instead of being split again.
const maxShellDepth = 16

// shellSegment is one simple command of a shell line: its source text, which
// the pattern rules match against, and its words with quoting removed, which
// say what program it runs.
type shellSegment struct {
	text  string
	words []string
	// terminator is the control operator that ended the segment: ";", "&&",
	// "||", "|", "|&", "&", or "\n"; "" when the line, a group, or a
	// substitution ended instead.
	terminator string
	// scope is the command list the segment belongs to: 0 for the line
	// itself, and a new one for each ( group ) and each substitution, nested
	// in the scope it appears in. A `cd` changes the directory of its own
	// scope only, which is how a subshell behaves.
	scope int
}

// shellLine is a split line: its segments in the order they run (a
// substitution before the command that uses it) and each scope's parent,
// -1 for the line itself.
type shellLine struct {
	segments []shellSegment
	parents  []int
}

// splitShell splits a shell line into the simple commands it runs. It breaks
// on unquoted `;`, `&`, `&&`, `||`, `|`, `|&`, `(`, `)` and newlines, drops
// comments and line continuations, and returns the body of every `$(…)`,
// `<(…)`, `>(…)` and backtick substitution as segments of its own, because a
// substitution runs no matter which command it appears in. Single and double
// quotes and backslash escapes are honoured. It is a splitter, not a parser:
// the rules only need to know where each command starts and what it runs.
func splitShell(line string) []shellSegment {
	return parseShellLine(line).segments
}

// parseShellLine is splitShell plus the scope tree, for rules that follow a
// line's `cd`s, pipelines, and `&&` chains.
func parseShellLine(line string) shellLine {
	splitter := shellSplitter{line: line, parents: []int{-1}}
	splitter.scan(0, 0, 0, 0)
	return shellLine{segments: splitter.segments, parents: splitter.parents}
}

// commandWords returns the assignments that prefix a segment's command
// (FOO=1, including those an env wrapper sets) and its words from the
// program on, after grouping words and keywords ({, !, then, do) and the
// wrappers that run their arguments (sudo, env, command, exec, time, nohup)
// with their options.
func (segment shellSegment) commandWords() (assignments []string, words []string) {
	words = segment.words
	for len(words) > 0 {
		word := words[0]
		switch {
		case isShellAssignment(word):
			assignments = append(assignments, word)
			words = words[1:]
			continue
		case shellKeywords[word]:
			words = words[1:]
			continue
		case shellWrappers[word]:
			words = words[1:]
			for len(words) > 0 && strings.HasPrefix(words[0], "-") {
				words = words[1:]
			}
			continue
		}
		return assignments, words
	}
	return assignments, nil
}

// program is the basename of the command a segment runs (see commandWords).
// It is "" when nothing is left.
func (segment shellSegment) program() string {
	_, words := segment.commandWords()
	if len(words) == 0 {
		return ""
	}
	return baseName(words[0])
}

func baseName(word string) string {
	return word[strings.LastIndexByte(word, '/')+1:]
}

var (
	shellKeywords = map[string]bool{
		"{": true, "}": true, "!": true, "if": true, "then": true, "else": true,
		"elif": true, "fi": true, "do": true, "done": true, "while": true, "until": true,
	}
	shellWrappers = map[string]bool{
		"sudo": true, "env": true, "command": true, "exec": true, "time": true, "nohup": true,
	}
)

func isShellAssignment(word string) bool {
	name, _, found := strings.Cut(word, "=")
	if !found || name == "" {
		return false
	}
	for index, r := range name {
		letter := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		if !letter && (index == 0 || r < '0' || r > '9') {
			return false
		}
	}
	return true
}

type shellSplitter struct {
	line     string
	segments []shellSegment
	parents  []int
}

// newScope opens a command list nested in parent.
func (splitter *shellSplitter) newScope(parent int) int {
	splitter.parents = append(splitter.parents, parent)
	return len(splitter.parents) - 1
}

// segmentBuilder accumulates the segment being read.
type segmentBuilder struct {
	text   strings.Builder
	word   strings.Builder
	inWord bool
	words  []string
}

func (builder *segmentBuilder) literal(value string) {
	builder.word.WriteString(value)
	builder.text.WriteString(value)
	builder.inWord = true
}

func (builder *segmentBuilder) endWord() {
	if builder.inWord {
		builder.words = append(builder.words, builder.word.String())
		builder.word.Reset()
		builder.inWord = false
	}
}

func (builder *segmentBuilder) flush(splitter *shellSplitter, scope int, terminator string) {
	builder.endWord()
	if len(builder.words) > 0 {
		splitter.segments = append(splitter.segments, shellSegment{
			text:       builder.text.String(),
			words:      builder.words,
			terminator: terminator,
			scope:      scope,
		})
	}
	builder.text.Reset()
	builder.words = nil
}

// scan splits line[start:] until it reaches closer outside quotes and
// parentheses (closer 0 scans to the end of the line), and returns the index
// just past what it consumed. Its segments belong to scope, or to the groups
// opened inside it.
func (splitter *shellSplitter) scan(start int, closer byte, depth int, scope int) int {
	line := splitter.line
	var current segmentBuilder
	// groups holds the scopes of the ( … ) groups open here, innermost last.
	groups := []int{scope}
	inner := func() int { return groups[len(groups)-1] }
	flush := func(terminator string) { current.flush(splitter, inner(), terminator) }
	next := func(index int) byte {
		if index+1 < len(line) {
			return line[index+1]
		}
		return 0
	}
	// documents are the here-documents whose bodies start after this line.
	var documents []hereDocument
	index := start
	for index < len(line) {
		character := line[index]
		switch {
		case closer != 0 && character == closer && (closer != ')' || len(groups) == 1):
			flush("")
			return index + 1
		case character == '<' && strings.HasPrefix(line[index:], "<<<"):
			// A here-string is one word of input.
			current.literal("<<<")
			index += 3
		case character == '<' && next(index) == '<':
			if end, document, ok := readHereDocument(line, index); ok {
				current.literal(line[index:end])
				documents = append(documents, document)
				index = end
			} else {
				current.literal("<<")
				index += 2
			}
		case character == '\\':
			switch {
			case index+1 >= len(line):
				current.literal(`\`)
				index++
			case line[index+1] == '\n':
				// A line continuation joins the two lines.
				index += 2
			default:
				current.word.WriteByte(line[index+1])
				current.text.WriteString(line[index : index+2])
				current.inWord = true
				index += 2
			}
		case character == '\'':
			stop := len(line)
			body := line[index+1:]
			if end := strings.IndexByte(body, '\''); end >= 0 {
				body = body[:end]
				stop = index + 1 + end + 1
			}
			current.word.WriteString(body)
			current.text.WriteString(line[index:stop])
			current.inWord = true
			index = stop
		case character == '"':
			index = splitter.doubleQuoted(&current, index, depth, inner())
		case character == '`':
			index = splitter.substitution(&current, index, index+1, '`', depth, inner())
		case (character == '$' || character == '<' || character == '>') && next(index) == '(':
			index = splitter.substitution(&current, index, index+2, ')', depth, inner())
		case character == '#' && !current.inWord:
			// A comment runs to the end of the line.
			for index < len(line) && line[index] != '\n' {
				index++
			}
		case character == ' ' || character == '\t':
			current.endWord()
			current.text.WriteByte(character)
			index++
		case character == '(':
			flush("")
			groups = append(groups, splitter.newScope(inner()))
			index++
		case character == ')':
			flush("")
			if len(groups) > 1 {
				groups = groups[:len(groups)-1]
			}
			index++
		case character == '\n' || character == ';':
			flush(string(character))
			index++
			if character == '\n' && len(documents) > 0 {
				// Here-document bodies are the command's input, not commands.
				index = skipHereDocuments(line, index, documents)
				documents = nil
			}
		case character == '|' && current.inWord && index > start && line[index-1] == '>':
			// `>|` redirects despite noclobber; it is not a pipe.
			current.literal("|")
			index++
		case character == '|':
			terminator := "|"
			if next(index) == '|' || next(index) == '&' {
				terminator = line[index : index+2]
			}
			flush(terminator)
			index += len(terminator)
		case character == '&':
			switch {
			case next(index) == '&':
				flush("&&")
				index += 2
			case next(index) == '>' || (index > start && (line[index-1] == '>' || line[index-1] == '<')):
				// A redirection (&>, 2>&1, <&3), not a background job.
				current.literal("&")
				index++
			default:
				flush("&")
				index++
			}
		default:
			current.literal(line[index : index+1])
			index++
		}
	}
	flush("")
	return index
}

// doubleQuoted reads a double-quoted string starting at line[start] into the
// current word. Substitutions inside it still run, so they are split out too.
func (splitter *shellSplitter) doubleQuoted(current *segmentBuilder, start int, depth int, scope int) int {
	line := splitter.line
	current.inWord = true
	current.text.WriteByte('"')
	index := start + 1
	for index < len(line) {
		character := line[index]
		switch {
		case character == '"':
			current.text.WriteByte(character)
			return index + 1
		case character == '\\' && index+1 < len(line) && strings.IndexByte("$`\"\\\n", line[index+1]) >= 0:
			if line[index+1] != '\n' {
				current.word.WriteByte(line[index+1])
				current.text.WriteString(line[index : index+2])
			}
			index += 2
		case character == '`':
			index = splitter.substitution(current, index, index+1, '`', depth, scope)
		case character == '$' && index+1 < len(line) && line[index+1] == '(':
			index = splitter.substitution(current, index, index+2, ')', depth, scope)
		default:
			current.word.WriteByte(character)
			current.text.WriteByte(character)
			index++
		}
	}
	return index
}

// substitution splits the body of a command, process, or backtick
// substitution into segments of its own scope, nested in scope, and keeps
// its source as part of the word it appears in. The segment's text, which
// the pattern rules read, holds only a placeholder: the body's commands are
// judged as segments of their own, and its here-documents not at all. Past
// maxShellDepth the body is only skipped over, to its matching closer, and
// stays plain text.
func (splitter *shellSplitter) substitution(current *segmentBuilder, open int, body int, closer byte, depth int, scope int) int {
	line := splitter.line
	end := body
	if depth < maxShellDepth {
		end = splitter.scan(body, closer, depth+1, splitter.newScope(scope))
		current.word.WriteString(line[open:end])
		current.text.WriteString(line[open:body] + "…" + string(closer))
		current.inWord = true
		return end
	}
	for nesting := 0; end < len(line); {
		character := line[end]
		end++
		if character == closer && (closer != ')' || nesting == 0) {
			break
		}
		if character == '(' {
			nesting++
		} else if character == ')' {
			nesting--
		}
	}
	current.literal(line[open:end])
	return end
}

// hereDocument is a here-document (<<word or <<-word) whose body starts on
// the line after its operator.
type hereDocument struct {
	delimiter string
	// stripTabs is <<-, whose delimiter line may be indented with tabs.
	stripTabs bool
}

// readHereDocument reads the operator and delimiter word at line[index:]
// (quoted or not) and returns the index just past them. Only a name-like
// delimiter counts, so arithmetic such as $(( 1 << 2 )) is left alone.
func readHereDocument(line string, index int) (int, hereDocument, bool) {
	document := hereDocument{}
	position := index + 2
	if position < len(line) && line[position] == '-' {
		document.stripTabs = true
		position++
	}
	for position < len(line) && (line[position] == ' ' || line[position] == '\t') {
		position++
	}
	var delimiter strings.Builder
	for position < len(line) && !strings.ContainsRune(" \t\n;|&<>()", rune(line[position])) {
		switch character := line[position]; character {
		case '\'', '"':
			end := strings.IndexByte(line[position+1:], character)
			if end < 0 {
				return 0, hereDocument{}, false
			}
			delimiter.WriteString(line[position+1 : position+1+end])
			position += end + 2
		case '\\':
			position++
		default:
			delimiter.WriteByte(character)
			position++
		}
	}
	if !hereDocumentDelimiter.MatchString(delimiter.String()) {
		return 0, hereDocument{}, false
	}
	document.delimiter = delimiter.String()
	return position, document, true
}

var hereDocumentDelimiter = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// skipHereDocuments returns the index just past the bodies of documents,
// which follow one another from line[start:]. A body without its delimiter
// line runs to the end of the input.
func skipHereDocuments(line string, start int, documents []hereDocument) int {
	index := start
	for _, document := range documents {
		for index < len(line) {
			text, next := line[index:], len(line)
			if end := strings.IndexByte(line[index:], '\n'); end >= 0 {
				text, next = line[index:index+end], index+end+1
			}
			index = next
			if document.stripTabs {
				text = strings.TrimLeft(text, "\t")
			}
			if text == document.delimiter {
				break
			}
		}
	}
	return index
}
