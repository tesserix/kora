package push

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/devices"
	"github.com/tesserix/kora/api/internal/notifications"
)

func newLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func at() time.Time           { return time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC) }

type stubStore struct {
	pending    []notifications.PendingPush
	skipCutoff time.Time
	listSince  time.Time
	marked     []uuid.UUID
}

func (s *stubStore) SkipStalePush(_ context.Context, cutoff time.Time) (int, error) {
	s.skipCutoff = cutoff
	return 0, nil
}
func (s *stubStore) ListPendingPush(_ context.Context, since time.Time, _ int) ([]notifications.PendingPush, error) {
	s.listSince = since
	return s.pending, nil
}
func (s *stubStore) MarkPushSent(_ context.Context, id uuid.UUID) error {
	s.marked = append(s.marked, id)
	return nil
}

type stubTokens struct {
	byUser map[uuid.UUID][]devices.DeviceToken
	err    error
	pruned []string
}

func (s *stubTokens) ListForUser(_ context.Context, userID uuid.UUID) ([]devices.DeviceToken, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.byUser[userID], nil
}
func (s *stubTokens) DeleteToken(_ context.Context, token string) error {
	s.pruned = append(s.pruned, token)
	return nil
}

type stubSender struct {
	sent     [][]Message
	receipts []Receipt
	err      error
}

func (s *stubSender) Send(_ context.Context, messages []Message) ([]Receipt, error) {
	s.sent = append(s.sent, messages)
	if s.err != nil {
		return nil, s.err
	}
	if s.receipts != nil {
		return s.receipts, nil
	}
	r := make([]Receipt, len(messages))
	for i, m := range messages {
		r[i] = Receipt{Token: m.To}
	}
	return r, nil
}

func pending(uid uuid.UUID) notifications.PendingPush {
	return notifications.PendingPush{ID: uuid.New(), UserID: uid, Type: notifications.TypeFriendRequest, ActorName: "Alice"}
}

func TestTickSendsFreshAndMarks(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{byUser: map[uuid.UUID][]devices.DeviceToken{uid: {{Token: "tok-a"}}}}
	sender := &stubSender{}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Equal(t, at().Add(-15*time.Minute), store.skipCutoff, "skip-stale cutoff = now - freshness")
	require.Equal(t, at().Add(-15*time.Minute), store.listSince, "list window = now - freshness")
	require.Len(t, sender.sent, 1)
	require.Equal(t, "tok-a", sender.sent[0][0].To)
	require.Equal(t, "Alice sent you a friend request", sender.sent[0][0].Body)
	require.Equal(t, []uuid.UUID{p.ID}, store.marked)
}

func TestTickNoTokensMarksSentWithoutSending(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{byUser: map[uuid.UUID][]devices.DeviceToken{}} // no tokens
	sender := &stubSender{}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Empty(t, sender.sent, "no send when recipient has no tokens")
	require.Equal(t, []uuid.UUID{p.ID}, store.marked, "still marked sent")
}

func TestTickSendErrorDoesNotMark(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{byUser: map[uuid.UUID][]devices.DeviceToken{uid: {{Token: "tok-a"}}}}
	sender := &stubSender{err: errors.New("expo down")}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Empty(t, store.marked, "send failure leaves row unsent for retry")
}

func TestTickListTokensErrorDoesNotMark(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{err: errors.New("db down")}
	sender := &stubSender{}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Empty(t, store.marked)
	require.Empty(t, sender.sent)
}

func TestTickPrunesDeviceNotRegistered(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{byUser: map[uuid.UUID][]devices.DeviceToken{uid: {{Token: "dead-tok"}}}}
	sender := &stubSender{receipts: []Receipt{{Token: "dead-tok", DeviceNotRegistered: true}}}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Equal(t, []string{"dead-tok"}, tokens.pruned)
	require.Equal(t, []uuid.UUID{p.ID}, store.marked, "row still marked sent after prune")
}
