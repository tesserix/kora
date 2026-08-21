package metrics

import (
	"regexp"
	"sync"
)

// Agent and skill names come from the Agentic Registry rather than from a
// constant in this binary, so they cannot be allowlisted the way call types
// are. Cardinality is bounded two ways instead: the value must look like a
// registry identifier, and only the first maxAgentLabels distinct values are
// ever used as labels. Everything else collapses into labelOther, preserving
// the same guarantee labels.go makes — no input can grow the label space
// without limit.
const maxAgentLabels = 32

var agentLabelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// seenAgentLabels is the bounded set of values admitted so far. It is
// process-lifetime: agents are published by a reviewed PR, so the set
// stabilises within one TTL of startup and never churns.
var seenAgentLabels = struct {
	sync.Mutex
	values map[string]bool
}{values: map[string]bool{}}

func normalizeAgentLabel(value string) string {
	if !agentLabelPattern.MatchString(value) {
		return labelOther
	}

	seenAgentLabels.Lock()
	defer seenAgentLabels.Unlock()
	if seenAgentLabels.values[value] {
		return value
	}
	if len(seenAgentLabels.values) >= maxAgentLabels {
		return labelOther
	}
	seenAgentLabels.values[value] = true
	return value
}

// knownResolveResults mirrors agents.CacheResult. Duplicated as literals so
// this package keeps importing nothing from the domain.
var knownResolveResults = map[string]bool{"hit": true, "miss": true, "stale": true, "error": true}

func normalizeResolveResult(result string) string {
	if knownResolveResults[result] {
		return result
	}
	return labelOther
}
