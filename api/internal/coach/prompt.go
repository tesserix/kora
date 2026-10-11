package coach

import (
	"strings"
	"unicode/utf8"

	"github.com/tesserix/kora/api/internal/agents"
)

const historyHeader = "\nCONVERSATION SO FAR:\n"

// agentPrompt builds the CONTEXT/history/QUESTION body within the agents' limit.
// The question is never cut: the oldest turns go first, then the tail of the context.
func agentPrompt(context, history, question string) (string, bool) {
	build := func(c, h string) string { return "CONTEXT:\n" + c + "\n" + h + "\nQUESTION: " + question }

	over := utf8.RuneCountInString(build(context, history)) - agents.MaxPromptRunes
	if over <= 0 {
		return build(context, history), false
	}
	history = dropOldestTurns(history, over)
	if over = utf8.RuneCountInString(build(context, history)) - agents.MaxPromptRunes; over > 0 {
		context = agents.FirstRunes(context, max(utf8.RuneCountInString(context)-over, 0))
	}
	return build(context, history), true
}

// dropOldestTurns removes whole turns from the front of a rendered history
// until at least n characters are gone, or the history is empty.
func dropOldestTurns(history string, n int) string {
	body, ok := strings.CutPrefix(history, historyHeader)
	if !ok {
		return ""
	}
	for n > 0 && body != "" {
		line, rest, _ := strings.Cut(body, "\n")
		n -= utf8.RuneCountInString(line) + 1
		body = rest
	}
	if body == "" {
		return ""
	}
	return historyHeader + body
}
