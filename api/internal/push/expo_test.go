package push

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestExpoSenderParsesTicketsAndDeviceNotRegistered(t *testing.T) {
	var received []Message
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"status":"ok","id":"x"},{"status":"error","message":"not registered","details":{"error":"DeviceNotRegistered"}}]}`))
	}))
	defer srv.Close()

	s := NewExpoSender("")
	s.url = srv.URL // override endpoint for the test

	receipts, err := s.Send(context.Background(), []Message{
		{To: "good-tok", Title: "Kora", Body: "hi"},
		{To: "dead-tok", Title: "Kora", Body: "hi"},
	})
	require.NoError(t, err)
	require.Len(t, received, 2)
	require.Len(t, receipts, 2)
	require.Equal(t, "good-tok", receipts[0].Token)
	require.False(t, receipts[0].DeviceNotRegistered)
	require.Equal(t, "dead-tok", receipts[1].Token)
	require.True(t, receipts[1].DeviceNotRegistered)
}
