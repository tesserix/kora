package notifications_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"os"

	"github.com/tesserix/kora/api/internal/notifications"
	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/user"
)

func wiringDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func seedU(t *testing.T, db *gorm.DB, name, email string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)",
		id, "wi-"+id.String(), email, name).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM notifications WHERE user_id = ? OR actor_id = ?", id, id)
		db.Exec("DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?", id, id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

// failingNotifier proves a notifier error never fails the action.
type failingNotifier struct{}

func (failingNotifier) FriendRequested(context.Context, uuid.UUID, uuid.UUID) error {
	return errors.New("boom")
}
func (failingNotifier) FriendAccepted(context.Context, uuid.UUID, uuid.UUID) error {
	return errors.New("boom")
}

func TestSendRequestWritesFriendRequestNotification(t *testing.T) {
	db := wiringDB(t)
	sender := seedU(t, db, "Sender", "sender-"+uuid.NewString()+"@t.dev")
	recipient := seedU(t, db, "Recipient", "recipient-"+uuid.NewString()+"@t.dev")

	notifSvc := notifications.NewService(notifications.NewRepository(db), nil) // nil members ok — no fan-out here
	svc := social.NewService(social.NewRepository(db), user.NewRepository(db)).WithNotifier(notifSvc)

	var recipEmail string
	require.NoError(t, db.Raw("SELECT email FROM users WHERE id = ?", recipient).Scan(&recipEmail).Error)
	_, err := svc.SendRequest(context.Background(), sender, recipEmail, "")
	require.NoError(t, err)

	list, err := notifications.NewRepository(db).ListForUser(context.Background(), recipient, 50)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, notifications.TypeFriendRequest, list[0].Type)
	require.Equal(t, "Sender", list[0].ActorName)
}

func TestNotifierErrorDoesNotFailAction(t *testing.T) {
	db := wiringDB(t)
	sender := seedU(t, db, "Sender", "s2-"+uuid.NewString()+"@t.dev")
	recipient := seedU(t, db, "Recipient", "r2-"+uuid.NewString()+"@t.dev")
	svc := social.NewService(social.NewRepository(db), user.NewRepository(db)).WithNotifier(failingNotifier{})

	var recipEmail string
	require.NoError(t, db.Raw("SELECT email FROM users WHERE id = ?", recipient).Scan(&recipEmail).Error)
	_, err := svc.SendRequest(context.Background(), sender, recipEmail, "")
	require.NoError(t, err) // action succeeds despite the notifier error
}
