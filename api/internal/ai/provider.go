package ai

import "context"

// Provider is a single AI backend. Implementations (Gemini, OpenAI) are thin
// adapters; all higher layers depend only on this interface so they are
// testable without live calls.
type Provider interface {
	IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error)
	IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error)
	Decompose(ctx context.Context, dish string) ([]IngredientGuess, Usage, error)
	Embed(ctx context.Context, text string) ([]float32, Usage, error)
	Name() string
}
