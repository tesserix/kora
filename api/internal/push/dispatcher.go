package push

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/devices"
	"github.com/tesserix/kora/api/internal/notifications"
)

const pendingLimit = 200

// pendingStore is the notifications outbox surface (notifications.Repository satisfies it).
type pendingStore interface {
	SkipStalePush(ctx context.Context, cutoff time.Time) (int, error)
	ListPendingPush(ctx context.Context, since time.Time, limit int) ([]notifications.PendingPush, error)
	MarkPushSent(ctx context.Context, id uuid.UUID) error
}

// tokenLister lists a user's device tokens and prunes dead ones (devices.Repository satisfies it).
type tokenLister interface {
	ListForUser(ctx context.Context, userID uuid.UUID) ([]devices.DeviceToken, error)
	DeleteToken(ctx context.Context, token string) error
}

type Dispatcher struct {
	store     pendingStore
	tokens    tokenLister
	sender    Sender
	freshness time.Duration
	interval  time.Duration
	log       *slog.Logger
}

func New(store pendingStore, tokens tokenLister, sender Sender, freshness, interval time.Duration, log *slog.Logger) *Dispatcher {
	return &Dispatcher{store: store, tokens: tokens, sender: sender, freshness: freshness, interval: interval, log: log}
}

// Run ticks until ctx is cancelled. A tick error is logged; the loop continues.
func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(d.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := d.Tick(ctx, time.Now()); err != nil {
				d.log.WarnContext(ctx, "push tick failed", "err", err)
			}
		}
	}
}

// Tick retires stale rows, then sends fresh ones and marks them.
func (d *Dispatcher) Tick(ctx context.Context, now time.Time) error {
	cutoff := now.Add(-d.freshness)

	if _, err := d.store.SkipStalePush(ctx, cutoff); err != nil {
		return err
	}
	pending, err := d.store.ListPendingPush(ctx, cutoff, pendingLimit)
	if err != nil {
		return err
	}

	for _, p := range pending {
		toks, err := d.tokens.ListForUser(ctx, p.UserID)
		if err != nil {
			d.log.WarnContext(ctx, "push: list tokens", "user", p.UserID, "err", err)
			continue // do not mark → retry next tick (until it ages out)
		}
		if len(toks) > 0 {
			msgs := make([]Message, 0, len(toks))
			for _, t := range toks {
				msgs = append(msgs, Message{To: t.Token, Title: pushTitle, Body: body(p.Type, p.ActorName), Data: dataFor(p)})
			}
			receipts, err := d.sender.Send(ctx, msgs)
			if err != nil {
				d.log.WarnContext(ctx, "push: send", "notification", p.ID, "err", err)
				continue // do not mark → retry
			}
			for _, rc := range receipts {
				if rc.DeviceNotRegistered {
					if err := d.tokens.DeleteToken(ctx, rc.Token); err != nil {
						d.log.WarnContext(ctx, "push: prune token", "err", err)
					}
				}
			}
		}
		if err := d.store.MarkPushSent(ctx, p.ID); err != nil {
			d.log.WarnContext(ctx, "push: mark sent", "notification", p.ID, "err", err)
		}
	}
	return nil
}
