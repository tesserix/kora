package coach

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/tesserix/kora/api/internal/agents"
)

func TestAgentPromptIsUnchangedWhenItFits(t *testing.T) {
	prompt, trimmed := agentPrompt("calories: 1200", "\nCONVERSATION SO FAR:\nUser: hi\n", "what next?")

	want := "CONTEXT:\ncalories: 1200\n\nCONVERSATION SO FAR:\nUser: hi\n\nQUESTION: what next?"
	if prompt != want || trimmed {
		t.Fatalf("agentPrompt = (%q, %t), want (%q, false)", prompt, trimmed, want)
	}
}

func TestAgentPromptKeepsTheQuestionWhenContextIsOversized(t *testing.T) {
	question := strings.Repeat("ü", 4000)
	history := "\nCONVERSATION SO FAR:\n" + strings.Repeat("User: old turn é\n", 2000) + "User: latest turn\n"
	context := "calories: 1200\n" + strings.Repeat("ß", 20_000)

	prompt, trimmed := agentPrompt(context, history, question)

	if !trimmed {
		t.Error("trimmed = false, want the oversized prompt reported as trimmed")
	}
	if !strings.HasSuffix(prompt, "\nQUESTION: "+question) {
		t.Error("the user's question did not survive trimming intact")
	}
	if !strings.HasPrefix(prompt, "CONTEXT:\ncalories: 1200\n") {
		t.Error("the head of the context did not survive trimming")
	}
	if !utf8.ValidString(prompt) || utf8.RuneCountInString(prompt) > agents.MaxPromptRunes {
		t.Fatalf("prompt has %d runes (valid UTF-8: %t), want at most %d", utf8.RuneCountInString(prompt), utf8.ValidString(prompt), agents.MaxPromptRunes)
	}
}

func TestAgentPromptKeepsTheLatestTurnsWhenOnlyHistoryOverflows(t *testing.T) {
	history := "\nCONVERSATION SO FAR:\n" + strings.Repeat("User: old turn\n", 2000) + "User: latest turn\n"

	prompt, trimmed := agentPrompt("calories: 1200", history, "what next?")

	if !trimmed || !strings.Contains(prompt, "CONVERSATION SO FAR:\nUser: old turn\n") || !strings.Contains(prompt, "User: latest turn\n\nQUESTION: what next?") {
		t.Fatalf("history was not trimmed to its newest whole turns:\n%s", prompt[:200])
	}
	if utf8.RuneCountInString(prompt) > agents.MaxPromptRunes {
		t.Fatalf("prompt has %d runes, want at most %d", utf8.RuneCountInString(prompt), agents.MaxPromptRunes)
	}
}
