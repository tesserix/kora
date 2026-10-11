package ai

import "context"

// Provider is a single AI backend. Implementations (Gemini, OpenAI) are thin
// adapters; all higher layers depend only on this interface so they are
// testable without live calls.
type Provider interface {
	IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error)
	IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error)
	// IdentifyBodyComposition reads a smart-scale result screenshot and
	// returns only what is legible — see BodyCompositionReading's doc
	// comment. A separate method from IdentifyPhoto because the response
	// shape is fundamentally different (one reading's worth of measured
	// numbers, not a list of food guesses) and cannot be forced into
	// []Guess.
	IdentifyBodyComposition(ctx context.Context, image []byte, mime string) (BodyCompositionReading, Usage, error)
	Decompose(ctx context.Context, dish string) ([]IngredientGuess, Usage, error)
	Embed(ctx context.Context, text string) ([]float32, Usage, error)
	// Transcribe converts spoken audio (a person describing what they ate)
	// into plain text. Only the primary (Gemini) implements it; the fallback
	// returns an error, so audio is never sent to a text-only model.
	Transcribe(ctx context.Context, audio []byte, mime string) (string, Usage, error)
	// GenerateText produces a free-form text response for the given system
	// and user prompts — no JSON schema, no structured output. Intended for
	// conversational/coaching use cases where the answer is prose, not a
	// parseable food/ingredient shape.
	GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, Usage, error)
	Name() string
}
